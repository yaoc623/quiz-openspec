# F-01 至 F-28 第二輪驗收矩陣

已核對助教 PDF 與根目錄的共同功能表截圖，衝突項目依較新的共同功能表與本輪補充規格實作。Windows、Node.js v26.13.1 的 `npm test` 結果為 **64 通過、0 失敗**。Chrome／Edge 驗收使用隔離的瀏覽器設定檔及模擬 Sheets。 `npm ci` 成功，`npm start` 在 localhost:3000 回應 HTTP 200。

| 編號 | 需求 | 第二輪狀態 | 主要實作檔案 | 對應測試 | 第二輪結果 | 待驗 |
|---|---|---|---|---|---|---|
| F-01 | 教師登入，使用指定環境變數管理帳密，限制失敗次數，並以有期限的 Session 驗證與登出 | 已完成 | `src/server.js` | student-login.test.js | 自動測試通過 | — |
| F-02 | 學生登入，頁首顯示伺服器提供的「第 N 組｜學號」，未開題時顯示等待 | 已完成 | `src/identity.js`、`public/app.js` | student-login.test.js／Chrome／Edge | 自動及瀏覽器通過 | — |
| F-03 | 重複登入，重登與重啟恢復帳號、組別、鎖定及結果 | 已完成 | `src/activity-store.js` | student-login.test.js | 自動及瀏覽器通過 | 實體跨裝置網路驗收受 localhost 限制。 |
| F-04 | 匯入題目，掃描導學單動態定位題號、題數及答案格 | 部分完成 | `src/worksheet-parser.js` | worksheet-parser.test.js / worksheet-service.test.js | 模擬 Sheets 通過 | 待兩份真實 Sheets 導學單。 |
| F-05 | 逐題開始與停止，以逐題開關作為主要操作並維護獨立狀態 | 已完成 | `src/quiz-state.js` | student-login.test.js / server-integration.test.js | 自動及瀏覽器通過 | — |
| F-06 | 活動 ID、學號與題號去重，同組不同學號各自作答 | 已完成 | `src/quiz-state.js` | student-login.test.js / stress.js／測試 A、B | 自動及瀏覽器通過 | — |
| F-07 | 前後端答案檢查，拒絕空白及不完整題組 | 已完成 | `public/app.js` | client-ui.test.js / student-login.test.js | 自動測試通過 | — |
| F-08 | 送出狀態，傳送中立即鎖定，原內容重送，顯示截止、已送出或未計入原因 | 已完成 | `public/app.js` | client-ui.test.js / student-login.test.js | 自動測試通過 | — |
| F-09 | 奈秒收件，與背景判定分離，記錄單調奈秒、顯示時間和流水號 | 已完成 | `src/server.js` | student-login.test.js / stress.js | 自動測試通過 | — |
| F-10 | 背景佇列，按流水號處理受理記錄，持久化待處理資料並跨重啟續跑 | 已完成 | `src/quiz-state.js` | student-login.test.js / stress.js | 自動測試通過 | — |
| F-11 | 第一名判定，判定時間及流水號排序，題目停止收件且佇列清空後確定第一名 | 已完成 | `src/quiz-state.js` | quiz-state.test.js / student-login.test.js / stress.js | 自動測試通過 | — |
| F-12 | 學生資料隔離，只提供本人的作答狀態及已公布結果 | 已完成 | `src/quiz-state.js` | student-login.test.js / server-integration.test.js | 自動及瀏覽器通過 | — |
| F-13 | 教師即時監看，顯示學號、組別、答案、時間、延遲及順位 | 已完成 | `public/app.js` | server-integration.test.js / client-ui.test.js／測試 A、L | 自動及瀏覽器通過 | — |
| F-14 | 彙整推送，教師答案更新以 300ms 彙整，保留最後更新 | 已完成 | `src/server.js` | student-login.test.js | 自動測試通過 | — |
| F-15 | 學生結算，顯示已公布的第一名及本組是否得分 | 已完成 | `public/app.js` | client-ui.test.js / server-integration.test.js／測試 E–G | 自動及瀏覽器通過 | — |
| F-16 | 重連同步，重新連線取得當輪題目、截止、鎖定與公布狀態 | 已完成 | `src/server.js` | student-login.test.js / server-integration.test.js | 自動及瀏覽器通過 | 實體裝置網路未驗。 |
| F-17 | Sheets 回填，以獨立工作與 batchUpdate 寫入動態目標，暫時錯誤退避重試並呈現狀態 | 部分完成 | `src/worksheet-service.js` | worksheet-service.test.js / final-integration.test.js | 模擬 Sheets 通過 | 待實際授權、雲端回填及公式／格式檢查。 |
| F-18 | 壓力驗證，100 人三秒內提交並核對流水號、正確順位、唯一勝者及清空佇列 | 已完成 | `test-support/stress.js` | test-support/stress.js | 100 人壓測通過 | — |
| F-19 | 機敏資料，忽略本機帳密、憑證與私人資料，檢查 Git 追蹤 | 已完成 | `.gitignore` | worksheet-parser.test.js / Git 追蹤檢查 | Git 檢查通過 | — |
| F-20 | 題組，題組完整提交共用順位、計分及動態回填 | 部分完成 | `src/worksheet-parser.js` | worksheet-parser.test.js / worksheet-service.test.js | 模擬 Sheets 通過 | 待真實題組回填。 |
| F-21 | 倒數計時，提供不限時、30、60、120、180 與自訂秒數，伺服器獨立控時 | 已完成 | `src/quiz-state.js` | server-integration.test.js / client-ui.test.js | 自動及瀏覽器通過 | — |
| F-22 | 計分板，僅計入已確定第一名，題組一分，審核後重算 | 已完成 | `src/quiz-state.js` | quiz-state.test.js / student-login.test.js／測試 D–H | 自動測試通過 | — |
| F-23 | 公平搶答，以收件時該組已確定的勝題數計算固定延遲 | 已完成 | `src/quiz-state.js` | quiz-state.test.js / final-integration.test.js / stress.js／測試 J | 自動測試通過 | — |
| F-24 | 教師審核，駁回與恢復依原判定順序遞補並留下操作紀錄 | 已完成 | `src/quiz-state.js` | quiz-state.test.js / final-integration.test.js／測試 E–G | 自動測試通過 | — |
| F-25 | CSV，每筆回答一列，題組完整編碼，輸出 BOM 並防公式注入 | 部分完成 | `src/csv-export.js` | csv-export.test.js / server-integration.test.js | 自動測試通過 | 待 Excel GUI 驗證。 |
| F-26 | 逐題揭曉，允許按題獨立公布，學生只收到已公布結果 | 已完成 | `src/quiz-state.js` | server-integration.test.js / Chrome、Edge | 自動及瀏覽器通過 | — |
| F-27 | 新活動，確認後清除當輪狀態、保留帳號，隔離舊請求 | 已完成 | `src/server.js` | student-login.test.js / client-ui.test.js | 自動測試通過 | — |
| F-28 | 草稿，以活動、學號、題目隔離未送出草稿 | 已完成 | `public/app.js` | client-ui.test.js／測試 C | 自動及瀏覽器通過 | — |

## A 至 N 驗收

| 測試 | 第二輪結果與證據 |
|---|---|
| A | 通過。四連線整合中，同組三名各有有效題組答案，順位為 1、2、3。 |
| B | 通過。Chrome 與 Edge 併發送出同學號答案，伺服器只保留一筆。另有獨立 Socket.IO Session 回歸測試。 |
| C | 通過。Chrome／Edge 驗證同組送出後仍保留原草稿，輸入框可用且焦點維持。 |
| D | 通過。前三位同組，題目開放時 0 分，關題後共 1 分。 |
| E | 通過。駁回第一名後，同組第二名遞補，該組仍為 1 分。 |
| F | 通過。下一位有效學生屬另一組時，該題分數移轉。 |
| G | 通過。取消駁回恢復原第一名，揭曉、CSV 與模擬 Sheets 使用當前勝者。 |
| H | 通過。完整雙小題共用一個順位與一分，分開寫回兩格。 |
| I | 通過。跨瀏覽器重整與重登恢復原組、送出狀態及鎖定。 |
| J | 通過。同組兩筆都固定為 3 秒，之後改變前題結果也不重算。 |
| K | 通過。100 名不同學號在 3 秒內提交，詳見下表。 |
| L | 通過。Chrome／Edge 驗證「第 1 組｜000012」在換題、重整與重登仍正確。 |
| M | 通過。整合測試涵蓋正確帳密、錯誤帳密、登出與教師權限。 |
| N | 通過。回歸及新增整合測試合計 64 項。 |

## 100 人壓力測試

`npm run test:stress` 啟動獨立 localhost 伺服器與暫存活動檔，再以 100 個已登入的 Socket.IO 客戶端送出同一題。

| 送出 | 成功 | 失敗 | 重送 | 重複計入 | 遺漏 | 送出至收件確認 | 待處理 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 100 | 0 | 1 | 0 | 0 | 211 ms | 0 |

已檢查流水號唯一、同組多人均可提交、排序、唯一第一名、原內容重送、截止及公平延遲。測試統計採本機收件回覆時間，Sheets 不在壓測路徑。

## 尚待驗證及封存

請使用兩份內容可供測試且已授權服務帳號編輯的 Google Sheets 導學單，依展示流程實際匯入和回填。核對不同分頁、欄位位置、題組、公式與格式。回填後若新審核讓已填過的題目沒有勝者，應人工清理舊值。瀏覽器及模擬 API 結果不代表真實雲端驗收。

OpenSpec 變更與三份正式規格均通過嚴格驗證。已同步 quiz-session 正式規格。缺真實 Sheets 導學單驗收，change 保持開啟；完成後使用 `openspec archive student-login-and-ta-compliance --skip-specs`，正式規格已在本次同步。
