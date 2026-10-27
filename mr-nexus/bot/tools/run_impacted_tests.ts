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
  commandNeedsRuby,
  commandWithAbsoluteBundle,
  ensureImpactedRuby,
  type RubyBootstrap,
} from "../lib/ruby-runtime.js";
import {
  prUrlSchemaDescription,
  requirePrRef,
  stagePrComment,
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

const TOKEN_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HIVE_GIT_READ_TOKEN",
  "SHALLOW_CLONE_GIT_TOKEN",
  "SHALLOW_CLONE_GIT_USERNAME",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "CURSOR_API_KEY",
  "CURSOR_SERVICE_ACCOUNT_KEY",
];

function specEnv(runtimeEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The runtime env already has the install's PATH, GEM_HOME, and GEM_PATH.
  // Overlaying process.env would put the pod PATH back in front of that install.
  const env: NodeJS.ProcessEnv = { ...(runtimeEnv ?? process.env) };
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
  runtimeEnv?: NodeJS.ProcessEnv,
  bundleBin?: string,
): Promise<CommandResult> {
  const started = Date.now();
  const command = commandWithAbsoluteBundle(
    shellCommand,
    bundleBin ?? (typeof runtimeEnv?.MR_NEXUS_BUNDLE_BIN === "string" ? runtimeEnv.MR_NEXUS_BUNDLE_BIN : undefined),
  );
  return await new Promise((resolve) => {
    // shell:false so the child is /bin/sh -c with the install's env.
    // shell:true looks up `bundle` on a PATH that does not include ~/.mr-nexus.
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      shell: false,
      env: specEnv(runtimeEnv),
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

function resultsMarkdown(
  checkout: CheckoutResult,
  results: CommandResult[],
  linesPct: number | undefined,
  planned: { label: string; command: string }[],
  runtimeNote: string | undefined,
  installLog?: string,
): string {
  if (!checkout.ok) {
    const lines = [
      "## Mr. Nexus — impacted tests",
      "",
      `**Checkout:** skipped — ${checkout.reason}`,
      "**Result:** not run. This is not a test failure.",
      "**Line coverage:** unavailable",
      "",
    ];
    for (const item of planned) {
      lines.push(`- not run \`${item.label}\``);
      lines.push(`  \`${item.command}\``);
    }
    return lines.join("\n");
  }
  if (installLog !== undefined) {
    const lines = [
      "## Mr. Nexus — impacted tests",
      "",
      `**Checkout:** \`${checkout.headSha}\` (shallow)`,
      ...(runtimeNote ? [`**Runtime:** ${runtimeNote}`] : []),
      "**Result:** not run. Bootstrap failed, so RSpec was not started.",
      "**Line coverage:** unavailable",
      "",
      "Install log:",
      "```",
      installLog.trim().slice(-2000) || "(no installer output)",
      "```",
      "",
    ];
    for (const item of planned) {
      lines.push(`- not run \`${item.label}\``);
      lines.push(`  \`${item.command}\``);
    }
    return lines.join("\n");
  }
  const passed = results.filter((item) => item.passed).length;
  const lines = [
    "## Mr. Nexus — impacted tests",
    "",
    `**Checkout:** \`${checkout.headSha}\` (shallow)`,
    ...(runtimeNote ? [`**Runtime:** ${runtimeNote}`] : []),
    `**Result:** ${passed}/${results.length} passed`,
    `**Line coverage:** ${linesPct === undefined ? "unavailable" : `${linesPct}%`}`,
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

async function bootstrapRuby(
  checkoutDir: string,
  commands: readonly string[],
  onProgress?: (update: { step: string; logTail: string }) => Promise<void> | void,
): Promise<{
  failed?: Extract<RubyBootstrap, { ok: false }>;
  note?: string;
  env?: NodeJS.ProcessEnv;
  bundleBin?: string;
}> {
  const runtime = await ensureImpactedRuby({ checkoutDir, commands, onProgress });
  if (!runtime.ok) return { failed: runtime };
  if (runtime.skipped) return {};
  return { note: runtime.note, env: runtime.env, bundleBin: runtime.bundleBin };
}

export default defineTool({
  description:
    "Shallow-clone the PR head, install Ruby and Bundler when an RSpec or Rails command needs them, run bundle install, then run the impacted test commands in that checkout. Posts pass/fail plus any line coverage printed by the runner. Does not require package.json. A skipped checkout is not a test failure. Posts a PR comment only; pr-write cannot create check runs.",
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
    let runtimeNote: string | undefined;
    let installLog: string | undefined;
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
    } else if (commands.some((item) => commandNeedsRuby(item.command))) {
      await stagePrComment({
        ctx,
        ref,
        kind: "impacted-tests",
        markdown: [
          "## Mr. Nexus — impacted tests",
          "",
          `**Checkout:** \`${checkout.headSha}\` (shallow)`,
          "**Runtime:** installing Ruby and Bundler",
          "**Result:** not finished",
          "",
        ].join("\n"),
      });
    }
    if (checkout.ok) {
      const runtime = await bootstrapRuby(
        checkout.checkoutDir,
        commands.map((item) => item.command),
        async ({ step, logTail }) => {
          await stagePrComment({
            ctx,
            ref,
            kind: "impacted-tests",
            markdown: [
              "## Mr. Nexus — impacted tests",
              "",
              `**Checkout:** \`${checkout.headSha}\` (shallow)`,
              `**Runtime:** ${step}`,
              "**Result:** not finished. Installer output so far:",
              "",
              "```",
              logTail.trim().slice(-2000) || "(no output yet)",
              "```",
            ].join("\n"),
          });
        },
      );
      if (runtime.failed) {
        runtimeNote = `bootstrap failed — ${runtime.failed.note}`;
        installLog = runtime.failed.logTail;
      } else {
        runtimeNote = runtime.note;
        for (const item of commands) {
          const result = await runCommand(
            checkout.checkoutDir,
            item.label,
            item.command,
            timeout,
            runtime.env,
            runtime.bundleBin,
          );
          fullLogs.push(result.logTail);
          results.push(result);
        }
      }
    }

    const linesPct = extractLinesPct(fullLogs);
    const bootstrapFailed = installLog !== undefined;
    const executed = checkout.ok && !bootstrapFailed;
    const passed = executed ? results.every((item) => item.passed) : null;
    const markdown = resultsMarkdown(checkout, results, linesPct, commands, runtimeNote, installLog);
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
          title: !executed ? "Impacted tests not run" : passed ? "Impacted tests passed" : "Impacted tests failed",
          summary: markdown,
          conclusion: !executed ? "skipped" : passed ? "success" : "failure",
        })
      : { checkUrl: undefined, skipped: "no head SHA; PR comment is the result" };

    return {
      posted: true,
      pr: `${ref.owner}/${ref.repo}#${ref.number}`,
      url: comment.url,
      checkUrl: check.checkUrl ?? null,
      checkSkipped: check.skipped ?? null,
      executed,
      outcome: !checkout.ok ? "skipped" : bootstrapFailed ? "bootstrap-failed" : passed ? "passed" : "failed",
      passed,
      checkout: checkout.ok ? "ready" : "skipped",
      checkoutReason: checkout.ok ? null : checkout.reason,
      checkoutHeadSha: checkout.ok ? checkout.headSha : null,
      linesPct: linesPct ?? null,
      results: executed
        ? results.map(({ label, command: cmd, exitCode, passed: commandPassed, durationMs }) => ({
            label,
            command: cmd,
            exitCode,
            passed: commandPassed,
            durationMs,
          }))
        : commands.map((item) => ({
            label: item.label,
            command: item.command,
            exitCode: null,
            passed: null,
            durationMs: 0,
          })),
    };
  },
});
