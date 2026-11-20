# Proposal

## Why

目前專案沒有課堂搶答流程，老師無法從學習單建立題目、同步控制作答階段、即時掌握各組提交，也無法把搶答成功答案寫回原試算表。本變更定義一套免帳密、依組參與並由伺服器判定順位的核心流程。

## What Changes

- 首頁可選老師或第 N 組；組數預設為 4，老師可設定組數，不需帳號密碼。
- 老師貼上 Google 試算表網址後，系統透過 Google Sheets API 掃描所有工作表，匯入題號與小題結構，不向學生顯示題目文字；顯示總題數及每題小題數。
- 解析表頭、答案格及合併儲存格以掃描結果動態定位，程式不使用固定儲存格座標；題組須完整一次提交。
- 以準備中、搶答中、已結束同步所有畫面；伺服器以收到有效答案的先後決定順位及每題搶答成功組別。
- 老師即時查看所有組別答案、時間及順位；搶答中學生只能取得自己組別的答案，結束後老師和學生可看結果。
- 顯示服務帳號 email 和試算表編輯者分享提醒；服務憑證存於 `credentials.json`、排除於版本控制，且不寫進程式碼；答案直接寫回原 Google 試算表，不下載 xlsx。
- 為解析功能建立假資料單元測試，涵蓋六題單題、兩題各含兩小題加兩題單題，以及表格向右/向下移動。

## Capabilities

### New Capabilities
- `quiz-session`: 管理角色、組別、同步階段、作答、順位、權限及結果。
- `worksheet-integration`: 透過 Google Sheets API 動態解析學習單並回寫成功答案。

### Modified Capabilities

無。

## Impact

- 專案採用 Node.js、Express、Socket.IO、googleapis、純 HTML/CSS/JavaScript、記憶體狀態及本機 `localhost:3000`；實作須建立符合目標堆疊的 `npm start` 入口。
- 預期影響伺服器、前端、Google Sheets adapter、`.gitignore` 與測試；需以假資料測試解析，不依賴真實 Google 憑證。
