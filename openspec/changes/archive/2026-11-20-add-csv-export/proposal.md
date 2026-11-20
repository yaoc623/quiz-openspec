# Proposal

## Why

活動結束後，老師需要一份可保存、整理與後續分析的作答明細。以標準 CSV 匯出所有題目、小題及各組狀態，可讓未作答與駁回資料也一併留存。

## What Changes

- 活動結束後提供老師下載搶答結果 CSV。
- 每個題目小題與組別各產生一列，包含未作答組別，並以駁回後的成功順位與結果標示狀態。
- 匯出欄位、台灣時間格式、檔名、UTF-8 BOM 與 CSV 特殊字元跳脫依規格固定。

## Capabilities

### New Capabilities

### Modified Capabilities
- `quiz-session`: 活動結束後由老師匯出每題、每小題、每組的結果 CSV。

## Impact

影響結果資料的 CSV 轉換、教師專用下載端點、教師頁面下載操作，以及匯出格式與權限測試；不新增套件或持久化資料。
