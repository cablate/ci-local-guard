# ci-local-guard field battery

ci-local-guard（受測 CLI＝repo 根目錄的 `cli.mjs`）的壓力與邊界測試電池。零相依、純 Node 22。情境全部資料驅動，加情境改各 runner 裡的陣列即可，不要為單次測試重寫程式。

## 執行

```bash
cd quality/field-battery
node run-offline.mjs            # 離線邊界：discover/diff/check/read-evidence/inspect-runs/plan/doctor（不需 gh、Docker）
node run-gh.mjs                 # gh 唯讀：#2 修復回歸、limit 邊界、export round-trip、並發（需 gh 登入）
node run-flake.mjs              # discovery 15s deadline 壓力：基準/並發/CPU 負載
node run-replay.mjs             # act/Docker 重播：env mismatch、TAP failedTests、lastActivity、未知 job、缺映像
# 任一 runner 可加 --only <名稱子字串> 只跑符合的情境
```

`REAL_REPO` 預設是維護者本機的 interactive-engine checkout，可用環境變數 `GUARD_FIELD_REAL_REPO` 覆蓋——CI 的 `field-battery` job 就是用 `$GITHUB_WORKSPACE`（Guard repo 自己）跑 offline 電池。act 的路徑可用 `GUARD_FIELD_ACT` 覆蓋（預設仍是維護者本機路徑）。

報告落在 `reports/<timestamp>-<label>/`（每情境一份 JSON＋summary.json；`reports/`、`tmp/` 不進版控）。

## 結構

- `lib/harness.mjs` — `run()` 包 CLI、`makeRepo()` 造 fixture repo、`battery()` 跑情境寫報告、`wf` workflow 模板。
- `run-*.mjs` — 四個電池；情境是陣列元素 `{name, run, expect, note}`。
- `tmp/` — fixture 與暫存（可整個刪掉重跑重建）。

## 依賴

- gh 已登入（run-gh）；Docker Desktop 開著＋act（run-replay）。
- 映像：`catthehacker/ubuntu:act-latest`（happy path）、`debian:bookworm-slim`（缺庫情境）。

## 已知用法

2026-10-11 對 guard `b9b8383` 全跑過一輪：issue #2 的 11 項修復回歸全過；新發現 discovery deadline 不隨 inventory 縮放（150 workflows 即觸發 `git-read-unavailable-or-limit`）與離線指令非法輸入不出 JSON，詳見當時開的 field report issue。該輪是在工具目錄 `C:/Users/user/.claude/tools/ci-local-guard-tests` 跑的，本目錄是收編進 repo 後的版本。
