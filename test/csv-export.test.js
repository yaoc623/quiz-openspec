const test = require('node:test');
const assert = require('node:assert/strict');
const { buildQuizCsv, csvField, csvFilename, taiwanTimestamp } = require('../src/csv-export');

function endedState() {
  return {
    phase: '已結束', groupCount: 3, fairModeEnabled: true,
    worksheet: { questions: [
      { number: '1', subquestions: [{}] },
      { number: '2', subquestions: [{ label: 'a' }, { label: 'b' }] }
    ] },
    submissions: [
      { questionNumber: '1', group: 1, answers: ['單題答案'], receivedAtMs: 1795163696789, judgedAtMs: 1795163696789, rank: 1, rejected: false },
      { questionNumber: '2', group: 1, answers: ['含,逗號、"引號"\n換行', '第二小題'], receivedAtMs: 1795163696789, judgedAtMs: 1795163699789, rank: null, rejected: true },
      { questionNumber: '2', group: 2, answers: ['遞補甲', '遞補乙'], receivedAtMs: 1795163697789, judgedAtMs: 1795163697789, rank: 1, rejected: false },
      { questionNumber: '2', group: 3, answers: ['其他答案甲', '其他答案乙'], receivedAtMs: 1795163698789, judgedAtMs: 1795163698789, rank: 2, rejected: false }
    ]
  };
}

test('CSV 依題目、小題及組別展開，含未作答與駁回遞補狀態', () => {
  const result = buildQuizCsv(endedState(), 1795163696789);
  const lines = result.content.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
  assert.equal(lines.length, 10);
  assert.equal(lines[0], '題號,小題號,組別,答案,實際送出時間,判定時間,搶答順位,狀態,是否使用公平模式,學號,審核狀態,是否獲勝');
  assert.match(lines[1], /^1,,1,單題答案,/);
  assert.match(lines[2], /^1,,2,,,,,未作答,是,,,否$/);
  assert.match(lines[3], /^1,,3,,,,,未作答,是,,,否$/);
  assert.match(lines[4], /^2,a,1,"含,逗號、""引號""\n換行",.*,,已駁回,是,,已駁回,否$/);
  assert.match(lines[5], /^2,a,2,遞補甲,.*?,.*?,1,成功,是,,有效,是$/);
  assert.match(lines[6], /^2,a,3,其他答案甲,.*?,.*?,2,未成功,是,,有效,否$/);
  assert.match(lines[7], /^2,b,1,第二小題,.*,,已駁回,是,,已駁回,否$/);
  assert.match(lines[8], /^2,b,2,遞補乙,.*?,.*?,1,成功,是,,有效,是$/);
  assert.match(lines[9], /^2,b,3,其他答案乙,.*?,.*?,2,未成功,是,,有效,否$/);
});

test('時間使用台灣時區毫秒格式，檔名使用台灣年月日時分秒', () => {
  const timestamp = Date.parse('2026-11-20T08:34:56.789Z');
  assert.equal(taiwanTimestamp(timestamp), '2026-11-20 16:34:56.789');
  assert.equal(csvFilename(timestamp), 'quiz-result-20261120-163456.csv');
});

test('CSV 特殊欄位依標準規則保留逗號、引號及換行', () => {
  assert.equal(csvField('一般文字'), '一般文字');
  assert.equal(csvField('含,逗號'), '"含,逗號"');
  assert.equal(csvField('含"引號"'), '"含""引號"""');
  assert.equal(csvField('第一行\n第二行'), '"第一行\n第二行"');
});

test('CSV 以 UTF-8 BOM 開頭並拒絕未結束或未匯入活動', () => {
  const { content } = buildQuizCsv(endedState(), 1795163696789);
  assert.equal(content.charCodeAt(0), 0xFEFF);
  assert.throws(() => buildQuizCsv({ ...endedState(), phase: '搶答中' }), /活動結束/);
  assert.throws(() => buildQuizCsv({ ...endedState(), worksheet: null }), /活動結束/);
});
