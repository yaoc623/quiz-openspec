const test = require('node:test');
const assert = require('node:assert/strict');
const { io: createClient } = require('socket.io-client');
const { createQuizServer } = require('../src/server');

function nextEvent(socket, eventName) {
  return new Promise((resolve) => socket.once(eventName, resolve));
}

async function request(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-quiz-role': 'teacher' }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

test('HTTP 與三個 Socket.IO 角色完成匯入、作答、結果及 mock 回寫', { timeout: 10000 }, async () => {
  const writes = [];
  const importUrls = [];
  let sheetsClientCreations = 0;
  let sheetsWriteCalls = 0;
  let failImport = true;
  let failWriteback = false;
  const parsed = { sheet: '練習單', questions: [{ number: '1', subquestions: [
    { label: 'a', target: { sheet: '練習單', row: 6, column: 4 } },
    { label: 'b', target: { sheet: '練習單', row: 7, column: 4 } }
  ] }] };
  const service = createQuizServer({
    readCredentials: () => ({ client_email: 'quiz-service@example.test' }),
    importWorksheet: async (url) => {
      importUrls.push(url);
      if (failImport) throw new Error('permission denied');
      return { spreadsheetId: `mock-sheet-${importUrls.length}`, parsed, serviceAccountEmail: 'quiz-service@example.test' };
    },
    createSheetsClient: async () => { sheetsClientCreations += 1; return { spreadsheets: { values: { batchUpdate: async ({ requestBody }) => {
      sheetsWriteCalls += 1;
      if (failWriteback) throw new Error('permission denied');
      writes.push(...requestBody.data);
      return { data: { totalUpdatedCells: requestBody.data.length } };
    } } } }; }
  });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const clients = [];
  try {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /課堂搶答系統/);
    const info = await fetch(`${base}/api/info`).then((response) => response.json());
    assert.equal(info.groupCount, 4);
    assert.equal(info.serviceAccountEmail, 'quiz-service@example.test');
    assert.equal((await request(base, '/api/groups', { groupCount: 2 })).groupCount, 2);
    const importFailure = await fetch(`${base}/api/worksheet/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-quiz-role': 'teacher' }, body: JSON.stringify({ url: 'mock-url' }) });
    assert.equal(importFailure.status, 400);
    assert.match((await importFailure.json()).error, /試算表操作失敗/);
    assert.equal(service.state.worksheet, null);
    failImport = false;
    const imported = await request(base, '/api/worksheet/import', { url: 'https://docs.google.com/spreadsheets/d/fake/edit' });
    assert.equal(imported.questionCount, 1);

    const connect = (role, group) => {
      const client = createClient(base, { auth: { role, group }, transports: ['websocket'] });
      clients.push(client);
      return client;
    };
    const teacher = connect('teacher');
    const teamOne = connect('student', 1);
    const [teacherInitial, oneInitial] = await Promise.all([nextEvent(teacher, 'state'), nextEvent(teamOne, 'state')]);
    assert.equal(teacherInitial.phase, '準備中');
    assert.equal(oneInitial.questions[0].number, '1');
    const earlyReset = await new Promise((resolve) => teacher.emit('activity:new', {}, resolve));
    assert.equal(earlyReset.ok, false);
    assert.match(earlyReset.error, /已結束/);
    assert.equal(service.state.worksheet, parsed);

    const teacherStarted = nextEvent(teacher, 'state');
    const oneStarted = nextEvent(teamOne, 'state');
    await request(base, '/api/phase/start', {});
    const [teacherActive, oneActive] = await Promise.all([teacherStarted, oneStarted]);
    assert.equal(teacherActive.phase, '搶答中');
    assert.equal(oneActive.phase, '搶答中');

    const teamTwo = connect('student', 2);
    const twoInitial = await nextEvent(teamTwo, 'state');
    assert.equal(twoInitial.phase, '搶答中');
    assert.equal(twoInitial.submissions.length, 0);

    const teacherUpdate = nextEvent(teacher, 'state');
    const oneUpdate = nextEvent(teamOne, 'state');
    const twoUpdate = nextEvent(teamTwo, 'state');
    const first = await new Promise((resolve) => teamOne.emit('answer:submit', { questionNumber: '1', answers: ['一甲', '一乙'] }, resolve));
    assert.equal(first.ok, true);
    const [teacherAfterFirst, oneAfterFirst, twoAfterFirst] = await Promise.all([teacherUpdate, oneUpdate, twoUpdate]);
    assert.equal(teacherAfterFirst.submissions.length, 1);
    assert.equal(oneAfterFirst.submissions[0].answers[0], '一甲');
    assert.equal(JSON.stringify(twoAfterFirst).includes('一甲'), false);

    const teacherSecond = nextEvent(teacher, 'state');
    const twoSecond = nextEvent(teamTwo, 'state');
    const oneSecond = nextEvent(teamOne, 'state');
    const second = await new Promise((resolve) => teamTwo.emit('answer:submit', { questionNumber: '1', answers: ['二甲', '二乙'] }, resolve));
    assert.equal(second.entry.rank, 2);
    await Promise.all([teacherSecond, twoSecond, oneSecond]);

    const teacherFinished = nextEvent(teacher, 'state');
    const oneFinished = nextEvent(teamOne, 'state');
    const twoFinished = nextEvent(teamTwo, 'state');
    await request(base, '/api/phase/finish', {});
    const [teacherResult, oneResult, twoResult] = await Promise.all([teacherFinished, oneFinished, twoFinished]);
    assert.equal(teacherResult.phase, '已結束');
    assert.equal(oneResult.winners[0].group, 1);
    assert.deepEqual(twoResult.winners[0].answers, ['一甲', '一乙']);

    const writeback = await request(base, '/api/worksheet/writeback', {});
    assert.equal(writeback.updatedCells, 2);
    assert.deepEqual(writes.map((item) => item.values[0][0]), ['一甲', '一乙']);
    failWriteback = true;
    const writebackFailure = await fetch(`${base}/api/worksheet/writeback`, { method: 'POST', headers: { 'x-quiz-role': 'teacher' } });
    assert.equal(writebackFailure.status, 400);
    assert.match((await writebackFailure.json()).error, /試算表操作失敗/);
    assert.equal(service.state.writebackCompleted, true);

    const stateBeforeUnauthorizedReset = service.state.publicState('teacher');
    const deniedReset = await new Promise((resolve) => teamOne.emit('activity:new', {}, resolve));
    assert.deepEqual(deniedReset, { ok: false, error: '此操作僅限老師使用。' });
    const afterUnauthorizedReset = service.state.publicState('teacher');
    afterUnauthorizedReset.timer.serverNow = stateBeforeUnauthorizedReset.timer.serverNow;
    assert.deepEqual(afterUnauthorizedReset, stateBeforeUnauthorizedReset);

    const clientCreationsBeforeReset = sheetsClientCreations;
    const writeCallsBeforeReset = sheetsWriteCalls;
    const teacherReset = nextEvent(teacher, 'state');
    const oneReset = nextEvent(teamOne, 'state');
    const twoReset = nextEvent(teamTwo, 'state');
    const resetReply = await new Promise((resolve) => teacher.emit('activity:new', {}, resolve));
    assert.deepEqual(resetReply, { ok: true });
    const [teacherResetState, oneResetState, twoResetState] = await Promise.all([teacherReset, oneReset, twoReset]);
    for (const resetState of [teacherResetState, oneResetState, twoResetState]) {
      assert.equal(resetState.phase, '準備中');
      assert.equal(resetState.groupCount, 2);
      assert.deepEqual(resetState.questions, []);
      assert.deepEqual(resetState.submissions, []);
      assert.equal(JSON.stringify(resetState).includes('一甲'), false);
    }
    assert.equal(service.state.worksheet, null);
    assert.equal(service.state.writebackCompleted, false);
    assert.equal(sheetsClientCreations, clientCreationsBeforeReset);
    assert.equal(sheetsWriteCalls, writeCallsBeforeReset);

    const lateStudent = connect('student', 1);
    const lateStudentState = await nextEvent(lateStudent, 'state');
    assert.equal(lateStudentState.phase, '準備中');
    assert.deepEqual(lateStudentState.questions, []);

    const sameSheetUrl = 'https://docs.google.com/spreadsheets/d/fake/edit';
    await request(base, '/api/worksheet/import', { url: sameSheetUrl });
    assert.equal(service.state.worksheet, parsed);
    assert.equal(service.state.groupCount, 2);
    await request(base, '/api/phase/start', {});
    await request(base, '/api/phase/finish', {});
    const teacherSecondReset = nextEvent(teacher, 'state');
    const secondResetReply = await new Promise((resolve) => teacher.emit('activity:new', {}, resolve));
    assert.deepEqual(secondResetReply, { ok: true });
    await teacherSecondReset;
    const duplicateReset = await new Promise((resolve) => teacher.emit('activity:new', {}, resolve));
    assert.equal(duplicateReset.ok, false);
    assert.match(duplicateReset.error, /已結束/);

    const differentSheetUrl = 'https://docs.google.com/spreadsheets/d/another-sheet/edit';
    await request(base, '/api/worksheet/import', { url: differentSheetUrl });
    assert.equal(service.state.worksheet, parsed);
    assert.deepEqual(importUrls.slice(-2), [sameSheetUrl, differentSheetUrl]);
    assert.equal(service.state.groupCount, 2);
    await request(base, '/api/phase/start', {});
    assert.equal(service.state.phase, '搶答中');
  } finally {
    clients.forEach((client) => client.close());
    await new Promise((resolve) => service.io.close(resolve));
  }
});

test('計時設定由伺服器控時，到期同步結束且重新連線取得正確剩餘時間', { timeout: 10000 }, async () => {
  let now = 100000;
  let scheduled;
  const service = createQuizServer({
    now: () => now,
    setTimeout: (callback, delay) => { scheduled = { callback, delay }; return scheduled; },
    clearTimeout: () => {},
    readCredentials: () => ({ client_email: 'quiz@example.test' }),
    importWorksheet: async () => ({ spreadsheetId: 'timer-sheet', parsed: { sheet: '練習單', questions: [{ number: '1', subquestions: [{}] }] }, serviceAccountEmail: 'quiz@example.test' })
  });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const clients = [];
  const connect = (role, group) => { const client = createClient(base, { auth: { role, group }, transports: ['websocket'] }); clients.push(client); return client; };
  try {
    const teacher = connect('teacher');
    await nextEvent(teacher, 'state');
    const denied = await fetch(`${base}/api/timer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limitSeconds: 30 }) });
    assert.equal(denied.status, 403);
    await request(base, '/api/worksheet/import', { url: 'mock-url' });
    const bad = await fetch(`${base}/api/timer`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-quiz-role': 'teacher' }, body: JSON.stringify({ limitSeconds: 0 }) });
    assert.equal(bad.status, 400);
    await request(base, '/api/timer', { limitSeconds: 30 });
    const beforeStart = service.state.timerSnapshot();
    assert.equal(beforeStart.limitSeconds, 30);
    const teacherStarted = nextEvent(teacher, 'state');
    await request(base, '/api/phase/start', {});
    const live = await teacherStarted;
    assert.equal(live.timer.remainingMs, 30000);
    assert.equal(scheduled.delay, 30000);
    now += 12000;
    const student = connect('student', 1);
    const resumed = await nextEvent(student, 'state');
    assert.equal(resumed.timer.remainingMs, 18000);
    const teacherEnded = nextEvent(teacher, 'state');
    now += 18000;
    scheduled.callback();
    const ended = await teacherEnded;
    assert.equal(ended.phase, '已結束');
    assert.equal(service.state.finishedAt, 130000);
    const manualFinish = await fetch(`${base}/api/phase/finish`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-quiz-role': 'teacher' }, body: '{}' });
    assert.equal(manualFinish.status, 400);
  } finally {
    clients.forEach((client) => client.close());
    await new Promise((resolve) => service.io.close(resolve));
  }
});

test('老師提前結束計時活動會取消期限排程且不會重複結束', { timeout: 10000 }, async () => {
  let now = 5000;
  let scheduled;
  const cleared = [];
  const service = createQuizServer({ now: () => now, setTimeout: (callback, delay) => (scheduled = { callback, delay }), clearTimeout: (timer) => cleared.push(timer), readCredentials: () => ({ client_email: 'quiz@example.test' }), importWorksheet: async () => ({ spreadsheetId: 'sheet', parsed: { sheet: '題目', questions: [{ number: '1', subquestions: [{}] }] }, serviceAccountEmail: 'quiz@example.test' }) });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  try {
    await request(`http://127.0.0.1:${service.server.address().port}`, '/api/worksheet/import', { url: 'mock-url' });
    await request(`http://127.0.0.1:${service.server.address().port}`, '/api/timer', { limitSeconds: 30 });
    await request(`http://127.0.0.1:${service.server.address().port}`, '/api/phase/start', {});
    const deadline = scheduled;
    now += 4000;
    await request(`http://127.0.0.1:${service.server.address().port}`, '/api/phase/finish', {});
    assert.deepEqual(cleared, [deadline]);
    assert.equal(service.state.phase, '已結束');
    deadline.callback();
    assert.equal(service.state.phase, '已結束');
  } finally {
    await new Promise((resolve) => service.io.close(resolve));
  }
});

test('公平模式設定只限老師，推送明細不洩漏給學生且結果標示模式', { timeout: 10000 }, async () => {
  const service = createQuizServer({ readCredentials: () => ({ client_email: 'quiz@example.test' }) });
  service.state.setWorksheet({ sheet: '題目', questions: [{ number: '1', subquestions: [{}] }, { number: '2', subquestions: [{}] }] });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const clients = [];
  const connect = (role, group) => { const client = createClient(base, { auth: { role, group }, transports: ['websocket'] }); clients.push(client); return client; };
  try {
    const teacher = connect('teacher');
    const studentOne = connect('student', 1);
    const studentTwo = connect('student', 2);
    const [initialTeacher, initialOne, initialTwo] = await Promise.all([nextEvent(teacher, 'state'), nextEvent(studentOne, 'state'), nextEvent(studentTwo, 'state')]);
    assert.equal(initialTeacher.fairModeEnabled, false);
    assert.equal(initialTeacher.fairDelaySeconds, 3);
    assert.equal('fairDelaySeconds' in initialOne, false);
    const denied = await fetch(`${base}/api/fair-mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, delaySeconds: 3 }) });
    assert.equal(denied.status, 403);
    const invalid = await fetch(`${base}/api/fair-mode`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-quiz-role': 'teacher' }, body: JSON.stringify({ enabled: true, delaySeconds: 0 }) });
    assert.equal(invalid.status, 400);

    const teacherConfigured = nextEvent(teacher, 'state');
    const oneConfigured = nextEvent(studentOne, 'state');
    const twoConfigured = nextEvent(studentTwo, 'state');
    await request(base, '/api/fair-mode', { enabled: true, delaySeconds: 3 });
    const [configuredTeacher, configuredOne, configuredTwo] = await Promise.all([teacherConfigured, oneConfigured, twoConfigured]);
    assert.equal(configuredTeacher.fairModeEnabled, true);
    assert.equal(configuredOne.fairModeEnabled, true);
    assert.equal(configuredTwo.fairModeEnabled, true);

    const teacherStarted = nextEvent(teacher, 'state');
    const oneStarted = nextEvent(studentOne, 'state');
    await request(base, '/api/phase/start', {});
    await Promise.all([teacherStarted, oneStarted]);
    let teacherSubmission = nextEvent(teacher, 'state');
    let oneSubmission = nextEvent(studentOne, 'state');
    let twoSubmission = nextEvent(studentTwo, 'state');
    const accepted = await new Promise((resolve) => studentOne.emit('answer:submit', { questionNumber: '1', answers: ['甲'] }, resolve));
    assert.equal(accepted.ok, true);
    const [teacherState, oneState, twoState] = await Promise.all([teacherSubmission, oneSubmission, twoSubmission]);
    const detail = teacherState.submissions[0];
    assert.equal(detail.successfulCountAtSubmission, 0);
    assert.equal(detail.penaltySeconds, 0);
    assert.ok(detail.judgedAt);
    assert.equal(oneState.submissions.length, 1);
    assert.equal('judgedAt' in oneState.submissions[0], false);
    assert.equal('penaltySeconds' in oneState.submissions[0], false);
    assert.equal(twoState.submissions.length, 0);
    assert.equal(JSON.stringify(twoState).includes('甲'), false);

    const teacherFinished = nextEvent(teacher, 'state');
    const oneFinished = nextEvent(studentOne, 'state');
    await request(base, '/api/phase/finish', {});
    const [finalTeacher, finalStudent] = await Promise.all([teacherFinished, oneFinished]);
    assert.equal(finalTeacher.fairModeEnabled, true);
    assert.equal(finalStudent.fairModeEnabled, true);
    assert.deepEqual(finalStudent.winners[0].answers, ['甲']);
    assert.equal('submissions' in finalStudent, false);
  } finally {
    clients.forEach((client) => client.close());
    await new Promise((resolve) => service.io.close(resolve));
  }
});

test('老師駁回與取消駁回即時同步順位，學生與未授權 HTTP 操作不能駁回', { timeout: 10000 }, async () => {
  const service = createQuizServer({ readCredentials: () => ({ client_email: 'quiz@example.test' }) });
  service.state.setWorksheet({ sheet: '題目', questions: [{ number: '1', subquestions: [{}] }] });
  service.state.start();
  const first = service.state.submit(1, '1', ['一組答案']);
  service.state.submit(2, '1', ['二組答案']);
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const clients = [];
  const connect = (role, group) => { const client = createClient(base, { auth: { role, group }, transports: ['websocket'] }); clients.push(client); return client; };
  try {
    const teacher = connect('teacher');
    const student = connect('student', 1);
    await Promise.all([nextEvent(teacher, 'state'), nextEvent(student, 'state')]);
    const denied = await fetch(`${base}/api/submissions/${first.sequence}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    const teacherUpdate = nextEvent(teacher, 'state');
    const studentUpdate = nextEvent(student, 'state');
    await request(base, `/api/submissions/${first.sequence}/reject`, {});
    const [teacherState, studentState] = await Promise.all([teacherUpdate, studentUpdate]);
    assert.equal(teacherState.submissions.find((entry) => entry.sequence === first.sequence).rejected, true);
    assert.equal(teacherState.submissions.find((entry) => entry.group === 2).successful, true);
    assert.equal(studentState.submissions.length, 1);
    assert.equal(studentState.submissions[0].rejected, true);
    const restored = nextEvent(teacher, 'state');
    await request(base, `/api/submissions/${first.sequence}/restore`, {});
    assert.equal((await restored).submissions[0].successful, true);
  } finally {
    clients.forEach((client) => client.close());
    await new Promise((resolve) => service.io.close(resolve));
  }
});

test('CSV 下載僅限老師於活動結束後使用且回應包含完整 UTF-8 CSV', { timeout: 10000 }, async () => {
  let now = Date.parse('2026-11-20T08:34:56.789Z');
  const service = createQuizServer({ now: () => now });
  service.state.setGroupCount(2);
  service.state.setWorksheet({ questions: [{ number: '1', subquestions: [{}] }, { number: '2', subquestions: [{ label: 'a' }, { label: 'b' }] }] });
  service.state.start();
  service.state.submit(1, '1', ['答案,"含引號"']);
  service.state.submit(2, '2', ['題組甲', '題組乙']);
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const early = await fetch(`${base}/api/results.csv`, { headers: { 'x-quiz-role': 'teacher' } });
    assert.equal(early.status, 400);
    service.state.finish();
    const denied = await fetch(`${base}/api/results.csv`);
    assert.equal(denied.status, 403);
    const response = await fetch(`${base}/api/results.csv`, { headers: { 'x-quiz-role': 'teacher' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv; charset=utf-8/);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="quiz-result-20261120-163456.csv"');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    const content = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    assert.match(content, /1,,1,"答案,""含引號"""/);
    assert.match(content, /1,,2,,,,,未作答,否/);
    assert.match(content, /2,b,2,題組乙/);
  } finally { await new Promise((resolve) => service.io.close(resolve)); }
});
