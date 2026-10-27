import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  formatGitHubOutboundComment,
  parseGitHubPrContinuationKey,
  type GitHubPullRequestRef,
} from "@grok/agent-sdk/channels/github";
import type { ToolContext } from "@grok/agent-sdk/tools";

export const SHA = /^[0-9a-f]{40}$/i;

export type PrRef = GitHubPullRequestRef;

export function requirePrRef(ctx: ToolContext): PrRef {
  const ref = parseGitHubPrContinuationKey(ctx.session.continuationKey ?? "");
  if (ref === undefined) {
    throw new Error("This tool requires a GitHub pull request session");
  }
  return ref;
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
