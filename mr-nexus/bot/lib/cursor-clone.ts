import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { cloneAuthFromEnv, tryCreateShallowPrCheckout } from "@grok/agent-sdk/scm";
import { SHA } from "./pr.js";

/**
 * Hosted cursorAccount keeps the GitHub installation token off the guest
 * (`GH_TOKEN` stays empty; REST goes through the GitHub proxy). Shallow
 * clone still needs a credential at tool time:
 *
 * 1. `HIVE_GIT_READ_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` when one is set.
 * 2. Cursor git proxy (`POST /v0/scm-events/github-clone-target`) using the
 *    Cursor API key as bearer. The key never goes to github.com.
 * 3. pr-write lease (`POST /v0/scm-events/github-token`) passed only into
 *    `tryCreateShallowPrCheckout` auth. Not exported onto the test child.
 *
 * Neither token is written to argv, `.git/config`, or the PR comment.
 */

const SECRET_HINT =
  "Not a test failure. If this persists, set deployment secret HIVE_GIT_READ_TOKEN to a fine-grained GitHub PAT with Contents: Read only on bizzycar-garage/hive-api, hive-web, and hive-recall (no Contents: Write). Command: npx --yes \"@grok/agent-sdk@0.3.0\" secret set mr-nexus HIVE_GIT_READ_TOKEN";

const PROXY_REMOTE_PATH = /^\/v0\/scm-events\/[a-z]+-git-proxy\/.+\.git$/;
const NAMED_TOKEN_ENV = ["HIVE_GIT_READ_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

const SECRET_RES = [
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /ghs_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /x-access-token:[^@\s]+/gi,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
];

type Attempt = { ok: true } | { ok: false; reason: string };

export async function clonePrHead(input: {
  checkoutDir: string;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  headBranch?: string;
  baseSha?: string;
}): Promise<Attempt> {
  const repo = `${input.owner}/${input.repo}`;
  const prUrl = `https://github.com/${input.owner}/${input.repo}/pull/${input.number}`;
  const held: string[] = [];
  const attempts: string[] = [];

  const named = namedCloneToken();
  if (named !== undefined) {
    held.push(named);
    const viaNamed = await shallowWithGitHubToken({ ...input, prUrl, token: named });
    if (viaNamed.ok) {
      return { ok: true };
    }
    attempts.push(`env token: ${viaNamed.reason}`);
  }

  const apiKey = cursorApiKey();
  if (apiKey !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    attempts.push("unexpected repository name");
  } else if (apiKey !== undefined) {
    held.push(apiKey);
    const viaProxy = await shallowViaGitProxy({ ...input, apiKey, repo });
    if (viaProxy.ok) {
      return { ok: true };
    }
    attempts.push(`git proxy: ${viaProxy.reason}`);

    const lease = await mintPrWriteLease(apiKey, repo);
    if (!lease.ok) {
      attempts.push(`pr-write lease: ${lease.reason}`);
    } else {
      held.push(lease.token);
      note(`using pr-write lease`, repo);
      const viaLease = await shallowWithGitHubToken({ ...input, prUrl, token: lease.token });
      if (viaLease.ok) {
        return { ok: true };
      }
      attempts.push(`pr-write lease: ${viaLease.reason}`);
    }
  } else if (named === undefined) {
    attempts.push("no HIVE_GIT_READ_TOKEN, GH_TOKEN, GITHUB_TOKEN, or CURSOR_API_KEY");
  }

  return { ok: false, reason: failureReason(attempts, held) };
}

function namedCloneToken(): string | undefined {
  for (const name of NAMED_TOKEN_ENV) {
    const value = process.env[name]?.trim() ?? "";
    if (value !== "") {
      return value;
    }
  }
  return cloneAuthFromEnv("github")?.token;
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

async function shallowWithGitHubToken(input: {
  checkoutDir: string;
  prUrl: string;
  headSha: string;
  headBranch?: string;
  baseSha?: string;
  token: string;
}): Promise<Attempt> {
  const result = await tryCreateShallowPrCheckout({
    prUrl: input.prUrl,
    headSha: input.headSha,
    baseSha: input.baseSha,
    headBranch: safeBranch(input.headBranch),
    checkoutDir: input.checkoutDir,
    auth: { token: input.token },
  });
  if (!result.ok) {
    return { ok: false, reason: scrub(result.reason, [input.token]).slice(0, 300) };
  }
  return { ok: true };
}

async function shallowViaGitProxy(input: {
  checkoutDir: string;
  repo: string;
  number: number;
  headSha: string;
  headBranch?: string;
  baseSha?: string;
  apiKey: string;
}): Promise<Attempt> {
  const target = await postCursor(input.apiKey, "/v0/scm-events/github-clone-target", {
    repo: input.repo,
  });
  if (!target.ok) {
    return target;
  }
  const remoteUrl = proxyRemoteUrl(target.json);
  if (remoteUrl === undefined) {
    return { ok: false, reason: "git proxy returned no bearer remote" };
  }
  note("using cursor git proxy", input.repo);
  return materializeProxyCheckout({
    checkoutDir: input.checkoutDir,
    remoteUrl,
    apiKey: input.apiKey,
    headSha: input.headSha,
    baseSha: input.baseSha,
    headBranch: input.headBranch,
    number: input.number,
  });
}

function proxyRemoteUrl(json: unknown): string | undefined {
  if (!isRecord(json) || !isRecord(json.clone)) {
    return undefined;
  }
  if (json.clone.authMode !== "bearer" || typeof json.clone.remotePath !== "string") {
    return undefined;
  }
  const remotePath = json.clone.remotePath;
  if (!PROXY_REMOTE_PATH.test(remotePath)) {
    return undefined;
  }
  if (/[\\?@\s]|\.\./.test(remotePath)) {
    return undefined;
  }
  const base = cursorApiBase();
  return base === undefined ? undefined : `${base}${remotePath}`;
}

async function mintPrWriteLease(
  apiKey: string,
  repo: string,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const minted = await postCursor(apiKey, "/v0/scm-events/github-token", {
    repos: [repo],
    permissions: "pr-write",
  });
  if (!minted.ok) {
    return minted;
  }
  const token =
    isRecord(minted.json) && typeof minted.json.token === "string" ? minted.json.token.trim() : "";
  if (token === "") {
    return { ok: false, reason: "github-token returned no token" };
  }
  return { ok: true, token };
}

async function postCursor(
  apiKey: string,
  path: "/v0/scm-events/github-clone-target" | "/v0/scm-events/github-token",
  body: unknown,
): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
  const base = cursorApiBase();
  if (base === undefined) {
    return { ok: false, reason: "Cursor API base URL is not https" };
  }
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ok: false, reason: scrub(errorMessage(error), [apiKey]).slice(0, 300) };
  }
  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      reason: `${path} HTTP ${response.status}: ${scrub(text, [apiKey]).slice(0, 180)}`,
    };
  }
  try {
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: `${path} returned non-JSON` };
  }
}

async function materializeProxyCheckout(input: {
  checkoutDir: string;
  remoteUrl: string;
  apiKey: string;
  headSha: string;
  baseSha?: string;
  headBranch?: string;
  number: number;
}): Promise<Attempt> {
  const secrets = [input.apiKey];
  const fail = (error: unknown): Attempt => ({
    ok: false,
    reason: scrub(errorMessage(error), secrets).slice(0, 300),
  });
  if (!SHA.test(input.headSha)) {
    return { ok: false, reason: "refused proxy fetch without a full head SHA" };
  }
  try {
    await rm(input.checkoutDir, { recursive: true, force: true });
    await mkdir(input.checkoutDir, { recursive: true });
    await git(input.checkoutDir, ["init", "--quiet"]);
    await git(input.checkoutDir, ["remote", "add", "origin", input.remoteUrl]);
    await fetchPinnedHead(input);
    if ((await revParse(input.checkoutDir, input.headSha, input.apiKey)) === undefined) {
      return { ok: false, reason: "git proxy fetch completed without the pinned head" };
    }
    await git(input.checkoutDir, ["checkout", "--quiet", "--detach", input.headSha]);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

async function fetchPinnedHead(input: {
  checkoutDir: string;
  apiKey: string;
  headSha: string;
  baseSha?: string;
  headBranch?: string;
  number: number;
}): Promise<void> {
  const baseExtra =
    input.baseSha !== undefined && input.baseSha !== input.headSha && SHA.test(input.baseSha)
      ? [input.baseSha]
      : [];
  const present = async (): Promise<boolean> =>
    (await revParse(input.checkoutDir, input.headSha, input.apiKey)) !== undefined;
  let lastError: unknown = new Error("pinned sha fetch did not resolve");
  try {
    await git(
      input.checkoutDir,
      ["fetch", "--depth=1", "--no-tags", "--quiet", "origin", input.headSha, ...baseExtra],
      input.apiKey,
    );
    if (await present()) {
      return;
    }
  } catch (error) {
    lastError = error;
  }
  if (baseExtra.length > 0) {
    try {
      await git(
        input.checkoutDir,
        ["fetch", "--depth=1", "--no-tags", "--quiet", "origin", input.headSha],
        input.apiKey,
      );
      if (await present()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
  }
  await fetchRefFallback(input, lastError);
}

async function fetchRefFallback(
  input: {
    checkoutDir: string;
    apiKey: string;
    headSha: string;
    headBranch?: string;
    number: number;
  },
  shaError: unknown,
): Promise<void> {
  const branch = safeBranch(input.headBranch);
  const fallback = `refs/pull/${input.number}/head`;
  const local = "refs/remotes/origin/shallow-clone-pr-head";
  try {
    await git(
      input.checkoutDir,
      ["fetch", "--depth=1", "--no-tags", "--quiet", "origin", `+${fallback}:${local}`],
      input.apiKey,
    );
  } catch (error) {
    if (branch === undefined) {
      throw error;
    }
    await git(
      input.checkoutDir,
      ["fetch", "--depth=1", "--no-tags", "--quiet", "origin", `+refs/heads/${branch}:${local}`],
      input.apiKey,
    );
  }
  const fetched = await revParse(input.checkoutDir, local, input.apiKey);
  if (fetched?.toLowerCase() !== input.headSha.toLowerCase()) {
    throw new Error(
      `git proxy ref fetch resolved to ${fetched ?? "nothing"}, expected ${input.headSha} (${scrub(errorMessage(shaError), [input.apiKey]).slice(0, 160)})`,
    );
  }
}

function safeBranch(branch: string | undefined): string | undefined {
  if (branch === undefined || branch === "") {
    return undefined;
  }
  if (!BRANCH.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) {
    return undefined;
  }
  return branch;
}

function git(cwd: string, args: string[], token?: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_KEY_0;
  delete env.GIT_CONFIG_VALUE_0;
  if (token !== undefined) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${token}`;
  }
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 480_000,
        env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stderr || ""}`.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
          reject(new Error(`git ${args[0] ?? "command"} failed — ${detail ?? error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function revParse(cwd: string, rev: string, token: string): Promise<string | undefined> {
  try {
    const sha = (await git(cwd, ["rev-parse", "--verify", `${rev}^{commit}`], token)).trim();
    return sha === "" ? undefined : sha;
  } catch {
    return undefined;
  }
}

function failureReason(attempts: string[], secrets: string[]): string {
  const detail = attempts.map((item) => scrub(item, secrets)).join("; ") || "no clone credential";
  const clipped = detail.slice(0, 280);
  return scrub(`skipped: ${clipped}. ${SECRET_HINT}`, secrets).slice(0, 900);
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      out = out.split(secret).join("[redacted]");
    }
  }
  for (const pattern of SECRET_RES) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function note(message: string, repo: string): void {
  process.stderr.write(`[shallow-clone] ${message} repo=${repo}\n`);
}
