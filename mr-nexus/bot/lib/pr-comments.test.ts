import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolContext } from "@grok/agent-sdk/tools";
import hook from "../hooks/pr-comments.js";
import {
  commentBody,
  flushStagedPrComments,
  sectionMarker,
  sectionToken,
  stagePrComment,
  upsertPrComment,
} from "./pr.js";

const ref = { owner: "bizzycar-garage", repo: "hive-api", number: 7614 };

type FakeComment = { id: number; body: string | null };

function harness(options?: { failWrites?: boolean }) {
  const store = new Map<string, unknown>();
  const comments: FakeComment[] = [];
  let seq = 10;
  const flags = { failWrites: options?.failWrites ?? false };
  const octokit = {
    rest: {
      issues: {
        async updateComment(input: { comment_id: number; body: string }) {
          if (flags.failWrites) throw new Error("update failed");
          const item = comments.find((comment) => comment.id === input.comment_id);
          if (item === undefined) throw new Error(`missing ${input.comment_id}`);
          item.body = input.body;
          return { data: { id: item.id, html_url: `https://github.com/bizzycar-garage/hive-api/pull/7614#issuecomment-${item.id}` } };
        },
        async createComment(input: { body: string }) {
          if (flags.failWrites) throw new Error("create failed");
          const item = { id: seq, body: input.body };
          seq += 1;
          comments.push(item);
          return { data: { id: item.id, html_url: `https://github.com/bizzycar-garage/hive-api/pull/7614#issuecomment-${item.id}` } };
        },
      },
    },
    async paginate() {
      if (flags.failWrites) throw new Error("list failed");
      return comments.map((item) => ({ id: item.id, body: item.body }));
    },
  };
  const ctx = {
    session: { id: "ses_test", purpose: "live" },
    host: {
      kv: {
        async get(key: string) {
          return store.get(key);
        },
        async put(key: string, value: unknown) {
          store.set(key, value);
        },
        async delete(key: string) {
          store.delete(key);
        },
      },
      github: {
        async getOctokit() {
          return octokit;
        },
      },
    },
  } as unknown as ToolContext;
  return { store, comments, ctx, flags };
}

test("comment bodies keep the html marker and a plain token", () => {
  const body = commentBody("impacted-tests", "## Mr. Nexus — impacted tests");
  assert.match(body, /mr-nexus-section:impacted-tests/);
  assert.match(body, /<!-- mr-nexus:impacted-tests -->/);
  assert.equal(sectionToken("impacted-tests"), "mr-nexus-section:impacted-tests");
  assert.equal(sectionMarker("impacted-tests"), "<!-- mr-nexus:impacted-tests -->");
});

test("a finished upsert updates the existing marker instead of leaving it stale", async () => {
  const { comments, store, ctx } = harness();
  comments.push({
    id: 3,
    body: "old\n\n<!-- mr-nexus:impacted-tests -->\n\n<!-- agent-serve-github -->",
  });
  const first = await upsertPrComment({
    ctx,
    ref,
    kind: "impacted-tests",
    markdown: "## Mr. Nexus — impacted tests\n\n**Result:** not finished",
  });
  assert.equal(first.updated, true);
  assert.equal(first.commentId, 3);
  assert.equal(comments.length, 1);
  assert.match(comments[0]?.body ?? "", /not finished/);
  assert.equal(store.has("pr-comment-pending:ses_test:impacted-tests"), false);

  const second = await upsertPrComment({
    ctx,
    ref,
    kind: "impacted-tests",
    markdown: "## Mr. Nexus — impacted tests\n\n**Result:** not run",
  });
  assert.equal(second.commentId, 3);
  assert.match(comments[0]?.body ?? "", /not run/);
});

test("a failed GitHub write stays staged and the finished-turn hook posts it", async () => {
  const { comments, store, ctx, flags } = harness({ failWrites: true });
  await assert.rejects(
    upsertPrComment({
      ctx,
      ref,
      kind: "impacted-tests",
      markdown: "## Mr. Nexus — impacted tests\n\ninstall stderr",
    }),
    /create failed/,
  );
  assert.equal(comments.length, 0);
  assert.equal(store.has("pr-comment-pending:ses_test:impacted-tests"), true);

  flags.failWrites = false;
  const handler = hook.events["turn.completed"];
  assert.equal(typeof handler, "function");
  await handler?.({} as never, ctx as never);
  assert.equal(comments.length, 1);
  assert.match(comments[0]?.body ?? "", /install stderr/);
  assert.match(comments[0]?.body ?? "", /mr-nexus-section:impacted-tests/);
  assert.equal(store.has("pr-comment-pending:ses_test:impacted-tests"), false);
});

test("flush gives up after two failed attempts and skips eval sessions", async () => {
  const { comments, store, ctx, flags } = harness({ failWrites: true });
  await stagePrComment({
    ctx,
    ref,
    kind: "impacted-tests",
    markdown: "pending",
  });
  await flushStagedPrComments(ctx);
  await flushStagedPrComments(ctx);
  assert.equal(comments.length, 0);
  assert.equal(store.has("pr-comment-pending:ses_test:impacted-tests"), true);
  await flushStagedPrComments(ctx);
  assert.equal(store.has("pr-comment-pending:ses_test:impacted-tests"), false);

  flags.failWrites = false;
  await stagePrComment({
    ctx,
    ref,
    kind: "coverage",
    markdown: "should not post",
  });
  const evalCtx = { ...ctx, session: { ...ctx.session, purpose: "eval" } } as ToolContext;
  const handler = hook.events["turn.failed"];
  await handler?.({} as never, evalCtx as never);
  assert.equal(comments.length, 0);
  assert.equal(store.has("pr-comment-pending:ses_test:coverage"), true);
});
