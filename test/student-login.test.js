const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { createQuizServer } = require('../src/server');
const { login, teacherCookie, teacherOptions } = require('../test-support/login');

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
    const client = io(base, { forceNew: true, reconnection: false, extraHeaders: { cookie } });
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

test('逐題開關與期限、跨連線併發、同組限制、重登恢復、結算及活動重設', { timeout: 10000 }, async (t) => {
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
  assert.equal(attempts.filter((attempt) => attempt.ok).length, 1);
  assert.deepEqual(attempts.find((attempt) => attempt.ok), { ok: true });
  const own = (await ownUpdate)[0];
  assert.equal(own.submissions.length, 1);
  assert.equal(own.submissions[0].rank, undefined);
  assert.equal(own.winners, undefined);
  assert.deepEqual((await teammateUpdate)[0].submissions, []);
  assert.equal((await submit(teammate, '1', '同組')).ok, false);
  assert.equal((await post('/api/groups/student', { studentId: '000012', group: 2 })).status, 400);
  assert.equal((await service.request('/api/groups/student', { studentId: '000013', group: 2 }, teammateLogin.cookie)).status, 403);
  assert.equal((await post('/api/groups/student', { studentId: '000013', group: 2 })).status, 200);
  await service.request('/api/session/logout', {}, firstLogin.cookie);
  const returned = await service.student('000012');
  assert.deepEqual((await service.socket(returned.cookie)).snapshot.submissions, own.submissions);
  now = 11000;
  assert.equal((await submit(other, '1', '過期')).ok, false);
  assert.equal((await submit(other, '2', '還能作答')).ok, true);
  assert.equal((await submit(other, '2', '重複')).ok, false);
  const settled = once(other, 'state');
  await post('/api/phase/finish');
  const final = (await settled)[0];
  assert.deepEqual(final.winners.slice(0, 2).map(({ studentId, group }) => [studentId, group]), [['000012', 1], ['000014', 2]]);
  const csv = await service.request('/api/results.csv', undefined, teacher).then((r) => r.text());
  assert.match(csv, /學號,審核狀態,是否獲勝/);
  assert.match(csv, /000012,有效,是/);
  assert.deepEqual(await teacherClient.emitWithAck('activity:new', {}), { ok: true });
  assert.deepEqual((await service.student('000012')).body, { requiresGroup: true });
});
