import {
  defaultGitHubPullRequestDispatch,
  githubChannel,
} from "@grok/agent-sdk/channels/github";

const MAX_DIFF_CHARS = 150_000;
const MAX_BODY_CHARS = 20_000;

export default githubChannel({
  botName: "mr-nexus",
  // Repos come from serve/deploy `--repo` (Cursor account relay, one owner, max 20).
  // Broaden later with a GitHub App webhook when noise is acceptable.
  cursorAccount: true,
  checks: true,
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
        "Post a test plan, run impacted tests, summarize coverage, then E2E when a base URL exists.",
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
