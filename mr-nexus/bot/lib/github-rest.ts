/**
 * Issue comments on api.github.com with a pr-write lease.
 *
 * A continuation turn's proxied Octokit call can resolve with the comment
 * already on the pull request and leave that body unchanged. Callers keep
 * the staged comment unless a direct read shows the revision they just sent.
 */

const GITHUB_API = "https://api.github.com";
const NAME = /^[A-Za-z0-9_.-]+$/;
const REV = /^[0-9a-f]{8,64}$/;

export const STALE_COMMENT = "GitHub kept the previous mr-nexus comment body";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let testTransport: { token: string; fetch: FetchLike } | undefined;

/** Unit tests inject a lease and a fetch. Production mints the lease. */
export function setGithubCommentTransportForTests(next?: { token: string; fetch: FetchLike }): void {
  testTransport = next;
}

export function isGithubUnreachable(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("github-unreachable:");
}

export function isStaleComment(error: unknown): boolean {
  return error instanceof Error && error.message === STALE_COMMENT;
}

export function commentRevisionLine(rev: string): string {
  return REV.test(rev) ? `mr-nexus-rev:${rev}` : "";
}

export async function tryPrWriteToken(repo: string): Promise<string | undefined> {
  if (testTransport !== undefined) {
    return testTransport.token;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return undefined;
  }
  const apiKey = cursorApiKey();
  const base = cursorApiBase();
  if (apiKey === undefined || base === undefined) {
    return undefined;
  }
  try {
    const response = await fetch(`${base}/v0/scm-events/github-token`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ repos: [repo], permissions: "pr-write" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return undefined;
    }
    const json: unknown = await response.json();
    if (!isRecord(json) || typeof json.token !== "string") {
      return undefined;
    }
    const token = json.token.trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

export type LiveComment = {
  id: number;
  htmlUrl: string;
  updated: boolean;
};

export async function upsertLiveIssueComment(input: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  body: string;
  rev: string;
  commentId?: number;
  matches: (body: string | null | undefined) => boolean;
}): Promise<LiveComment> {
  const { token, owner, repo, number, body, rev } = input;
  assertName(owner, repo);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("refused GitHub comment for an unexpected pull request number");
  }
  let commentId = input.commentId;
  let updated = commentId !== undefined;
  if (commentId !== undefined) {
    const patched = await patchComment(token, owner, repo, commentId, body);
    if (patched === undefined) {
      commentId = undefined;
      updated = false;
    }
  }
  if (commentId === undefined) {
    const existing = await listComments(token, owner, repo, number);
    const match = existing.find((item) => input.matches(item.body));
    if (match !== undefined) {
      const patched = await patchComment(token, owner, repo, match.id, body);
      if (patched === undefined) {
        throw new Error("GitHub comment HTTP 404");
      }
      commentId = match.id;
      updated = true;
    } else {
      commentId = (await createComment(token, owner, repo, number, body)).id;
      updated = false;
    }
  }
  const live = await readLiveIssueComment({ token, owner, repo, number, commentId });
  if (live.status === "unreachable" || live.status === "forbidden") {
    throw new Error("github-unreachable: could not read the comment back");
  }
  if (live.status !== "ok" || !live.body.includes(`mr-nexus-rev:${rev}`)) {
    throw new Error(STALE_COMMENT);
  }
  return { id: commentId, htmlUrl: live.htmlUrl, updated };
}

export async function readLiveIssueComment(input: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  commentId: number;
}): Promise<
  | { status: "ok"; body: string; htmlUrl: string }
  | { status: "unreachable" }
  | { status: "forbidden" }
  | { status: "missing" }
> {
  try {
    const response = await github(
      input.token,
      "GET",
      `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}`,
    );
    if (response.status === 401 || response.status === 403) {
      return { status: "forbidden" };
    }
    if (response.status === 404) {
      return { status: "missing" };
    }
    if (response.status !== 200 || !isRecord(response.json)) {
      throw new Error(`GitHub comment HTTP ${response.status}`);
    }
    const body = typeof response.json.body === "string" ? response.json.body : "";
    return {
      status: "ok",
      body,
      htmlUrl: commentHtmlUrl(input.owner, input.repo, input.number, input.commentId, response.json.html_url),
    };
  } catch (error) {
    if (isGithubUnreachable(error)) {
      return { status: "unreachable" };
    }
    throw error;
  }
}

async function patchComment(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<{ id: number } | undefined> {
  const response = await github(token, "PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
  if (response.status === 404) {
    return undefined;
  }
  if (response.status !== 200) {
    throw new Error(`GitHub comment HTTP ${response.status}`);
  }
  const id = numericId(isRecord(response.json) ? response.json.id : undefined);
  if (id === undefined) {
    throw new Error("GitHub comment HTTP 200");
  }
  return { id };
}

async function createComment(
  token: string,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<{ id: number }> {
  const response = await github(token, "POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`GitHub comment HTTP ${response.status}`);
  }
  const id = numericId(isRecord(response.json) ? response.json.id : undefined);
  if (id === undefined) {
    throw new Error(`GitHub comment HTTP ${response.status}`);
  }
  return { id };
}

async function listComments(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<Array<{ id: number; body: string | null }>> {
  const found: Array<{ id: number; body: string | null }> = [];
  for (let page = 1; page <= 5; page += 1) {
    const response = await github(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
    );
    if (response.status !== 200 || !Array.isArray(response.json)) {
      throw new Error(`GitHub comment HTTP ${response.status}`);
    }
    if (response.json.length === 0) {
      break;
    }
    for (const item of response.json) {
      if (!isRecord(item)) continue;
      const id = numericId(item.id);
      if (id === undefined) continue;
      found.push({ id, body: typeof item.body === "string" ? item.body : null });
    }
    if (response.json.length < 100) {
      break;
    }
  }
  return found;
}

async function github(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const url = `${GITHUB_API}${path}`;
  if (!url.startsWith(`${GITHUB_API}/`)) {
    throw new Error("refused GitHub comment URL");
  }
  let response: Response;
  try {
    const fetchImpl = testTransport?.fetch ?? fetch;
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "mr-nexus",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`github-unreachable: ${scrub(message, [token])}`);
  }
  const text = await response.text();
  let json: unknown = {};
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = {};
    }
  }
  return { status: response.status, json };
}

function commentHtmlUrl(owner: string, repo: string, number: number, commentId: number, fromApi: unknown): string {
  const prefix = `https://github.com/${owner}/${repo}/`;
  if (typeof fromApi === "string" && fromApi.startsWith(prefix)) {
    return fromApi;
  }
  return `https://github.com/${owner}/${repo}/pull/${number}#issuecomment-${commentId}`;
}

function assertName(owner: string, repo: string): void {
  if (!NAME.test(owner) || !NAME.test(repo)) {
    throw new Error("refused GitHub comment for an unexpected repository name");
  }
}

function numericId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cursorApiKey(): string | undefined {
  for (const name of ["CURSOR_API_KEY", "CURSOR_SERVICE_ACCOUNT_KEY"] as const) {
    const value = process.env[name]?.trim() ?? "";
    if (value !== "") {
      return value;
    }
  }
  return undefined;
}

function cursorApiBase(): string | undefined {
  const raw = (process.env.CURSOR_API_BASE_URL ?? "https://api.cursor.com").trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/ghs_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
}
