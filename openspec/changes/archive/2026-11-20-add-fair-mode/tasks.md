# Tasks

## 1. 公平模式狀態與判定

- [x] 1.1 在 QuizState 加入公平模式開關、延遲設定、準備階段驗證與新活動預設；以單元測試驗證預設、合法設定、非法設定與重設。
- [x] 1.2 保存每筆提交的成功題數快照、加權秒數及判定時間，並依模式計算順位；以單元測試驗證關閉時相容、公平排序、相同時間序及題組計分。

## 2. 伺服器同步與資訊隔離

- [x] 2.1 提供教師公平設定端點並將模式旗標和提交明細依角色回傳；以 Socket.IO 整合測試驗證教師資料、學生僅見開啟提示及結束後模式結果。
- [x] 2.2 在教師準備畫面提供模式開關與延遲設定，教師作答列顯示實際時間、加權秒數、判定時間、順位；學生只顯示公平模式開啟提示。以 UI 測試驗證顯示與欄位唯讀。

## 3. 整合驗收

- [x] 3.1 執行完整測試、OpenSpec 驗證及 `npm start` 首頁檢查；記錄 `npm test` 35/35 通過，`openspec validate add-fair-mode` 與 `openspec validate --specs` 通過，首頁 HTTP 200。

## Workflow follow-up

- Verify the change and fix any gaps before syncing.
- Sync the delta spec, then archive the change.
- Commit with the required Co-authored-by trailer, push the branch, and open a PR to main with the predecessor-PR merge note.
- Confirm `credentials.json` is ignored and absent from the commit.
