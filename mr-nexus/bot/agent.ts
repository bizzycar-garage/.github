import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  name: "Mr. Nexus",
  description:
    "Background QA engineer for Engineering PRs: test plans, impacted tests, coverage, and product E2E.",
  model: {
    id: "grok-4.7",
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
    secretNames: ["E2E_BASE_URL"],
  },
});
