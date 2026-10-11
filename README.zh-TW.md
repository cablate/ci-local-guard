# CI Local Guard
[English](README.md)

![CI Local Guard：commit 穿過光學檢測台，輸出檢查報告。](assets/banner/banner.webp)

**給寫程式的 AI 用的 CI 失敗診斷與 workflow 審查工具。**

AI 改完程式、推上去，CI 失敗了。下一步？把整份日誌貼進對話浪費時間和 context；用猜的浪費一次 push。Guard 給你的 AI 一條最短路徑找到原因：哪個 job、哪個 step 失敗、哪個測試在哪個檔案哪一行，以及日誌到底該讀哪一段。

它也能在問題變成事故前先回答：改完 workflow 之後，同樣的變更 CI 是不是檢查得比較少？它還會讀 GitHub Actions 的耗時——把 flaky 失敗和真正的失敗分開——讓速度改善落在真正等待的地方。

- **診斷失敗的 run。** `ci locate` 指出失敗的 job、step、workflow 行號與失敗的測試，並只存下該 step 的日誌段落供分頁閱讀。
- **審查 workflow 修改。** `ci diff` 顯示修改後哪些跑得比較少、比較多或無法判定；`ci check` 對 workflow 做靜態掃描。
- **看懂慢的 CI。** `ci history` 把 flaky 失敗（同一 commit 稍後通過）和持續性失敗分開，沿著 gate jobs 追到真正決定等待時間的 job，並用分鐘估計失敗 run 的代價。
- **選配：push 前在本機重播 job。** `ci verify` / `ci replay` 把一個 commit 的 Linux jobs 跑在本機容器裡。大多數專案不需要這個也能得到上面的價值。

Guard 和你原本的 CI 搭配使用。它讀 GitHub 已經知道的資料，能在本機跑的就在本機跑；需要 hosted 環境的部分仍交給 GitHub Actions。

## 直接請你的 AI 設定

把這個 repo 連結交給 AI，像這樣說就可以：

> 幫我的專案使用 https://github.com/cablate/ci-local-guard 。先讀它的 README 和文件，之後 CI run 失敗時用 ci locate 找原因，合併 workflow 修改前用 ci diff 檢查沒有漏掉檢查。

你的 AI 需要能讀取專案檔案、執行 Node 指令；診斷 GitHub 上的 run 還需要已登入的 GitHub CLI（gh）。這些命令不需要任何專案設定或 adapter。

## 安裝 CLI

需要 Node 22（>=22.13.0 <23）和 Git。把工具 clone 到它自己的目錄：

```sh
git clone --branch v0.3.0 --depth 1 https://github.com/cablate/ci-local-guard.git
node ci-local-guard/cli.mjs --version
node ci-local-guard/cli.mjs --help
```

版本指令應顯示 0.3.0。裝好一份，就能給多個專案使用。

不需要 npm 帳號，也可以從 [GitHub Releases](https://github.com/cablate/ci-local-guard/releases) 下載。這個工具透過 GitHub 提供，沒有發布到 npm registry。

想先試一下、不設定專案？可以照[離線範例](docs/reference.zh-TW.md#離線示範)分析一份小型樣本。

### 你用的是 Claude Code？

也可以安裝選用的 plugin：

```sh
claude plugin marketplace add cablate/ci-local-guard
claude plugin install ci-local-guard@ci-local-guard-marketplace
```

重新啟動 Claude Code，輸入 /ci-local-guard:ci。plugin 內含同一套 CLI，並附給 Claude 的使用指引；仍需要 Node 和 Git。

## AI 操作入口

先讀[指令參考](docs/reference.zh-TW.md)。一般流程是：

1. **GitHub 上的 run 失敗了。** `ci locate` 找出 HEAD commit 的 runs（或用 `--run <id>` 指定單一 run），指出失敗的 job、step、workflow 行號與失敗的測試（附檔案與行號），並存下該 step 的日誌供 `read-evidence` 分頁閱讀。
2. **你改了 workflow。** `ci diff` 對同樣的 events 和檔案比較兩個 commit：哪些跑得比較少、比較多或無法判定。`ci check` 再加靜態掃描（actionlint、zizmor）。
3. **CI 很慢。** `ci history` 顯示決定等待時間的 job（gate jobs 追到它們實際等待的對象），把 flaky 失敗和持續性失敗分開，並估計失敗 run 的代價。`ci optimize` 把這些變成附證據的候選發現。
4. **接手陌生 repo。** `ci discover` 列出 CI 會跑什麼、哪些 job 能在本機重播、該用哪些命令。

### 實驗功能：專案 adapter 與 push hooks

preflight 這條路線——專案自有的 adapter 腳本、`.ci-local-guard.json` descriptor、receipts，以及 `install-hook` pre-push 閘門——是**實驗功能**。它早於 `ci` 命令、需要專案設定，而且它的 hook 不會和你既有的 hooks 鏈結（安裝時若會讓既有 hooks 停止運作會直接拒絕；`--force` 可覆蓋）。除非你明確想要 commit 閘門式的專案檢查，否則不要建立在它上面：

```sh
node "<tool-directory>/cli.mjs" doctor --check --repo "<consumer-path>" --summary
node "<tool-directory>/cli.mjs" preflight --repo "<consumer-path>" --base <base> --head <commit> --summary
```

完整的契約請見[參考手冊](docs/reference.zh-TW.md)。

## 選配：push 前在本機重播 job

這些命令直接讀取你的 GitHub workflows，不需要 adapter。重播 job 需要 [act](https://github.com/nektos/act) 0.2.89，以及能跑 Linux 容器的 Docker。

```sh
node "<tool-directory>/cli.mjs" ci verify --repo "<project>" --summary
node "<tool-directory>/cli.mjs" ci replay --repo "<project>" --workflow .github/workflows/ci.yml --job test --summary
```

verify 拿你準備推送的 commit，判斷它會觸發哪些 workflows，再把 Linux jobs 跑在本機容器裡。它會回報預期失敗的部分（附失敗的 step、命令與 log 位置），以及仍需 GitHub 驗證的部分，例如 Windows job 或用到 secrets 的 job。replay 則隨選重播單一 job；在 Windows 上，verify 也會列出對應 hosted-only legs 的命令，讓 AI 直接在工作目錄裡執行。細節見[參考手冊](docs/reference.zh-TW.md#看懂檢查與重播-ci)。

## 查 CI 為什麼慢

只要 GitHub CLI（gh）已登入：

```sh
node "<tool-directory>/cli.mjs" ci history --repo "<project>" --workflow ci.yml --summary
node "<tool-directory>/cli.mjs" ci optimize --repo "<project>" --summary
```

history 把 flaky 失敗（同一 commit 稍後通過——pre-push 檢查也抓不到）和持續性失敗分開，`--reproduce` 只重播持續性失敗的 commit，跳過 flakes。離線收集器（`collect-runs`、`inspect-runs`、`audit-runs`、`compare-runs`）分析已存的匯出資料。目的是少做重複、沒必要的工作，不是少跑該跑的測試。

## 壓力測試電池

[quality/field-battery/](quality/field-battery/README.md) 用資料驅動的情境，對 Guard 自己的 CLI 做壓力測試：離線邊界、gh 唯讀查詢、discovery 截止時間壓力，以及 act/Docker 重播。CI 在每次 push 與 pull request 都會跑離線電池，並以這個 repo 自身作為樣本 repo。另外三個電池從 repo 根目錄手跑：`node quality/field-battery/run-gh.mjs`（需已登入的 GitHub CLI）、`node quality/field-battery/run-flake.mjs`、`node quality/field-battery/run-replay.mjs`（需 Docker 與 act）。

## 更多說明

- [設定、報告格式與範例](docs/reference.zh-TW.md)
- [更新與移除](docs/reference.zh-TW.md#更新停用與移除)
- [設定與疑難排解](docs/reference.zh-TW.md#資料權限與設定)
- [版本變更](CHANGELOG.zh-TW.md) · [參與開發](https://github.com/cablate/ci-local-guard/blob/main/CONTRIBUTING.md) · [MIT 授權](LICENSE)

Guard 會用你的本機權限執行專案腳本，請用在你信任的專案上。工具本身沒有遙測；分享日誌前記得先檢查內容。安全問題可以[私下回報](https://github.com/cablate/ci-local-guard/security/advisories/new)。

<details>
<summary>PRINCIPLE：我們怎麼決定這工具該做什麼</summary>

1. 同時幫助本機開發與 CI，不只是把工作搬來搬去。
2. 改善速度時，保留真正保護專案的檢查。
3. 沿用專案的規則，不另養一套。
4. 檢查準備提交的版本，和未完成的修改分開。
5. 先減少重複、沒必要的工作，再考慮快取或平行處理。
6. 輸入確實相同，結果才值得重用；目前 Guard 每次都重新檢查。
7. 分開看等待時間和工作總耗時，不直接拿來當帳單。
8. 失敗要有用：說清楚跑了什麼、哪裡沒過、去哪裡查。
9. 分開調查、提案與修改，需要授權的操作先確認。
10. 工具保持小而好維護，依真實需求增加功能，不預造整合層。

</details>

## 目前進度

[v0.3.0](https://github.com/cablate/ci-local-guard/releases/tag/v0.3.0) 是實驗版。[Windows 與 Ubuntu 測試](https://github.com/cablate/ci-local-guard/actions/runs/38147060855)已通過，真實專案情境的壓力測試電池也隨每次 push 在 CI 上跑。發布壓縮檔，以及 Claude Code 2.1.293 plugin 的安裝、更新和移除，最近一次是在 v0.1.1 實測。macOS、arm64、Claude Desktop、WSL 尚未測試。

Guard 的重點是失敗診斷（ci locate）、workflow 審查（ci diff、ci check）與耗時分析（ci history、ci optimize）；本機重播（ci verify、ci replay）是選配，專案 adapter／push hook 這條路線是實驗功能。來自一個 12-workflow 真實專案的四輪 field reports 塑造了現在的樣貌：真正幫上忙的成為主角。

我們也用 Guard 檢查這個 repo。重播已在 Windows 搭配 Docker Desktop（Linux 容器）實測，也實測過讓 Guard 本身在 Linux 容器裡操作同一個 Docker engine，包含 Ctrl-C 後的清理。原生 Linux 機器與 macOS 尚未測試。

哪裡看不懂或用不起來？歡迎[開 issue](https://github.com/cablate/ci-local-guard/issues)，附上工具版本、作業系統和簡單的重現例子。
