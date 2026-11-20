# Tasks

## 1. 計時狀態與生命週期

- [x] 1.1 在活動狀態加入不限時/秒數設定、開始時間與期限，驗證自訂秒數為正整數且新活動重設為不限時；以 QuizState 單元測試涵蓋預設、有效設定、無效設定及重設。
- [x] 1.2 實作伺服器權威期限、剩餘時間快照、到期自動結束及手動結束清除排程；以可控時鐘測試到期、提前結束、重新連線快照及不重複結束。

## 2. 計時介面與同步

- [x] 2.1 在老師準備畫面加入不限時、預設秒數、自訂秒數設定並在開始前提交；以介面測試驗證選項、錯誤輸入阻擋及開始後唯讀。
- [x] 2.2 在老師與學生畫面顯示伺服器校正倒數、最後 10 秒紅色提示及新連線接續時間；以瀏覽器端測試驗證同步狀態、顏色門檻及重新連線不重設期限。

## 3. 排行榜計算與角色可見性

- [x] 3.1 加入每題一分（題組算一題）、累計有效實際送出時間與組別編號的穩定排序；以 QuizState 單元測試驗證分數、題組計分、時間平手及最終平手。
- [x] 3.2 在角色專用狀態快照提供老師搶答中即時排行榜、學生結束前不含排行榜及結束後所有分頁的最終排行榜；以 Socket.IO 多角色整合測試驗證資料可見性及同步。
- [x] 3.3 加入老師與學生排行榜介面，確保搶答中只有老師看到即時榜、結束後所有分頁看到相同排序；以瀏覽器端測試驗證畫面顯示和即時更新。

## 4. 整合驗收

- [x] 4.1 執行完整舊有與新增測試、OpenSpec change/spec 驗證，並以 `npm start` 啟動及檢查首頁；記錄所有命令結果。`npm test`：30/30 通過；`openspec validate add-timer-scoreboard` 通過；`npm start` 首頁 HTTP 200。

## Workflow follow-up

- Verify the change and fix any gaps before syncing.
- Sync the delta spec, then archive the change.
- Commit with the required Co-authored-by trailer, push the branch, and open a PR to main with the predecessor-PR merge note.
- Confirm `credentials.json` is ignored and absent from the commit.
