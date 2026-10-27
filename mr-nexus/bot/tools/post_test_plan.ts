import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { requirePrRef, upsertPrComment } from "../lib/pr.js";

export default defineTool({
  description:
    "Post or update the QA test plan as a pull request comment. Call once per turn after drafting the plan.",
  effect: "idempotent",
  inputSchema: z.object({
    markdown: z
      .string()
      .min(1)
      .max(60_000)
      .describe("Full test plan markdown for the PR comment."),
  }),
  dryRunResult: () => ({ posted: false, reason: "dry-run" }),
  async execute({ markdown }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { posted: false, reason: "eval", chars: markdown.length };
    }
    const ref = requirePrRef(ctx);
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
