/**
 * E2E targets are app URLs only.
 * `E2E_BASE_URL`, or a preview / staging / e2e label in the PR text.
 * Atlassian, Jira, and GitHub links are never base URLs.
 */

const LABELED_URL_RE =
  /\b(?:e2e(?:[\s_-]*url)?|preview(?:[\s_-]*url)?|staging(?:[\s_-]*url)?)\s*[:=]\s*(https?:\/\/[^\s)>"']+)/gi;

const TRACKER_HOST = /(^|\.)(atlassian\.(net|com)|jira\.com|github\.com)$/i;
const TICKET_PATH = /\/browse\/[A-Z][A-Z0-9]+-\d+/i;

export function acceptAppUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/[.,;]+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  if (TRACKER_HOST.test(host)) return undefined;
  if (TICKET_PATH.test(url.pathname)) return undefined;
  if (/\/jira(\/|$)/i.test(url.pathname)) return undefined;
  return url.toString().replace(/\/$/, "");
}

/** App base URL from the env secret or an explicit preview/staging/e2e label. */
export function resolveE2eBaseUrl(meta: string | undefined, envUrl: string | undefined): string | undefined {
  const fromEnv = acceptAppUrl(envUrl);
  if (fromEnv) return fromEnv;
  if (!meta) return undefined;
  for (const match of meta.matchAll(LABELED_URL_RE)) {
    const accepted = acceptAppUrl(match[1]);
    if (accepted) return accepted;
  }
  return undefined;
}
