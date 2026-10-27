import { spawn } from "node:child_process";
import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import {
  ensurePrCheckout,
  extractLinesPct,
  redactSecrets,
  resolvePrPin,
  type CheckoutResult,
} from "../lib/checkout.js";
import {
  prUrlSchemaDescription,
  requirePrRef,
  tryCreateCheck,
  upsertPrComment,
} from "../lib/pr.js";

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

const TOKEN_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "SHALLOW_CLONE_GIT_TOKEN", "GIT_CONFIG_VALUE_0"];

function testEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of TOKEN_ENV) {
    delete env[key];
  }
  return env;
}

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
      env: testEnv(),
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
      const log = redactSecrets(Buffer.concat(chunks).toString("utf8"));
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
        logTail: redactSecrets(String(error)),
      });
    });
  });
}

function resultsMarkdown(checkout: CheckoutResult, results: CommandResult[], linesPct: number | undefined): string {
  const passed = results.filter((item) => item.passed).length;
  const lines = [
    "## Mr. Nexus — impacted tests",
    "",
    checkout.ok
      ? `**Checkout:** \`${checkout.headSha}\` (shallow)`
      : `**Checkout:** failed — ${checkout.reason}`,
    `**Result:** ${passed}/${results.length} passed${checkout.ok ? "" : " (not executed)"}`,
    `**Line coverage:** ${linesPct === undefined ? "unavailable" : `${linesPct}%`}`,
    "",
  ];
  for (const item of results) {
    const exit = checkout.ok ? `exit ${item.exitCode ?? "n/a"}, ${item.durationMs}ms` : "not run";
    lines.push(`- ${item.passed ? "PASS" : "FAIL"} \`${item.label}\` (${exit})`);
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
    "Shallow-clone the PR head, run the impacted test commands in that checkout, and post pass/fail plus any line coverage printed by the runner. Does not require package.json (Rails/RSpec repos are valid). Check runs are best-effort under pr-write.",
  effect: "write",
  inputSchema: z.object({
    commands: z.array(command).min(1).max(20).describe("Shell commands to run for impacted tests, in the PR checkout."),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    prUrl: z.string().min(1).max(500).optional().describe(prUrlSchemaDescription),
  }),
  dryRunResult: ({ commands }) => ({
    posted: false,
    reason: "dry-run",
    planned: commands.map((item) => item.label),
  }),
  async execute({ commands, timeoutMs, prUrl }, ctx) {
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

    const ref = requirePrRef(ctx, prUrl);
    const timeout = timeoutMs ?? 300_000;
    let headShaForCheck: string | undefined;
    let checkout: CheckoutResult;
    try {
      const pin = await resolvePrPin(ctx, ref);
      headShaForCheck = pin.headSha;
      checkout = await ensurePrCheckout({
        workspaceDir: ctx.workspaceDir,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        headSha: pin.headSha,
        headBranch: pin.headBranch,
        baseSha: pin.baseSha,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checkout = { ok: false, reason: redactSecrets(message).slice(0, 500) };
    }

    const fullLogs: string[] = [];
    const results: CommandResult[] = [];
    if (!checkout.ok) {
      for (const item of commands) {
        results.push({
          label: item.label,
          command: item.command,
          exitCode: null,
          passed: false,
          durationMs: 0,
          logTail: "",
        });
      }
    } else {
      for (const item of commands) {
        const result = await runCommand(checkout.checkoutDir, item.label, item.command, timeout);
        fullLogs.push(result.logTail);
        results.push(result);
      }
    }

    const linesPct = extractLinesPct(fullLogs);
    const allPassed = checkout.ok && results.every((item) => item.passed);
    const markdown = resultsMarkdown(checkout, results, linesPct);
    const comment = await upsertPrComment({
      ctx,
      ref,
      kind: "impacted-tests",
      markdown,
    });

    const check = headShaForCheck
      ? await tryCreateCheck({
          github: ctx.host.github,
          owner: ref.owner,
          repo: ref.repo,
          name: "Mr. Nexus / impacted tests",
          sha: headShaForCheck,
          title: allPassed ? "Impacted tests passed" : "Impacted tests failed",
          summary: markdown,
          conclusion: allPassed ? "success" : "failure",
        })
      : { checkUrl: undefined, skipped: "no head SHA for check run" };

    return {
      posted: true,
      pr: `${ref.owner}/${ref.repo}#${ref.number}`,
      url: comment.url,
      checkUrl: check.checkUrl ?? null,
      checkSkipped: check.skipped ?? null,
      passed: allPassed,
      checkout: checkout.ok ? "ready" : "failed",
      checkoutHeadSha: checkout.ok ? checkout.headSha : null,
      linesPct: linesPct ?? null,
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
