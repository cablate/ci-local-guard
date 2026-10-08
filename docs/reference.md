# CI Local Guard contract reference
[繁體中文](reference.zh-TW.md)

Advanced contracts and limits; start adoption at [README](../README.md).

## Project contract: the project owns its rules

Commit .ci-local-guard.json and your scripts in the **consumer project**, not in Guard. Only the candidate commit's descriptor is used; dirty/staged configuration is not trusted as committed evidence. Minimal standalone configuration:

```json
{
  "schemaVersion": "ci-local-guard/project/v1",
  "preflight": {
    "entrypoint": "quality/preflight.mjs",
    "dependencies": "none",
    "receipt": "guard-v1"
  }
}
```

entrypoint is a regular repository JS file. Shell commands, escaping paths, symlinks and linked directories are rejected. dependencies currently accepts only none: this means the project prepares and verifies dependencies, not that it has no dependencies. Guard never runs npm ci automatically. Equal lockfile bytes may allow linking source node_modules; the checkout is not a fully immutable environment.

```powershell
ci-local-guard preflight --repo <project> --base <base-ref> --head <candidate-ref> --event push --json
ci-local-guard plan --repo <project> --base <base-ref> --head <candidate-ref> --event push --ref refs/heads/main --json
ci-local-guard preflight --repo <project> --base <base-ref> --head <candidate-ref> --event push --ref refs/heads/main --with-plan --json
```

base comes only from --base or CI_LOCAL_GUARD_BASE; Guard does not guess a target branch or fetch. plan requires --head and does not support working-tree mode. event is pull_request, push or workflow_dispatch.

### Preflight result

Guard uses the same Node executable for entrypoint, passing --base, --head and --event. cwd is the isolated checkout; CI_LOCAL_GUARD_EVENT reflects event. The product may emit logs; guard-v1 must write tmp/preflight/project-report.json:

- schemaVersion: ci-local-guard/project-preflight/v1.
- identity: the supplied exact base, head and event, plus mode: committed.
- changedFiles: declared changed paths; --with-plan also checks them against the plan's exact diff.
- checks: unique id, owner, why, status, result, durationMs, log and blockedBy.
- outcome: incomplete or failed; adapters cannot declare local-complete.
- unverified: layers not verified.

A successful check has status: ran, result: success and nonnegative durationMs; log is relative to the receipt directory. Failure and child exit must agree. external-owner/unavailable cannot count as success. Receipt/log identity, size and paths are validated; stdout PASS text is not evidence.

receipt: none permits standalone execution without per-check evidence, but cannot authorize push. JSON product ran/success only means the product process was observed succeeding; outcome incomplete does not mean full CI verification.

### Optional plan and push policy

The descriptor may add plan: { entrypoint: quality/plan.mjs, dependencies: none }. Guard passes the same base/head/event plus --json; CI_LOCAL_GUARD_EVENT_CONTEXT contains event/ref/baseRef/headRef and optional PR context. Adapter stdout must contain only project-plan/v1 JSON: identity, changedFiles, eventContext, jobs and needsReview. Each job has unique id, boolean selected, reason and owners. changedFiles must match the Git ACDMRT diff exactly. Exit 0 corresponds to needsReview false, exit 2 to true.

--pr-action and --pr-fork true|false apply only to PR plan/with-plan and must be echoed unchanged. Guard does not infer unknown actions. Context is caller-declared, not Hosted event attestation.

A push hook additionally requires an explicit policy (illustrative only: main and unit are not Guard defaults):

```json
{
  "schemaVersion": "ci-local-guard/local-push-policy/v1",
  "scope": "project-declared-local-gates",
  "targetRefs": ["refs/heads/main"],
  "bindings": [{ "job": "unit", "owner": "unit", "checkIds": ["0:unit"] }]
}
```

Put this in descriptor.pushPolicy. Bindings must cover selected job/owner pairs, and required check IDs must freshly succeed. targetRefs explicitly permits targets; it does not discover protected branches. Success is local-policy-satisfied, **not full protection coverage or Hosted approval**.

pre-push uses Git's remote old SHA, not another branch. Missing old objects, new remote refs, missing policy, wrong identity, missing owners, external owners, review or failure block the operation. Deleted refs do not run product checks; the project plan selects checks. stdin is limited to 1 MiB/128 lines. There is no cryptographic external-owner acceptance.

```powershell
ci-local-guard install-hook --repo <project>
ci-local-guard uninstall-hook --repo <project>
```

Only the explicitly selected repository's local hook configuration is changed. Legacy ci-local-guard.modelCheckout settings are ignored; Guard never borrows their rules or deletes old user settings/caches automatically.

## Evidence, safety and agent use

- Preflight exit 0: product execution succeeded, coverage may be incomplete. Exit 1: execution/contract failure. Exit 2: unavailable/incomplete obligations/needs-review. Neither zero exit nor empty failedChecks proves all CI completed.
- --json stdout is one report; preflight child output stays in logs and diagnostics go to stderr. Failed plan raw output is neither retained nor echoed; the project owner inspects the adapter locally. See the README AI entry point for interpretation.
- checkoutObservation samples before/after HEAD, tree and tracked dirty state; drift rejects success. It excludes reverted transient changes, untracked/ignored files, mutable dependencies and Hosted provenance.
- Every execution is fresh; old caches/environment opt-ins cannot skip new failures. Normal completion cleans the isolated checkout and preserves necessary logs; interruption/cancellation cannot guarantee cleanup in every case.
- executionFailure distinguishes spawn, child exit/signal, logging, receipt and post-validation failures, retaining simultaneous causes. It does not infer root cause from log text. Do not retry to green.
- Optional protection manifests match declared responsibilities to local evidence only. Declared completeness does not verify Hosted required checks. The complete contract and negative cases are in src/project.mjs and tests/project.test.mjs.
- JSON/logs may contain private repository paths or script output: review before sharing. No automatic upload or environment/token enumeration; masking is not comprehensive leak prevention.

## CI timing analysis: independent of the product

```powershell
ci-local-guard collect-runs --repository example/project --workflow ci.yml > runs.json
ci-local-guard collect-run --repository example/project --run-id <id> --attempt <n> --workflow-id <id> --head <exact-SHA> > one-run.json
ci-local-guard inspect-runs --input runs.json
ci-local-guard audit-runs --input runs.json
ci-local-guard compare-runs --input comparison.json
```

Fixed github.com host, existing gh credentials and read-only Actions API. No raw logs, actors, billing, rerun/dispatch or workflow changes. API identity does not attest checkout, owner or Hosted policy. Exports cannot unlock push.

Minimal offline export (empty samples only validate input, not optimization conclusions):

```json
{
  "schemaVersion": "ci-local-guard/github-export/v1",
  "repository": "example/project",
  "runs": []
}
```

Each full export entry contains run and jobs: { total_count, jobs }, with exact attempt/head, complete bounded job pagination and timestamps checked. A comparison input uses run-comparison-input/v1; before/after are each complete exports, with at least two independent runs per side. Reruns are not independent samples.

Execution wall time and job-sum are separate; matched profiles permit descriptive differences only. Failures, cancellations and missing evidence are not silently excluded. Without proof of checkout, scope, cache, protection and intervention, attributable savings stays null. There are **no proven CI savings** today. Timing rankings start investigation; they do not authorize deleting responsibilities.
