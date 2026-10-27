import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  name: "Mr. Nexus",
  description:
    "Background QA engineer for Engineering PRs: test plans, impacted tests, coverage, and product E2E.",
  // Pin to the package DEFAULT-compatible id (`effort` + `fast`). A newer
  // id that the hosted harness rejects aborts turns with runner_error before
  // any tool call (no post_test_plan in the trajectory).
  model: {
    id: "grok-4.5",
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
  tools: ["read", "grep", "glob", "ls", "shell"],
  local: {
    sandbox: true,
  },
  hosting: {
    secretNames: ["E2E_BASE_URL", "HIVE_GIT_READ_TOKEN"],
  },
});
