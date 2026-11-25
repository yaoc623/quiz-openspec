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
test('兩份不同工作表與版面的 Guided Notes 以模擬 API 匯入及動態回填', async () => {
  const { importWorksheet, writeWinningAnswers } = require('../src/worksheet-service');
  const examples = [
    { title: '單題範例', rows: [
      ['題號', '題目', '作答'], ['1', '單題'],
    ], expected: [["'單題範例'!C2", '答案 1-1']] },
    { title: "課堂'練習", rows: [
      ['導學單'], [], ['', '', '題號', '題目', '作答'],
      ['', '', '3', '題組', '(a)'], ['', '', '', '延伸', '（b）'],
      ['', '', '4', '單題'],
    ], merges: [{ startRowIndex: 3, endRowIndex: 5, startColumnIndex: 2, endColumnIndex: 3 }],
    expected: [["'課堂''練習'!F4", '答案 3-1'], ["'課堂''練習'!F5", '答案 3-2'], ["'課堂''練習'!E6", '答案 4-1']] }
  ];
  for (const { title, rows, merges = [], expected } of examples) {
    const writes = [];
    const sheets = { spreadsheets: {
      async get() { return { data: { sheets: [{ properties: { title: '封面' } }, { properties: { title }, merges }] } }; },
      values: {
        async get({ range }) { return { data: { values: range === "'封面'" ? [['說明']] : rows } }; },
        async batchUpdate(request) { writes.push(request); return { data: {} }; }
      }
    } };
    const { parsed, spreadsheetId } = await importWorksheet('https://docs.google.com/spreadsheets/d/mock/edit', {
      credentials: { client_email: 'example@example.test' }, sheets
    });
    assert.equal(parsed.sheet, title);
    const submissions = parsed.questions.map(({ number, subquestions }) => ({
      questionNumber: number, rank: 1, rejected: false,
      answers: subquestions.map((_, index) => `答案 ${number}-${index + 1}`)
    }));
    await writeWinningAnswers(sheets, spreadsheetId, parsed.questions, submissions);
    assert.equal(writes[0].requestBody.valueInputOption, 'RAW');
    assert.deepEqual(writes[0].requestBody.data.map(({ range, values }) => [range, values[0][0]]), expected);
  }
});
