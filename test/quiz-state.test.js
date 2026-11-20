const test = require('node:test');
const assert = require('node:assert/strict');
const { QuizState } = require('../src/quiz-state');

function worksheet() {
  return { questions: [
    { number: '1', subquestions: [{}, {}] },
    { number: '2', subquestions: [{}] }
  ] };
}

function activeState() {
  const state = new QuizState();
  state.setWorksheet(worksheet());
  state.start();
  return state;
}

test('預設四組並只允許準備階段設定正整數組數', () => {
  const state = new QuizState();
  assert.equal(state.groupCount, 4);
  state.setGroupCount(6);
  assert.equal(state.groupCount, 6);
  state.setGroupCount(101);
  assert.equal(state.groupCount, 101);
  assert.throws(() => state.setGroupCount(0), /正整數/);
  assert.throws(() => state.setGroupCount(-1), /正整數/);
  assert.throws(() => state.setGroupCount(2.5), /正整數/);
});

test('題目載入後開始、結束及錯誤階段轉換', () => {
  const state = new QuizState();
  assert.throws(() => state.start(), /先匯入/);
  state.setWorksheet(worksheet());
  state.start();
  assert.equal(state.phase, '搶答中');
  state.finish();
  assert.equal(state.phase, '已結束');
  assert.throws(() => state.finish(), /不是搶答階段/);
});

test('只在搶答中接受完整答案並限制同組同題只能提交一次', () => {
  const state = new QuizState();
  state.setWorksheet(worksheet());
  assert.throws(() => state.submit(1, '1', ['a', 'b']), /不是搶答階段/);
  state.start();
  assert.throws(() => state.submit(1, '1', ['a']), /所有小題/);
  assert.throws(() => state.submit(5, '1', ['a', 'b']), /組別無效/);
  state.submit(1, '1', ['a', 'b']);
  assert.throws(() => state.submit(1, '1', ['c', 'd']), /不能重複/);
  assert.deepEqual(state.submit(2, '2', ['單題答案']).answers, ['單題答案']);
  state.finish();
  assert.throws(() => state.submit(2, '2', ['x']), /不是搶答階段/);
});

test('有效提交的伺服器收件順位依序增加，無效提交不影響順位', () => {
  const state = activeState();
  assert.throws(() => state.submit(1, '1', ['不完整']), /所有小題/);
  const first = state.submit(2, '1', ['甲', '乙']);
  const second = state.submit(1, '1', ['丙', '丁']);
  assert.deepEqual([first.rank, second.rank], [1, 2]);
  assert.ok(Date.parse(first.receivedAt));
  assert.equal(state.publicState('teacher').submissions[0].successful, true);
});

test('搶答中學生只看自己組別答案，結束後只收到得勝組結果', () => {
  const state = activeState();
  state.submit(1, '1', ['秘密甲', '秘密乙']);
  state.submit(2, '1', ['己組甲', '己組乙']);
  const student = state.publicState({ group: 2 });
  assert.deepEqual(student.submissions.map((entry) => entry.answers), [['己組甲', '己組乙']]);
  assert.equal(JSON.stringify(student).includes('秘密甲'), false);
  const teacher = state.publicState('teacher');
  assert.equal(teacher.submissions.length, 2);
  state.finish();
  const result = state.publicState({ group: 2 });
  assert.deepEqual(result.winners[0], { questionNumber: '1', group: 1, answers: ['秘密甲', '秘密乙'] });
});

test('匯入活動只公開題號與小題標記，不包含題目文字或答案目標', () => {
  const state = new QuizState();
  state.setWorksheet({ questions: [{ number: '1', prompt: '不應公開', subquestions: [{ label: 'a', target: { sheet: 'private' } }] }] });
  const snapshot = JSON.stringify(state.publicState({ group: 1 }));
  assert.equal(snapshot.includes('不應公開'), false);
  assert.equal(snapshot.includes('private'), false);
});

test('已結束活動重設清除題目作答與回寫狀態並保留組數', () => {
  const state = new QuizState();
  state.setGroupCount(7);
  state.setWorksheet(worksheet());
  state.start();
  state.submit(1, '1', ['甲', '乙']);
  state.finish();
  state.markWritebackCompleted();

  state.resetActivity();

  assert.equal(state.phase, '準備中');
  assert.equal(state.groupCount, 7);
  assert.equal(state.worksheet, null);
  assert.deepEqual(state.submissions, []);
  assert.equal(state.sequence, 0);
  assert.equal(state.writebackCompleted, false);
  assert.deepEqual(state.publicState('teacher').questions, []);
  assert.deepEqual(state.publicState('teacher').submissions, []);
});

test('未結束或重複重設會拒絕且不改變活動狀態', () => {
  const state = new QuizState();
  state.setWorksheet(worksheet());
  const worksheetBefore = state.worksheet;
  assert.throws(() => state.resetActivity(), /已結束/);
  state.start();
  assert.throws(() => state.resetActivity(), /已結束/);
  assert.equal(state.phase, '搶答中');
  assert.equal(state.worksheet, worksheetBefore);
  state.finish();
  state.resetActivity();
  assert.throws(() => state.resetActivity(), /已結束/);
  assert.equal(state.worksheet, null);
});

test('倒數時間預設不限時，接受正整數並在新活動重設', () => {
  let now = 1000;
  const state = new QuizState({ now: () => now });
  assert.equal(state.timerLimitSeconds, null);
  assert.equal(state.timerSnapshot().remainingMs, null);
  for (const invalid of [0, -1, 2.5, '30']) assert.throws(() => state.setTimerLimit(invalid), /正整數/);
  state.setTimerLimit(30);
  state.setWorksheet(worksheet());
  state.start();
  assert.equal(state.roundStartedAt, 1000);
  assert.equal(state.deadlineAt, 31000);
  now = 11000;
  assert.equal(state.timerSnapshot().remainingMs, 20000);
  state.finish();
  state.resetActivity();
  assert.equal(state.timerLimitSeconds, null);
  assert.equal(state.deadlineAt, null);
});

test('排行榜每題計一分並依實際送出總時間及組別排序', () => {
  let now = 1000;
  const state = new QuizState({ now: () => now });
  state.setGroupCount(3);
  state.setWorksheet(worksheet());
  state.start();
  now = 2000; state.submit(2, '1', ['二甲', '二乙']);
  now = 3000; state.submit(1, '1', ['一甲', '一乙']);
  now = 5000; state.submit(1, '2', ['一題']);
  now = 6000; state.submit(3, '2', ['三題']);
  assert.deepEqual(state.leaderboard(), [
    { group: 2, score: 1, totalSubmissionTimeMs: 1000 },
    { group: 1, score: 1, totalSubmissionTimeMs: 6000 },
    { group: 3, score: 0, totalSubmissionTimeMs: 5000 }
  ]);
  const student = state.publicState({ group: 1 });
  assert.equal('leaderboard' in student, false);
  assert.ok(state.publicState('teacher').leaderboard);
  state.finish();
  assert.deepEqual(state.publicState({ group: 1 }).leaderboard, state.leaderboard());
});

test('公平模式保存正整數延遲，依送出當下成功題數加權判定', () => {
  let now = 100000;
  const state = new QuizState({ now: () => now });
  state.setGroupCount(2);
  assert.equal(state.fairModeEnabled, false);
  assert.equal(state.fairDelaySeconds, 3);
  assert.throws(() => state.setFairMode(true, 0), /正整數/);
  assert.throws(() => state.setFairMode('true', 3), /開啟或關閉/);
  state.setFairMode(true, 3);
  state.setWorksheet(worksheet());
  state.start();
  now += 1000;
  const first = state.submit(1, '1', ['一甲', '一乙']);
  now += 1000;
  state.submit(1, '2', ['一題']);
  now += 500;
  const laterButWinner = state.submit(2, '2', ['二題']);
  assert.equal(first.successfulCountAtSubmission, 0);
  assert.equal(first.penaltySeconds, 0);
  assert.equal(laterButWinner.successfulCountAtSubmission, 0);
  assert.equal(laterButWinner.judgedAtMs, laterButWinner.receivedAtMs);
  assert.equal(state.submissions.find((item) => item.group === 1 && item.questionNumber === '2').penaltySeconds, 3);
  assert.equal(state.submissions.find((item) => item.group === 1 && item.questionNumber === '2').rank, 2);
  assert.equal(laterButWinner.rank, 1);
  assert.equal(state.publicState('teacher').submissions.find((item) => item.group === 2).successful, true);
  state.finish();
  assert.equal(state.publicState({ group: 1 }).fairModeEnabled, true);
  state.resetActivity();
  assert.equal(state.fairModeEnabled, false);
  assert.equal(state.fairDelaySeconds, 3);
});

test('公平模式判定時間相同時依實際時間及伺服器序號穩定排序，學生不收明細', () => {
  let now = 1000;
  const state = new QuizState({ now: () => now });
  state.setFairMode(true, 3);
  state.setWorksheet(worksheet());
  state.start();
  state.submit(2, '1', ['二甲', '二乙']);
  state.submit(1, '1', ['一甲', '一乙']);
  const student = state.publicState({ group: 1 });
  assert.equal(student.fairModeEnabled, true);
  assert.equal('fairDelaySeconds' in student, false);
  assert.equal('leaderboard' in student, false);
  assert.equal('judgedAt' in student.submissions[0], false);
  assert.equal('penaltySeconds' in student.submissions[0], false);
  assert.equal(state.submissions.find((entry) => entry.group === 2).rank, 1);
  assert.equal(state.submissions.find((entry) => entry.group === 1).rank, 2);
});

test('老師駁回成功答案會依原順位遞補，取消駁回可恢復且排行榜重算', () => {
  const state = activeState();
  const first = state.submit(1, '1', ['一甲', '一乙']);
  const second = state.submit(2, '1', ['二甲', '二乙']);
  assert.equal(state.reviewSubmission(first.sequence, true).rejected, true);
  assert.equal(first.rank, null);
  assert.equal(second.rank, 1);
  assert.equal(state.leaderboard().find((row) => row.group === 2).score, 1);
  assert.equal(state.publicState('teacher').submissions.find((entry) => entry.sequence === first.sequence).successful, false);
  assert.equal(state.publicState('teacher').submissions.find((entry) => entry.sequence === first.sequence).rejected, true);
  assert.throws(() => state.reviewSubmission(first.sequence, true), /目前成功答案/);
  state.reviewSubmission(first.sequence, false);
  assert.equal(first.rank, 1);
  assert.equal(second.rank, 2);
  assert.throws(() => state.reviewSubmission(first.sequence, false), /沒有被駁回/);
});

test('駁回最後一筆答案後結果標示無人答對，公平模式新權重以遞補結果為準', () => {
  let now = 1000;
  const state = new QuizState({ now: () => now });
  state.setGroupCount(2);
  state.setFairMode(true, 3);
  state.setWorksheet(worksheet());
  state.start();
  const first = state.submit(1, '1', ['甲', '乙']);
  state.reviewSubmission(first.sequence, true);
  assert.equal(state.publicState('teacher').leaderboard[0].score, 0);
  now += 1000;
  const second = state.submit(2, '2', ['答案']);
  assert.equal(second.successfulCountAtSubmission, 0);
  state.finish();
  assert.equal(state.publicState({ group: 1 }).winners[0].noCorrectAnswer, true);
  assert.equal(state.publicState({ group: 1 }).winners[0].group, null);
});

test('揭曉模式只向學生公開目前已揭曉題目並在全部完成後顯示排行榜', () => {
  const state = new QuizState();
  state.setGroupCount(2);
  state.setWorksheet({ sheet: '題目', questions: [{ number: '1', subquestions: [{}] }, { number: '2', subquestions: [{}] }] });
  state.start();
  state.submit(1, '1', ['第一題答案']);
  state.submit(2, '2', ['第二題答案']);
  state.finish();

  const ordinaryResults = state.publicState({ group: 1 });
  assert.equal(ordinaryResults.winners.length, 2);
  state.setRevealIndex(-1);
  const hidden = state.publicState({ group: 1 });
  assert.deepEqual(hidden.winners, []);
  assert.equal(hidden.leaderboard, undefined);
  assert.equal(JSON.stringify(hidden).includes('第一題答案'), false);
  state.setRevealIndex(0);
  const first = state.publicState({ group: 1 });
  assert.deepEqual(first.winners.map((winner) => winner.questionNumber), ['1']);
  assert.equal(JSON.stringify(first).includes('第二題答案'), false);
  state.setRevealIndex(2);
  assert.equal(state.publicState({ group: 1 }).leaderboard.length, 2);
  assert.equal(state.publicState('teacher').submissions.length, 2);
  assert.throws(() => state.setRevealIndex(3), /超出範圍/);
});
