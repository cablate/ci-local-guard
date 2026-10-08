# 版本紀錄
[English](CHANGELOG.md)

這裡記錄使用或升級 Guard 時需要知道的變更，依 Keep a Changelog 整理。工具仍在實驗階段，0.x 次版號可能調整用法；更新前請先看升級說明。

## [未發布]

### 新增
- 新增 ci verify：檢查準備推送的 commit。它判斷這次 push 或 pull request 會觸發哪些 workflows，執行 workflow 靜態檢查並在本機重播會被觸發的 Linux jobs，再列出預期失敗、本機已通過，以及只有 GitHub 能驗證的部分。
- 新增 ci replay：用 act 0.2.89 在本機 Linux 容器執行已提交 workflow 的一個 job，回報失敗的 step、命令、失敗測試與 log 位置，並只移除它自己建立的 containers、networks、volumes。
- 新增 ci discover：讀取已提交的 workflows（含本地 reusable workflows 與 composite actions），列出 CI 執行的命令、哪些 job 能在本機跑、本機工具狀態與下一步命令，不需要 adapter。
- 新增 ci locate：GitHub run 失敗時，找出失敗的 job、step、workflow 行號與失敗測試（附檔案與行號），並把該 step 的 log 存在本機，可分頁讀取。
- 新增 ci history：列出 workflow 在 Hosted 的等待時間與各 job 耗時基準、失敗 attempts 耗掉的時間與計費分鐘；加上 --reproduce 時，標出哪些失敗能被本機 ci verify 事先抓到。
- 新增 ci check，以 actionlint／zizmor 對已提交 workflows 做離線基準掃描。既有命令維持相容。

### 變更
- 中英文 README 加入檢測台風格 Banner。靜態圖片隨 CLI 壓縮檔提供，可編輯的 HTML／JS 視覺原始檔留在 repo。
- 指南按日常任務重寫：接入、看結果、查失敗、維護安裝。更新與移除指令也分開示範。
- 簡化 AI、貢獻者和安全回報指引，修正導航，並為所有 Markdown 指南加入標題連結檢查。指令行為與資料格式不變。
- 整理過往版本紀錄的文字，保留原有日期與變更事項。
- 貢獻與發布指引留在 repo，不再放進 CLI 壓縮檔；安裝版 README 改用連結導向。使用指南、版本紀錄與授權仍隨包提供。

## [0.1.1] - 2026-10-08

這一版讓 AI 更容易開始使用 Guard。安裝包包含英文與繁中指南；plan 腳本失敗時，也不再把原始輸出帶進 Agent 診斷。

**升級：** 更新 GitHub 壓縮檔／clone 或 Claude marketplace plugin，確認 --version 顯示 0.1.1。既有設定與檢查紀錄不用遷移。plan 腳本失敗時，請在本機檢查；原始輸出不再回印。

### 變更
- CLI 壓縮檔加入配對的英文、繁中接入指南，說明何時檢查未完成的修改、何時檢查 commit，以及怎麼看待仍未驗證的工作。
- 加入 tools/docs.mjs，檢查翻譯文件的結構與可執行範例是否一致。Release notes 也改用同一 parser，從雙語 changelog 產生。

### 安全性
- plan adapter 失敗時，不再把原始 stdout/stderr 回印到終端與 Agent 診斷；退出狀態與 failed/blocked 結果不變。這項修補針對 plan 失敗輸出，其他日誌分享前仍需檢查。

## [0.1.0] - 2026-10-08

不需要 npm 帳號，直接從 GitHub 安裝。第一個實驗版提供本機 commit 檢查、分段讀取失敗日誌，以及 Claude Code plugin。push 前先跑本機檢查，其餘工作交給雲端 CI。

**升級：** 以前依賴隱含 adapter 的專案，現在需要提交自己的 .ci-local-guard.json 和腳本。請從報告確認檢查範圍；指令成功或出現 PASS 文字，不表示每項 CI 檢查都跑過。

### 新增
- GitHub Release 壓縮檔與校驗碼，以及固定版本的離線 npm-exec 安裝測試。發布前會核對 tag；停用 npm registry 發布。
- Claude Code plugin，內含同一份 CLI 並同步版號。提供的是 skill，不是另一套 runner、自動 hooks 或 MCP server。
- `--version`，查看已安裝 CLI 的版本。
- Doctor 依各項能力列出需求與已知缺項；即使未接入專案，也能使用離線分析。
- 失敗檢查的日誌位置，以實際寫入的位元組位置與已驗證 check ID 對應，不從日誌文字猜測。
- `read-evidence`，將日誌切成小份 JSON 讀取，包含續頁版本與無法讀取時的原因。
- Agent 短報告與 `--output`，可把完整 preflight 或 doctor 報告存成新檔，包含下一步建議、日誌位置和適用性仍未知的工作。
- 唯讀 `doctor --check --json`，查看已提交設定，並列出尚待驗證的依賴或雲端檢查。
- 專案擁有的 adapter 與簡短 AI 入口，讓 Guard 能檢查自己。
- 預設 900 秒期限、取消處理、終止這次啟動的程序樹，以及需要保留 checkout 時的診斷。
- 可執行的離線耗時範例，以及可直接交給 AI 的接入請求。
- 指定 commit 的本機檢查，包含有大小限制的日誌與專案腳本結果驗證。
- 由專案定義的 plan 與本機 push 規則；缺少必要結果時會阻擋。
- GitHub Actions 執行紀錄收集，以及離線耗時分析／比較。
- AI 使用指引，能從已安裝的 CLI 找到。

### 變更
- 用六次執行實驗，嘗試減少重複的測試資料準備。中位等待改善 7.6%，未達選定的 10% 目標，平均等待也沒有變化，因此撤回修改。
- 移除對應用名稱、腳本與分支的假設，也不再借用其他 checkout 的規則。
- 移除 PASS 結果快取、部署預覽與七項擴張診斷指令。
- 移除舊 check 指令。現在必須明確指定比較基準，plan 也需要已提交的 head。

### 修正
- CLI help 正確介紹為已公開的實驗工具，不再寫成私人候選版本。
- 遮罩延遲處理最後幾個字元時，stdout/stderr 日誌行仍保持分開。
- Windows 測試比較使用系統原生的路徑正規化。

[unreleased]: https://github.com/cablate/ci-local-guard/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/cablate/ci-local-guard/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cablate/ci-local-guard/releases/tag/v0.1.0
