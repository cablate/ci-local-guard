# Changelog
[繁體中文](CHANGELOG.zh-TW.md)

Changes to know about when using or upgrading Guard. Entries follow Keep a Changelog. While Guard is experimental, 0.x minor releases may change how it works; check the upgrade notes before updating.

## [Unreleased]

### Changed
- Guard is repositioned around what field reports showed actually helps: failure diagnosis (`ci locate`), workflow review (`ci diff`, `ci check`) and timing analysis lead the README; local replay (`ci verify`, `ci replay`) is optional, and the project-adapter/push-hook path (preflight, plan, descriptors, receipts, hooks) is marked experimental.

### Fixed
- `ci history` and `ci optimize` no longer report a short aggregator gate job as the critical path: when the last-finishing job is shorter than half of a job it needs, the wait is attributed to that job (from declared `needs`, or from timing when the workflow is not mapped), and the gate is listed beside it. A gate job that fails only because a needed job failed is counted apart in `failures.byJob` (`downstreamOfFailedNeeds`), not as a second failure.
- `ci history` separates flaky failures using hosted data alone: an attempt that failed and later passed on the same commit is reported under `failures.flaky` with its own cost, marked in `failures.attempts`, and `--reproduce` skips those commits instead of replaying them. `--reproduce` also prints an estimate from hosted job durations and one progress line per commit on stderr (stdout stays JSON).
- Vitest runs that end with "Unhandled Errors" (no FAIL line) now contribute to `failedTests`: the error line (often a `##[error]` annotation) is paired with the `originated in "<file>"` line below it, in both `ci locate` and `ci replay`.
- `--test-timing` samples only attempts where the job's own conclusion is success; a skipped job no longer surfaces as `log-unavailable`.
- `install-hook` refuses when installing would stop existing hooks from running (executable files in `.git/hooks`, or an inherited global/system `core.hooksPath`), saying which; `--force` overrides and the refusal conditions are documented.

## [0.2.3] - 2026-10-11

Fixes from the third field report (#7) against the two surfaces added in 0.2.2: `ci optimize` findings are more accurate, and host-executable and reproduce commands say which shell and directory each step expects.

**Upgrading:** Update the GitHub archive/clone or Claude marketplace plugin and check that --version prints 0.2.3. No migration needed; commands, configuration and receipts are unchanged.

### Fixed
- `ci optimize --workflow <caller>.yml` no longer reports a reusable call job as unbounded when the called workflow, outside the selection, already gives every job a timeout.
- `ci verify` host-executable commands and the `ci locate` reproduce command carry the shell each step expects (declared, or the runner default such as pwsh on Windows) and its working directory (step, then job `defaults.run`, then workflow `defaults.run`); `hostExecutable` reports `totalCommands` and `truncated` when more than 12 run steps exist.
- `ci optimize` compares matrix legs on the same runner family only, reports history that ran through a local reusable call once (or against the caller job and line with `via`), flags pull request concurrency groups that only queue, and no longer counts global tool installs (`npm install -g`, `pip install <tool>`) as dependency installs. `--limit 1..50` bounds the runs read per workflow, and one progress line per workflow goes to stderr.
- `ci verify`, `ci replay`, `ci history` and `ci locate` accept `--json` as a no-op, like the other ci commands.

## [0.2.2] - 2026-10-11

Three additions from the field-report loop: `ci optimize` lists efficiency candidates with evidence, the reporter's field battery runs in CI on every push, and `ci verify` suggests working-tree commands for hosted-only legs whose runner family matches the machine.

**Upgrading:** Update the GitHub archive/clone or Claude marketplace plugin and check that --version prints 0.2.2. No migration needed; commands, configuration and receipts are unchanged.

### Added
- Added ci optimize: efficiency candidates with evidence — missing timeout-minutes, missing concurrency cancel and uncached dependency installs (static, with workflow lines), plus the dominant step of the critical-path job, matrix-leg spread and repeated setup across parallel jobs (from hosted history, read-only, up to 15 runs). Exit 0 clear, 1 candidates, 2 blocked; without usable hosted history the report is static-only and history findings are skipped.
- Added the field battery under quality/field-battery/ (from the issue #4 reporter's scenario suite): the offline battery runs in CI on every push; the gh, flake (deadline pressure) and replay batteries run on demand with the documented prerequisites.
- `ci verify` suggests working-tree commands for hosted-only legs whose runner family matches the machine (a windows leg on a Windows host): `hostExecutable` lists the job commands with line numbers and a `run-host-commands` next action. A suggestion only — not isolated, not a replay, and the hosted run stays required.

## [0.2.1] - 2026-10-11

Fixes from two real-project field reports (#2, #4): third-party runner-label baselines and platform mapping in `ci verify`, billable-minutes and failed-run locating, a discovery budget that scales with inventory, JSON reports for invalid offline input, and hosted-style replay step names.

**Upgrading:** Update the GitHub archive/clone or Claude marketplace plugin and check that --version prints 0.2.1. No migration needed; commands, configuration and receipts are unchanged.

### Fixed
- Detect explicit Docker daemon commands and Docker build actions before isolated replay, including job dependencies. Report the missing capability instead of a misleading workflow failure.
- `ci check`/`ci verify` read `self-hosted-runner.labels` from the committed `.github/actionlint.yaml` (and accept a repeatable `--runner-label`), so third-party runner labels (Blacksmith, Namespace, self-hosted) no longer produce false unknown-label findings; the applied labels and their sources are recorded in the report's `baseline` field.
- `ci verify` plans replays with the same `--platform` mapping as `ci replay`: mapped legs count as locally replayable (`imageSource: caller-mapped`) and their runner-label findings become coverage notes instead of expected failures. Static findings from workflows the event does not trigger move to `staticOutsideTrigger`, and replays that failed only on well-known image gaps (missing shared libraries, missing sudo) are reported as environment mismatches, not project failures.
- `ci history` no longer bills skipped and never-started jobs; they are counted as `skippedJobs` instead.
- `ci diff` probes the literal branches and tags the workflows name (and an escapee for ignore lists), so filter changes scoped to custom branches are caught; `--json` is accepted like the other ci commands, and blocked option errors name the unsupported flag.
- `ci locate` resolves the triggering run for `workflow_run` events and reports its commit instead of the default branch head, keeping the run's own head under `runHead`.
- `ci locate` and `ci replay` parse Playwright summary blocks and Vitest/Jest `FAIL` lines into `failedTests`, not just TAP.
- A replay's `lastActivity` no longer points at action post steps after a failure (`lastFailure` names the failed step) and post-step output is marked `post`.
- `ci discover` reads Git objects under a budget that scales with the inventory (15 s plus 250 ms per entry, capped at 120 s) instead of a fixed 15 s wall clock; each git call is capped at 10 s and retried once, and a timed-out read reports `git-call-timeout` or `discovery-deadline` instead of masquerading as `git-read-unavailable-or-limit`.
- `inspect-runs`, `audit-runs` and `compare-runs` answer invalid input with a JSON blocked report (machine-readable issue code, exit 2) instead of bare stderr text, keeping the JSON-report contract for AI callers.
- `ci discover` adds a `no-github-workflows` note when a repository has no GitHub workflows, so the gap surfaces one round trip earlier than `ci check`.
- `ci replay` names steps the way hosted runs do — the declared step name, or `Run <first line>` for unnamed run steps — in `jobs`, `failures`, `execution.lastActivity` and `execution.lastFailure`, instead of the raw multi-line `run:` script (which stays available as `failures[].command`).

## [0.2.0] - 2026-10-09

This update lets your AI catch CI failures before pushing. New ci commands read your GitHub workflows directly, replay the Linux jobs locally with act, point to the failing step and test when a GitHub run fails, and show whether a workflow change makes CI check less. No adapter needed.

**Upgrading:** Update the GitHub archive/clone or Claude marketplace plugin and check that --version prints 0.2.0. Existing commands, configuration and receipts are unchanged and need no migration. Replaying jobs needs act 0.2.89 and Docker with Linux containers.

### Added
- Added ci verify: checks the commit you are about to push. It decides which workflows the push or pull request triggers, runs the workflow static check and replays the triggered Linux jobs locally, then lists what is expected to fail, what passed locally and what only GitHub can verify.
- Added ci replay: runs one job of a committed workflow in local Linux containers with act 0.2.89, reports the failing step, command, failed tests and log location, and removes only the containers, networks and volumes it created.
- Added ci discover: reads committed workflows, including local reusable workflows and composite actions, and lists the commands CI runs, which jobs can run locally, local tool readiness and next commands. No adapter needed.
- Added ci diff: compares the workflows of two commits and lists, for the same event and changed files, which workflows, jobs, matrix legs and commands run less, more or cannot be determined, so a coverage reduction is confirmed before it is merged.
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

[unreleased]: https://github.com/cablate/ci-local-guard/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/cablate/ci-local-guard/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/cablate/ci-local-guard/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cablate/ci-local-guard/releases/tag/v0.1.0
[0.2.1]: https://github.com/cablate/ci-local-guard/compare/v0.2.0...v0.2.1
[0.2.2]: https://github.com/cablate/ci-local-guard/compare/v0.2.1...v0.2.2
[0.2.3]: https://github.com/cablate/ci-local-guard/compare/v0.2.2...v0.2.3
