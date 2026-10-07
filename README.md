---
status: public-experimental
as_of: 2026-10-08
owner: CI Local Guard maintainers
next_action: 驗證有界執行與自身接入，完成 CI 對照實驗、現行 IE 隔離接入與無歷史 AI 採用驗收；未驗不宣稱完成。
---

# CI Local Guard

給開發 AI／Agent 與人類審查者使用的 **本機 CI 預檢與 GitHub Actions 耗時診斷 CLI**。MIT 開源、零 npm runtime dependencies；不綁定特定應用程式。

**push 前檢查真正送出的 commit；用真實 CI runs 找出值得改善的耗時。必要保護不能減少。**

**主要使用者是開發 AI／Agent；人負責目標、審查與高風險決策。**工具負責執行、驗證與診斷；專案自己的 CI／scripts 決定哪些檢查不可省略。

**先選你的情境：**本機用 plan／preflight；CI 分析用 collect-run(s) → inspect-runs／audit-runs → compare-runs。兩條路徑獨立，收集 CI 不需要本機 adapter。

**採用底線：**實驗性工具，不代表安全保證。工具不是惡意程式 sandbox；必須信任被執行的專案程式。本機成功不是 Hosted CI 通過；耗時排名不是刪除檢查清單。private: true 僅阻止 npm registry 發布，不影響公開 clone。

| 你想解決的問題 | 可以先做什麼 | 需要什麼 |
|---|---|---|
| CI 太慢，不知道該先調查哪裡 | 讀取 run／job／step 時間與缺失證據 | 離線 export，或 gh 的 Actions 讀取權限；不需要 adapter |
| 推送前先抓到既有專案檢查的失敗 | 在 exact commit 執行專案預檢，保留失敗日誌 | 專案明確提交的 adapter／契約與 Git |
| 讓 AI 有依據地提 CI 改善建議 | 先診斷，再核對 workflow，最後比較前後獨立 runs | 人類目標與專案規則；不自動修改或放行 |

不適合：執行不可信專案、自動替代所有 Hosted checks、直接推算帳單或保證省費用。可先試診斷，再決定是否接入本機預檢；不用一次設定全部能力。

[快速試用](#五分鐘首次執行不登入不碰專案設定) · [交給你的 AI](#交給你的-ai可直接貼上) · [完整使用規則](#ai-操作入口) · [貢獻](CONTRIBUTING.md) · [問題回報](https://github.com/cablate/ci-local-guard/issues)

### English entry point

CI Local Guard is an experimental, MIT-licensed CLI for development agents and human reviewers. Run project-owned checks against an exact Git commit, or inspect GitHub Actions timing metadata without a project adapter. It does not replace hosted CI, sandbox untrusted code, or prove billing savings.

Use Node >=22.13.0 <23 and Git. Clone this public repository, then run `node cli.mjs --help`. The offline demo below requires no login or project configuration: it reports 60 seconds of execution wall time versus 80 job-seconds, with `savings: null`. User guidance is primarily Traditional Chinese; CLI help, JSON fields and [contributor guidance](CONTRIBUTING.md) are English. There is no npm registry package or versioned Release yet.

## 安裝

### 專案 AI 接入流程

1. 確認目標 repo、branch、HEAD、dirty state 與既有 agent 指令；先讀專案自己的檢查規則。
2. 執行 `node "<tool-directory>/cli.mjs" doctor --check --json --repo <project>`。此模式不下載、不登入、不執行 adapter；只核對 HEAD 設定及已安裝工具。`configured` 不代表依賴就緒或 checks PASS；exit 0／2／1 分別是 configured／unconfigured／blocked。
3. 未配置時，由專案 AI 提出最小 `.ci-local-guard.json` 與專案擁有的 adapter，包裝既有檢查。提交前先驗 adapter；不新增較弱的檢查，不把專案規則移入 Guard。完整契約見下方 AI 操作入口。
4. 在專案**既有** AGENTS／CLAUDE 等入口加短導航：何時用、工具位置取得方式、descriptor 與檢查 owner。不要複製整份 README 或提交個人絕對路徑；工具不自動改 agent 文件。
5. 開發中 dirty changes 先跑專案原生命令；獲准提交後，用明確 `--base`、`--head` 與 `--json` 建立 exact-commit 證據。缺依賴由專案準備，不自動安裝。
6. 讀取 identity、outcome、receipt、nextAction 與 unverified；失敗先診斷，不重試到綠。CI 診斷是獨立路徑，不需要 adapter。

本 repo 的導航是 AGENTS.md，descriptor 指向 quality/preflight.mjs；它執行 package.json 的完整測試契約，不再呼叫 Guard。通過仍只代表目前 OS 的本機檢查，Hosted 與另一 OS 未驗。

### 本輪 dogfood 狀態

採用入口、可靠執行與自身 adapter 正在實作／驗證。後續依序為自身 CI 單一變因實驗、現行 IE 獨立接入、無歷史 AI 驗收；尚不宣稱完成或節省。測試責任保持：真實 Git hooks、封裝安裝、exact checkout、receipt 身份、日誌與遮蔽，以及 Windows／Ubuntu。

執行逾時、SIGINT／SIGTERM 取消或輸出超限時，工具停止自己啟動的程序樹，不按名稱殺程序，也不重試。若程序終止或 checkout 清理無法確認，失敗 JSON 提供 `retainedCheckout`／`cleanupFailure`；先確認沒有活程序使用它，再人工處理。Windows 已退出父程序的孤兒、故意脫離群組的程序與強制關閉整個 Guard 程序不保證可清理；這不是 sandbox。逾時／取消後的殘留 receipt 不作成功證據。

### 安裝方式

Node >=22.13.0 <23；本機預檢需要 Git。唯讀 GitHub 收集需要既有 gh 與 Actions 讀取權限。不自動登入、不安裝專案依賴；npm runtime dependencies 為零。

先 clone 到獨立工具目錄，不必把工具的原始碼複製進應用程式。以下命令適用 PowerShell 與 POSIX shell：

```sh
git clone https://github.com/cablate/ci-local-guard.git
cd ci-local-guard
node cli.mjs --help
```

看到命令清單與 README 位置即可繼續；在其他工作目錄使用 `node "<tool-directory>/cli.mjs" ...`。目前是 source 分發，**不要使用 `npm install ci-local-guard` 或 `npx ci-local-guard`**：本專案未發布 registry 套件，不能保證同名套件是本工具。

<details>
<summary>可選：安裝本機 tarball 的 CLI 入口</summary>

在工具 clone 內跑 `npm pack --offline --ignore-scripts`，到自己選定的 consumer 目錄安裝產生的 tarball（以輸出的實際檔名為準）：

```sh
npm install "<absolute-tarball-path>" --offline --ignore-scripts --no-audit --no-fund --package-lock=false
```

Windows 用 `.\node_modules\.bin\ci-local-guard.cmd --help`；POSIX 用 `./node_modules/.bin/ci-local-guard --help`。不假設全域安裝，不執行 npm publish。

</details>

本工具 MIT 不取代 Node／Git／gh／actionlint／專案程式各自授權。package allowlist 不是完整 secret scanner。

## 五分鐘首次執行（不登入、不碰專案設定）

在剛才的 clone 內，建立一份**合成示範**：兩個平行 jobs，unit 20 秒、integration 60 秒。這不是本工具或任何真實專案的成效數據。

```sh
node --input-type=module -e "import {writeFileSync} from 'node:fs'; const head='a'.repeat(40); const start='2026-10-01T00:00:00Z'; const run={id:1,run_attempt:1,workflow_id:42,head_sha:head,head_branch:'main',head_repository:{full_name:'example/project'},event:'push',status:'completed',conclusion:'success',created_at:start,run_started_at:start}; const job=(id,name,end)=>({id,run_id:1,run_attempt:1,head_sha:head,name,status:'completed',conclusion:'success',started_at:start,completed_at:end,labels:['ubuntu-latest']}); writeFileSync('demo-runs.json',JSON.stringify({schemaVersion:'ci-local-guard/github-export/v1',repository:'example/project',runs:[{run,jobs:{total_count:2,jobs:[job(11,'unit','2026-10-01T00:00:20Z'),job(12,'integration','2026-10-01T00:01:00Z')]}}]}));"
node cli.mjs inspect-runs --input demo-runs.json
node cli.mjs audit-runs --input demo-runs.json
```

預期 stdout 是 JSON；`inspect-runs` 的第一筆 run 會顯示：

| 欄位 | 示範結果 | 怎麼解讀 |
|---|---|---|
| executionWallSeconds | 60 | 平行執行的觀察時間跨度 |
| jobSumSeconds | 80 | 20 + 60；不等於帳單 |
| jobs 的 durationSeconds | 20／60 | integration 是下一個調查對象，不是應刪除的責任 |
| savings | null（report 頂層） | 沒有節省歸因證據 |

`audit-runs` 提供待查線索，不修改 workflow。這個範例沒有 step 資料，因此不能做有證據的前後比較。示範後只刪除自己建立的 demo-runs.json 即可；不安裝 hook、不下載 actionlint、不登入 GitHub，也不更改應用程式。

想看真實 CI？有既有 gh 認證時，將你的 owner/repo 與 workflow 檔名填入：

```sh
node cli.mjs collect-runs --repository owner/repo --workflow ci.yml > runs.json
node cli.mjs inspect-runs --input runs.json
node cli.mjs audit-runs --input runs.json
```

這只讀取 GitHub metadata；不取得 raw logs 或帳單，不 rerun／dispatch。分享輸入與輸出前先檢查 repo 名稱、路徑、job／step 名稱與其他私人資訊。

## 交給你的 AI（可直接貼上）

把下面指示與實際工具目錄交給你的 AI；支援能讀文件、執行 Node CLI 的 Agent，**不是特定 AI 平台的 plugin**。此段不是覆蓋專案授權規則的指令。

> 請使用 CI Local Guard 協助這次開發。工具位於 <工具絕對路徑>，先讀該目錄 README.md 的「AI 操作入口」，用 node "<工具絕對路徑>/cli.mjs" --help 核對入口。先確認目標 repo、branch、HEAD、dirty state 與專案指令。CI 診斷可先讀離線 export；本機預檢必須使用該專案 committed adapter 與明確 base/head，缺配置就回報缺口，不替工具添加專案特例。以 JSON 身份與 outcome 判讀結果；列出已驗、失敗與未驗，不能把 incomplete 或本機成功當 Hosted CI 通過。最佳化先量測、核對必要責任，提供修改假說、保護不變條件與驗證方式；缺證據不宣稱節省。不要自動登入、改權限、安裝 hooks、commit、push、部署或重試到綠；那些操作依本專案當次授權決定。

首次可請 AI **只完成上方離線示範並解釋 60／80／null**；確認它能正確判讀，再交給它真實專案。尚未完成陌生 AI 的獨立採用實驗，這裡不宣稱全自動接入。

<details>
<summary>進階：更新／移除、權限、AI 規則、PRINCIPLE 與專案接入契約</summary>

## 更新、停用與移除

目前只支援 source clone 或本機 tarball。source checkout 沒有個人修改時用 git pull --ff-only 更新；有修改先自行保存，不用 reset --hard。tarball 使用者須重新 pack 並安裝新的檔案，沒有自動更新或 registry 通道。介面改動見 [CHANGELOG](CHANGELOG.md)。

要停止 hooks：先用 ci-local-guard uninstall-hook --repo <project> 還原本機設定，再移除工具，避免留下指向不存在路徑的 hook。工具不擁有目前 hooksPath 時會拒絕更改，應先查 git config --local --get core.hooksPath，不覆蓋別人的 hooks。

本機 npm consumer 移除方式：npm uninstall ci-local-guard --offline --ignore-scripts --no-audit --no-fund（在安裝目錄）。source 使用者於解除 hooks 後自行移除專用 clone。這些操作不會刪除專案的 .ci-local-guard.json、保留日誌、自訂日誌目錄或 actionlint cache；確認不再需要後，才刪除自己擁有的資料，不遞迴刪除 repo 的 .git。

## 資料、網路、隱私與環境變數

沒有內建遙測或自動上傳。collect-run(s) 透過現有 gh 向 github.com 發 GET；doctor 可能從 rhysd/actionlint GitHub Releases 下載與 hash 核對固定 binary。offline diagnostics 本身不連網。專案 adapter 是可信程式，其網路、費用、依賴與副作用由專案負責，工具不提供 sandbox。

| 變數 | 預設／用途 |
|---|---|
| CI_LOCAL_GUARD_BASE | 未設定；代替明確 --base，不猜分支。 |
| CI_LOCAL_GUARD_TIMEOUT_SECONDS | 子程序預設 900 秒；只能設 1..2147483 正整數。plan 保持既有 30 秒限制。 |
| CI_LOCAL_GUARD_LOG_DIR | 使用專案 git common directory 下 ci-local-guard/logs；可指定自己擁有的目錄。 |
| CI_LOCAL_GUARD_KEEP_LOGS | 未設定時清除成功的主執行 log；非空值保留。失敗與已收集的證據可能仍保留。 |
| CI_LOCAL_GUARD_CACHE | 家目錄 .cache/ci-local-guard；僅 actionlint binary cache，不是 PASS cache。 |
| ACTIONLINT_BIN | 未設定；可指定既有 binary，doctor 仍核對版本。 |
| CI_LOCAL_GUARD_EVENT／CI_LOCAL_GUARD_EVENT_CONTEXT | 工具傳給 adapter 的 event／JSON context；caller-declared，不是 Hosted attestation。 |

JSON 可含本機絕對路徑；日誌可含產品輸出。分享前檢查與遮蔽；環境值遮罩不是完整 secret scanner。

## 疑難排解與貢獻

| 症狀 | 先做什麼 |
|---|---|
| 找不到 CLI | source 用 node cli.mjs --help；consumer 用其 node_modules/.bin 入口，不假設全域安裝。 |
| 產品 unavailable | 讀 nextAction；確認 candidate commit 有 descriptor，不採用 dirty 配置。 |
| exit 0 但 incomplete | 列出實際成功項目與缺失責任，不改成完整 CI 通過。 |
| git／npm 找不到 | 檢查 PATH；測試需要 Git 與 Node 隨附 npm，不需要 gh 登入。 |
| checkout／receipt 不相符 | 先查身份與保留的 log；不略過核對或重試到綠。 |

開發、模組地圖、測試與回報方式見 [CONTRIBUTING](CONTRIBUTING.md)。一般 bug 回報附版本、OS、最小重現與去識別 report；不貼 token、私人資料或原始日誌。敏感漏洞請用已啟用的 [私下漏洞回報](https://github.com/cablate/ci-local-guard/security/advisories/new)，不要公開 exploit 或秘密。

## AI 操作入口

給使用者的 AI：先依任務選路徑，不必每次跑完所有命令。本文是工具使用規則的唯一入口；專案自己的 AGENTS.md／CLAUDE.md 或其他 Agent instructions 可連到本文，不需要複製整份契約。

| 你正在做什麼 | 下一步 |
|---|---|
| 改完程式，準備確認提交內容 | 使用下方本機預檢路徑；尚未提交的修改不會被 exact-head 預檢涵蓋。 |
| 想知道這次修改需要哪些 CI checks | 有 committed plan 才使用 plan；不能把預測當測試成功。 |
| CI 失敗，想調查原因 | 先讀實際失敗 job 的證據；本工具的 runs 分析不是 raw log 根因診斷器。 |
| CI 太慢／太貴 | 使用 CI 分析路徑，先量測，再提出不削弱必要保護的修改。 |
| 要把工具接進專案 | 先檢查既有 scripts 與 CI owner，再用專案契約接入；沒有配置就回報缺口，不建立工具內的專案特例。 |

### 本機預檢：先身份，再執行，再判讀

1. 確認目標 repo、branch、HEAD 與 dirty state，遵守該專案指令；不要因發現其他 checkout 有 adapter 就換過去。用 --help 確認當前工具入口。
2. 確認 candidate commit 已包含要驗的修改。base 應由這次比較／送出目標決定；不知道就向使用者確認，不猜 origin/dev、不偷偷 commit、fetch 或 push。明確指定 --repo、--base、--head。
3. 讀 candidate commit 的 .ci-local-guard.json，確認其程式可信。有 plan 用 preflight --with-plan --json；只有 preflight 用 preflight --json，並明示沒有驗 plan 的責任範圍。沒有配置：回報 unavailable，指出需接入專案既有檢查，不另造一套分類規則。
4. 儲存 stdout JSON 與 stderr 分開。核對 schemaVersion、identity 的 repo/base/head/event 是否為本次請求，再讀 outcome 與 product；無有效 report 時以執行失敗處理，不猜成功。
5. 依下表採取下一步；修正實際問題後才重跑相同或更新後的身份。candidate 改變時，舊結果不可拿來代表新 commit。

| 證據 | AI 應做什麼 |
|---|---|
| product.status: unavailable | 說明檢查沒有執行、缺少何種配置；不宣稱 CI 已通過。 |
| outcome: failed／exit 1 | 讀 executionFailure、failedChecks 與必要 log，區分產品、環境、契約或 checkout 問題；不要重試到綠。 |
| outcome: needs-review | 說明需要判斷的範圍，交由人審查；不自行把 needsReview 改成 false。 |
| 產品成功但 outcome: incomplete | 列已驗項目與尚缺責任；有 planObligations 時看 missing、各 owner 的 evidenceBlockers。缺失不等於應刪掉的檢查。 |
| push outcome: local-policy-satisfied | 只能說專案宣告的本機 gates 滿足；Hosted CI、完整保護、部署仍未驗。 |

不要只判 exit code：standalone preflight 的 exit 0 仍可是 incomplete。不要把無 plan 的執行成功當成所有 CI owners 都已涵蓋。

### CI 最佳化：資料 → 假說 → 授權修改 → 驗證

先由使用者目標確定 repository／workflow 與比較範圍。有 export 就離線 inspect-runs／audit-runs；沒有才用現有 gh 權限 collect-runs，或用 exact identity 的 collect-run。權限不足時回報缺口，不改權限或登入設定。

對耗時集中、失敗／取消、同 SHA 多 run 提出**待查假說**，回到該專案 workflow／scripts 核對責任、觸發條件與重複性；不要把耗時排名直接當刪除清單。提出修改時附保護不變條件、預期效益、回滾方式與驗證方法。在既有授權範圍內才修改專案，不自動 rerun／dispatch、發布或部署。

修改前後保留可比較的獨立 runs，使用 compare-runs；profile 不匹配、樣本不足或未知欄位應明示。分開 wall time 與 job-sum，沒有歸因證據就不聲稱省下多少 CI 成本。

### 讓使用者的 AI 找到工具

使用者可將以下短指示放進**自己專案既有的 Agent instructions**，填入實際安裝入口與 README 路徑；工具不會自動修改那些檔案：

> 本專案使用 CI Local Guard。涉及提交前預檢、push 檢查或 CI 耗時最佳化時，先閱讀 <安裝位置的 README.md> 的「AI 操作入口」，使用 <CLI 入口> --help 核對版本入口。專案 CI 規則以本專案 committed 契約與既有 CI/scripts 為準；本機結果不能當成 Hosted CI 通過。缺配置、owner 或身份證據時回報具體缺口，不跳過保護、不借其他專案規則。高風險操作遵守本專案的人類授權要求。

回報人類時只需要：**驗證對象、已完成檢查、失敗／未驗項目、證據位置、下一步**。分享前檢查私人路徑與日誌。安裝後 --help 指向隨包 README；產品成功仍可能 incomplete，失敗回報 failed，未配置回報 unavailable／exit 2。陌生 AI 的自主接入能力尚未驗證。

## PRINCIPLE：設計與最佳化原則

1. **兩層一起改善。**既要改善 CI Local 的速度、可靠性與使用成本，也要協助專案找出 CI 浪費；不要只把雲端成本搬到本機。
2. **保護優先於速度。**每個必要檢查都要有明確責任與適用情境。未知範圍、無法證明的比較基準或不相容規則，不能變成綠燈；應阻擋或明確要求審查。commit 前可先提醒，push 前才執行必要阻擋。
3. **專案規則是唯一權威。**重用專案的 simulator、preflight 與 CI 定義，不另養一套分類規則。工具負責串接、證據與診斷；不猜專案名稱、分支或腳本，不借其他 checkout 的規則。
4. **檢查真正送出的內容。**commit 檢查應區分 staged 與 working tree；push 的驗證對象是 exact SHA，不受 dirty worktree 影響。多分支、多 worktree、並行代理不得互相污染結果。
5. **先減掉工作，再加速工作。**先查重複觸發、重複責任與無關範圍，再看依賴初始化、產物重用、快取、檢查排序與平行化。無量測依據，不宣稱節省比例。
6. **快取必須能證明等價。**只重用適用於相同檢查輸入的成功證據；內容、base、規則、工具或相關環境改變時應失效。快取 miss 必須正常運作，並能強制重跑。無法涵蓋輸入時不啟用快取；一般應用程式 preflight 預設重跑。
7. **分開衡量快、省與可信度。**分別看回饋 wall time、runner 執行時間總和、本機資源及儲存／傳輸負擔。平行化變快不代表更省；預測不是帳單，也不是 hosted PASS。
8. **失敗要能處理。**區分產品檢查失敗、環境不足與證據過期；交代檢查了什麼、跳過什麼、理由與下一步。保留必要日誌，正常失敗可清理，取消／中斷需獨立驗證。
9. **診斷、提案、執行分開。**診斷結論需對應規則與代表性真實 runs；提案需含保護不變條件、效益、風險、回滾與驗證。部署、真實付費、權限、秘密與不可逆操作需要當次授權，不自動修改 hosted 設定。
10. **最小且可維護。**每個檔案有入口、測試或明確責任；不為少檔案硬併責任，也不為未來想像先造框架。現況與下一步只在 README，歷史只保留仍影響判斷的證據。

## 現有能力與邊界

| 入口 | 責任與邊界 |
|---|---|
| plan | 從 exact head 的 committed adapter 預測 RUN／SKIP／review；必須明確 base、head。不執行產品檢查、不代表 CI 覆蓋完整。 |
| preflight | 每次在隔離 exact checkout fresh 執行產品預檢；必須明確 base，head 預設 HEAD。缺配置回傳 unavailable／2；不是完整 push gate。 |
| preflight --with-plan | 同一 checkout 的 plan 與 receipt owner 對照；缺責任仍 incomplete／2，review 為 needs-review／2。 |
| pre-push | 只接受明確 committed pushPolicy、plan、receipt；逐 ref 使用 remote old SHA → pushed SHA。缺證據或 review 阻擋。 |
| pre-commit | 只跑 staged whitespace check；不猜產品規則、不拿 working tree 模擬 staged CI。 |
| install-hook／uninstall-hook | 明確安裝／還原本機 core.hooksPath；拒絕覆蓋活躍 custom hooks，worktrees 可能共用設定。 |
| doctor | 準備並驗證固定版本 actionlint；首次可能下載。不是產品驗證或完整環境診斷。 |
| collect-runs／collect-run | gh API 唯讀 GET；核對 repo／workflow／run／attempt／head，收集完整 bounded jobs，輸出 export JSON。 |
| inspect-runs | 離線核對 export、run attempt 身份、wall time 與 job-sum，保留缺失證據。 |
| audit-runs | 離線列耗時集中、失敗／取消與 same-SHA 多 run；耗時大不等於浪費，多觸發不等於重複保護。 |
| compare-runs | before／after 的獨立 samples 與 profile 對照；僅描述性差值，不宣稱可歸因節省或帳單省額。 |

共 12 個命令。沒有舊 check 入口、專案命名腳本猜測、origin/dev 預設、外部 model checkout、Classroom／Staging 預覽或 PASS cache。沒有配置時不 fallback；generic 專案缺明確 push 契約時不支援 pre-push 放行。

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
- --json 的 stdout 是一份 report；child output 留日誌，diagnostics 在 stderr。操作與判讀順序見「AI 操作入口」。
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

</details>

## 驗證、限制與發布狀態

MIT；GitHub 已公開。Windows／Ubuntu 的 [GitHub CI](https://github.com/cablate/ci-local-guard/actions) 執行完整測試（最新結果與數量以連結為準），包含離線安裝／移除、Git hook、exact checkout、receipt、遮罩與失敗阻擋。workflow 使用 SHA-pinned actions、唯讀 token、不保留 checkout 認證。macOS／arm64 尚未驗證。

公開前 22 個候選檔案的靜態安全審查沒有可報告漏洞；不包含 Git 歷史、遠端權限或動態 exploit 驗證，不是安全保證。其後修正了 Hosted 發現的日誌交錯與 Windows 路徑測試，並新增回歸測試。工具不是 sandbox，adapter 與 actionlint cache 必須可信；遮罩只是 best effort，日誌不保證 stdout／stderr 的全域時間順序。

敏感漏洞請用 [GitHub 私下漏洞回報](https://github.com/cablate/ci-local-guard/security/advisories/new)，非敏感問題用 [Issues](https://github.com/cablate/ci-local-guard/issues)。不要公開私人路徑、token 或原始日誌。

沒有 tag、Release 或 npm 發布；package.json 的 private:true 僅阻止 registry 發布。CI 節省與陌生 AI 採用成效仍未證明。下一步以真實使用回饋改善工具，不新增專案耦合或自動放行。

## 如何分享與回報採用經驗

可直接分享 [repo](https://github.com/cablate/ci-local-guard)，邀請對方先跑離線示範，不要求提供私人 CI 或安裝 hooks。下面是可直接貼出的介紹，不是成效承諾：

> CI Local Guard 是給開發 AI／Agent 與人類審查者使用的 MIT 開源 CLI：在 exact commit 跑專案自己的預檢，或讀取 GitHub Actions 耗時資料，協助找出值得調查的 CI 問題。不綁定應用程式、不自動改 CI；本機成功不等於 Hosted 通過，也不宣稱未證明的節省。先 clone 跑五分鐘離線示範，不需登入：https://github.com/cablate/ci-local-guard

> CI Local Guard is an experimental MIT CLI for development agents and human reviewers: exact-commit project preflight and read-only GitHub Actions timing diagnostics. No app-specific rules, automatic CI changes, or claims of proven cost savings. Try the offline demo without signing in: https://github.com/cablate/ci-local-guard

歡迎在 [Issues](https://github.com/cablate/ci-local-guard/issues) 回報：你想完成的工作、source/package 版本、OS 與 Node/Git 版本、使用哪條路徑、在哪一步卡住、預期與實際結果、最小合成重現。一般分享回饋不需要原始日誌或私人 repo 存取權；敏感資訊改走私下漏洞回報。

目前可以分享給願意試用實驗性工具的使用者；尚未證明陌生 AI 能自主完成 adapter 接入、實際 CI 節省、macOS／arm64、完整 Hosted equivalence。不要把它推廣成一鍵替代 CI 或已成熟的跨平台產品。
