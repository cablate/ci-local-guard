# Contributing

This open-source, experimental CLI is intended for development agents and their human reviewers. Public guidance uses English with matching Traditional Chinese translations; code identifiers, tests and commit messages use English.

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

## Releasing

package.json owns the version. `.claude-plugin/plugin.json` mirrors it because Claude requires its own manifest: after changing the package version, run `npm run distribution:sync`; CI rejects drift. Do not repeat the version in the marketplace entry. Keep private: true: distribution is through GitHub, not npm registry. No npm login, token or OIDC configuration is required.

For each release:
1. Change package.json version; run `npm run distribution:sync`. Move reviewed Unreleased notes to `## [<version>] - YYYY-MM-DD` in both CHANGELOG.md and CHANGELOG.zh-TW.md, leaving an empty Unreleased section. Add the comparison link and explain required migration in an Upgrading paragraph. `node quality/release-notes.mjs` reads the package version and uses `tools/docs.mjs` to derive bilingual notes from these owners; `node tools/docs.mjs release <version>` previews a specific version.
2. Run tests, distribution:check and both `claude plugin validate --strict .` and `claude plugin validate --strict .claude-plugin/plugin.json`. Review package contents and external changes.
3. Merge the reviewed, green commit to main. No automatic merge or tag creation.
4. With release approval, push `v<package-version>` at that commit. Release reuses Windows/Linux tests and the pinned Claude validator, checks tag/version/notes and main ancestry, then creates an experimental GitHub Release with the CLI tarball and SHA256SUMS. Only the release job receives contents:write; ordinary branch pushes never publish. Tags are immutable; a failed release must be investigated before any retry.
5. Download the release archive, verify its SHA256, run its `--version` and `--help`, and verify remote marketplace installation/update/removal with isolated Claude settings. Install dependencies only where required by the consuming project, not by this distribution layer.

If a version is bad, pin consumers to the last known good tag/SHA and prepare a reviewed patch version. Do not move published tags or automatically delete release assets. GitHub checksums provide integrity checks, not a separate publisher signature. Natural-language skill adoption remains distinct from manifest/install verification.

A release requires clean-clone/install tests, cross-platform Hosted CI, review of current files and Git history, a working private security-report channel and maintainer approval. The workflow runs offline tests on Windows and Ubuntu; verify its actual result before claiming Hosted success. Tags, Releases, registry publication, history rewrites and repository visibility/settings changes need explicit approval.

## Writing docs

Public README, reference and changelog documents use English sources and matching
Traditional Chinese files named X.zh-TW.md. Contributor/security documents may
remain English-only. Keep corresponding headings, lists and tables aligned;
commands and fenced code must be identical. Translate explanations, not schema
keys or paths. Run `node tools/docs.mjs check`; it checks structure, links, inline
code and complete fenced-code contents, not translation meaning or command safety.
Review those manually. The full test suite and CI enforce the same documentation
check; missing translations or divergent executable examples block delivery.

Use Keep a Changelog categories Added/Changed/Deprecated/Removed/Fixed/Security,
translated as 新增/變更/棄用/移除/修正/安全性. Put the user benefit first and explain
required upgrade steps separately. Update both Unreleased sections when a change
is made. Do not hand-author a second set of GitHub Release notes or move old tags.
