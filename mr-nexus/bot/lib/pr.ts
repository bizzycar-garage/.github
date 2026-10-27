import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
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

/** Plain token kept when a proxy drops HTML comments from the stored body. */
export function sectionToken(kind: string): string {
  return `mr-nexus-section:${kind}`;
}

const COMMENT_KINDS = ["test-plan", "impacted-tests", "coverage", "e2e"] as const;

type CommentHost = {
  session: { id: string };
  host: {
    kv: ToolContext["host"]["kv"];
    github: ToolContext["host"]["github"];
  };
};

type StagedComment = {
  owner: string;
  repo: string;
  number: number;
  kind: string;
  markdown: string;
  attempts: number;
};

function pendingKey(sessionId: string, kind: string): string {
  return `pr-comment-pending:${sessionId}:${kind}`;
}

function isStaged(value: unknown): value is StagedComment {
  if (typeof value !== "object" || value === null) return false;
  const item = value as StagedComment;
  return (
    typeof item.owner === "string" &&
    typeof item.repo === "string" &&
    typeof item.number === "number" &&
    typeof item.kind === "string" &&
    typeof item.markdown === "string" &&
    typeof item.attempts === "number"
  );
}

function sanitizeComment(body: string): string {
  return body.replaceAll("\u0000", "").slice(0, 60_000);
}

export function commentBody(kind: string, markdown: string): string {
  const marker = sectionMarker(kind);
  const token = sectionToken(kind);
  const body = `${markdown.trim()}\n\n${token}\n\n${marker}`;
  return formatGitHubOutboundComment(sanitizeComment(body));
}

function bodyHasMarker(body: string | null | undefined, kind: string): boolean {
  if (body === null || body === undefined) return false;
  return body.includes(sectionMarker(kind)) || body.includes(sectionToken(kind));
}

/**
 * Remember the comment a finished turn must publish.
 * GitHub writes happen at the end of a long tool. A wake that ends first
 * leaves this record for the turn.completed / turn.failed hook.
 */
export async function stagePrComment(input: {
  ctx: CommentHost;
  ref: PrRef;
  kind: string;
  markdown: string;
}): Promise<void> {
  const { ctx, ref, kind, markdown } = input;
  const current = await ctx.host.kv.get(pendingKey(ctx.session.id, kind));
  const attempts = isStaged(current) ? current.attempts : 0;
  const staged: StagedComment = {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    kind,
    markdown,
    attempts,
  };
  await ctx.host.kv.put(pendingKey(ctx.session.id, kind), staged);
}

async function clearStaged(ctx: CommentHost, kind: string): Promise<void> {
  await ctx.host.kv.delete(pendingKey(ctx.session.id, kind));
}

async function writePrComment(input: {
  ctx: CommentHost;
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

  const updated = async (commentId: number) => {
    const response = await octokit.rest.issues.updateComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: commentId,
      body,
    });
    await ctx.host.kv.put(kvKey, { commentId: response.data.id });
    return {
      posted: true as const,
      commentId: response.data.id,
      url: response.data.html_url,
      updated: true,
    };
  };

  if (storedId !== undefined) {
    try {
      return await updated(storedId);
    } catch {
      // Stored id is stale, or this token cannot edit it. Search, then create.
    }
  }

  try {
    const existing = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      per_page: 100,
    });
    const match = existing.find((item) => bodyHasMarker(item.body, kind));
    if (match !== undefined) {
      try {
        return await updated(match.id);
      } catch {
        // Fall through and create when the matched comment cannot be edited.
      }
    }
  } catch {
    // Listing failed. A new comment is still better than leaving the marker stale.
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

export async function upsertPrComment(input: {
  ctx: ToolContext;
  ref: PrRef;
  kind: string;
  markdown: string;
}): Promise<{ posted: true; commentId: number; url: string; updated: boolean }> {
  await stagePrComment(input);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await writePrComment(input);
      await clearStaged(input.ctx, input.kind);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Publish comments a tool staged but did not finish posting. */
export async function flushStagedPrComments(ctx: CommentHost): Promise<void> {
  for (const kind of COMMENT_KINDS) {
    const key = pendingKey(ctx.session.id, kind);
    const staged = await ctx.host.kv.get(key);
    if (!isStaged(staged) || staged.kind !== kind) continue;
    if (staged.attempts >= 2) {
      await ctx.host.kv.delete(key);
      continue;
    }
    await ctx.host.kv.put(key, { ...staged, attempts: staged.attempts + 1 });
    try {
      await writePrComment({
        ctx,
        ref: { owner: staged.owner, repo: staged.repo, number: staged.number },
        kind: staged.kind,
        markdown: staged.markdown,
      });
      await ctx.host.kv.delete(key);
    } catch {
      // Leave the record. A later finished turn tries once more.
    }
  }
}

/**
 * Comments are the result. `permissions: "pr-write"` does not include
 * `checks:write` (`checks: true` would upgrade the lease to contents:write).
 * Calling the Checks API returns 403 and that line was read as a test failure.
 * This does not call GitHub.
 */
export async function tryCreateCheck(_input: {
  github: ToolContext["host"]["github"];
  owner: string;
  repo: string;
  name: string;
  sha: string;
  title: string;
  summary: string;
  conclusion: "success" | "failure" | "neutral" | "skipped";
}): Promise<{ checkUrl?: string; skipped?: string }> {
  return {
    skipped: "not posted; pr-write has no checks:write. The PR comment is the result.",
  };
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

export { resolveE2eBaseUrl } from "./e2e-url.js";
