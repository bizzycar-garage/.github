import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createGitHubCheck } from "@grok/agent-sdk/channels/github";
import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { readHeadSha, requirePrRef, upsertPrComment } from "../lib/pr.js";

const command = z.object({
  label: z.string().min(1).max(120),
  command: z.string().min(1).max(2000),
});

type CommandResult = {
  label: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  logTail: string;
};

async function runCommand(
  cwd: string,
  label: string,
  shellCommand: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(shellCommand, {
      cwd,
      shell: true,
      env: process.env,
    });
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 32_000) {
        child.kill("SIGTERM");
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const log = Buffer.concat(chunks).toString("utf8");
      resolve({
        label,
        command: shellCommand,
        exitCode: code,
        passed: code === 0,
        durationMs: Date.now() - started,
        logTail: log.slice(-4000),
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        label,
        command: shellCommand,
        exitCode: null,
        passed: false,
        durationMs: Date.now() - started,
        logTail: String(error),
      });
    });
  });
}

function resultsMarkdown(results: CommandResult[]): string {
  const passed = results.filter((item) => item.passed).length;
  const lines = [
    "## Mr. Nexus — impacted tests",
    "",
    `**Result:** ${passed}/${results.length} passed`,
    "",
  ];
  for (const item of results) {
    lines.push(`- ${item.passed ? "PASS" : "FAIL"} \`${item.label}\` (exit ${item.exitCode ?? "n/a"}, ${item.durationMs}ms)`);
    lines.push(`  \`${item.command}\``);
    if (!item.passed && item.logTail.trim()) {
      lines.push("  ```");
      lines.push(item.logTail.trim().slice(-1500));
      lines.push("  ```");
    }
  }
  return lines.join("\n");
}

export default defineTool({
  description:
    "Run the selected impacted test commands in the session workspace, post a PR comment, and update a check run.",
  effect: "write",
  inputSchema: z.object({
    commands: z.array(command).min(1).max(20).describe("Shell commands to run for impacted tests."),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  }),
  dryRunResult: ({ commands }) => ({
    posted: false,
    reason: "dry-run",
    planned: commands.map((item) => item.label),
  }),
  async execute({ commands, timeoutMs }, ctx) {
    if (ctx.session.purpose === "eval") {
      return {
        posted: false,
        reason: "eval",
        results: commands.map((item) => ({
          label: item.label,
          command: item.command,
          exitCode: 0,
          passed: true,
          durationMs: 0,
          logTail: "",
        })),
      };
    }

    const ref = requirePrRef(ctx);
    const headSha = await readHeadSha(ctx.workspaceDir);
    const timeout = timeoutMs ?? 180_000;
    const packageJson = join(ctx.workspaceDir, "package.json");
    let hasPackage = false;
    try {
      await access(packageJson);
      hasPackage = true;
    } catch {
      hasPackage = false;
    }

    const results: CommandResult[] = [];
    if (!hasPackage) {
      for (const item of commands) {
        results.push({
          label: item.label,
          command: item.command,
          exitCode: null,
          passed: false,
          durationMs: 0,
          logTail:
            "No package.json in the session workspace. Seed a checkout or run with a workspace that contains the repo before re-running.",
        });
      }
    } else {
      for (const item of commands) {
        results.push(await runCommand(ctx.workspaceDir, item.label, item.command, timeout));
      }
    }

    const allPassed = results.every((item) => item.passed);
    const markdown = resultsMarkdown(results);
    const comment = await upsertPrComment({
      ctx,
      ref,
      kind: "impacted-tests",
      markdown,
    });

    const check = await createGitHubCheck({
      github: ctx.host.github,
      owner: ref.owner,
      repo: ref.repo,
      name: "Mr. Nexus / impacted tests",
      sha: headSha,
      output: {
        title: allPassed ? "Impacted tests passed" : "Impacted tests failed",
        summary: markdown,
      },
    });
    await check.conclude({
      conclusion: allPassed ? "success" : "failure",
      output: {
        title: allPassed ? "Impacted tests passed" : "Impacted tests failed",
        summary: markdown,
      },
    });

    return {
      posted: true,
      pr: `${ref.owner}/${ref.repo}#${ref.number}`,
      url: comment.url,
      checkUrl: check.url,
      passed: allPassed,
      results: results.map(({ label, command: cmd, exitCode, passed, durationMs }) => ({
        label,
        command: cmd,
        exitCode,
        passed,
        durationMs,
      })),
    };
  },
});
