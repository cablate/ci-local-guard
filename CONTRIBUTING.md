# Contributing

This open-source, experimental CLI is intended for development agents and their human reviewers. User guidance is currently Traditional Chinese; code identifiers, tests and commit messages use English.

## Develop and test

Use Node >=22.13.0 <23, its bundled npm, and Git. No npm runtime dependencies or installation step are required. From the repository root:

```sh
node --test tests/*.test.mjs
```

Tests use temporary Git repositories, synthetic receipts and mocked provider responses. They do not need GitHub authentication, private applications, a database or a hosted CI run. The package test runs npm pack/install offline; npm must be available alongside Node or on PATH. On Windows, Git for Windows supplies the shell used by hook integration tests.

Start with a focused test file. Run the full suite for changes to execution, identity, receipts or push gating. Do not weaken assertions or required checks to obtain a green result.

## Code map

- cli.mjs: command routing, orchestration, local hooks and reports.
- src/project.mjs: project contracts, identity and owner/check validation.
- src/checkout.mjs: temporary exact checkout and sampled tracked-state observation.
- src/run-log.mjs: bounded execution, receipts, logs and failure evidence.
- src/ci-runs.mjs: read-only GitHub collection and offline diagnostics.
- src/actionlint.mjs: pinned actionlint download and verification for doctor only.
- tests/: unit and isolated integration cases, including an installed consumer.

Keep application scripts and classification rules in the consuming application. Do not add project-name exceptions, external model fallback, undeclared network access or unproven success caching. Prefer a small coherent patch over a new framework. Existing style: ES modules, two spaces, semicolons, no build step. No separate formatter/linter is enforced yet.

## Public interfaces and changes

CLI verbs/options, descriptor/plan/receipt/report schemas and documented environment variables are consumer interfaces. Source-module exports are implementation details, not a stable library API. Update README and CHANGELOG when behavior changes. Tests must cover valid use and the affected failure boundary; a local PASS does not certify Hosted CI or complete protection.

## Issues and sensitive reports

Use this repository's Issues for non-sensitive bugs. Include the package version, Node/Git versions, OS, reproduction, exit code and sanitized report. Remove private paths, tokens and raw logs. Use [GitHub private vulnerability reporting](https://github.com/cablate/ci-local-guard/security/advisories/new) for sensitive findings; see [security reporting guidance](https://github.com/cablate/ci-local-guard/security/policy).

## Releasing (not enabled)

The only version source is package.json. Keep private: true to block npm publication; this does not control GitHub visibility. No npm release or GitHub Release has been issued. Maintain CHANGELOG/Unreleased; choose the next version before release, and document migration for breaking interfaces. Breaking stable interfaces require a major version. Do not rename the package without an explicit migration decision.

A release requires clean-clone/install tests, cross-platform Hosted CI, review of current files and Git history, a working private security-report channel and maintainer approval. The workflow runs offline tests on Windows and Ubuntu; verify its actual result before claiming Hosted success. Tags, Releases, registry publication, history rewrites and repository visibility/settings changes need explicit approval.
