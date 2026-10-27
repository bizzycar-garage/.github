---
description: Use when mapping a PR diff to the nearest unit or integration tests to run.
---

# Impacted test selection

1. List changed files from `pr/diff.patch`.
2. Prefer colocated tests (`*.test.*`, `*.spec.*`, `__tests__`).
3. Fall back to the nearest package or folder test script.
4. Build 1–5 shell commands the repo already understands
   (for example `npm test -- path/to/file` or `pnpm vitest run path`).
5. Call `run_impacted_tests` with those commands.
6. Call `coverage_summary` next with numbers from the run, or
   `status: "unavailable"` when coverage output is missing.

Do not invent a test runner. If the repo layout is unclear, choose the
smallest package-script command and say so in the command label.
