# 學習單差異規格

## ADDED Requirements

### Requirement: 保持回填與當輪結果一致
系統 SHALL 在回填進行期間拒絕重複回填、活動重設及變更成功答案的審核操作。回填成功或失敗後 SHALL 恢復操作，並允許失敗後重試。

#### Scenario: 回填未完成時嘗試重設
- **WHEN** 教師在 Sheets 請求進行中要求開始新活動
- **THEN** 系統拒絕並保留本輪狀態及外部寫入目標

#### Scenario: 回填失敗後可重試
- **WHEN** Sheets API 回報回填失敗
- **THEN** 系統回報失敗並允許教師再回填或重設活動
