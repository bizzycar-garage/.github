import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { loadPrWorkspace, prUrlSchemaDescription, requirePrRef } from "../lib/pr.js";

export default defineTool({
  description:
    "Fetch a GitHub pull request via the Cursor GitHub proxy and seed pr/meta.md, pr/head.sha, and pr/diff.patch. Use on HTTP/playground turns that include a PR URL before drafting the test plan.",
  effect: "idempotent",
  inputSchema: z.object({
    prUrl: z.string().min(1).max(500).describe(prUrlSchemaDescription),
  }),
  dryRunResult: ({ prUrl }) => ({ loaded: false, reason: "dry-run", prUrl }),
  async execute({ prUrl }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { loaded: false, reason: "eval", prUrl };
    }
    const ref = requirePrRef(ctx, prUrl);
    const loaded = await loadPrWorkspace({ ctx, ref });
    return {
      loaded: true,
      pr: `${ref.owner}/${ref.repo}#${ref.number}`,
      title: loaded.title,
      url: loaded.htmlUrl,
      headSha: loaded.headSha,
      headRef: loaded.headRef,
      baseRef: loaded.baseRef,
      labels: loaded.labels,
      metaChars: loaded.metaChars,
      diffChars: loaded.diffChars,
    };
  },
});
