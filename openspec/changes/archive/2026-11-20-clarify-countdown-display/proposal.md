# 釐清倒數顯示

## Why

教師已套用時限但尚未開始時，快照沒有剩餘毫秒，舊畫面會把這個狀態顯示為不限時，讓老師與學生誤以為設定沒有生效。

## What Changes

- 依目前階段顯示已設定秒數、剩餘時間或結束狀態。

## Capabilities

### Modified Capabilities

- `quiz-session` 新增各階段的倒數顯示規則。

## Impact

僅涉及倒數顯示及前端測試。
