// A long impacted-test tool stages its PR comment before the GitHub write.
// If that write throws, or the proxied update does not change the live
// comment, this hook publishes the staged marker. actions.completed runs
// before the turn span closes, so a continuation that dies at the end of
// the runner still posts.
import { defineHook } from "@grok/agent-sdk/hooks";
import { flushStagedPrComments } from "../lib/pr.js";

async function flush(
  ctx: Parameters<typeof flushStagedPrComments>[0],
  purpose: string | undefined,
  consumeAttempt: boolean,
): Promise<void> {
  if (purpose === "eval") return;
  await flushStagedPrComments(ctx, { consumeAttempt });
}

export default defineHook({
  events: {
    async "actions.completed"(_event, ctx) {
      await flush(ctx, ctx.session.purpose, false);
    },
    async "turn.completed"(_event, ctx) {
      await flush(ctx, ctx.session.purpose, true);
    },
    async "turn.failed"(_event, ctx) {
      await flush(ctx, ctx.session.purpose, true);
    },
  },
});
