---
status: scope-reduced-private-candidate
as_of: 2026-10-07
owner: CI Local Guard maintainers
next_action: 以陌生 AI 的首次採用驗證下列操作引導；先檢查是否找得到入口、能判讀未完成與失敗，不增加專案耦合或 Agent 框架。
---

# CI Local Guard

獨立 private repository：[cablate/ci-local-guard](https://github.com/cablate/ci-local-guard)。本工具有自己的 Git 歷史與 origin，不依賴父層 workspace；仍未公開或 registry 發布。

**push 前檢查真正送出的 commit；用真實 CI runs 找出值得改善的耗時。必要保護不能減少。**

**主要使用者是開發 AI／Agent；人負責目標、審查與高風險決策。**工具只負責執行、驗證與診斷。哪些檔案需要哪些檢查，由使用它的專案自己定義；IE、Synora 或其他應用程式不是工具的內建依賴。

**先選你的情境：**本機用 plan／preflight；CI 分析用 collect-run(s) → inspect-runs／audit-runs → compare-runs。兩條路徑獨立，收集 CI 不需要本機 adapter。

**採用底線：**MIT private 候選；正式安全掃描未開始，沒有公開發布安全放行。private: true 仍保留。工具不是惡意程式 sandbox；必須信任被執行的專案程式。未授權發布、push 或更改 Hosted 設定。

## 安裝

Node >=22.13.0 <23；本機預檢需要 Git。唯讀 GitHub 收集需要既有 gh 與 Actions 讀取權限。不自動登入、不安裝專案依賴；npm runtime dependencies 為零。

```powershell
node cli.mjs --help
npm pack --offline --ignore-scripts
# 在獨立 consumer 目錄安裝產生的 tarball，不是 registry publish：
npm install "<tarball-path>" --offline --ignore-scripts --no-audit --no-fund --package-lock=false
.\node_modules\.bin\ci-local-guard.cmd --help
```

本工具 MIT 不取代 Node／Git／gh／actionlint／專案程式各自授權。package allowlist 不是完整 secret scanner。

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

回報人類時只需要：**驗證對象、已完成檢查、失敗／未驗項目、證據位置、下一步**。分享前檢查私人路徑與日誌。獨立 consumer 的 offline package 路徑已驗證：從安裝後 --help 找到可讀的 README；產品成功仍回報 incomplete；失敗回報 failed；未配置回報 unavailable／exit 2 並指向安裝後文件與接入下一步，原 dirty source 保留。Windows 相關 51 項、Linux 全套 94 項通過。這是實際 CLI／consumer 驗證；陌生 AI 是否能自行完成接入仍未驗，不當成已驗證的 Agent 整合。

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

## 目前驗證與刪減狀態

已移除七個擴張命令、PASS cache、下游部署預覽；本輪再移除硬編碼專案 adapter、分支分類、外部 model fallback 與 check 入口。工具檔案不存應用程式規則；測試 fixture 明確提供自有契約。

先前 Windows／Debian Linux 的 source、offline package、exact checkout、receipt 與失敗阻擋已有驗證。本輪去耦合後 Windows／Debian Linux 全套均 94/94 通過（包含 offline package 與真實 Git hook fixture）。真實未配置專案回傳 unavailable／exit 2、push blocked／exit 1；已配置專案的三項 bounded checks 成功、receipt validated、checkout matched，缺完整 release／CodeQL 仍 incomplete／exit 2。兩個來源 checkout 狀態與 worktree 清單保持不變；macOS／arm64、完整真實應用 CI、Hosted equivalence 與公開安全放行仍未驗。

不為消除 coupling 去修改應用程式。原本靠隱含 adapter 的專案會變為 unavailable／push blocked，必須由該專案明確提交契約後才能採用；不保留另一套隱藏相容層。
