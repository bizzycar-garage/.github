import {
  defaultGitHubPullRequestDispatch,
  githubChannel,
} from "@grok/agent-sdk/channels/github";

const MAX_DIFF_CHARS = 150_000;
const MAX_BODY_CHARS = 20_000;

/** Wake repos for Cursor-account relay (one owner, ≤20). Keep in sync with deploy `--cursor-events-repo`. */
const WAKE_REPOS = [
  "bizzycar-garage/hive-api",
  "bizzycar-garage/hive-web",
  "bizzycar-garage/hive-recall",
] as const;

export default githubChannel({
  botName: "mr-nexus",
  // `pr-write` covers PR comments. Do not set `checks: true` — that opts the
  // hosted lease up to contents:write and logs the push-capable token warning.
  cursorAccount: {
    repos: [...WAKE_REPOS],
    permissions: "pr-write",
  },
  deliverReplies: false,
  onComment: () => null,
  onPullRequest: (ctx, pr) => {
    if (pr.draft) {
      return null;
    }
    const dispatch = defaultGitHubPullRequestDispatch(ctx, pr);
    if (dispatch === null) {
      return null;
    }
    return {
      auth: dispatch.auth,
      context: [
        "Read pr/meta.md and pr/diff.patch.",
        "Call post_test_plan once with the plan. Skip impacted tests / coverage / E2E unless a checkout exists; prefer posting the plan.",
      ],
      async workspaceFiles() {
        const octokit = await ctx.github.getOctokit();
        const pull = {
          owner: ctx.repository.owner,
          repo: ctx.repository.name,
          pull_number: pr.number,
        };
        const [meta, diff] = await Promise.all([
          octokit.rest.pulls.get(pull),
          octokit.rest.pulls.get({ ...pull, mediaType: { format: "diff" } }),
        ]);
        const diffText = typeof diff.data === "string" ? diff.data : "";
        const body = meta.data.body ?? "";
        const labels = (meta.data.labels ?? [])
          .map((label) => (typeof label === "string" ? label : label.name))
          .filter((name): name is string => typeof name === "string" && name.length > 0);
        const metaMd = [
          `# ${meta.data.title}`,
          "",
          `PR: ${meta.data.html_url}`,
          `Head: ${meta.data.head.ref} (${meta.data.head.sha})`,
          `Base: ${meta.data.base.ref}`,
          `Author: ${meta.data.user?.login ?? "unknown"}`,
          `Labels: ${labels.join(", ") || "(none)"}`,
          "",
          "## Body",
          body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…[truncated]\n` : body || "(empty)",
        ].join("\n");
        return {
          "pr/meta.md": metaMd,
          "pr/head.sha": meta.data.head.sha,
          "pr/diff.patch":
            diffText.length > MAX_DIFF_CHARS
              ? `${diffText.slice(0, MAX_DIFF_CHARS)}\n…[truncated]\n`
              : diffText,
        };
      },
    };
  },
});
