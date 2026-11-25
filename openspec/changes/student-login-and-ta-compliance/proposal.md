## Why

課堂活動需要可重複辨識學生的學號，以及由伺服器驗證的教師控制權。每道題目也需要獨立開放、停止及計時。

## What Changes

- 以學號登入、活動組別及 Cookie Session 取代前端自行宣告的角色。
- 新增單題開關，保留全題與逐題模式。
- 將學號納入提交、公布與 CSV。

## Capabilities

### New Capabilities

### Modified Capabilities

- `quiz-session`：登入、逐題開關、提交資料及結算。

## Impact

影響首頁、HTTP、Socket.IO、活動狀態及 CSV。沿用 Google Sheets 動態映射。
