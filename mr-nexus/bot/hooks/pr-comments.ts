// A long impacted-test tool stages its PR comment before the GitHub write.
// If that write throws, or the wake ends while install is still running,
// this hook publishes the staged marker once the turn is finished.
import { defineHook } from "@grok/agent-sdk/hooks";
import { flushStagedPrComments } from "../lib/pr.js";

async function flush(ctx: Parameters<typeof flushStagedPrComments>[0], purpose: string | undefined): Promise<void> {
  if (purpose === "eval") return;
  await flushStagedPrComments(ctx);
}

export default defineHook({
  events: {
    async "turn.completed"(_event, ctx) {
      await flush(ctx, ctx.session.purpose);
    },
    async "turn.failed"(_event, ctx) {
      await flush(ctx, ctx.session.purpose);
    },
  },
});
