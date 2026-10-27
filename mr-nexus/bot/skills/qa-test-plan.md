---
description: Use when drafting the structured QA test plan for a pull request.
---

# QA test plan

Read `pr/meta.md` and `pr/diff.patch`.

Write a markdown plan with these sections only:

1. **Scope** — what the PR changes in one or two sentences.
2. **Risk areas** — concrete regressions to watch.
3. **Manual checks** — short checklist an engineer can run.
4. **Automated focus** — unit/integration areas to prioritize.
5. **E2E candidates** — user paths to cover when a base URL exists.

Keep each section short. Prefer concrete file or route names from the
diff. Then call `post_test_plan` with that markdown.
