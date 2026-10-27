import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { prUrlSchemaDescription, requirePrRef, upsertPrComment } from "../lib/pr.js";

export default defineTool({
  description:
    "Post or update the QA test plan as a pull request comment via the Cursor GitHub proxy. Call once per turn after drafting the plan. Pass prUrl on HTTP/playground sessions.",
  effect: "idempotent",
  inputSchema: z.object({
    markdown: z
      .string()
      .min(1)
      .max(60_000)
      .describe("Full test plan markdown for the PR comment."),
    prUrl: z.string().min(1).max(500).optional().describe(prUrlSchemaDescription),
  }),
  dryRunResult: () => ({ posted: false, reason: "dry-run" }),
  async execute({ markdown, prUrl }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { posted: false, reason: "eval", chars: markdown.length };
    }
    const ref = requirePrRef(ctx, prUrl);
    const result = await upsertPrComment({
      ctx,
      ref,
      kind: "test-plan",
      markdown: `## Mr. Nexus — test plan\n\n${markdown.trim()}`,
    });
    return {
      posted: result.posted,
      updated: result.updated,
      pr: `${ref.owner}/${ref.repo}#${ref.number}`,
      url: result.url,
      commentId: result.commentId,
    };
  },
});
