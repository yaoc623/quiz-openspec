const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: connect } = require('socket.io-client');
const { createQuizServer } = require('../src/server');
const { parseWorksheet } = require('../src/worksheet-parser');
const { targetA1 } = require('../src/worksheet-service');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('教師與兩組學生串接公平順位、遞補、揭曉、CSV 與位移回填', { timeout: 10000 }, async (t) => {
  const parsed = parseWorksheet({
    title: '位移學習單',
    rows: [[], ['', '', '題號', '題目', '作答'], ['', '', '1', '甲', '(a)'],
      ['', '', '', '乙', '（b）'], ['', '', '2', '丙', '']],
    merges: [{ startRowIndex: 2, endRowIndex: 4, startColumnIndex: 2, endColumnIndex: 3 }]
  });
  const writes = [];
  const started = deferred();
  const pending = deferred();
  let now = Date.UTC(2026, 10, 20, 8);
  const service = createQuizServer({
    now: () => now,
    readCredentials: () => ({}),
    importWorksheet: async () => ({ spreadsheetId: 'mock', parsed }),
    createSheetsClient: async () => ({ spreadsheets: { values: {
      batchUpdate: async (payload) => {
        writes.push(payload);
        if (writes.length === 1) {
          started.resolve();
          await pending.promise;
          throw new Error('模擬回填失敗');
        }
        return { data: { totalUpdatedCells: payload.requestBody.data.length } };
      }
    } } })
  });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const sockets = [];
  t.after(async () => {
    pending.resolve();
    sockets.forEach((socket) => socket.close());
    await service.io.close();
  });
  const post = (path, body = {}, teacher = true) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(teacher ? { 'x-quiz-role': 'teacher' } : {}) },
    body: JSON.stringify(body)
  });
  const join = (role, group) => {
    const socket = connect(base, { auth: { role, group }, forceNew: true, reconnection: false });
    sockets.push(socket);
    return socket;
  };
  assert.equal((await post('/api/groups', { groupCount: 2 })).status, 200);
  await once(join('student', 3), 'connect_error');
  const teacher = join('teacher');
  const first = join('student', 1);
  const second = join('student', 2);
  await Promise.all([teacher, first, second].map((socket) => once(socket, 'state')));
  assert.equal((await post('/api/worksheet/import', {}, false)).status, 403);
  assert.equal((await post('/api/worksheet/import')).status, 200);
  assert.equal((await post('/api/timer', { limitSeconds: 30 })).status, 200);
  assert.equal((await post('/api/fair-mode', { enabled: true, delaySeconds: 3 })).status, 200);
  assert.equal((await post('/api/phase/start')).status, 200);
  const submit = (socket, questionNumber, answers) => socket.emitWithAck('answer:submit', { questionNumber, answers });
  assert.equal((await submit(first, '1', ['甲', '  '])).ok, false);
  assert.equal((await submit(first, '1', ['甲', '乙'])).entry.rank, 1);
  now += 100;
  assert.equal((await submit(second, '1', ['其他甲', '其他乙'])).entry.rank, 2);
  now += 100;
  assert.equal((await submit(first, '2', ['較早送出'])).entry.penaltySeconds, 3);
  now += 100;
  assert.equal((await submit(second, '2', ['單題'])).entry.rank, 1);
  assert.equal((await post('/api/phase/finish')).status, 200);
  const studentReset = await first.emitWithAck('activity:new', {});
  assert.match(studentReset.error, /僅限老師/);

  const initialWrite = post('/api/worksheet/writeback');
  await started.promise;
  assert.equal((await post('/api/worksheet/writeback')).status, 409);
  assert.match((await teacher.emitWithAck('activity:new', {})).error, /回填進行中/);
  assert.equal((await post('/api/submissions/1/reject')).status, 409);
  assert.equal(service.state.phase, '已結束');
  pending.resolve();
  assert.equal((await initialWrite).status, 400);
  assert.equal(service.state.writebackCompleted, false);
  assert.equal((await post('/api/submissions/1/reject', {}, false)).status, 403);
  assert.equal((await post('/api/submissions/1/reject')).status, 200);
  assert.equal((await post('/api/reveal', { index: -1 }, false)).status, 403);
  const hidden = once(second, 'state');
  assert.equal((await post('/api/reveal', { index: -1 })).status, 200);
  const [hiddenState] = await hidden;
  assert.deepEqual(hiddenState.winners, []);
  assert.equal(hiddenState.leaderboard, undefined);
  const firstReveal = once(first, 'state');
  assert.equal((await post('/api/reveal', { index: 0 })).status, 200);
  const [firstRevealState] = await firstReveal;
  assert.deepEqual(firstRevealState.winners.map(({ group, answers }) => [group, answers]), [[2, ['其他甲', '其他乙']]]);
  const finalReveal = once(second, 'state');
  assert.equal((await post('/api/reveal', { index: 2 })).status, 200);
  const [finalState] = await finalReveal;
  assert.equal(finalState.leaderboard[0].group, 2);
  assert.equal(finalState.leaderboard[0].score, 2);
  assert.equal((await fetch(base + '/api/results.csv')).status, 403);
  const csv = await fetch(base + '/api/results.csv', { headers: { 'x-quiz-role': 'teacher' } });
  assert.equal(csv.status, 200);
  const contents = await csv.text();
  assert.match(contents, /其他甲/);
  assert.match(contents, /已駁回/);
  assert.equal((await post('/api/worksheet/writeback')).status, 200);
  assert.deepEqual(writes[1].requestBody.data.map(({ range, values }) => [range, values[0][0]]),
    parsed.questions.flatMap((question, i) => question.subquestions.map((part, j) =>
      [targetA1(part.target), [['其他甲', '其他乙'], ['單題']][i][j]])));
  assert.equal((await teacher.emitWithAck('activity:new', {})).ok, true);
  assert.equal(service.state.phase, '準備中');
});
