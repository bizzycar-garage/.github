import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptAppUrl, resolveE2eBaseUrl } from "./e2e-url.js";

const JIRA = "https://bizzycar.atlassian.net/browse/BCH-11851";

const HIVE_META = [
  "# Hold communication tickets",
  "",
  "PR: https://github.com/bizzycar-garage/hive-api/pull/7618",
  "Head: feature (3c14d380aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)",
  "Base: main",
  "",
  "## Body",
  `Ticket: ${JIRA}`,
].join("\n");

test("rejects the hive-api#7618 Jira ticket as an E2E base URL", () => {
  assert.equal(acceptAppUrl(JIRA), undefined);
  assert.equal(resolveE2eBaseUrl(HIVE_META, undefined), undefined);
  assert.equal(resolveE2eBaseUrl(HIVE_META, JIRA), undefined);
  assert.equal(resolveE2eBaseUrl(undefined, JIRA), undefined);
});

test("accepts E2E_BASE_URL and labeled preview or staging app URLs", () => {
  assert.equal(
    resolveE2eBaseUrl(HIVE_META, "https://staging.example.com/app/"),
    "https://staging.example.com/app",
  );
  const labeled = `${HIVE_META}\nPreview: https://hive-7618.preview.example.com/\n`;
  assert.equal(resolveE2eBaseUrl(labeled, undefined), "https://hive-7618.preview.example.com");
  const staging = `${HIVE_META}\nstaging url = https://staging.example.com/hive`;
  assert.equal(resolveE2eBaseUrl(staging, undefined), "https://staging.example.com/hive");
});

test("skips a labeled Jira URL and keeps a later preview URL", () => {
  const meta = [`e2e_url: ${JIRA}`, "preview: https://preview.example.com/pr"].join("\n");
  assert.equal(resolveE2eBaseUrl(meta, undefined), "https://preview.example.com/pr");
});

test("does not scrape unlabeled non-GitHub URLs", () => {
  const meta = "Docs: https://example.com/help and https://status.example.com";
  assert.equal(resolveE2eBaseUrl(meta, undefined), undefined);
});

test("rejects github, ticket paths, and non-http values", () => {
  assert.equal(acceptAppUrl("https://github.com/bizzycar-garage/hive-api/pull/7618"), undefined);
  assert.equal(acceptAppUrl("https://tickets.example.com/browse/BCH-11851"), undefined);
  assert.equal(acceptAppUrl("not a url"), undefined);
  assert.equal(acceptAppUrl("javascript:alert(1)"), undefined);
});
