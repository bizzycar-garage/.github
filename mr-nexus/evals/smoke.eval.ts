import { defineEval, includes } from "@grok/agent-sdk/evals";

const OPENED = [
  "GitHub pull request trigger: acme/shop#42",
  "Action: opened",
  "PR: https://github.com/acme/shop/pull/42",
  "Title: Add checkout discount banner",
  "Head: feat/discount (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)",
  "Base: main",
  "Author: sam",
  "",
  "Read pr/meta.md and pr/diff.patch.",
  "Call post_test_plan once with the plan. Skip impacted tests / coverage / E2E unless a checkout exists; prefer posting the plan.",
].join("\n");

const BACKFILL = [
  "Backfill QA for open PR https://github.com/acme/shop/pull/42.",
  "Read that PR (title, body, labels, head SHA, diff).",
  "Draft a structured test plan (Scope, Risk areas, Manual checks, Automated focus, E2E candidates).",
  "Call post_test_plan once with that plan. Skip impacted tests / coverage / E2E unless you have a checkout; prefer posting the plan.",
].join("\n");

const META = [
  "# Add checkout discount banner",
  "",
  "PR: https://github.com/acme/shop/pull/42",
  "Head: feat/discount (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)",
  "Base: main",
  "Author: sam",
  "Labels: (none)",
  "",
  "## Body",
  "Shows a discount banner on checkout.",
].join("\n");

const DIFF = [
  "diff --git a/src/checkout/Banner.tsx b/src/checkout/Banner.tsx",
  "--- a/src/checkout/Banner.tsx",
  "+++ b/src/checkout/Banner.tsx",
  "+export function Banner() { return <div>Save 10%</div>; }",
  "diff --git a/src/checkout/Banner.test.tsx b/src/checkout/Banner.test.tsx",
  "--- /dev/null",
  "+++ b/src/checkout/Banner.test.tsx",
  "+test('renders', () => {});",
].join("\n");

export default defineEval({
  tags: ["smoke"],
  cases: [
    {
      id: "test-plan",
      description: "Posts a structured QA test plan for a checkout UI PR.",
      async test(t) {
        await t.send(OPENED, {
          workspaceFiles: {
            "pr/meta.md": META,
            "pr/head.sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "pr/diff.patch": DIFF,
          },
        });
        t.succeeded();
        t.calledTool("post_test_plan");
        t.check(t.reply, includes(/test plan|checkout|banner|impacted|coverage|e2e/i));
      },
    },
    {
      id: "backfill-plan",
      description: "HTTP backfill message posts a plan (workspace already seeded as load_pr would).",
      async test(t) {
        await t.send(BACKFILL, {
          workspaceFiles: {
            "pr/meta.md": META,
            "pr/head.sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "pr/diff.patch": DIFF,
          },
        });
        t.succeeded();
        t.calledTool("post_test_plan");
      },
    },
  ],
});
