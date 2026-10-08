# CI Local Guard 契約參考
[English](reference.md)

進階契約與限制；首次採用先讀 [README](../README.zh-TW.md)。

## 專案契約：規則由專案擁有

在**使用工具的專案**提交 .ci-local-guard.json 與自己的腳本；工具 repository 不放應用程式 adapter。只讀 candidate commit 的 descriptor，不採信 dirty／staged 版本。最小 standalone 配置：

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

entrypoint 是 repo 內 regular JS 檔案；拒絕 shell command、逃逸路徑、symlink／linked directory。dependencies 目前只接受 none：不代表產品不需依賴，而是專案必須自行準備／驗證；工具不自動 npm ci。lockfile 位元組相同時可能連結來源 node_modules，因此 checkout 並非完全不可變環境。

```powershell
ci-local-guard preflight --repo <project> --base <base-ref> --head <candidate-ref> --event push --json
ci-local-guard plan --repo <project> --base <base-ref> --head <candidate-ref> --event push --ref refs/heads/main --json
ci-local-guard preflight --repo <project> --base <base-ref> --head <candidate-ref> --event push --ref refs/heads/main --with-plan --json
```

base 只來自 --base 或 CI_LOCAL_GUARD_BASE，不猜目標分支、不 fetch。plan 必須有 --head，不支援 working-tree 模式。event 可為 pull_request／push／workflow_dispatch。

### Preflight 回傳

工具用同一 Node 執行 entrypoint，傳 --base、--head、--event；cwd 是隔離 checkout，CI_LOCAL_GUARD_EVENT 反映 event。產品可輸出日誌；guard-v1 要寫 tmp/preflight/project-report.json：

- schemaVersion：ci-local-guard/project-preflight/v1。
- identity：傳入的 exact base、head、event，加 mode: committed。
- changedFiles：宣告的 changed paths；--with-plan 還會與 plan 的 exact diff 核對。
- checks：唯一 id、owner、why、status、result、durationMs、log、blockedBy。
- outcome：incomplete 或 failed；不能自行宣稱 local-complete。
- unverified：尚未驗證的層次。

成功 check 為 status: ran、result: success、非負 durationMs，log 為 receipt 目錄內的相對日誌路徑；失敗與 child exit 必須一致。external-owner／unavailable 不可當成功。收據與日誌會核對身份、大小與路徑，不以 stdout 的 PASS 文字判斷。

receipt: none 可以做 standalone 執行，但沒有逐項證據，不可配置 push 放行。JSON report 的 product ran/success 只表示已觀察到產品程式成功；outcome incomplete 不等於完整 CI 已驗。

### 可選 plan 與 push policy

descriptor 可加 plan: { entrypoint: quality/plan.mjs, dependencies: none }。工具傳相同 base/head/event，加 --json；CI_LOCAL_GUARD_EVENT_CONTEXT 包含 event/ref/baseRef/headRef（與可選 PR context）。adapter stdout 必須只有 project-plan/v1 JSON：identity、changedFiles、eventContext、jobs、needsReview。每個 job 有唯一 id、selected 布林、reason、owners；changedFiles 必須精確符合 Git diff 的 ACDMRT 路徑。exit 0 對應 needsReview false；exit 2 對應 true。

--pr-action 與 --pr-fork true|false 只適用 PR plan／with-plan，adapter 必須原樣 echo；未知 action 不由工具推測。context 是 caller-declared，不是 Hosted event attestation。

要安裝 push hook，另加明確 policy（以下僅示意，不代表 main 或 unit 是工具預設）：

```json
{
  "schemaVersion": "ci-local-guard/local-push-policy/v1",
  "scope": "project-declared-local-gates",
  "targetRefs": ["refs/heads/main"],
  "bindings": [{ "job": "unit", "owner": "unit", "checkIds": ["0:unit"] }]
}
```

將其放在 descriptor.pushPolicy；bindings 必須涵蓋 selected job/owner，指定的 check IDs 必須 fresh 成功。targetRefs 僅為明確允許的目標，不自行辨識 protected branch。成功為 local-policy-satisfied，**不是完整保護覆蓋或 Hosted 批准**。

pre-push 讀 Git 提供的 remote old SHA，不改用其他分支。缺 old object、新 remote ref、無政策、錯誤身份、owner 缺失、external owner、review 或失敗均阻擋。刪除 ref 不執行產品檢查；是否選中檢查由專案 plan 決定；stdin 上限 1 MiB／128 行。沒有 cryptographic 外部 owner 接納功能。

```powershell
ci-local-guard install-hook --repo <project>
ci-local-guard uninstall-hook --repo <project>
```

只改明確目標 repo 的本機 hook 設定；不自動修改其他專案。舊 ci-local-guard.modelCheckout 設定被忽略，不再借它的規則；不自動刪除使用者原有設定或舊 cache 檔案。

## 證據、安全與 Agent 使用

- 預檢 exit 0：產品執行成功但可能覆蓋不完整；exit 1：執行／契約失敗；exit 2：unavailable／incomplete obligations／needs-review。不要只看 exit 0 或空 failedChecks 判定全部 CI 完成。
- --json 的 stdout 是一份 report；preflight child output 留日誌，diagnostics 在 stderr。plan 失敗的原始輸出不保留、不回印，改由專案 owner 在本機檢查 adapter。操作與判讀順序見「AI 操作入口」。
- checkoutObservation 是工具採樣的前後 HEAD／tree／tracked dirty state；drift 拒絕成功。它不涵蓋短暫改動後還原、untracked／ignored、mutable dependencies 或 Hosted provenance。
- 每次 fresh 執行；舊 cache／環境 opt-in 不可跳過新失敗。正常結束清理隔離 checkout、保留必要 logs；中斷／取消不能一概保證清理。
- executionFailure 區分啟動、child exit／signal、日誌、receipt、後驗證；同時失敗全部保留，不從 log 文字推斷根因。不要自動重試到綠。
- 可選 protection manifest 只對照專案宣告與本機證據；宣告完整不等於 Hosted required checks 已核對。完整 contract 與負面案例見 src/project.mjs、tests/project.test.mjs。
- JSON／logs 可能含私人 repo 路徑或腳本輸出；分享前人工檢查。不自動上傳、不列環境或 token；秘密遮罩不是完整防洩漏保證。

## CI 耗時分析：不耦合產品

```powershell
ci-local-guard collect-runs --repository example/project --workflow ci.yml > runs.json
ci-local-guard collect-run --repository example/project --run-id <id> --attempt <n> --workflow-id <id> --head <exact-SHA> > one-run.json
ci-local-guard inspect-runs --input runs.json
ci-local-guard audit-runs --input runs.json
ci-local-guard compare-runs --input comparison.json
```

固定 github.com、既有 gh 認證、唯讀 Actions API；不拿 raw logs、actor 或 billing，不 rerun／dispatch／改 workflow。API identity 相符不代表 checkout／owner／Hosted policy 已驗，不接受 export 解鎖 push。

最小離線 export（空樣本只驗證輸入，不產生最佳化結論）：

```json
{
  "schemaVersion": "ci-local-guard/github-export/v1",
  "repository": "example/project",
  "runs": []
}
```

完整 export 的每筆包含 run 與 jobs: { total_count, jobs }；核對 exact attempt/head、complete job 分頁與時間。compare input 為 run-comparison-input/v1，before／after 各是完整 export，至少各兩個獨立 runs；rerun 不當獨立 sample。

分開 execution wall time 與 job-sum；相同 profile 才給描述性變化。失敗／取消／缺證據不默默排除。checkout、scope、cache、保護與 intervention 沒有證明，attributable savings 固定 null；現在**沒有已證明的 CI 節省**。耗時排名是調查起點，不是自動刪除責任的理由。


