---
description: Use when mapping a PR diff to the nearest unit or integration tests to run.
---

# Impacted test selection

1. List changed files from `pr/diff.patch`. Include any `*_spec.rb`,
   `*.spec.*`, or `*.test.*` paths already named in the test plan.
2. Map a changed Ruby file `app/.../foo.rb` to `spec/.../foo_spec.rb`
   when that spec is in the diff or is the conventional twin.
3. For RSpec paths, pass one command:
   - label: `rspec impacted`
   - command: `bundle exec rspec spec/a_spec.rb spec/b_spec.rb --format documentation`
   - `timeoutMs`: `600000` when the repo is Rails
   The tool installs Ruby and Bundler and runs `bundle install`
   before that command when `bundle` is not on PATH. Do not skip
   because the pod has no Bundler.
4. For a JS repo, use the test script the repo already has
   (`npm test -- path`, `pnpm vitest run path`). Do not invent a runner.
   If the diff changes no application or spec files, one command is enough:
   label `no impacted specs`, command `echo "no impacted specs"`.
5. Call `run_impacted_tests` with those commands. On HTTP/playground
   sessions pass `prUrl`. The tool clones the PR head and runs the
   commands there. Do not skip because `package.json` is missing.
   If the tool returns `outcome: "skipped"`, report that the checkout
   was skipped. That is not a test failure. If it returns
   `outcome: "bootstrap-failed"`, Ruby did not install and RSpec was
   not started. That is not a spec failure.
6. Call `coverage_summary` with `linesPct` from the tool result, or
   `status: "unavailable"` when `linesPct` is null.
7. Call `e2e_run`. Omit `baseUrl` unless `E2E_BASE_URL` or an
   explicit preview/staging app URL is known. Never pass a Jira,
   Atlassian, or `/browse/` ticket link.

Do not invent a test runner. If the repo layout is unclear, choose the
smallest command the changed paths imply and say so in the command label.
