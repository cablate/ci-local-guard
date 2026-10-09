# CI Local Guard 使用指南
[English](reference.md)

這份文件說明怎麼接入專案、讀取結果，以及更新或移除工具。想先了解它能做什麼，請看 [README](../README.zh-TW.md)。

範例中的 <project>、<commit> 是佔位符，請換成要檢查的專案路徑與 Git 版本。以 ci-local-guard 開頭的指令假設你已安裝命令；如果是下載原始碼，就改用 node 加上 cli.mjs 的完整路徑。

- [看懂、檢查與重播 CI](#看懂檢查與重播-ci未發布)
- [接入專案](#接入專案)
- [讀取報告](#讀取報告)
- [讀取失敗日誌](#讀取失敗日誌)
- [分析 CI 耗時](#分析-ci-耗時)
- [更新或移除工具](#更新停用與移除)
- [疑難排解](#疑難排解)

## 看懂、檢查與重播 CI（未發布）

這些命令已加入開發版原始碼，v0.1.1 尚未提供，也都不需要專案 adapter。AI Agent 的典型用法：

1. 先跑 ci discover，了解 CI 會跑什麼、哪些能在本機跑。
2. 修改期間，直接在工作目錄執行它列出的 CI 命令。
3. 提交後、推送前，執行 ci verify。要細看某一部分時，再用 ci check 或 ci replay。
4. 回報哪些已在本機通過、哪些預期會失敗、哪些仍需要 Hosted CI。
5. 如果 GitHub 上的 run 仍然失敗，用 ci locate 找出失敗的 step 與測試。

### 推送前檢查 commit

```sh
node "<tool-directory>/cli.mjs" ci verify --repo "<project>" --summary --output <new-report.json>
```

verify 回答一個問題：這個 commit 推上去，什麼會失敗？它依 branch、tag、path 篩選判斷這次 push（或 --event pull_request）會觸發哪些 workflows，執行靜態檢查，再重播每個會被觸發的 Linux job leg。被重播 job needs 的 jobs 會一併執行。變更檔案來自 --base（push 預設為分支的 upstream，pull_request 預設為 origin 的預設分支）；判斷不了時，有 path 篩選的 workflow 標為未知，仍會檢查。

verdict 是一句話的總結。expectedFailures 列出靜態 findings 與重播失敗的 step，附命令與 log 位置。passedLocally 列出已重播通過的 leg。hostedOnly 列出只有 GitHub 能檢查的部分：Windows 或 macOS runner、用到 secrets 或部署環境的 jobs。notVerified 列出本機無法檢查的項目與原因，例如缺 act，或只被呼叫的 reusable workflow。notTriggered 列出這個事件不會啟動的 workflows，以及排除它的篩選條件。

| 結果 | 意義 | Exit |
|---|---|---|
| clear-locally | 本機能檢查的都通過；hostedOnly 仍需 GitHub 驗證 | 0 |
| expected-to-fail | 有靜態 finding 或重播的 step 失敗 | 1 |
| blocked | 輸入無效或沒有 workflows | 2 |
| incomplete | 有本機檢查無法執行或完成；見 notVerified | 3 |

--static-only 跳過重播，做快速檢查。重播選項 --platform、--pull、--timeout、--act-binary 會直接傳下去。

### 量測失敗的代價

```sh
node "<tool-directory>/cli.mjs" ci history --repo "<project>" --workflow ci.yml --limit 50 --save-export <new-export.json> --summary
node "<tool-directory>/cli.mjs" ci history --repo "<project>" --workflow ci.yml --input <new-export.json> --reproduce --summary
```

history 用 gh 唯讀讀取一個 workflow 已完成的 runs，包含被重跑取代的較早 attempts。baseline 列出成功 run 的等待時間（中位數與 p90）與各 job 的中位耗時，可以看出是哪個 job 決定了等待時間。failures 列出失敗的 attempts 數，以及它們耗掉的等待時間與計費分鐘。計費分鐘把每個 job 進位到整分鐘，不含 runner 倍率與免費額度，只能當估計值。

--reproduce 會對每個失敗的 commit 執行 ci verify（最多 --reproduce-limit 個，預設 5），並把每個失敗的 Hosted job 分類：

- reproduced-locally：同一個 job 在本機也失敗，推送前的 verify 能抓到。
- passed-locally：本機重播通過，可能是環境差異或不穩定的測試。
- outside-local-coverage：這個 job 需要本機重播沒有的 runner 或 secrets。
- undetermined：無法對應或檢查這個 job，會附上原因。

baseline.speedLeads 指出時間花在哪裡：最後完成的 job（它決定等待時間）、占掉大部分時間的 step、準備步驟的比例，以及耗時差很多的 matrix legs。每項都附數字並說明下一步該量什麼，都不是已證明的節省。要看測試 step 內部，加上 --test-timing "<job 名稱>" --compare-job "<另一個 job>"：history 會讀該 job 最近幾次成功 run 的 log（--samples，預設 3），從 TAP 輸出取得測試耗時，列出最慢的測試、和另一個 job 的倍數，以及這個 step 實際的平行程度。

avoidable 加總第一類的 attempts、等待時間與分鐘數。--save-export 保存下載的資料，之後用 --input 就不必重抓。結果為 measured（exit 0）或 blocked（exit 2）。

### 定位 GitHub 失敗的 run

```sh
node "<tool-directory>/cli.mjs" ci locate --repo "<project>" --summary
node "<tool-directory>/cli.mjs" ci locate --repo "<project>" --run <run-id> --summary
```

locate 用 gh 唯讀讀取 run 的 jobs，以及失敗 jobs 的 log。預設取 HEAD commit 的所有 runs；--head 指定其他 commit，--workflow 只看一份 workflow 檔，--run（可加 --attempt）指定一個 run。每個失敗的 job 會列出失敗的 step、對應的 workflow 行號與命令、錯誤標註，以及最後幾行輸出。如果該 step 有 TAP 輸出，failedTests 會列出每個失敗測試的檔案與行號、assertion 失敗的那一行，以及錯誤訊息的前幾行（包含實際值與預期值）。

失敗 job 的 log 會存在 .git/ci-local-guard/hosted-logs，下次直接重用。報告不包含整份 log，而是給出該 step 區段與每個失敗測試的 read-evidence 參數，讓 AI 只讀需要的部分。nextActions 也會建議要打開的 workflow 行、本機與 runner 是同一種 OS 時可直接執行的命令、Linux job 對同一個 commit 的 ci replay，以及再次推送前的 ci verify。如果 run 對應的 commit 與你的 HEAD 不同，也會註明。

| 結果 | 意義 | Exit |
|---|---|---|
| passed | 選定的 runs 沒有失敗的 job | 0 |
| located | 每個失敗的 job 都在 log 中定位到 step | 1 |
| blocked | 輸入無效、找不到 GitHub repository，或 gh 失敗 | 2 |
| incomplete | log 缺失、log 中找不到該 step、run 仍在執行，或這個 commit 沒有 runs | 3 |

失敗資訊是觀察到的輸出，不是診斷出的原因。準備步驟失敗會標為 runner-setup，因為原因不一定是專案的修改。

### 檢查 workflow 修改

```sh
node "<tool-directory>/cli.mjs" ci diff --repo "<project>" --summary
node "<tool-directory>/cli.mjs" ci diff --repo "<project>" --base <ref> --head <ref> --summary
```

diff 比較兩個 commit 已提交的 workflows，回答：同一個事件、同一組變更檔案下，CI 是否檢查得比較少？沒給 --base 時，比較 HEAD 與它從 origin 預設分支分出來的那一點。對 push 與 pull_request 的篩選條件，它把每個追蹤中的檔案單獨當成一次變更，分別試推送到預設分支、推送到其他分支、推送 tag，以及發 pull request 到預設分支或其他分支。接著比較 jobs、matrix legs、runner、if 與 continue-on-error 設定，以及每個 job 執行的命令（包含本機 composite action 的 steps）。

每項變更都有一個效果：

- reduced：CI 檢查變少，例如刪掉 matrix leg、branch 或 path 篩選變窄、job 加上 if: false、刪掉命令，或改成 continue-on-error: true。
- unknown：運算式或 if 條件改了，無法求值。
- review：執行內容改了但涵蓋沒有變少，例如換 runner 或修改命令。
- added 與 neutral：涵蓋增加，或改名、命令移到其他 job、action 版本更新。

| 結果 | 意義 | Exit |
|---|---|---|
| unchanged | 沒有影響 CI 執行內容的 workflow 修改 | 0 |
| no-reduction | 有修改，但沒有一項減少涵蓋 | 0 |
| reduced | 至少一項修改讓 CI 檢查變少；每項都附行號 | 1 |
| blocked | 輸入無效或找不到 revision | 2 |
| undetermined | 沒發現減少，但有修改無法求值 | 3 |

減少可能是刻意的，例如只改文件時不跑 CI。報告把它列出來，讓 AI 先跟使用者確認，而不是事後才發現。想比較實際執行結果時，nextActions 會建議用 ci replay 在兩個 commit 上重播受影響的 job。

### 探索 CI

```sh
node "<tool-directory>/cli.mjs" ci discover --repo "<project>" --summary
```

探索讀的是已提交版本（HEAD 或 --head），不讀未完成的修改。每份 GitHub 頂層 workflow 會列出觸發事件、jobs、needs、matrix 數量，以及各 step 的 run 命令與行號。ciCommands 把這些命令去重列出，並標出它們呼叫的 package scripts，讓 AI 沿用專案自己的檢查，不必猜。每個 job 會標成可重播、只能靠 Hosted（例如 Windows、macOS runner），或無法判定（reusable workflow、動態 matrix、runs-on 運算式）。

tools 欄位顯示 actionlint、zizmor、act、Linux Docker engine 與 gh 是否可用；只會執行它們的版本命令。nextActions 以參數陣列給出下一步命令。只會主動建議重播 pull_request 會觸發的 workflow，因為發布或部署 workflow 可能有副作用。GitLab、Jenkins、Woodpecker、Nx、Turborepo、Dagger、Earthly、Bazel 的根目錄設定只列出、不分析。workflow 結構是 YAML 宣告的內容：觸發條件、if 與運算式都不會求值。

### 靜態檢查 workflow

```sh
node "<tool-directory>/cli.mjs" ci check --repo "<project>" --head <commit> --provider actionlint --summary --output <new-report.json>
node "<tool-directory>/cli.mjs" ci check --repo "<project>" --head <commit> --provider zizmor --binary "<absolute-tool-path>" --summary --output <another-new-report.json>
```

目前支援 actionlint 1.7.12 與 zizmor 1.30.1，不自動下載工具。actionlint 使用 Guard 既有快取或 ACTIONLINT_BIN；zizmor 接受 ZIZMOR_BIN。兩者都可用 --binary 明確指定絕對路徑。版本相符不代表執行檔可信：請從官方來源取得，並在執行前核對 checksum。

檢查只把已提交的頂層 workflow blobs 複製到暫存目錄，不執行 Git checkout hooks、smudge filters、專案測試或 workflows。這是工具基準掃描：不載入專案的工具設定、停用 zizmor 行內忽略規則，也停用 actionlint 的 ShellCheck／pyflakes 整合。每次檢查共用 30 秒期限，最多接受 128 份 workflows（每份 1 MiB、總計 8 MiB）；超限或輸出格式錯誤都不算通過。--summary 最多顯示 20 項 findings 並列出總數。

### 在本機重播 job

```sh
node "<tool-directory>/cli.mjs" ci replay --repo "<project>" --workflow .github/workflows/ci.yml --job test --matrix os:ubuntu-latest --summary --output <new-report.json>
```

重播會用 [act](https://github.com/nektos/act) 0.2.89，在本機 Linux 容器中執行已提交 workflow 的一個 job，以及它 needs 的 jobs。需要 act（在 PATH、ACT_BIN，或用 --act-binary 指定）與本機 Linux Docker engine。重播會執行專案程式碼，請只用在信任的 repo。

| 選項 | 意義 |
|---|---|
| --head | 要重播的 commit，預設 HEAD；不含未提交的修改 |
| --event | push（預設）、pull_request 或 workflow_dispatch；必須是 workflow 宣告過的事件 |
| --matrix key:value | 選擇 matrix leg，可重複；沒選到的 leg 列在 coverage.notSelected |
| --platform label=image | 指定 runs-on label 使用的 image。預設把 ubuntu-latest、ubuntu-24.04、ubuntu-22.04 對應到 catthehacker/ubuntu act images |
| --pull | 允許下載缺少的 image；沒加時缺 image 會停止 |
| --offline | job 容器不給網路；預設使用本次建立的專用網路 |
| --timeout | 幾秒後停止；預設 CI_LOCAL_GUARD_TIMEOUT_SECONDS 或 900 |
| --ref | 事件的 branch 或 tag ref，預設目前分支；記錄為呼叫端宣告 |

重播會隔離與不會隔離的部分：

- 從獨立 checkout 重播指定 commit，不連結工作目錄的依賴。
- secrets、variables、inputs 與 .env 都是空的，不傳 GitHub token，也不讀環境中的 .actrc 與 act 設定。
- 不掛載 Docker socket、關閉 cache server，job 容器以 init 程序啟動，孤兒程序會像在 Hosted VM 上一樣被回收。
- image、預裝工具與權限都和 GitHub Hosted runner 不同。job 用到的 actions 第一次可能需要下載。

執行前，Guard 會算出 act 這些 jobs 會用到的所有 container、network、volume 名稱，只要有任何一個已存在就停止。結束後（包含逾時或 Ctrl-C），只移除標上本次 label 的容器、名稱完全相符的資源，以及這些容器的匿名 volumes。不做 prune，也不用前綴比對。act 共用的 act-toolcache volume 與下載的 images 會保留，列在 resources.shared。若無法確認 act 已終止，不會刪任何東西，結果為 incomplete。如果 Guard 程序本身被強制結束，資源會留下；它們都標有 ci-local-guard.run label，下次重播同一個 job 時會以 docker-resource-collision 停止並列出這些資源。setup action 安裝的工具（例如 Python、Java）保存在 act-toolcache，只有第一次重播需要下載。執行中斷時，execution.lastActivity 會指出最後有輸出的 step，以及它已經多久沒有輸出。

| 結果 | 意義 | Exit |
|---|---|---|
| passed | job 所有選定 leg 都成功，且清理已確認 | 0 |
| failed | 有 workflow step 失敗 | 1 |
| blocked | 缺輸入、act、Docker、image，或資源名稱已被占用；沒有執行 | 2 |
| incomplete | 逾時、取消、workflow step 以外的 job 失敗，或清理未確認 | 3 |

step 失敗時，failures 會列出 job、matrix leg、step 名稱、workflow 行號、run 命令、輸出的最後幾行，以及 TAP「not ok」測試名稱。這些是觀察到的輸出，不是診斷出的原因。evidence.reader 是讀取保留 log 中該 step 區段的 read-evidence 參數。nextActions 會建議讀該區段、打開 workflow 那一行、在工作目錄執行該命令，並在提交修正後再重播。通過只涵蓋 coverage.replayed；coverage.notReplayed 與 coverage.notSelected 要在 Hosted CI 確認。

報告使用 ci-local-guard/ci-inventory/v1、ci-local-guard/ci-check/v1、ci-local-guard/ci-replay/v1、ci-local-guard/ci-locate/v1 與 ci-local-guard/ci-diff/v1。閱讀 outcome 時也要看 identity、scope、coverage、issues。執行最佳化實驗仍在規劃，尚未實作。既有命令的 schemas 與 exit codes 不變。

## 接入專案

Guard 沿用專案原本的測試。接入時要做的，是把這些測試接到工具上：

| 名稱 | 用途 |
|---|---|
| Descriptor（設定檔） | .ci-local-guard.json，告訴 Guard 要跑哪個腳本 |
| Adapter（接入腳本） | 放在專案裡，呼叫既有檢查並回報結果 |
| Receipt（檢查紀錄） | 腳本產生的 JSON，記錄測了哪個版本、哪些檢查 |
| Plan（檢查計畫） | 選用腳本，決定這次修改需要哪些檢查 |

### 給 AI 的接入步驟

1. 先讀專案指引、現有 CI 與測試腳本，確認 repo、分支、HEAD 和未提交的修改。找到工具實際安裝位置；要檢查的是使用者的專案，不是 plugin 目錄。
2. 執行下方 doctor --check。capabilities 會列出可用指令、已知缺項與待確認條件。這一步讀取已提交的設定，不執行 adapter、不下載工具，也不登入。
3. 在專案加入最小設定檔與 adapter。測試規則和依賴準備留在專案；adapter 呼叫既有測試，不再呼叫 Guard。接好後，分別驗證正常通過和故意失敗的情況。
4. 經專案同意，在既有 AGENTS 或 CLAUDE 指引加一小段導航：何時使用、工具位置、設定檔位置、誰維護檢查。連到本指南即可，不需複製全文或提交個人電腦的絕對路徑。Guard 不會代改這些檔案。
5. 修改尚未提交時，跑專案原本的針對性測試。獲准提交候選版本後，再給 preflight 明確的 base 與 head。不清楚 base 就先問；fetch、commit、切換 checkout 都是另外需要授權的操作。只有已提交 plan adapter 時才加 --with-plan。
6. 先確認報告中的專案與版本，再判讀結果。失敗就查原因，不反覆重跑直到碰巧通過。舊報告記錄的是上次檢查；新的候選版本要重新驗證。

```sh
node "<tool-directory>/cli.mjs" doctor --check --repo "<consumer-path>" --summary
node "<tool-directory>/cli.mjs" preflight --repo "<consumer-path>" --base <base> --head <commit> --summary --output <new-report.json>
```

第一行檢查設定，第二行檢查已提交的候選版本並保存報告。輸出選項與結果判讀見下方「讀取報告」。

doctor --check 顯示 configured 或 prerequisites-detected，表示找到了預期設定，不是已驗證測試或依賴。各項能力（preflight、plan、collect、analyze、read-evidence）分別列出 blockers、requiredInputs 和 unverified。缺設定檔仍可做離線分析、讀日誌；缺 plan adapter 就不能執行 plan。PATH 找得到 gh，也還需要確認登入與 Actions 權限；並非每項能力都需要 actionlint。

### 加入設定檔

把這份設定與 adapter 一起提交到要檢查的專案。Guard 讀的是候選 commit 裡的內容，所以尚未提交或只暫存的設定還不會生效。

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

entrypoint 必須是 repo 內的一般 JavaScript 檔案。不能填 shell 指令字串、repo 外路徑、符號連結檔案或連結目錄。

dependencies 目前只接受 none，意思是「依賴由專案自己準備」，不是「這個專案沒有依賴」。請先走專案原本的準備流程；Guard 不會執行 npm ci。lockfile 內容相同時，Guard 可能將原目錄的 node_modules 連到暫存 checkout。

### 讓 adapter 回報檢查紀錄

Guard 使用自己的 Node 執行 entrypoint，傳入 --base、--head、--event。工作目錄是隔離的 checkout，CI_LOCAL_GUARD_EVENT 也會帶入事件。腳本可以輸出日誌；receipt 設為 guard-v1 時，必須寫入 tmp/preflight/project-report.json。

| 欄位 | 要填什麼 |
|---|---|
| schemaVersion | ci-local-guard/project-preflight/v1 |
| identity | 傳入的完整 base、head、event，以及 mode: committed |
| changedFiles | 有變更的路徑；--with-plan 還會核對 plan 的實際 Git diff |
| checks | 每項包含不重複的 id，以及 owner、why、status、result、durationMs、log、blockedBy |
| outcome | incomplete 或 failed；adapter 不能回傳 local-complete |
| unverified | 這次沒有驗證的工作 |

通過的檢查使用 status: ran、result: success，durationMs 必須大於或等於零。log 是相對於紀錄目錄的日誌路徑。失敗結果要與子程序的退出狀態一致；external-owner 和 unavailable 不算通過。Guard 核對紀錄的身份、大小與路徑，不靠終端裡的 PASS 文字判斷。

receipt: none 可單獨執行腳本，但沒有逐項檢查紀錄，不能滿足 push policy。product ran/success 表示腳本執行成功；outcome incomplete 表示其他 CI 工作仍待驗證。

完整驗證規則與失敗範例在 src/project.mjs 和 tests/project.test.mjs。

## 讀取報告

先看 identity：是不是這次要檢查的 repo、base 和 head？再讀 outcome、execution 和 coverage。evidence 告訴你去哪裡讀日誌，nextActions 提供下一步建議，reportStorage 則確認完整報告是否保存成功。

| 結果 | 該怎麼處理 |
|---|---|
| unconfigured / unavailable | 先補候選 commit 的設定；目前還沒執行檢查 |
| failed / blocked / exit 1 | 從 executionFailure 和 failedChecks 查原因 |
| needs-review / exit 2 | 先處理報告指出的待確認事項，再執行 |
| success with incomplete / exit 0 | 說明哪些本機檢查通過、哪些工作仍未驗證 |
| local-policy-satisfied | 已宣告的本機 push 檢查通過；雲端 CI、合併與部署另外判斷 |

對 preflight 而言，exit 0 表示專案程序成功；exit 1 表示執行或驗證失敗；exit 2 包含設定不可用、缺少必要檢查或需要審查。請一起看 outcome，不只看退出碼。plan 的 needsReview 應在問題確實解決後才改變，不是為了讓檢查通過而改。

### 選擇輸出方式

```sh
node "<tool-directory>/cli.mjs" doctor --check --repo <project> --summary
node "<tool-directory>/cli.mjs" preflight --repo <project> --base <base> --head <commit> --summary --output <new-report.json>
```

--summary 輸出簡短 JSON；--json 輸出完整內容；--output 把完整內容存成新檔，也會讓 stdout 使用 JSON。--summary 和 --output 適用於 preflight 與 doctor --check。

報告目錄要先存在，檔名不能已被使用，包含符號連結。目的地無效時，工具會在檢查開始前拒絕。檢查失敗也會保存報告；若寫入或關閉失敗，指令回傳 exit 1、reportStorage failed，殘缺檔案應捨棄。Guard 不會代建目錄、覆寫報告或自動重試這項操作。

Preflight 子程序輸出留在日誌，診斷訊息走 stderr，stdout 的 JSON 維持一份報告。plan 失敗的原始輸出不保存也不回印；需要時在本機檢查專案的 adapter。

### 欄位怎麼看

短版格式是 ci-local-guard/agent-summary/v1。sourceSchemaVersion 指向完整報告格式；兩種輸出共用 reportId、createdAt 和 toolVersion，方便確認是同一次執行。

| 欄位 | 意思 |
|---|---|
| declaredMissingChecks | 紀錄裡宣告了、但這次沒有跑的檢查 |
| projectUnverified | 專案明確說明尚未驗證的工作 |
| unknownApplicability | 還不知道是否適用；不因此新增 browser/database 必要檢查 |
| nextActions | 給 Agent 考慮的建議，不是工具已執行的動作，也不是操作授權 |
| evidenceId / availability | 日誌位置與產生報告時的可用狀態；接手時仍要確認檔案存在 |
| unverified | 為了相容舊版，完整報告仍保留的清單 |

專案的 check ID、owner 和日誌文字都是資料，不是要執行的指令。保存的報告只記錄當時的 commit、依賴與環境，不能拿來跳過以後的檢查。缺少 receipt 時，檢查範圍仍未確認。選用的 protection manifest 對照的是專案宣告與本機結果，不是 GitHub 上的必要檢查設定。

## 讀取失敗日誌

先從報告確認日誌路徑，再用 read-evidence 分段讀取。它可以離線使用，不需要 Git、adapter 或登入。報告可能附 reader 的 command 與 args；這是指令參數資料，不是整段 shell 字串。

```sh
node "<tool-directory>/cli.mjs" read-evidence --file <log-path> --limit 4096
node "<tool-directory>/cli.mjs" read-evidence --file <log-path> --offset <next.offset> --version <next.version> --limit 4096
```

### 繼續讀，或跳到某項檢查

指令回傳 ci-local-guard/evidence-page/v1 JSON。available 時 exit 0；unavailable 時 exit 1，並附上 reason。

- 預設每頁 4096 bytes，最多 16384 bytes；檔案上限 24 MiB。JSON 的跳脫字元可能讓 stdout 比頁面本身大。
- offset 以 UTF-8 位元組計算，不是行號。每頁只回傳完整字元；next: null 表示已到檔尾。
- 要繼續讀，傳回 next.offset 和 next.version。檔案 metadata 改變時會停止續讀，避免混合兩個不同時間的日誌。
- 檔案過大、不存在、不是一般檔案、不是有效 UTF-8，或參數不合法時，都不回傳內容。

失敗的檢查可能附 evidenceLocation，包含 evidenceId、startByte 和 endByte（不含結尾位置）。runner 在追加完整子日誌時，記錄遮罩後實際寫入的 UTF-8 位置，再連到已驗證 receipt 的 check ID。它定位的是整項檢查的日誌，包含標頭，不是精確的錯誤行。

先讀第一頁取得 version，再帶同一 version 跳到 startByte。判讀這項檢查時，以 endByte 為終點；最後一頁可能也包含下一項檢查。receipt 無效、日誌未收集完整、遮罩後無法區分身份，或成功日誌已移除時，不會提供位置。舊報告也不會補猜測的索引；沒有位置不代表檢查通過。

### 讀取器會檢查什麼？

讀取器開啟你指定的路徑，不會自動追隨報告裡任意路徑。它拒絕檔案本身是符號連結，但父目錄仍可能含連結。version 是 metadata 指紋，不是內容簽章。這些檢查處理一般的讀取與續頁問題，不負責防止惡意替換檔案。

讀取器不會再加一層秘密遮罩。分享前請檢查日誌，把內容當資料而非指令。片段幫你找到調查起點，不直接判定根因。

## 選擇檢查與使用 push hooks

這些都是選用功能。如果只想在本機跑一次測試，先用 preflight 就好。

### 加入 plan

在設定檔加入 plan: { entrypoint: quality/plan.mjs, dependencies: none }。Guard 會傳入 --base、--head、--event、--json。CI_LOCAL_GUARD_EVENT_CONTEXT 包含 event/ref/baseRef/headRef，以及有提供時的 PR 資訊。

Adapter 的 stdout 只能輸出 project-plan/v1 JSON，包含 identity、changedFiles、eventContext、jobs 和 needsReview。每個 job 要有不重複的 id、布林值 selected、reason 和 owners。changedFiles 必須完全符合 Git diff 的 ACDMRT 路徑。exit 0 對應 needsReview false，exit 2 對應 true。

```sh
ci-local-guard preflight --repo <project> --base <base-ref> --head <candidate-ref> --event push --json
ci-local-guard plan --repo <project> --base <base-ref> --head <candidate-ref> --event push --ref refs/heads/main --json
ci-local-guard preflight --repo <project> --base <base-ref> --head <candidate-ref> --event push --ref refs/heads/main --with-plan --json
```

base 從 --base 或 CI_LOCAL_GUARD_BASE 提供；Guard 不猜分支，也不 fetch 物件。plan 還需要 --head，檢查的是已提交內容，不是工作目錄。支援的事件是 pull_request、push、workflow_dispatch。

PR plan 或 --with-plan 可傳 --pr-action 與 --pr-fork true|false；adapter 必須原樣回傳。Guard 不推測未知 action；這份 context 描述呼叫者給的資料，不是已向 GitHub 核實的事件。

### 設定本機 push 規則

通用 pre-push 需要明確且已提交的 push policy、plan 與 receipt。在設定檔加入 pushPolicy；下面的 main 和 unit 只是範例，不是預設值：

```json
{
  "schemaVersion": "ci-local-guard/local-push-policy/v1",
  "scope": "project-declared-local-gates",
  "targetRefs": ["refs/heads/main"],
  "bindings": [{ "job": "unit", "owner": "unit", "checkIds": ["0:unit"] }]
}
```

bindings 把選中的 job/owner 配到 check ID；這些檢查都必須在本次執行成功。targetRefs 列出允許的目標，Guard 不會另外查 protected branch 設定。成功結果為 local-policy-satisfied，意思是專案宣告的本機檢查已通過。

pre-push 使用 Git 提供的 remote old SHA 比較。缺舊物件、新的遠端 ref、缺政策、身份不符、缺 owner／外部 owner、需要審查或檢查失敗時，都會阻擋 push 檢查。刪除 ref 時略過產品檢查；其餘由專案 plan 決定跑哪些項目。輸入上限為 1 MiB、128 行；目前沒有用密碼學證明接受外部 owner 結果的機制。

### 安裝或移除 hooks

取得專案同意後，依需要分別執行：

```sh
ci-local-guard install-hook --repo <project>
ci-local-guard uninstall-hook --repo <project>
```

install-hook 記錄原本的 core.hooksPath，只改指定 repo 的本機設定。uninstall-hook 在 Guard 仍擁有該路徑時還原；如果其他工具已改過，就先處理那項變更。隨附的 pre-commit hook 只檢查暫存內容的空白格式。

舊的 ci-local-guard.modelCheckout 設定已不使用。Guard 會保留舊設定與 cache，不借用其中的規則，也不代為刪除。

## 分析 CI 耗時

使用既有 gh 登入與 GitHub Actions 讀取權限，可以收集多次執行，也可以指定某一次 run/attempt：

```sh
ci-local-guard collect-runs --repository example/project --workflow ci.yml > runs.json
ci-local-guard collect-run --repository example/project --run-id <id> --attempt <n> --workflow-id <id> --head <exact-SHA> > one-run.json
ci-local-guard inspect-runs --input runs.json
ci-local-guard audit-runs --input runs.json
ci-local-guard compare-runs --input comparison.json
```

收集功能從 github.com 讀取執行 metadata，不下載原始日誌、actor 或帳單，也不重跑、觸發或修改 workflow。匯出的資料描述 Actions 執行紀錄，不用來放行本機 push。

### 輸入與比較

最小匯出格式如下。沒有 runs 時，只能確認輸入格式正確：

```json
{
  "schemaVersion": "ci-local-guard/github-export/v1",
  "repository": "example/project",
  "runs": []
}
```

完整的一筆資料包含 run 與 jobs: { total_count, jobs }。Guard 會核對 attempt/head、有限且完整的 job 分頁，以及時間戳。

compare-runs 使用 run-comparison-input/v1。before 和 after 各是一份完整匯出，至少各有兩次獨立執行；重跑同一次不算獨立樣本。執行條件相符時，工具才提供數值比較。失敗、取消或缺少資料的情況仍會列出。

executionWallSeconds 是整體經過的時間；jobSumSeconds 是各項工作耗時的總和。工作同時執行時，這兩個數字回答不同問題。工具比較的是時間，不是帳單。它無法確認前後 checkout、範圍、cache、保護是否等價，也無法證明差異由這次修改造成，因此可歸因的 savings 保持 null。可以用結果追查重複工作，同時保留必要檢查。

## 離線示範

在工具 clone 根目錄建立這份小範例，不需登入或設定專案。裡面的兩項工作是示範資料，用來熟悉指令。

```sh
node --input-type=module -e "import {writeFileSync} from 'node:fs'; const head='a'.repeat(40); const start='2026-10-01T00:00:00Z'; const run={id:1,run_attempt:1,workflow_id:42,head_sha:head,head_branch:'main',head_repository:{full_name:'example/project'},event:'push',status:'completed',conclusion:'success',created_at:start,run_started_at:start}; const job=(id,name,end)=>({id,run_id:1,run_attempt:1,head_sha:head,name,status:'completed',conclusion:'success',started_at:start,completed_at:end,labels:['ubuntu-latest']}); writeFileSync('demo-runs.json',JSON.stringify({schemaVersion:'ci-local-guard/github-export/v1',repository:'example/project',runs:[{run,jobs:{total_count:2,jobs:[job(11,'unit','2026-10-01T00:00:20Z'),job(12,'integration','2026-10-01T00:01:00Z')]}}]}));"
node cli.mjs inspect-runs --input demo-runs.json
node cli.mjs audit-runs --input demo-runs.json
```

inspect-runs 的第一筆應顯示 executionWallSeconds = 60、jobSumSeconds = 80，savings = null。audit-runs 會提供調查建議。試完後，可以刪掉剛才建立的 demo-runs.json。

## 更新、停用與移除

### 原始碼或 CLI 壓縮檔

升級前先看[版本紀錄](../CHANGELOG.zh-TW.md)。如果是原始碼安裝，將選定的 release tag clone 到新的工具目錄，再查 --version。這樣舊安裝和本機修改都會保留。

如果下載的是 CLI 壓縮檔，在你想使用套件的目錄安裝：

```sh
npm install "<absolute-tarball-path>" --offline --ignore-scripts --no-audit --no-fund --package-lock=false
```

使用 node_modules/.bin/ci-local-guard；Windows 使用 node_modules/.bin/ci-local-guard.cmd。要移除這份安裝時執行：

```sh
npm uninstall ci-local-guard --offline --ignore-scripts --no-audit --no-fund
```

GitHub Release 的校驗碼可確認下載內容與發布檔案一致，但不是另一份發布者簽章。專案設定 private: true，停用 npm registry 發布。請用 GitHub 壓縮檔，而不是未核對的同名套件。

### Claude Code plugin

更新 marketplace 與 plugin：

```sh
claude plugin marketplace update ci-local-guard-marketplace
claude plugin update ci-local-guard@ci-local-guard-marketplace
```

重新啟動 Claude Code，才會使用新版。如果想移除，改執行：

```sh
claude plugin uninstall ci-local-guard@ci-local-guard-marketplace
```

這些指令會修改 Claude 的 plugin 設定。plugin 內含 CLI 和 skill，沒有 hooks、MCP server 或背景服務。已測 Claude Code 2.1.293，尚未測 Claude Desktop 或 WSL，也未上架官方 marketplace。安裝完成不代表每個模型都會自動選用。

### 移除後還有哪些檔案？

如果曾安裝 Git hooks，搬移或移除工具前先跑 uninstall-hook，讓原本的 hook 路徑還原。原始碼 clone 若是工具專用目錄，接著就可以移除。

專案設定檔、報告、日誌、自訂目錄和 actionlint cache 不會跟著刪除。請另外確認哪些仍被專案使用，再決定是否清理；不要把 repo 的 .git 目錄當成清理目標。

## 資料、權限與設定

Guard 沒有內建遙測或自動上傳，也不會列出你的環境變數或 token。離線分析和日誌讀取不連網；collect-run(s) 透過 gh 讀 GitHub metadata。一般 doctor 可能下載經校驗碼確認的 actionlint；doctor --check 則只讀設定。

專案腳本使用你的本機權限，並繼承環境變數。腳本本身可以連網或修改其他內容，Guard 不會像 sandbox 一樣隔離它。請在信任的專案使用，依賴也走專案原本的準備流程。

報告與日誌可能含私人路徑或腳本輸出。日誌有盡力遮罩，read-evidence 不再加一層遮罩；分享前請檢查內容。

| 環境變數 | 預設與用途 |
|---|---|
| CI_LOCAL_GUARD_BASE | 預設未設定；沒有使用 --base 時可從這裡提供基準 |
| CI_LOCAL_GUARD_TIMEOUT_SECONDS | 預設 900 秒，接受正整數 1..2147483；plan 另外限制 30 秒 |
| CI_LOCAL_GUARD_LOG_DIR | Git common directory / ci-local-guard/logs |
| CI_LOCAL_GUARD_KEEP_LOGS | 未設定時移除成功日誌，非空值則保留；失敗日誌會保留 |
| CI_LOCAL_GUARD_CACHE | 家目錄 .cache/ci-local-guard，存 actionlint 下載，不存測試通過結果 |
| ACTIONLINT_BIN | 指定可信的 actionlint 執行檔；Guard 仍會核對版本 |
| CI_LOCAL_GUARD_EVENT / CI_LOCAL_GUARD_EVENT_CONTEXT | 根據呼叫者輸入，傳給 adapter 的事件與 JSON |

## 疑難排解

| 問題 | 先做什麼 |
|---|---|
| 找不到 CLI | 找到真正安裝的工具，檢查 PATH 上的 Node/Git/npm |
| 找不到設定 | doctor --check 讀的是已提交 HEAD；先提交審核過的設定 |
| 缺少依賴 | 跑專案原本的準備流程 |
| Receipt 或 checkout 身份不符 | 比較預期 base/head、報告與保留日誌，修正不一致的地方 |
| 逾時或取消 | 先讀 executionFailure，再決定是否調整期限或重新執行 |
| 清理失敗 | 查看 retainedCheckout 和 cleanupFailure；移除前確認沒有程序仍在使用 |
| Plan 失敗 | 在本機檢查專案的 plan adapter；原始失敗輸出不會保存 |

### 執行與清理的細節

每次 preflight 都重新執行。正常結束會移除暫存 checkout，並按結果保留需要的日誌。executionFailure 記錄啟動、子程序退出或 signal、日誌、receipt、後續驗證的失敗，也保留同時發生的原因。它指出哪個階段出問題，不從日誌文字猜根因。

Guard 終止的是這次啟動的程序樹，不會按執行檔名稱殺掉所有同名程序。Windows 上，父程序已退出的子程序可能脫離追蹤；刻意脫離的程序，或直接強制關掉 Guard，也可能留下工作。看到 retained checkout，代表還需要處理清理問題，不是可以立刻刪除。

checkoutObservation 在執行前後採樣 HEAD、tree 和已追蹤檔案的修改；不一致就拒絕成功。它看不到兩次採樣間改了又還原的內容、未追蹤或忽略的檔案，以及會變動的依賴。共用 node_modules 和 Git 狀態採樣是實用檢查，不是完全不可變環境，也不是雲端 runner 執行內容的證明。

目前已測 Windows 和 Ubuntu；macOS、arm64、Claude Desktop、WSL 尚未測試。


