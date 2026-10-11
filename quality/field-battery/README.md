# ci-local-guard field battery

ci-local-guard（受測 CLI＝repo 根目錄的 `cli.mjs`）的壓力與邊界測試電池。零相依、純 Node 22。情境全部資料驅動，加情境改各 runner 裡的陣列即可，不要為單次測試重寫程式。

## 執行

```bash
cd quality/field-battery
node run-offline.mjs            # 離線邊界：discover/diff/check/read-evidence/inspect-runs/plan/doctor，加上專案接入 adopt-*（descriptor／adapter／receipt、plan、pre-push、install-hook；不需 gh、Docker，需要 git 與 sh）
node run-gh.mjs                 # gh 唯讀：#2 修復回歸、limit 邊界、export round-trip、並發（需 gh 登入）
node run-flake.mjs              # discovery 15s deadline 壓力：基準/並發/CPU 負載
node run-replay.mjs             # act/Docker 重播：env mismatch、TAP failedTests、lastActivity、未知 job、缺映像
# 任一 runner 可加 --only <名稱子字串> 只跑符合的情境
```

## 目標與環境變數

全部選填。沒設時，電池以這個 Guard checkout 當受測 repo，從它的 origin remote 推出 GitHub repository；需要特定 run 的情境會顯示 SKIP 並寫出缺哪個變數。

| 變數 | 用途 | 沒設時 |
|---|---|---|
| `GUARD_FIELD_REAL_REPO` | offline、flake、gh 電池讀的本機 repo | 這個 Guard checkout |
| `GUARD_FIELD_REPOSITORY` | gh 電池讀歷史的 `owner/name` | 從受測 repo 的 origin remote 推出 |
| `GUARD_FIELD_WORKFLOW` | gh 電池讀歷史的 workflow 檔名 | `ci.yml` |
| `GUARD_FIELD_FAILED_RUN` | 一個 log 裡有測試失敗的失敗 run | 相關情境 SKIP |
| `GUARD_FIELD_WORKFLOW_RUN_RUN` | 一個由 `workflow_run` 觸發的 run | 相關情境 SKIP |
| `GUARD_FIELD_PLATFORMS` | 第三方 runner 標籤的映射，逗號分隔 `label=image` | 相關情境 SKIP |
| `GUARD_FIELD_RUN_IDS` | 並發 locate 用的 run ID，逗號分隔 | 用 `gh run list` 取最近 4 個 |
| `GUARD_FIELD_ACT` | act 執行檔路徑 | 交給 Guard 自己找（`ACT_BIN`，再來是 PATH 上的 `act`） |

CI 的 `field-battery` job 用 Guard repo 自己跑 offline 電池。

報告落在 `reports/<timestamp>-<label>/`（每情境一份 JSON＋summary.json；`reports/`、`tmp/` 不進版控）。

## 結構

- `lib/harness.mjs` — `run()` 包 CLI、`makeRepo()` 造 fixture repo、`battery()` 跑情境寫報告、`wf` workflow 模板。
- `run-*.mjs` — 四個電池；情境是陣列元素 `{name, run, expect, note}`，可再加：
  - `skip`：不跑的原因（例如缺環境變數），結果記為 SKIP。
  - `known`：這個情境重現的未修 issue（例如 `'#7'`）。失敗記為 KNOWN，不讓電池失敗；修好後會提示可以拿掉標記，請在修正的同一個變更裡拿掉。
- `tmp/` — fixture 與暫存（可整個刪掉重跑重建）。

## 依賴

- gh 已登入（run-gh）；Docker Desktop 開著＋act（run-replay）。
- 映像：`catthehacker/ubuntu:act-latest`（happy path）、`debian:bookworm-slim`（缺庫情境）。

## 已知用法

這組電池來自 issue #4 回報者的情境集，之後的 field report（#4、#7）都用它重現。
