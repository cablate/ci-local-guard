# 版本紀錄
[English](CHANGELOG.md)

使用者可見變更依 Keep a Changelog 整理。package.json 擁有版號；experimental 0.x 次版號可能改變行為。

## [未發布]

### 變更
- Agent 可從 repository URL 讀英文或繁中接入指引、找到安裝版契約，並區分 dirty 檢查、exact-commit 結果與未驗證 CI 責任。CLI 壓縮檔包含雙語指引與參考文件。
- 貢獻者可用 tools/docs.mjs 查出雙語結構與可執行範例漂移；Release notes 使用同一 parser 與配對 changelog，不另維護第二種格式。

### 安全性
- plan adapter 失敗時不再把原始 stdout/stderr 帶入終端或 Agent 診斷。退出狀態與 failed/blocked 報告不變；請在本機檢查專案擁有的 adapter。這不是全面秘密遮罩或 sandbox。

## [0.1.0] - 2026-10-08

不需要 npm 帳號，直接從 GitHub 安裝。首個實驗版提供 Agent exact-commit 檢查、有界失敗證據與 Claude 薄入口。package.json 擁有版號；本機成功不代表完整 Hosted CI 通過。

**升級：** 依賴隱含 adapter 的專案須提交自己的 .ci-local-guard.json 與 scripts；沒有 fallback。請讀取報告：standalone exit zero 或 PASS 文字不代表完整 CI 已驗。

### 新增
- GitHub Release 壓縮檔與校驗碼、固定版本離線 npm-exec 安裝驗證、tag 發布關卡；停用 npm registry 發布。
- Claude 薄 skill plugin，內含同一份 CLI、marketplace metadata 與版號同步驗證；沒有自動 hooks、MCP 或第二套 runner。
- `--version` 查驗已安裝 CLI 身分。
- Doctor 在完整與精簡報告區分各能力的缺項、必要輸入及未驗證條件；離線分析不依賴專案接入。
- 失敗 check 以 runner 記錄的遮罩後 UTF-8 byte range 與 validated receipt ID 定位，不從日誌文字猜測。
- 離線 `read-evidence` 有界 JSON 分頁，含續頁版本與機器可判讀的失敗原因；保留證據附非自動執行的 reader 參數。
- preflight／doctor --check 的 Agent 摘要與不覆寫完整報告 `--output`，包含穩定 action kinds、evidence IDs 與未知適用性；舊報告不能替代新檢查。
- 唯讀 `doctor --check --json` 區分已提交設定、尚未驗證的依賴與 Hosted 責任。
- 專案擁有的自身預檢與簡短 AI 入口。
- 預設 900 秒期限、取消、所啟動程序樹終止，以及保留 checkout 診斷。
- 公開上手流程、非空離線耗時範例、英文入口與可複製 Agent 指引。
- Exact-commit 本機預檢、有界日誌與 receipt 驗證。
- 明確的專案 plan 與本機 push policy；缺證據時阻擋。
- 唯讀 GitHub Actions metadata 收集與離線分析／比較。
- AI 操作指引與已安裝 consumer 文件導航。

### 變更
- 完成六次 fixture 成本實驗；中位等待改善 7.6% 未達原定 10% 門檻、平均等待相同，因此撤回候選，不宣稱可歸因的節省。
- 移除特定應用程式、分支與外部 checkout fallback 假設。
- 移除 PASS cache、下游部署預覽與七項擴張指令。
- 移除舊 check 指令；明確指定比較 base，plan 必須提供已提交 head。

### 修正
- CLI help 正確標示 public-experimental。
- 避免遮罩延遲造成 stdout／stderr 日誌行黏接。
- Windows 測試路徑使用原生 filesystem 正規化。

[unreleased]: https://github.com/cablate/ci-local-guard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cablate/ci-local-guard/releases/tag/v0.1.0
