import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolContext } from "@grok/agent-sdk/tools";
import { clonePrHead } from "./cursor-clone.js";
import { readOptionalText, SHA, type PrRef } from "./pr.js";

const HEAD_LINE = /^Head: (\S+) \(([0-9a-f]{40})\)/im;

const SECRET_RES = [
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /x-access-token:[^@\s]+/gi,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_RES) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

export type PrPin = {
  headSha: string;
  headBranch?: string;
  baseSha?: string;
};

export async function resolvePrPin(ctx: ToolContext, ref: PrRef): Promise<PrPin> {
  const meta = await readOptionalText(ctx.workspaceDir, "pr/meta.md");
  const headLine = meta?.match(HEAD_LINE);
  let headSha = headLine?.[2];
  let headBranch = headLine?.[1];
  const fileSha = (await readOptionalText(ctx.workspaceDir, "pr/head.sha"))?.trim();
  if (fileSha && SHA.test(fileSha)) {
    headSha = fileSha;
  }

  let baseSha: string | undefined;
  if (!headSha || !headBranch) {
    const octokit = await ctx.host.github.getOctokit();
    const pull = await octokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    headSha = pull.data.head.sha;
    headBranch = pull.data.head.ref;
    baseSha = pull.data.base.sha;
  }

  if (!headSha || !SHA.test(headSha)) {
    throw new Error("missing or invalid head SHA");
  }
  return { headSha, headBranch, baseSha };
}

export type CheckoutResult =
  | { ok: true; checkoutDir: string; headSha: string }
  | { ok: false; reason: string };

/**
 * Shallow-fetch the PR head into `<workspace>/checkout`.
 * Reuses a checkout already detached at the same SHA.
 * Hosted runs have no `GH_TOKEN`; {@link clonePrHead} uses the Cursor git
 * proxy, then a pr-write lease minted at call time.
 */
export async function ensurePrCheckout(input: {
  workspaceDir: string;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  headBranch?: string;
  baseSha?: string;
}): Promise<CheckoutResult> {
  const checkoutDir = join(input.workspaceDir, "checkout");
  const existing = await readFile(join(checkoutDir, ".git", "HEAD"), "utf8").catch(() => "");
  if (existing.trim().toLowerCase() === input.headSha.toLowerCase()) {
    return { ok: true, checkoutDir, headSha: input.headSha };
  }

  const result = await clonePrHead({
    checkoutDir,
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    headSha: input.headSha,
    headBranch: input.headBranch,
    baseSha: input.baseSha,
  });
  if (!result.ok) {
    return { ok: false, reason: redactSecrets(result.reason).slice(0, 900) };
  }
  return { ok: true, checkoutDir, headSha: input.headSha };
}

const COVERAGE_RES = [
  /Line Coverage:\s*([\d.]+)\s*%/i,
  /Lines\s*:\s*([\d.]+)\s*%/i,
  /(?:^|\n)\s*Coverage:\s*([\d.]+)\s*%/i,
];

/** Pull a line-coverage percent out of runner output, when the runner printed one. */
export function extractLinesPct(logs: readonly string[]): number | undefined {
  for (const log of logs) {
    for (const pattern of COVERAGE_RES) {
      const match = log.match(pattern);
      const value = match?.[1] === undefined ? Number.NaN : Number(match[1]);
      if (Number.isFinite(value) && value >= 0 && value <= 100) {
        return value;
      }
    }
  }
  return undefined;
}
