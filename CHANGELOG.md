# Changelog
[繁體中文](CHANGELOG.zh-TW.md)

Changes to know about when using or upgrading Guard. Entries follow Keep a Changelog. While Guard is experimental, 0.x minor releases may change how it works; check the upgrade notes before updating.

## [Unreleased]

### Added
- Added ci verify: checks the commit you are about to push. It decides which workflows the push or pull request triggers, runs the workflow static check and replays the triggered Linux jobs locally, then lists what is expected to fail, what passed locally and what only GitHub can verify.
- Added ci replay: runs one job of a committed workflow in local Linux containers with act 0.2.89, reports the failing step, command, failed tests and log location, and removes only the containers, networks and volumes it created.
- Added ci discover: reads committed workflows, including local reusable workflows and composite actions, and lists the commands CI runs, which jobs can run locally, local tool readiness and next commands. No adapter needed.
- Added ci locate: for a failed GitHub run, finds the failed job, step, workflow line and failing tests with their file and line, and saves the step's log locally so it can be read page by page.
- Added ci history: the hosted wait-time and job-duration baseline for a workflow, the time and billable minutes used by failed attempts, and with --reproduce, which failures a local ci verify would have caught.
- Added ci check for offline actionlint/zizmor baseline scans of committed workflows. Existing commands remain compatible.

### Changed
- Added the inspection-bench banner to both READMEs. Its static image ships with the CLI archive; the editable HTML/JS artwork stays in the repository.
- Rewrote the guides around everyday tasks: setup, reading results, investigating failures and maintaining an installation. Update and uninstall commands now have separate examples.
- Simplified the AI, contributor and security-reporting instructions, fixed their navigation, and added heading-link checks across all Markdown guides. Command behavior and data formats are unchanged.
- Edited earlier changelog entries for readability while keeping their version dates and recorded changes.
- Kept contributor/release instructions in the repository rather than the CLI archive. The installed README links to them; user guides, changelogs and the license remain bundled.

## [0.1.1] - 2026-10-08

This update makes it easier to get your AI started with Guard. The installed package includes English and Traditional Chinese guides, and failed plan scripts no longer send their raw output into agent diagnostics.

**Upgrading:** Update the GitHub archive/clone or Claude marketplace plugin and check that --version prints 0.1.1. Existing configuration and receipts need no migration. If a plan script fails, inspect it locally; its raw output is no longer echoed.

### Changed
- Added matching English and Traditional Chinese setup guides to the CLI archive. They explain when to check unfinished edits, when to check a commit, and how to read work that remains unverified.
- Added tools/docs.mjs to check that translated documents have matching structure and runnable examples. Release notes now use the same parser and both changelogs.

### Security
- Stopped echoing a failed plan adapter's raw stdout/stderr into terminal and agent diagnostics. Its exit status and failed/blocked result are unchanged. This targets plan-failure output; other logs still need review before sharing.

## [0.1.0] - 2026-10-08

Install from GitHub without an npm account. The first experimental release brings local commit checks, manageable failure logs and a Claude Code plugin. Run local checks before pushing, then let hosted CI cover the remaining work.

**Upgrading:** Projects that previously relied on an implicit adapter now need their own committed .ci-local-guard.json and scripts. Read the result report for coverage; a successful command or PASS message alone does not say that every CI check ran.

### Added
- GitHub Release archives and checksums, with tests for fixed-version offline npm-exec installation. Releases check the tag before publishing; npm registry publication is disabled.
- A Claude Code plugin that bundles the same CLI and keeps its version in sync. It provides a skill rather than another runner, automatic hooks or an MCP server.
- `--version` to identify the installed CLI.
- Doctor reports that show the requirements and known blockers for each capability, so offline analysis can be used without project setup.
- Log locations for failed checks, using recorded byte positions and validated check IDs instead of guessing from log text.
- `read-evidence` to read logs in small JSON pages, with continuation versions and reasons when a file cannot be read.
- Short agent reports and `--output` for saving a full preflight or doctor report to a new file. Reports include suggested next steps, log references and work whose relevance is still unknown.
- Read-only `doctor --check --json` to inspect committed setup and show which dependencies or hosted checks still need verification.
- A project-owned adapter and short AI entry point so Guard can test itself.
- A 900-second execution deadline by default, cancellation handling, termination of the started process tree, and diagnostics when a checkout must be retained.
- A runnable offline timing example and a copyable request for asking an AI to set up the tool.
- Local checks against a specific commit, with bounded logs and validated results from project scripts.
- Project-defined plans and local push rules that block when required results are missing.
- GitHub Actions run collection and offline timing analysis/comparison.
- Instructions for AI users, discoverable from an installed CLI.

### Changed
- Tried reducing repeated fixture setup in a six-run experiment. The 7.6% median wait improvement missed the chosen 10% target, and mean wait was unchanged, so the change was reverted.
- Removed assumptions about application names, scripts and branches, along with fallback rules borrowed from another checkout.
- Removed cached PASS results, deployment previews and seven expanded diagnostic commands.
- Removed the old check command. A comparison base must now be explicit, and plan needs a committed head.

### Fixed
- Updated CLI help to describe the already-public tool as experimental rather than a private candidate.
- Kept stdout/stderr log lines separate when redaction delays their final bytes.
- Used native path normalization for Windows test comparisons.

[unreleased]: https://github.com/cablate/ci-local-guard/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/cablate/ci-local-guard/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cablate/ci-local-guard/releases/tag/v0.1.0
