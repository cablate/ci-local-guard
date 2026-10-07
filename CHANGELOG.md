# Changelog

## Unreleased — experimental

Source repository is public under MIT; no versioned Release or registry publication yet. The version is owned by package.json.

### Added
- Public onboarding with a non-empty offline timing demo, English entry point and copyable agent handoff.
- Exact-commit local preflight, bounded logs and validated project receipts.
- Explicit project-owned plans and local push policies; missing evidence blocks push.
- Read-only GitHub Actions run collection and offline timing diagnostics/comparison.
- AI operating guidance and installed-consumer documentation discovery.

### Changed
- Removed application-specific script/branch assumptions and external checkout fallback.
- Removed PASS caching, downstream deployment previews and seven expanded diagnostic commands.
- Removed the legacy check command. Explicit comparison base is required; plan requires an explicit committed head.

### Fixed
- Prevent redaction-delayed stdout/stderr tails from splicing ordinary evidence lines.
- Compare Windows test paths with native filesystem canonicalization.

### Migration
- Consumers relying on implicit adapters must commit their own .ci-local-guard.json and scripts. There is no compatibility fallback.
- Standalone execution success can still be incomplete; consumers must read reports rather than interpret exit zero or PASS text as full CI completion.
