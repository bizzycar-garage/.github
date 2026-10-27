import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import {
  prUrlSchemaDescription,
  readHeadSha,
  requirePrRef,
  tryCreateCheck,
  upsertPrComment,
} from "../lib/pr.js";

export default defineTool({
  description:
    "Post a coverage summary comment for the impacted test run. Does not post a check run (pr-write has no checks:write). Unavailable coverage is not a test failure.",
  effect: "idempotent",
  inputSchema: z.object({
    status: z.enum(["reported", "unavailable"]),
    linesPct: z.number().min(0).max(100).optional(),
    baseLinesPct: z.number().min(0).max(100).optional(),
    notes: z.string().max(2000).optional(),
    prUrl: z.string().min(1).max(500).optional().describe(prUrlSchemaDescription),
  }),
  dryRunResult: ({ status }) => ({ posted: false, reason: "dry-run", status }),
  async execute({ status, linesPct, baseLinesPct, notes, prUrl }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { posted: false, reason: "eval", status };
    }

    const ref = requirePrRef(ctx, prUrl);
    const headSha = await readHeadSha(ctx.workspaceDir);
    const delta =
      linesPct !== undefined && baseLinesPct !== undefined
        ? Number((linesPct - baseLinesPct).toFixed(2))
        : undefined;

    const lines = ["## Mr. Nexus — coverage", ""];
    if (status === "unavailable") {
      lines.push("Coverage output was unavailable for this run.");
    } else {
      lines.push(
        `| Metric | Value |`,
        `| --- | --- |`,
        `| Lines % | ${linesPct ?? "n/a"} |`,
        `| Base lines % | ${baseLinesPct ?? "n/a"} |`,
        `| Delta | ${delta === undefined ? "n/a" : `${delta > 0 ? "+" : ""}${delta}`} |`,
      );
    }
    if (notes?.trim()) {
      lines.push("", notes.trim());
    }
    const markdown = lines.join("\n");

    const comment = await upsertPrComment({
      ctx,
      ref,
      kind: "coverage",
      markdown,
    });

    const check = await tryCreateCheck({
      github: ctx.host.github,
      owner: ref.owner,
      repo: ref.repo,
      name: "Mr. Nexus / coverage",
      sha: headSha,
      title: status === "unavailable" ? "Coverage unavailable" : "Coverage summary",
      summary: markdown,
      conclusion: status === "unavailable" ? "neutral" : "success",
    });

    if (linesPct !== undefined) {
      await ctx.host.kv.put(`coverage-baseline:${ref.owner}/${ref.repo}`, {
        linesPct,
        updatedAt: new Date().toISOString(),
        pr: ref.number,
      });
    }

    return {
      posted: true,
      pr: `${ref.owner}/${ref.repo}#${ref.number}`,
      url: comment.url,
      checkUrl: check.checkUrl ?? null,
      checkSkipped: check.skipped ?? null,
      status,
      linesPct: linesPct ?? null,
      delta: delta ?? null,
    };
  },
});
