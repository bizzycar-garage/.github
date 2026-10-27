import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createGitHubCheck,
  formatGitHubOutboundComment,
  parseGitHubPrContinuationKey,
  parseGitHubPrRef,
  type GitHubPullRequestRef,
} from "@grok/agent-sdk/channels/github";
import type { ToolContext } from "@grok/agent-sdk/tools";

export const SHA = /^[0-9a-f]{40}$/i;

export type PrRef = GitHubPullRequestRef;

const MAX_DIFF_CHARS = 150_000;
const MAX_BODY_CHARS = 20_000;

/** Optional PR URL / `owner/repo#N` for HTTP / playground sessions without a GitHub continuation key. */
export const prUrlSchemaDescription =
  "GitHub PR URL or owner/repo#N. Required for HTTP/playground sessions; omit when the session already is a GitHub PR turn.";

export function requirePrRef(ctx: ToolContext, prUrl?: string): PrRef {
  const fromSession = parseGitHubPrContinuationKey(ctx.session.continuationKey ?? "");
  if (fromSession !== undefined) {
    return fromSession;
  }
  const trimmed = prUrl?.trim() ?? "";
  if (trimmed !== "") {
    const fromUrl = parseGitHubPrRef(trimmed);
    if (fromUrl !== undefined) {
      return {
        owner: fromUrl.owner,
        repo: fromUrl.repo,
        number: fromUrl.number,
      };
    }
    throw new Error(`Invalid prUrl "${trimmed}"; expected https://github.com/owner/repo/pull/N or owner/repo#N`);
  }
  throw new Error(
    "This tool needs a GitHub pull request session or a prUrl (https://github.com/owner/repo/pull/N).",
  );
}

export async function readHeadSha(workspaceDir: string): Promise<string> {
  const headSha = (await readFile(join(workspaceDir, "pr/head.sha"), "utf8")).trim();
  if (!SHA.test(headSha)) {
    throw new Error("missing or invalid pr/head.sha");
  }
  return headSha;
}

export async function readOptionalText(
  workspaceDir: string,
  relativePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(join(workspaceDir, relativePath), "utf8");
  } catch {
    return undefined;
  }
}

/** Hidden section marker so the tool can update the same PR comment. */
export function sectionMarker(kind: string): string {
  return `<!-- mr-nexus:${kind} -->`;
}

export function commentBody(kind: string, markdown: string): string {
  const marker = sectionMarker(kind);
  const body = `${markdown.trim()}\n\n${marker}`;
  return formatGitHubOutboundComment(body);
}

export async function upsertPrComment(input: {
  ctx: ToolContext;
  ref: PrRef;
  kind: string;
  markdown: string;
}): Promise<{ posted: true; commentId: number; url: string; updated: boolean }> {
  const { ctx, ref, kind, markdown } = input;
  const octokit = await ctx.host.github.getOctokit();
  const kvKey = `pr-comment:${ref.owner}/${ref.repo}#${ref.number}:${kind}`;
  const body = commentBody(kind, markdown);
  const stored = await ctx.host.kv.get(kvKey);
  const storedId =
    typeof stored === "object" &&
    stored !== null &&
    "commentId" in stored &&
    typeof (stored as { commentId: unknown }).commentId === "number"
      ? (stored as { commentId: number }).commentId
      : undefined;

  if (storedId !== undefined) {
    try {
      const response = await octokit.rest.issues.updateComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: storedId,
        body,
      });
      return {
        posted: true,
        commentId: response.data.id,
        url: response.data.html_url,
        updated: true,
      };
    } catch {
      // Fall through and create a new comment when the stored id is gone.
    }
  }

  const marker = sectionMarker(kind);
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.number,
    per_page: 100,
  });
  const match = existing.find((item) => item.body?.includes(marker));
  if (match !== undefined) {
    const response = await octokit.rest.issues.updateComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: match.id,
      body,
    });
    await ctx.host.kv.put(kvKey, { commentId: response.data.id });
    return {
      posted: true,
      commentId: response.data.id,
      url: response.data.html_url,
      updated: true,
    };
  }

  const response = await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.number,
    body,
  });
  await ctx.host.kv.put(kvKey, { commentId: response.data.id });
  return {
    posted: true,
    commentId: response.data.id,
    url: response.data.html_url,
    updated: false,
  };
}

/**
 * Best-effort Checks API write. With `permissions: "pr-write"` (no `checks: true`)
 * merge-box checks are unavailable; comment posting must still succeed.
 */
export async function tryCreateCheck(input: {
  github: ToolContext["host"]["github"];
  owner: string;
  repo: string;
  name: string;
  sha: string;
  title: string;
  summary: string;
  conclusion: "success" | "failure" | "neutral" | "skipped";
}): Promise<{ checkUrl?: string; skipped?: string }> {
  try {
    const check = await createGitHubCheck({
      github: input.github,
      owner: input.owner,
      repo: input.repo,
      name: input.name,
      sha: input.sha,
      output: { title: input.title, summary: input.summary },
    });
    await check.conclude({
      conclusion: input.conclusion,
      output: { title: input.title, summary: input.summary },
    });
    return { checkUrl: check.url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { skipped: message.slice(0, 300) };
  }
}

/** Fetch PR meta + diff through the Cursor GitHub proxy and seed the workspace. */
export async function loadPrWorkspace(input: {
  ctx: ToolContext;
  ref: PrRef;
}): Promise<{
  title: string;
  htmlUrl: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  labels: string[];
  metaChars: number;
  diffChars: number;
}> {
  const { ctx, ref } = input;
  const octokit = await ctx.host.github.getOctokit();
  const pull = {
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
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
  const diffOut =
    diffText.length > MAX_DIFF_CHARS
      ? `${diffText.slice(0, MAX_DIFF_CHARS)}\n…[truncated]\n`
      : diffText;

  const files: Record<string, string> = {
    "pr/meta.md": metaMd,
    "pr/head.sha": meta.data.head.sha,
    "pr/diff.patch": diffOut,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(ctx.workspaceDir, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }

  return {
    title: meta.data.title,
    htmlUrl: meta.data.html_url,
    headSha: meta.data.head.sha,
    headRef: meta.data.head.ref,
    baseRef: meta.data.base.ref,
    labels,
    metaChars: metaMd.length,
    diffChars: diffOut.length,
  };
}

const E2E_URL_RE = /https?:\/\/[^\s)>"']+/gi;
const E2E_LABEL_RE = /e2e[_-]?url\s*[:=]\s*(https?:\/\/\S+)/i;

export function resolveE2eBaseUrl(meta: string | undefined, envUrl: string | undefined): string | undefined {
  if (envUrl && /^https?:\/\//i.test(envUrl.trim())) {
    return envUrl.trim().replace(/\/$/, "");
  }
  if (!meta) {
    return undefined;
  }
  const labeled = meta.match(E2E_LABEL_RE);
  if (labeled?.[1]) {
    return labeled[1].replace(/[.,;]+$/, "").replace(/\/$/, "");
  }
  const urls = meta.match(E2E_URL_RE) ?? [];
  const candidate = urls.find((url) => !/github\.com\//i.test(url));
  return candidate?.replace(/[.,;]+$/, "").replace(/\/$/, "");
}
