# Changelog

## Unreleased — experimental

Source repository is public under MIT; no versioned Release or registry publication yet. The version is owned by package.json.

### Added
- Publishable npm metadata, fixed-version offline npm-exec installation coverage and a tag-gated OIDC release workflow; registry bootstrap remains a maintainer prerequisite.
- Thin Claude skill plugin bundling the same CLI core, with marketplace metadata and checked version synchronization. No auto hooks, MCP or separate runner.
- `--version` for installed CLI identity checks.
- Doctor capability-specific blockers, required inputs and unverified prerequisites in full and compact reports; offline work stays independent of project setup.
- Failed-check evidence locations from runner-recorded redacted UTF-8 byte ranges and validated receipt IDs, not log-text heuristics.
- Offline `read-evidence` JSON pages with bounded UTF-8 reads, explicit continuation versions and machine-readable failure reasons; retained evidence includes non-automatic reader arguments.
- Agent summaries and exclusive full-report `--output` for preflight / doctor --check, including stable action kinds, evidence IDs and explicit unknown applicability; saved reports never replace fresh checks.
- Read-only `doctor --check --json` separates committed setup from unverified dependencies and Hosted checks.
- Project-owned self-preflight and short repository agent entrypoint.
- Bounded execution (default 900 seconds), cancellation, owned process-tree termination and retained-checkout diagnostics.
- Public onboarding with a non-empty offline timing demo, English entry point and copyable agent handoff.
- Exact-commit local preflight, bounded logs and validated project receipts.
- Explicit project-owned plans and local push policies; missing evidence blocks push.
- Read-only GitHub Actions run collection and offline timing diagnostics/comparison.
- AI operating guidance and installed-consumer documentation discovery.

### Changed
- Completed a six-run fixture-cost experiment; reverted the candidate because its 7.6% median wall reduction missed the predefined 10% threshold (mean wall unchanged; no attributable savings claim).
- Removed application-specific script/branch assumptions and external checkout fallback.
- Removed PASS caching, downstream deployment previews and seven expanded diagnostic commands.
- Removed the legacy check command. Explicit comparison base is required; plan requires an explicit committed head.

### Fixed
- CLI help now identifies the already-public repository as experimental rather than a private candidate.
- Prevent redaction-delayed stdout/stderr tails from splicing ordinary evidence lines.
- Compare Windows test paths with native filesystem canonicalization.

### Migration
- Consumers relying on implicit adapters must commit their own .ci-local-guard.json and scripts. There is no compatibility fallback.
- Standalone execution success can still be incomplete; consumers must read reports rather than interpret exit zero or PASS text as full CI completion.
