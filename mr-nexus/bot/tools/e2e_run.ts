import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { acceptAppUrl, resolveE2eBaseUrl } from "../lib/e2e-url.js";
import {
  prUrlSchemaDescription,
  readHeadSha,
  readOptionalText,
  requirePrRef,
  tryCreateCheck,
  upsertPrComment,
} from "../lib/pr.js";

async function runShell(cwd: string, shellCommand: string, timeoutMs: number): Promise<{
  exitCode: number | null;
  logTail: string;
  durationMs: number;
}> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(shellCommand, { cwd, shell: true, env: process.env });
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 48_000) {
        child.kill("SIGTERM");
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        logTail: Buffer.concat(chunks).toString("utf8").slice(-6000),
        durationMs: Date.now() - started,
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        logTail: String(error),
        durationMs: Date.now() - started,
      });
    });
  });
}

export default defineTool({
  description:
    "Run product E2E against an app base URL from E2E_BASE_URL or an explicit preview/staging URL, then post results on the PR. Jira, Atlassian, and other ticket links are ignored. With no app URL, post a skip comment and do not run anything. Does not post a check run (pr-write has no checks:write). A skip is not a test failure.",
  effect: "write",
  inputSchema: z.object({
    baseUrl: z
      .string()
      .url()
      .optional()
      .describe("Preview or staging app URL. Jira, Atlassian, and other ticket links are ignored."),
    command: z
      .string()
      .max(2000)
      .optional()
      .describe("Shell command to run E2E. Defaults to npx playwright test when omitted."),
    timeoutMs: z.number().int().positive().max(900_000).optional(),
    skipReason: z.string().max(500).optional(),
    prUrl: z.string().min(1).max(500).optional().describe(prUrlSchemaDescription),
  }),
  dryRunResult: ({ baseUrl, skipReason }) => ({
    posted: false,
    reason: "dry-run",
    baseUrl: baseUrl ?? null,
    skipped: Boolean(skipReason),
  }),
  async execute({ baseUrl, command, timeoutMs, skipReason, prUrl }, ctx) {
    if (ctx.session.purpose === "eval") {
      return {
        posted: false,
        reason: "eval",
        baseUrl: baseUrl ?? null,
        skipped: Boolean(skipReason),
      };
    }

    const ref = requirePrRef(ctx, prUrl);
    const headSha = await readHeadSha(ctx.workspaceDir);
    const meta = await readOptionalText(ctx.workspaceDir, "pr/meta.md");
    const override = acceptAppUrl(baseUrl);
    const resolved = override ?? resolveE2eBaseUrl(meta, process.env.E2E_BASE_URL);
    const ignoredNonAppBaseUrl = Boolean(baseUrl?.trim()) && override === undefined;

    if (skipReason || !resolved) {
      const markdown = [
        "## Mr. Nexus — E2E",
        "",
        skipReason?.trim() ||
          "Skipped: no app base URL. Set `E2E_BASE_URL` or an explicit preview/staging http(s) URL. Jira and Atlassian links are not E2E targets.",
      ].join("\n");
      const comment = await upsertPrComment({
        ctx,
        ref,
        kind: "e2e",
        markdown,
      });
      const check = await tryCreateCheck({
        github: ctx.host.github,
        owner: ref.owner,
        repo: ref.repo,
        name: "Mr. Nexus / e2e",
        sha: headSha,
        title: "E2E skipped",
        summary: markdown,
        conclusion: "skipped",
      });
      return {
        posted: true,
        skipped: true,
        pr: `${ref.owner}/${ref.repo}#${ref.number}`,
        url: comment.url,
        checkUrl: check.checkUrl ?? null,
        checkSkipped: check.skipped ?? null,
        baseUrl: resolved ?? null,
        ignoredNonAppBaseUrl,
      };
    }

    let hasPlaywrightConfig = false;
    for (const name of ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]) {
      try {
        await access(join(ctx.workspaceDir, name));
        hasPlaywrightConfig = true;
        break;
      } catch {
        // keep looking
      }
    }

    const shellCommand =
      command?.trim() ||
      (hasPlaywrightConfig
        ? `npx --yes playwright test --reporter=line`
        : "");

    if (!shellCommand) {
      const markdown = [
        "## Mr. Nexus — E2E",
        "",
        `Base URL: ${resolved}`,
        "",
        "Skipped: no Playwright config and no explicit E2E command.",
      ].join("\n");
      const comment = await upsertPrComment({
        ctx,
        ref,
        kind: "e2e",
        markdown,
      });
      return {
        posted: true,
        skipped: true,
        pr: `${ref.owner}/${ref.repo}#${ref.number}`,
        url: comment.url,
        baseUrl: resolved,
      };
    }

    const result = await runShell(ctx.workspaceDir, shellCommand, timeoutMs ?? 600_000);
    const passed = result.exitCode === 0;
    const markdown = [
      "## Mr. Nexus — E2E",
      "",
      `**Result:** ${passed ? "PASS" : "FAIL"}`,
      `**Base URL:** ${resolved}`,
      `**Command:** \`${shellCommand}\``,
      `**Duration:** ${result.durationMs}ms`,
      "",
      "```",
      result.logTail.trim() || "(no output)",
      "```",
    ].join("\n");

    const comment = await upsertPrComment({
      ctx,
      ref,
      kind: "e2e",
      markdown,
    });
    const check = await tryCreateCheck({
      github: ctx.host.github,
      owner: ref.owner,
      repo: ref.repo,
      name: "Mr. Nexus / e2e",
      sha: headSha,
      title: passed ? "E2E passed" : "E2E failed",
      summary: markdown,
      conclusion: passed ? "success" : "failure",
    });

    return {
      posted: true,
      skipped: false,
      passed,
      pr: `${ref.owner}/${ref.repo}#${ref.number}`,
      url: comment.url,
      checkUrl: check.checkUrl ?? null,
      checkSkipped: check.skipped ?? null,
      baseUrl: resolved,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  },
});
