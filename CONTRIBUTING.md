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

## Releasing

package.json owns the version. `.claude-plugin/plugin.json` mirrors it because Claude requires its own manifest: after changing the package version, run `npm run distribution:sync`; CI rejects drift. Do not repeat the version in the marketplace entry. No registry publication or GitHub Release has been issued yet. The package is publishable, but that is not proof of publication. Experimental npm releases use `next`, not `latest`.

One-time bootstrap (maintainer account required): authenticate to npm in your own terminal, verify the account and package name, then publish the reviewed tarball with `npm publish <tarball> --ignore-scripts --access public --tag next --registry=https://registry.npmjs.org/`. Never share tokens/OTP or commit npm credentials. Before this first publication, require the same exact-SHA Windows/Linux tests and package checks as subsequent releases. First local publication does not establish Hosted provenance.

Once the package exists, configure its npm Trusted Publisher for GitHub owner `cablate`, repository `ci-local-guard`, workflow filename `release.yml`, allowed action `npm publish`. No environment name is configured by this workflow. This is a one-time account/permission change requiring maintainer authorization; do not substitute a long-lived repository token. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

For each release:
1. Change package.json version; run `npm run distribution:sync`. Move reviewed Unreleased notes to `## <version> — experimental` in CHANGELOG; document breaking migrations.
2. Run tests, distribution:check and both `claude plugin validate --strict .` and `claude plugin validate --strict .claude-plugin/plugin.json`. Review package contents and external changes.
3. Merge the reviewed, green commit to main. Workflow dispatch of Release is a dry-run rehearsal only; it cannot publish. The workflow must exist on the default branch before dispatch is available.
4. With release approval, push `v<package-version>` at that commit. Release reuses the Windows/Linux tests and pinned Claude validator, checks tag/version/notes and main ancestry, packs once, dry-runs that archive, then publishes the same archive through OIDC with provenance. Ordinary branch pushes do not publish. No automatic main merge, tag creation or GitHub Release creation.
5. Verify `npm view ci-local-guard@<version> version dist.integrity --registry=https://registry.npmjs.org/`, fresh-cache `npx --yes ci-local-guard@<version> --version` and `--help`, then a real preflight on a trusted fixture. Confirm plugin upgrade sees the new version. Publication failures remain failures: inspect registry state before retrying; never replace an existing version or unpublish automatically.

If a version is bad, pin consumers to the last known good version and prepare a reviewed patch version. Deprecation or dist-tag changes require explicit approval. Registry publication and OIDC cannot be proved by dry-run or package installation tests alone.

A release requires clean-clone/install tests, cross-platform Hosted CI, review of current files and Git history, a working private security-report channel and maintainer approval. The workflow runs offline tests on Windows and Ubuntu; verify its actual result before claiming Hosted success. Tags, Releases, registry publication, history rewrites and repository visibility/settings changes need explicit approval.
