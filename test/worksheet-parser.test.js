const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseWorksheet, parseWorksheets } = require('../src/worksheet-parser');
const { spreadsheetIdFromUrl, loadCredentials, columnName, targetA1, readWorksheetData, writeWinningAnswers } = require('../src/worksheet-service');

function movedSheet({ top = 0, left = 0, body = [] } = {}) {
  const rows = Array.from({ length: top + body.length }, () => []);
  const header = [];
  header[left] = '題號'; header[left + 1] = '題目'; header[left + 2] = '作答';
  rows[top] = header;
  body.forEach((cells, index) => {
    const row = [];
    cells.forEach((cell, offset) => { if (cell !== undefined && cell !== null) row[left + offset] = cell; });
    rows[top + index + 1] = row;
  });
  return { rows, top, left };
}

test('掃描位移後的同列必要表頭並回傳動態欄索引', () => {
  const sheet = movedSheet({ top: 3, left: 4, body: [['1', '題目一', '']] });
  const parsed = parseWorksheet({ title: '學習單', rows: sheet.rows });
  assert.equal(parsed.header.row, 3);
  assert.deepEqual([parsed.header.number, parsed.header.prompt, parsed.header.answer], [4, 5, 6]);
  assert.deepEqual(parsed.questions.map((question) => question.number), ['1']);
});

test('解析六題單題並忽略題目欄空白列', () => {
  const body = Array.from({ length: 6 }, (_, index) => [String(index + 1), `題目 ${index + 1}`, '']);
  body.splice(3, 0, [null, '', '']);
  const { rows } = movedSheet({ body });
  const parsed = parseWorksheet({ title: '學習單', rows });
  assert.equal(parsed.questions.length, 6);
  assert.deepEqual(parsed.questions.map((question) => question.subquestions.length), [1, 1, 1, 1, 1, 1]);
});

test('解析兩個雙小題題組、單題及半形全形括號標記', () => {
  const { rows } = movedSheet({ top: 2, left: 3, body: [
    ['1', '題目一甲', '(a)'], [null, '題目一乙', '（b）'],
    ['2', '題目二甲', '（1）'], [null, '題目二乙', '(2)'],
    ['3', '題目三', '填答'], ['4', '題目四', '填答']
  ] });
  const merges = [
    { startRowIndex: 3, endRowIndex: 5, startColumnIndex: 3, endColumnIndex: 4 },
    { startRowIndex: 5, endRowIndex: 7, startColumnIndex: 3, endColumnIndex: 4 }
  ];
  const parsed = parseWorksheet({ title: '練習表', rows, merges });
  assert.deepEqual(parsed.questions.map((question) => question.subquestions.length), [2, 2, 1, 1]);
  assert.equal(parsed.questions[0].subquestions[0].target.column, parsed.header.answer + 1);
  assert.equal(parsed.questions[1].subquestions[1].label, '2');
});

test('合併題號與單題答案格使用合併區域左上角', () => {
  const { rows, top, left } = movedSheet({ top: 4, left: 2, body: [
    ['8', '題組甲', '(a)'], [null, '題組乙', '(b)'], ['9', '單題', '答案']
  ] });
  const merges = [
    { startRowIndex: top + 1, endRowIndex: top + 3, startColumnIndex: left, endColumnIndex: left + 1 },
    { startRowIndex: top + 3, endRowIndex: top + 4, startColumnIndex: left + 2, endColumnIndex: left + 4 }
  ];
  const parsed = parseWorksheet({ title: '工作表', rows, merges });
  assert.equal(parsed.questions[0].number, '8');
  assert.equal(parsed.questions[1].subquestions[0].target.row, top + 3);
  assert.equal(parsed.questions[1].subquestions[0].target.column, left + 2);
});

test('有題目但空白題號未合併時拒絕錯併到上一題', () => {
  const { rows } = movedSheet({ body: [['1', '題目一', '答案'], [null, '題號遺漏的題目', '答案']] });
  assert.throws(() => parseWorksheet({ title: '格式錯誤', rows }), /找不到題號或合併題號/);
});

test('學習單向右及向下移動時題目結構相同且答案索引同步移動', () => {
  const body = [['1', '題目甲', '(a)'], [null, '題目乙', '(b)']];
  const first = movedSheet({ body });
  const second = movedSheet({ top: 6, left: 8, body });
  const a = parseWorksheet({ title: 'A', rows: first.rows, merges: [{ startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 }] });
  const b = parseWorksheet({ title: 'B', rows: second.rows, merges: [{ startRowIndex: 7, endRowIndex: 9, startColumnIndex: 8, endColumnIndex: 9 }] });
  assert.deepEqual(a.questions.map(({ number, subquestions }) => [number, subquestions.length]), b.questions.map(({ number, subquestions }) => [number, subquestions.length]));
  assert.equal(b.questions[0].subquestions[0].target.row - a.questions[0].subquestions[0].target.row, 6);
  assert.equal(b.questions[0].subquestions[0].target.column - a.questions[0].subquestions[0].target.column, 8);
});

test('掃描全部工作表並在沒有表頭時拒絕匯入', () => {
  const worksheet = { title: '第二張', rows: movedSheet({ body: [['1', '題目', '']] }).rows, merges: [] };
  const mockSheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: '空白頁' } }, { properties: { title: worksheet.title } }] } }),
    values: { get: async ({ range }) => ({ data: { values: range.includes('第二張') ? worksheet.rows : [] } }) }
  } };
  return readWorksheetData(mockSheets, 'mock-id').then((parsed) => assert.equal(parsed.sheet, '第二張'));
});

test('找不到必要表頭時顯示繁體中文錯誤', () => {
  assert.throws(() => parseWorksheets([{ title: '空白頁', rows: [['欄位', '資料']] }]), /找不到同一列/);
});

test('解析 Google 試算表網址並拒絕其他網址', () => {
  assert.equal(spreadsheetIdFromUrl('https://docs.google.com/spreadsheets/d/abc_123/edit#gid=2'), 'abc_123');
  assert.throws(() => spreadsheetIdFromUrl('https://example.com/abc'), /Google 試算表/);
});

test('憑證讀取錯誤不洩漏內容並以繁體中文說明', () => {
  assert.throws(() => loadCredentials('此路徑不存在/credentials.json'), /找不到 credentials.json/);
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(27), 'AB');
  const target = { sheet: "老師's Sheet", row: 9, column: 27 };
  assert.ok(targetA1(target).endsWith(`${columnName(target.column)}${target.row + 1}`));
});

test('拒絕格式錯誤憑證並確認 credentials.json 受 Git 忽略', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-creds-'));
  const malformed = path.join(folder, 'credentials.json');
  fs.writeFileSync(malformed, JSON.stringify({ client_email: 'wrong@example.test' }));
  try { assert.throws(() => loadCredentials(malformed), /格式錯誤/); }
  finally { fs.rmSync(folder, { recursive: true, force: true }); }
  const result = spawnSync('git', ['check-ignore', '--no-index', 'credentials.json'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('回寫從解析出的答案目標批次更新單題與題組答案', async () => {
  const { rows, top, left } = movedSheet({ top: 2, left: 5, body: [['1', '甲', '(a)'], [null, '乙', '(b)'], ['2', '丙', '答案']] });
  const parsed = parseWorksheet({ title: '回寫頁', rows, merges: [{ startRowIndex: top + 1, endRowIndex: top + 3, startColumnIndex: left, endColumnIndex: left + 1 }] });
  const ranges = [];
  const mockSheets = { spreadsheets: { values: { batchUpdate: async (payload) => { ranges.push(...payload.requestBody.data); return { data: { totalUpdatedCells: payload.requestBody.data.length } }; } } } };
  const submissions = [
    { questionNumber: '1', rank: 1, answers: ['甲答', '乙答'] },
    { questionNumber: '2', rank: 1, answers: ['丙答'] }
  ];
  const response = await writeWinningAnswers(mockSheets, 'mock-id', parsed.questions, submissions);
  assert.equal(response.updatedCells, 3);
  assert.deepEqual(ranges.map((item) => item.values[0][0]), ['甲答', '乙答', '丙答']);
  assert.ok(ranges.every((item) => item.range.includes('回寫頁')));
  assert.equal(parsed.questions[0].subquestions[0].target.row, top + 1);
  assert.equal(parsed.questions[0].subquestions[0].target.column, left + 3);
});

test('Sheets API 回寫錯誤會向呼叫端拋出失敗', async () => {
  const mockSheets = { spreadsheets: { values: { batchUpdate: async () => { throw new Error('permission denied'); } } } };
  await assert.rejects(
    writeWinningAnswers(mockSheets, 'mock-id', [{ number: '5', subquestions: [{ target: { sheet: '表', row: 0, column: 0 } }] }], [{ questionNumber: '5', rank: 1, answers: ['答案'] }]),
    /permission denied/
  );
});
