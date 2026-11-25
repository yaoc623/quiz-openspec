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

test('CSV 每筆回答一列，保留同組題組與審核並防公式注入', () => {
  const state = endedState();
  state.submissions.forEach((entry, index) => { entry.sequence = index + 1; entry.studentId = String(900100 + index); });
  state.submissions.push({ ...state.submissions[0], sequence: 5, studentId: '900110', rank: 2, answers: ['=1+1'] });
  const result = buildQuizCsv(state, 1795163696789);
  const lines = result.content.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[0], '題號,流水號,收件時間（毫秒）,學號,組別,答案,延遲（秒）,判定時間,順位,是否第一名,是否駁回');
  assert.match(lines[1], /^1,1,.*?,900100,1,單題答案,.*?,1,是,否$/);
  assert.match(lines[2], /^2,2,.*?,900101,1,.*第二小題.*,,否,是$/);
  assert.match(lines[3], /^2,3,.*?,900102,2,.*遞補甲.*遞補乙.*1,是,否$/);
  assert.ok(lines[5].includes("900110,1,'=1+1"));
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
