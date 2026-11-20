const test = require('node:test');
const assert = require('node:assert/strict');
const { writeWinningAnswers } = require('../src/worksheet-service');

test('試算表回寫只採駁回後遞補答案，無有效答案的題目不寫入', async () => {
  let request;
  const sheets = { spreadsheets: { values: { batchUpdate: async (value) => { request = value; return { data: { totalUpdatedCells: value.requestBody.data.length } }; } } } };
  const questions = [
    { number: '1', subquestions: [{ target: { sheet: '題目', column: 0, row: 1 } }] },
    { number: '2', subquestions: [{ target: { sheet: '題目', column: 1, row: 1 } }] }
  ];
  const result = await writeWinningAnswers(sheets, 'sheet-id', questions, [
    { questionNumber: '1', answers: ['駁回答案'], rank: null, rejected: true },
    { questionNumber: '1', answers: ['遞補答案'], rank: 1, rejected: false },
    { questionNumber: '2', answers: ['無效答案'], rank: null, rejected: true }
  ]);
  assert.equal(result.updatedCells, 1);
  assert.deepEqual(request.requestBody.data, [{ range: "'題目'!A2", values: [['遞補答案']] }]);
});

test('所有答案遭駁回時不發出空白回寫請求', async () => {
  let called = false;
  const sheets = { spreadsheets: { values: { batchUpdate: async () => { called = true; } } } };
  const result = await writeWinningAnswers(sheets, 'sheet-id', [{ number: '1', subquestions: [{}] }], [{ questionNumber: '1', answers: ['答案'], rejected: true }]);
  assert.deepEqual(result, { updatedCells: 0 });
  assert.equal(called, false);
});
