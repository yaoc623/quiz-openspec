# 專案規則

## 專案
課堂搶答系統（軟體工程期末專題），使用 OpenSpec 流程開發。

## 技術
- Node.js + Express + Socket.IO + googleapis
- 前端用純 HTML / CSS / JavaScript
- 資料存在記憶體，不用資料庫
- 只在本機執行（localhost:3000）

## 一定要遵守
1. Google 金鑰放在 credentials.json，絕對不能寫進程式碼，必須列在 .gitignore。
2. 不能寫死任何試算表儲存格位置（例如 "G5"），所有位置都要由程式掃描試算表算出來。
3. 必須透過 Google Sheets API 直接讀寫雲端試算表，不能下載成 xlsx。
4. 每做完一個功能都要能用 npm start 跑起來。
5. 程式碼註解和介面文字使用繁體中文。
6. 修改程式前先說明要改什麼；改完要說明怎麼測試。
