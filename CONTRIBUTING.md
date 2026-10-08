# Contributing

Thanks for helping improve CI Local Guard. Small fixes, clearer examples and reports of real setup problems are all useful.

## Run it locally

Use Node 22 (>=22.13.0 <23), its bundled npm, and Git. There are no npm runtime dependencies to install. From the repository root:

```sh
npm test
```

Tests create temporary repositories and use sample data. You do not need a GitHub login, private application or database. Package tests also use npm to pack and install the CLI offline. On Windows, install Git for Windows so hook tests have a shell.

For a small change, start with the relevant file:

```sh
node --test tests/project.test.mjs
```

Run the full suite when changing execution, commit identity, result validation or push checks. Keep existing assertions; if a test fails, investigate the cause before changing what it requires.

## Find the code

| File | What it handles |
|---|---|
| cli.mjs | Commands, reports and local Git hooks |
| src/project.mjs | Project configuration, plans and check-result validation |
| src/checkout.mjs | Temporary checkouts and before/after Git-state checks |
| src/run-log.mjs | Execution deadlines, logs, receipts and failure details |
| src/ci-runs.mjs | GitHub run collection and timing analysis |
| src/actionlint.mjs | The actionlint download and version/hash checks used by doctor |
| tests/ | Unit tests and isolated integrations, including an installed consumer |

Use ES modules, two-space indentation and semicolons. There is no build step or enforced formatter yet. Keep a patch focused on the problem it solves.

Project-specific test scripts and selection rules belong in the project using Guard. Avoid project-name exceptions, fallback rules from another checkout, undeclared network access or caches that skip checks without proving equivalent inputs.

## Change a public interface

Commands, options, configuration/report formats and documented environment variables are public interfaces. Internal module exports are not a stable library API.

When behavior changes, update the relevant guide and both changelogs. Add tests for the intended use and affected failure cases. In your change description, distinguish local testing from any hosted testing you actually ran.

## Write documentation people can use

Start with what the reader wants to do. Explain an unfamiliar term before using it, put one action in each step, and show what the user should expect afterward.

- README introduces the tool and gives the shortest route to using it.
- docs/reference explains setup, formats, command details and troubleshooting.
- AGENTS and skills/ci/SKILL.md direct agents to those guides; they do not need another copy of the manual.
- CHANGELOG explains what changed for users. Start with the benefit and give migration steps separately.

Place an important warning beside the operation it affects and explain what to do instead. Avoid repeating the same disclaimer in every section or putting internal audit records into a product introduction.

README, reference and changelog use English and Traditional Chinese pairs. Contributor and security guidance may remain English-only. Keep headings, lists and tables aligned; commands, field names and fenced examples must match. Check them with:

```sh
node tools/docs.mjs check
```

This checks structure and examples, not whether the translation reads naturally. Read both versions as well. CI and the full test suite run the same check.

Use Keep a Changelog categories Added/Changed/Deprecated/Removed/Fixed/Security, translated as 新增/變更/棄用/移除/修正/安全性. Add new changes under Unreleased in both languages. Release notes come from those files rather than a separately written version.

## Keep public documents focused

Everything tracked in this public repository is public, including agent instructions. Separate documents by reader, not by pretending a folder is private:

| Document | Reader and purpose | Distribution |
|---|---|---|
| README pair | New users: what the tool does and how to start | Repository and CLI archive |
| docs/reference pair | Users and agents: setup, commands, results and troubleshooting | Repository and CLI archive |
| CHANGELOG pair | Upgrading users: changes and migration | Repository and CLI archive |
| CONTRIBUTING.md | Contributors: development, documentation and releases | Repository; linked from the installed README |
| AGENTS.md | Agents editing Guard's own code | Repository |
| skills/ci/SKILL.md | Claude users operating Guard on their projects | Plugin |
| .github/SECURITY.md | Anyone reporting a security concern | Repository and GitHub Security tab |
| LICENSE | Everyone using or distributing the code | Repository and CLI archive |
| assets/banner/ | README artwork; index.html is its editable, interactive source and banner.webp is the static export | WebP in repository and CLI archive; HTML in repository only |

Keep work diaries, internal TODO checklists, raw test/run logs, scan details, personal paths and private project examples out of tracked files and release attachments. Put temporary evidence outside the tracked tree. Share only the relevant, reviewed conclusion in the appropriate public guide or changelog. README holds a short current status and next priority, not an execution history.

package.json's files list controls the CLI archive, and package tests check the allowed contents. The Claude plugin uses a checkout of the public repository; the CLI file list does not filter that checkout. A directory name or .gitignore rule does not make an already tracked file private. Before publishing, review git diff and npm pack --dry-run --json as well as any separately attached assets.

## Report a problem

For ordinary bugs, [open an issue](https://github.com/cablate/ci-local-guard/issues). Include the tool version, OS, Node/Git versions, steps to reproduce, expected result and actual exit code/report. A small example with made-up data is ideal.

For sensitive findings, follow the [security reporting guide](https://github.com/cablate/ci-local-guard/security/policy). Remove credentials and private details from anything you post publicly.

## Publish a release

This section is for maintainers. Distribution uses GitHub Releases and the Claude plugin; npm registry publication stays disabled through private: true.

### Prepare the version

1. Change the version in package.json, then run npm run distribution:sync. This updates the Claude plugin manifest; keep the marketplace entry free of a separate version.
2. Move reviewed Unreleased notes into a dated section in both changelogs: ## [<version>] - YYYY-MM-DD. Leave an empty Unreleased section, add a comparison link, and explain migration in an Upgrading paragraph.
3. Run tests, npm run distribution:check and the documentation check. Validate the plugin with claude plugin validate --strict . and claude plugin validate --strict .claude-plugin/plugin.json. Review the package contents, current files and Git history for accidental private data.
4. Confirm clean-clone/install tests, Windows/Ubuntu hosted checks and the private security-report channel, then merge the reviewed passing commit to main.

Preview the release notes:

```sh
node quality/release-notes.mjs
```

This uses the package version and the shared tools/docs.mjs parser. To preview another version, use node tools/docs.mjs release <version>.

### Publish and check the result

With maintainer approval, push v<package-version> at the reviewed main commit. The release workflow repeats Windows/Linux and plugin checks, verifies the tag/version/notes and main ancestry, then publishes an experimental GitHub Release with the CLI archive and SHA256SUMS. Only that publishing job gets contents:write; an ordinary branch push does not publish.

Download the archive, verify its SHA256, and run --version and --help. Test marketplace installation, upgrade and removal with isolated Claude settings. These checks verify distribution; they do not prove how every AI will use the skill.

If a release is broken, investigate before retrying. Point users to the last working tag or SHA and prepare a patch version. Leave published tags and assets unchanged. Checksums verify file integrity, not an independent publisher signature.

Tagging, publishing, changing repository visibility/settings and rewriting history each need approval. npm accounts, tokens and OIDC setup are not part of this release process.
