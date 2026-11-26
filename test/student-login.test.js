const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { createQuizServer } = require('../src/server');
const { login, teacherCookie, teacherOptions, trackActivity } = require('../test-support/login');

async function launch(t, options = {}) {
  const service = createQuizServer({ ...teacherOptions, ...options });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const clients = [];
  t.after(async () => {
    clients.forEach((client) => client.close());
    await service.io.close();
  });
  const request = (url, body, cookie) => fetch(base + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  async function student(studentId, group) {
    const response = await login(base, 'student', { studentId, group });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function socket(cookie) {
    const client = trackActivity(io(base, { forceNew: true, reconnection: false, extraHeaders: { cookie } }));
    clients.push(client);
    const [snapshot] = await once(client, 'state');
    return { client, snapshot };
  }
  return { ...service, base, request, student, socket };
}

test('教師帳密、角色 Cookie、教師與學生登出及連線失效', { timeout: 10000 }, async (t) => {
  const service = await launch(t);
  assert.equal((await login(service.base, 'teacher', { username: 'test-teacher', password: 'wrong' })).status, 401);
  assert.equal((await service.request('/api/groups', { groupCount: 2 })).status, 403);
  const student = await service.student('900100', 1);
  assert.equal((await service.request('/api/groups', { groupCount: 2 }, student.cookie)).status, 403);
  assert.equal((await service.request('/api/info', undefined, student.cookie).then((r) => r.json())).serviceAccountEmail, undefined);
  const teacher = await teacherCookie(service.base);
  assert.equal((await service.request('/api/groups', { groupCount: 2 }, teacher)).status, 200);
  const forged = io(service.base, { auth: { role: 'teacher' }, extraHeaders: { cookie: 'quiz_session=teacher' }, reconnection: false });
  try { assert.match((await once(forged, 'connect_error'))[0].message, /先登入/); }
  finally { forged.close(); }
  for (const cookie of [student.cookie, teacher]) {
    const { client } = await service.socket(cookie);
    const disconnected = once(client, 'disconnect');
    assert.equal((await service.request('/api/session/logout', {}, cookie)).status, 200);
    await disconnected;
    assert.deepEqual(await service.request('/api/session', undefined, cookie).then((r) => r.json()), { identity: null });
  }
  assert.equal((await service.request('/api/groups', { groupCount: 2 }, teacher)).status, 403);
});

test('教師帳密缺漏提示設定，連續登入失敗限流', { timeout: 10000 }, async (t) => {
  const unconfigured = await launch(t, { teacherPassword: '' });
  const missing = await login(unconfigured.base, 'teacher', {});
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).error, /TEACHER_PASSWORD/);
  const service = await launch(t);
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await login(service.base, 'teacher', { username: 'test-teacher', password: 'wrong' })).status, 401);
  }
  const limited = await login(service.base, 'teacher', { username: 'test-teacher', password: 'wrong' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('重啟恢復已受理佇列、組別、截止與公布結果，舊活動資料隔離', { timeout: 10000 }, async (t) => {
  const { QuizState } = require('../src/quiz-state');
  const { createActivityStore } = require('../src/activity-store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-activity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const activityPath = path.join(directory, 'activity.json');
  const now = 10000;
  const saved = new QuizState({ now: () => now });
  saved.setWorksheet({ questions: [{ number: '1', subquestions: [{}] }] });
  saved.setTimerLimit(30);
  saved.toggleQuestion('1', 'open');
  saved.admit({
    studentId: '000012', group: 1, questionNumber: '1', answers: ['已受理待判定'],
    receivedAtMs: now, receivedAtNs: '100', orderNs: '50000000000'
  });
  createActivityStore(activityPath).save({ state: saved.snapshot(), groups: [['000012', 1]],
    spreadsheetId: 'mock', lastOrderNs: '50000000000' });
  const service = await launch(t, { activityPath, now: () => now + 1000 });
  const student = await service.student('000012', 2);
  assert.equal(student.body.identity.group, 1);
  const { client, snapshot } = await service.socket(student.cookie);
  assert.equal(snapshot.activityId, saved.activityId);
  assert.equal(snapshot.questions[0].deadlineAt, 40000);
  assert.deepEqual(snapshot.submissions[0].answers, ['已受理待判定']);
  assert.equal(service.state.pending.length, 0);
  assert.equal(service.state.submissions[0].receivedAtNs, '100');
  const second = await service.student('000014', 1);
  const peer = (await service.socket(second.cookie)).client;
  const processed = once(peer, 'state');
  assert.equal((await peer.emitWithAck('answer:submit', { questionNumber: '1', answers: ['重啟後'] })).ok, true);
  await processed;
  assert.equal(service.state.submissions[1].sequence, 2);
  assert.ok(BigInt(service.state.submissions[1].orderNs) > 50000000000n);
  assert.equal(service.state.submissions[0].rank, 1);
  const teacher = await teacherCookie(service.base);
  await service.request('/api/phase/finish', { reveal: true }, teacher);
  await service.request('/api/reveal/question/1', { visible: true }, teacher);
  await service.io.close();
  const restarted = await launch(t, { activityPath, now: () => now + 2000 });
  const resumed = await restarted.student('000012');
  assert.equal((await restarted.socket(resumed.cookie)).snapshot.winners[0].studentId, '000012');
  const newTeacher = (await restarted.socket(await teacherCookie(restarted.base))).client;
  const oldStudent = (await restarted.socket(resumed.cookie)).client;
  assert.equal((await newTeacher.emitWithAck('activity:new', {})).ok, true);
  const rejoined = await restarted.student('000012', 2);
  const current = (await restarted.socket(rejoined.cookie)).client;
  assert.equal((await current.emitWithAck('answer:submit', { activityId: saved.activityId, questionNumber: '1', answers: ['舊活動'] })).status, '已截止');
  assert.equal(restarted.state.receipts.length, 0);
  oldStudent.close();
  client.close();
});

test('未計入鎖定原始提交，教師作答以 300 毫秒彙整且不漏尾筆', { timeout: 10000 }, async (t) => {
  const service = await launch(t);
  service.state.setWorksheet({ questions: [{ number: '1', subquestions: [{}, {}] }, { number: '2', subquestions: [{}] }] });
  const teacher = await teacherCookie(service.base);
  const teacherClient = (await service.socket(teacher)).client;
  const first = (await service.socket((await service.student('000012', 1)).cookie)).client;
  const second = (await service.socket((await service.student('000013', 1)).cookie)).client;
  const open = once(teacherClient, 'state');
  await service.request('/api/questions/1/open', {}, teacher);
  await open;
  const secondOpen = once(teacherClient, 'state');
  await service.request('/api/questions/2/open', {}, teacher);
  await secondOpen;
  const invalid = new Promise((resolve) => {
    first.on('answer:status', (status) => { if (status.status === '未計入') resolve(status); });
  });
  const pushed = once(teacherClient, 'state');
  const started = performance.now();
  const submit = (client, questionNumber, answers) => client.emitWithAck('answer:submit', { questionNumber, answers });
  assert.equal((await submit(first, '1', ['少一題'])).status, '已送出');
  assert.match((await invalid).error, /所有小題/);
  assert.equal((await submit(first, '1', ['這', '是重送'])).status, '未計入');
  await Promise.all([submit(first, '2', ['甲']), submit(second, '2', ['乙'])]);
  const [snapshot] = await pushed;
  assert.ok(performance.now() - started >= 190);
  assert.deepEqual(snapshot.submissions.map(({ studentId }) => studentId).sort(), ['000012', '000013']);
  assert.ok(snapshot.submissions.every(({ confirmed }) => !confirmed));
  assert.equal(snapshot.leaderboard[0].score, 0);
  const closed = once(teacherClient, 'state');
  await service.request('/api/questions/2/close', {}, teacher);
  const [confirmed] = await closed;
  assert.ok(confirmed.submissions.every(({ confirmed }) => confirmed));
  assert.equal(confirmed.leaderboard[0].score, 1);
});

test('首次選組、重登沿用組別、唯一學號及重啟保存', { timeout: 10000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-students-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const accountsPath = path.join(directory, 'students.json');
  const service = await launch(t, { accountsPath });
  for (const invalid of ['', '  ', 'A12', 123]) assert.equal((await service.student(invalid, 1)).status, 400);
  assert.deepEqual((await service.student('000012')).body, { requiresGroup: true });
  assert.equal((await service.student('000012', 99)).status, 400);
  const first = await service.student(' 000012 ', 1);
  const second = await service.student('000012', 2);
  assert.deepEqual(first.body, second.body);
  assert.deepEqual(first.body.identity, { studentId: '000012', group: 1 });
  assert.notEqual(first.cookie, second.cookie);
  assert.deepEqual(await service.request('/api/session', undefined, first.cookie).then((r) => r.json()), first.body);
  assert.deepEqual(JSON.parse(fs.readFileSync(accountsPath)), ['000012']);
  await service.io.close();
  const restarted = await launch(t, { accountsPath });
  assert.deepEqual((await restarted.student('000012')).body, { requiresGroup: true });
  assert.equal((await restarted.student('000012', 2)).body.identity.group, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(accountsPath)), ['000012']);
});

test('逐題開關與期限、跨連線併發、同組分別作答、重登恢復、結算及活動重設', { timeout: 10000 }, async (t) => {
  let now = 1000;
  const service = await launch(t, { now: () => now });
  service.state.setWorksheet({ questions: ['1', '2', '3'].map((number) => ({ number, subquestions: [{}] })) });
  const teacher = await teacherCookie(service.base);
  const post = (url, body = {}) => service.request(url, body, teacher);
  const firstLogin = await service.student('000012', 1);
  const sameLogin = await service.student('000012', 2);
  const teammateLogin = await service.student('000013', 1);
  const otherLogin = await service.student('000014', 2);
  const first = (await service.socket(firstLogin.cookie)).client;
  const same = (await service.socket(sameLogin.cookie)).client;
  const teammate = (await service.socket(teammateLogin.cookie)).client;
  const other = (await service.socket(otherLogin.cookie)).client;
  const teacherClient = (await service.socket(teacher)).client;
  const submit = (client, questionNumber, answer) => client.emitWithAck('answer:submit', { questionNumber, answers: [answer] });
  const update = once(first, 'state');
  await post('/api/timer', { limitSeconds: 10 });
  assert.deepEqual((await update)[0].timer, { limitSeconds: 10, startedAt: null, deadlineAt: null, serverNow: 1000, remainingMs: null });
  assert.equal((await submit(first, '1', '甲')).ok, false);
  await post('/api/questions/1/open');
  now = 2000;
  await post('/api/questions/2/open');
  await post('/api/questions/3/open');
  const closed = once(other, 'state');
  await post('/api/questions/3/close');
  assert.deepEqual((await closed)[0].questions.map((q) => [q.open, q.deadlineAt]), [[true, 11000], [true, 12000], [false, 12000]]);
  assert.equal((await submit(other, '3', '未開放')).ok, false);
  const ownUpdate = once(same, 'state');
  const teammateUpdate = once(teammate, 'state');
  const attempts = await Promise.all([submit(first, '1', '甲'), submit(same, '1', '乙')]);
  assert.equal(attempts.filter((attempt) => attempt.ok).length, 2);
  assert.equal(service.state.receipts.filter((receipt) => receipt.studentId === '000012').length, 1);
  const own = (await ownUpdate)[0];
  assert.equal(own.submissions.length, 1);
  assert.equal(own.submissions[0].rank, undefined);
  assert.equal(own.winners, undefined);
  assert.deepEqual((await teammateUpdate)[0].submissions, []);
  assert.equal((await post('/api/groups/student', { studentId: '000012', group: 2 })).status, 400);
  assert.equal((await service.request('/api/groups/student', { studentId: '000013', group: 2 }, teammateLogin.cookie)).status, 403);
  assert.equal((await post('/api/groups/student', { studentId: '000013', group: 2 })).status, 200);
  const sameGroupLogin = await service.student('000015', 1);
  const sameGroup = (await service.socket(sameGroupLogin.cookie)).client;
  assert.equal((await submit(sameGroup, '1', '同組另位')).ok, true);
  await service.request('/api/session/logout', {}, firstLogin.cookie);
  const returned = await service.student('000012');
  assert.deepEqual((await service.socket(returned.cookie)).snapshot.submissions, own.submissions);
  now = 11000;
  assert.equal((await submit(other, '1', '過期')).ok, false);
  assert.equal((await submit(other, '2', '還能作答')).ok, true);
  assert.deepEqual((await submit(other, '2', '重複')).answers, ['還能作答']);
  const settled = once(other, 'state');
  await post('/api/phase/finish');
  const final = (await settled)[0];
  assert.deepEqual(final.winners.slice(0, 2).map(({ studentId, group }) => [studentId, group]), [['000012', 1], ['000014', 2]]);
  const csv = await service.request('/api/results.csv', undefined, teacher).then((r) => r.text());
  assert.match(csv, /學號,組別,答案,延遲/);
  assert.match(csv, /000012,1,.*?,1,是,否/);
  assert.deepEqual(await teacherClient.emitWithAck('activity:new', {}), { ok: true });
  assert.deepEqual((await service.student('000012')).body, { requiresGroup: true });
});
test('同組三人各自作答，題組一分，逐人遞補與恢復同步至揭曉、CSV 和 Sheets', { timeout: 10000 }, async (t) => {
  const writes = [];
  const questions = [
    { number: '1', subquestions: [
      { label: 'a', target: { sheet: '測試', column: 4, row: 2 } },
      { label: 'b', target: { sheet: '測試', column: 4, row: 3 } }
    ] },
    { number: '2', subquestions: [{ target: { sheet: '測試', column: 4, row: 4 } }] }
  ];
  const service = await launch(t, {
    readCredentials: () => ({}),
    importWorksheet: async () => ({ spreadsheetId: 'mock', parsed: { sheet: '測試', questions } }),
    createSheetsClient: async () => ({ spreadsheets: { values: {
      batchUpdate: async ({ requestBody }) => { writes.push(requestBody.data); return { data: {} }; }
    } } })
  });
  const teacher = await teacherCookie(service.base);
  const post = async (url, data = {}) => assert.equal((await service.request(url, data, teacher)).status, 200, url);
  await post('/api/worksheet/import');
  await post('/api/fair-mode', { enabled: true, delaySeconds: 3 });
  const clients = [];
  for (let index = 0; index < 4; index += 1) {
    clients.push((await service.socket((await service.student(String(980001 + index), index === 3 ? 2 : 1)).cookie)).client);
  }
  const submit = async (client, number, answers) => {
    const updated = once(client, 'state');
    assert.equal((await client.emitWithAck('answer:submit', { questionNumber: number, answers })).status, '已送出');
    await updated;
  };
  await post('/api/questions/1/open');
  for (const [i, client] of clients.entries()) await submit(client, '1', [`甲-${i}`, `乙-${i}`]);
  const first = service.state.submissions.slice();
  assert.deepEqual(first.map(({ studentId, rank }) => [studentId, rank]), [['980001', 1], ['980002', 2], ['980003', 3], ['980004', 4]]);
  assert.equal(service.state.leaderboard()[0].score, 0);
  await post('/api/questions/1/close');
  const score = () => service.state.leaderboard().filter(({ score }) => score > 0).map(({ group, score }) => [group, score]);
  assert.deepEqual(score(), [[1, 1]]);
  await post('/api/questions/2/open');
  await submit(clients[0], '2', ['延遲甲']);
  await submit(clients[1], '2', ['延遲乙']);
  const fixed = service.state.submissions.slice(4);
  assert.deepEqual(fixed.map(({ penaltySeconds }) => penaltySeconds), [3, 3]);
  await post('/api/submissions/' + first[0].sequence + '/reject');
  assert.equal(first[1].rank, 1);
  assert.deepEqual(score(), [[1, 1]]);
  await post('/api/submissions/' + first[1].sequence + '/reject');
  await post('/api/submissions/' + first[2].sequence + '/reject');
  assert.equal(first[3].rank, 1);
  assert.deepEqual(score(), [[2, 1]]);
  assert.deepEqual(fixed.map(({ penaltySeconds }) => penaltySeconds), [3, 3]);
  await post('/api/phase/finish', { reveal: true });
  assert.equal(service.state.publicState({ studentId: '980004', group: 2 }).leaderboard, undefined);
  await post('/api/reveal/question/1', { visible: true });
  const verify = async (winner, index) => {
    const visible = service.state.publicState({ studentId: '980004', group: 2 });
    assert.equal(visible.winners[0].studentId, winner);
    assert.equal(visible.winners.length, 1);
    assert.equal(visible.leaderboard, undefined);
    const csv = await service.request('/api/results.csv', undefined, teacher).then((response) => response.text());
    assert.equal(csv.split('\r\n').filter((row) => /^1,.*?,1,是,否$/.test(row)).length, 1);
    assert.match(csv, new RegExp('^1,.*,' + winner + ',.*?,1,是,否$', 'm'));
    await post('/api/worksheet/writeback');
    assert.deepEqual(writes.at(-1).slice(0, 2).map((entry) => entry.values[0][0]), [`甲-${index}`, `乙-${index}`]);
  };
  await verify('980004', 3);
  await post('/api/submissions/' + first[0].sequence + '/restore');
  assert.equal(first[0].rank, 1);
  assert.deepEqual(score(), [[1, 2]]);
  await verify('980001', 0);
});
