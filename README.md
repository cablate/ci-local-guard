# CI Local Guard
[繁體中文](README.zh-TW.md)

![CI Local Guard — a commit passes through an optical inspection bench and becomes a check report.](assets/banner/banner.webp)

**Give your coding AI a way to check its work before pushing—and investigate slow CI afterward.**

Your AI finishes a change, pushes it, and then CI catches a failing test. You send the logs back, the AI fixes something, and you wait again.

CI Local Guard helps shorten that loop. It runs your project's existing checks against the commit you plan to push, then gives the AI a report: what ran, what failed, where to read the logs, and what still needs checking.

It also reads GitHub Actions timings so you and your AI can investigate slow jobs and compare a proposed improvement with earlier runs.

## What can you use it for?

- **Check a commit before pushing.** Run your existing test scripts in a separate checkout, without mixing in unfinished edits.
- **Help your AI handle failures.** Give it a short JSON report and the relevant part of a log instead of pasting everything into a conversation.
- **Find out why CI is slow.** Inspect job and step timings, then compare runs before and after a change.

Guard works alongside your CI. It handles checks that can run locally; GitHub Actions still covers things that need the hosted environment.

## Let your AI set it up

Give your AI this repository link and a request like this:

> Help me use https://github.com/cablate/ci-local-guard in my project. Read its README and setup guide, look at my existing CI and test commands, then connect Guard to those checks. Show me how to use it while editing, before pushing, and when investigating slow CI.

Your AI will need to read project files and run Node commands. The [AI entry point](#ai-entry-point) below explains the setup; you do not need to write a new test suite.

## Install the CLI

You need Node 22 (>=22.13.0 <23) and Git. Clone the tool into its own directory:

```sh
git clone --branch v0.1.1 --depth 1 https://github.com/cablate/ci-local-guard.git
node ci-local-guard/cli.mjs --version
node ci-local-guard/cli.mjs --help
```

The version command should print 0.1.1. You can share this installation across projects.

No npm account is needed. Downloads are also available in [GitHub Releases](https://github.com/cablate/ci-local-guard/releases). This tool is distributed through GitHub, not the npm registry.

Want to try it without setting up a project? Follow the [offline example](docs/reference.md#offline-example) to analyze a small sample.

### Using Claude Code?

Install the optional plugin instead:

```sh
claude plugin marketplace add cablate/ci-local-guard
claude plugin install ci-local-guard@ci-local-guard-marketplace
```

Restart Claude Code and use /ci-local-guard:ci. The plugin bundles the same CLI and adds instructions for Claude; Node and Git are still required.

## AI entry point

Read the [setup guide and command reference](docs/reference.md) before connecting a project. The usual workflow is:

1. **Look at the project first.** Identify the repository, current branch, unfinished edits and existing test commands.
2. **Connect those checks.** A small project-owned script—called an adapter—runs the existing commands and reports their results. The project's .ci-local-guard.json tells Guard where to find it.
3. **Check the right version.** While editing, use the project's normal targeted tests. Before pushing, use Guard to check a specific commit against an explicit base.
4. **Read the result and act on it.** Tell the user what passed, what failed and what remains to be checked. Use the report's log locations to investigate failures.

Start by checking the project's setup:

```sh
node "<tool-directory>/cli.mjs" doctor --check --repo "<consumer-path>" --summary
```

This reads configuration without running the project's tests. Once the adapter is committed, check a candidate commit:

```sh
node "<tool-directory>/cli.mjs" preflight --repo "<consumer-path>" --base <base> --head <commit> --summary --output <new-report.json>
```

Replace the placeholders with actual paths and commits. The output directory must exist; use a new report filename. --summary gives the AI a short JSON response, while --output saves the full report.

An incomplete result means some work is still outside the local check—for example, a browser test that only runs in CI. The [result guide](docs/reference.md) explains how to handle each outcome.

## Catch CI failures before pushing (development source)

Not in v0.1.1 yet. These commands need no adapter; they read your GitHub workflows directly. Replaying jobs needs [act](https://github.com/nektos/act) 0.2.89 and Docker with Linux containers.

```sh
node "<tool-directory>/cli.mjs" ci discover --repo "<project>" --summary
node "<tool-directory>/cli.mjs" ci verify --repo "<project>" --summary
node "<tool-directory>/cli.mjs" ci locate --repo "<project>" --summary
node "<tool-directory>/cli.mjs" ci diff --repo "<project>" --summary
```

discover tells your AI which commands CI runs, which jobs can run locally and which only GitHub can check. verify takes the commit you are about to push, works out which workflows it triggers, and runs the Linux jobs in local containers. It reports what is expected to fail, with the failing step, command and log location, and what still needs GitHub, such as Windows jobs or jobs that use secrets. If a GitHub run still fails, locate finds the runs for your HEAD commit and points to the failed job, step and tests with their file and line. It saves that step's log locally so the AI reads only the part it needs. After editing a workflow, diff shows whether CI now checks less for the same changes, such as a dropped matrix leg, a narrower filter or a deleted command. Details are in the [reference](docs/reference.md#understand-check-and-replay-ci-unreleased).

## Investigate slow CI

You can use this part without setting up an adapter. With GitHub CLI (gh) already signed in:

```sh
node "<tool-directory>/cli.mjs" collect-runs --repository owner/repo --workflow ci.yml > runs.json
node "<tool-directory>/cli.mjs" inspect-runs --input runs.json
node "<tool-directory>/cli.mjs" audit-runs --input runs.json
```

These commands collect run metadata and show where time is spent. Your AI can then investigate a slow step, propose a change, and use compare-runs to compare the before-and-after runs. The aim is to remove unnecessary work, not necessary tests.

## More help

- [Setup, report formats and examples](docs/reference.md)
- [Updating and uninstalling](docs/reference.md#updating-disabling-and-removing)
- [Settings and troubleshooting](docs/reference.md#data-permissions-and-settings)
- [What's changed](CHANGELOG.md) · [Contributing](https://github.com/cablate/ci-local-guard/blob/main/CONTRIBUTING.md) · [MIT license](LICENSE)

Guard runs your project's scripts with your local permissions, so use it with projects you trust. It has no built-in telemetry. Review logs before sharing them; security concerns can be reported [privately](https://github.com/cablate/ci-local-guard/security/advisories/new).

<details>
<summary>PRINCIPLE — how we decide what belongs in this tool</summary>

1. Help improve both local development and CI, rather than just moving work between them.
2. Keep the checks that protect the project, even when making them faster.
3. Reuse the project's rules instead of creating a competing set.
4. Test the intended commit, separately from unfinished edits.
5. Remove repeated or unnecessary work before adding caching or parallelism.
6. Reuse results only when the inputs truly match. Guard currently runs fresh checks every time.
7. Measure waiting time and total job time separately; neither is a billing calculation.
8. Make failures useful: show what ran, what failed and where to look next.
9. Keep investigation, proposals and changes separate, with approval where needed.
10. Keep the tool small. Add features for real needs, not imagined integrations.

</details>

## Project status

[v0.1.1](https://github.com/cablate/ci-local-guard/releases/tag/v0.1.1) is an experimental release. [Windows and Ubuntu tests](https://github.com/cablate/ci-local-guard/actions/runs/37725011025) pass, and we've tested the release archive and Claude Code 2.1.293 plugin installation, upgrade and removal. macOS, arm64, Claude Desktop and WSL have not been tested.

We use Guard to check this repository too. The unreleased development source adds pre-push checking with ci discover, ci check, ci replay and ci verify, ci history for what failures and slow jobs cost, ci locate for failed GitHub runs, and ci diff for workflow changes. It has been tested so far on Windows with Docker Desktop (Linux containers). These commands are not included in v0.1.1.

Found something confusing or broken? [Open an issue](https://github.com/cablate/ci-local-guard/issues) with your tool version, operating system and a small example.
