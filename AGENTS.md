# CI Local Guard development

Read README.md for current state, adoption and result contracts. This repository
uses its own tool through the committed `.ci-local-guard.json`; the project-owned
adapter is `quality/preflight.mjs`. `package.json` owns the full test command.

- During edits, run relevant `node --test` files; run `npm test` for the full suite.
- Before exact-commit evidence, run `node cli.mjs doctor --check --json --repo .`,
  then `node cli.mjs preflight --repo . --base <explicit-base> --head <commit> --json`.
  Commit only when authorized; dirty edits are not included in exact evidence.
- For CI performance, use collect-runs → inspect-runs/audit-runs → compare-runs;
  preserve Windows/Linux and all existing assertions. Timings are not billing.
- Read JSON identity, outcome, failed checks and unverified responsibilities.
  Exit zero/incomplete is not Hosted PASS. No automatic retries, hooks or deployment.
- Keep consumer policies in consumers. Never add application-specific branches.
