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
    // Hosts bot/lib/ruby-runtime.ts calls before RSpec. Apt on noble uses
    // the Ubuntu archives. curl -fsSL follows ruby-builder release URLs
    // from github.com to the asset hosts. gem install and bundle install
    // use the RubyGems compact index and gem host. Comment confirmation
    // reads and updates issue comments on the GitHub REST API.
    egressDomains: [
      "archive.ubuntu.com",
      "security.ubuntu.com",
      "github.com",
      "api.github.com",
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
      "index.rubygems.org",
      "rubygems.org",
    ],
    secretNames: ["E2E_BASE_URL", "HIVE_GIT_READ_TOKEN"],
  },
});
