import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolContext } from "@grok/agent-sdk/tools";
import hook from "../hooks/pr-comments.js";
import { setGithubCommentTransportForTests, STALE_COMMENT } from "./github-rest.js";
import {
  commentBody,
  flushStagedPrComments,
  sectionMarker,
  sectionToken,
  stagePrComment,
  upsertPrComment,
} from "./pr.js";

let gate: Promise<void> = Promise.resolve();

function serial(name: string, fn: () => Promise<void> | void): void {
  const wait = gate;
  let release: () => void = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  test(name, async () => {
    await wait;
    try {
      await fn();
    } finally {
      release();
    }
  });
}

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

serial("comment bodies keep the html marker and a plain token", () => {
  const body = commentBody("impacted-tests", "## Mr. Nexus — impacted tests");
  assert.match(body, /mr-nexus-section:impacted-tests/);
  assert.match(body, /<!-- mr-nexus:impacted-tests -->/);
  assert.equal(sectionToken("impacted-tests"), "mr-nexus-section:impacted-tests");
  assert.equal(sectionMarker("impacted-tests"), "<!-- mr-nexus:impacted-tests -->");
  const revised = commentBody("coverage", "## Mr. Nexus — coverage", "abc12345");
  assert.match(revised, /mr-nexus-rev:abc12345/);
});

serial("a finished upsert updates the existing marker instead of leaving it stale", async () => {
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

serial("a failed GitHub write stays staged and the finished-turn hook posts it", async () => {
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

serial("flush gives up after two failed attempts and skips eval sessions", async () => {
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

function liveGithub(comments: FakeComment[], apply: () => boolean): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const method = init.method ?? "GET";
    const id = Number(url.split("?")[0]?.split("/").pop());
    if (method === "GET" && url.includes("/issues/7614/comments")) {
      return Response.json(comments.map((item) => ({ id: item.id, body: item.body })));
    }
    if (method === "GET" && url.includes("/issues/comments/")) {
      const item = comments.find((comment) => comment.id === id);
      if (item === undefined) {
        return new Response("{}", { status: 404 });
      }
      return Response.json({
        id: item.id,
        body: item.body,
        html_url: `https://github.com/bizzycar-garage/hive-api/pull/7614#issuecomment-${item.id}`,
      });
    }
    if (method === "PATCH" || method === "POST") {
      const parsed: unknown = JSON.parse(String(init.body));
      const body =
        typeof parsed === "object" && parsed !== null && "body" in parsed && typeof parsed.body === "string"
          ? parsed.body
          : "";
      if (method === "POST") {
        const item = { id: 21, body };
        comments.push(item);
        return Response.json(
          { id: item.id, body, html_url: `https://github.com/bizzycar-garage/hive-api/pull/7614#issuecomment-${item.id}` },
          { status: 201 },
        );
      }
      const item = comments.find((comment) => comment.id === id);
      if (item === undefined) {
        return new Response("{}", { status: 404 });
      }
      if (apply()) {
        item.body = body;
      }
      return Response.json({
        id: item.id,
        body: item.body,
        html_url: `https://github.com/bizzycar-garage/hive-api/pull/7614#issuecomment-${item.id}`,
      });
    }
    return new Response("{}", { status: 500 });
  };
}

serial("a continuation write that leaves the live comment unchanged stays staged", async () => {
  const { comments, store, ctx } = harness();
  comments.push({
    id: 3,
    body: "old\n\n<!-- mr-nexus:impacted-tests -->\n\n<!-- agent-serve-github -->",
  });
  let apply = false;
  setGithubCommentTransportForTests({
    token: "test-pr-write-token",
    fetch: liveGithub(comments, () => apply),
  });
  try {
    await assert.rejects(
      upsertPrComment({
        ctx,
        ref,
        kind: "impacted-tests",
        markdown: "## Mr. Nexus — impacted tests\n\n**Result:** bootstrap failed",
      }),
      new RegExp(STALE_COMMENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(comments[0]?.body ?? "", /^old/);
    assert.equal(store.has("pr-comment-pending:ses_test:impacted-tests"), true);

    apply = true;
    const handler = hook.events["actions.completed"];
    assert.equal(typeof handler, "function");
    await handler?.({} as never, ctx as never);
    assert.match(comments[0]?.body ?? "", /bootstrap failed/);
    assert.match(comments[0]?.body ?? "", /mr-nexus-rev:/);
    assert.match(comments[0]?.body ?? "", /<!-- mr-nexus:impacted-tests -->/);
    assert.equal(comments.length, 1);
    assert.equal(store.has("pr-comment-pending:ses_test:impacted-tests"), false);
  } finally {
    setGithubCommentTransportForTests(undefined);
  }
});

serial("a direct GitHub write updates the marker when the proxy client fails", async () => {
  const { comments, store, ctx } = harness({ failWrites: true });
  comments.push({ id: 3, body: "old\n\n<!-- mr-nexus:coverage -->" });
  setGithubCommentTransportForTests({
    token: "test-pr-write-token",
    fetch: liveGithub(comments, () => true),
  });
  try {
    const result = await upsertPrComment({
      ctx,
      ref,
      kind: "coverage",
      markdown: "## Mr. Nexus — coverage\n\nunavailable",
    });
    assert.equal(result.updated, true);
    assert.equal(result.commentId, 3);
    assert.match(comments[0]?.body ?? "", /unavailable/);
    assert.match(comments[0]?.body ?? "", /mr-nexus-rev:/);
    assert.equal(store.has("pr-comment-pending:ses_test:coverage"), false);
  } finally {
    setGithubCommentTransportForTests(undefined);
  }
});

serial("a proxied update stays staged when the live read never answers", async () => {
  const { comments, store, ctx } = harness();
  comments.push({
    id: 3,
    body: "old\n\n<!-- mr-nexus:e2e -->\n\n<!-- agent-serve-github -->",
  });
  setGithubCommentTransportForTests({
    token: "test-pr-write-token",
    fetch: async () => {
      throw new Error("network down");
    },
  });
  try {
    await assert.rejects(
      upsertPrComment({
        ctx,
        ref,
        kind: "e2e",
        markdown: "## Mr. Nexus — E2E\n\nSkipped: no app base URL.",
      }),
      new RegExp(STALE_COMMENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.equal(store.has("pr-comment-pending:ses_test:e2e"), true);
  } finally {
    setGithubCommentTransportForTests(undefined);
  }
});
