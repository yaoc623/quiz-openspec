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
  const parsed = { sheet: '練習單', questions: [{ number: '1', subquestions: [
    { label: 'a', target: { sheet: '練習單', row: 6, column: 4 } },
    { label: 'b', target: { sheet: '練習單', row: 7, column: 4 } }
  ] }] };
  const service = createQuizServer({
    readCredentials: () => ({ client_email: 'quiz-service@example.test' }),
    importWorksheet: async () => ({ spreadsheetId: 'mock-sheet-id', parsed, serviceAccountEmail: 'quiz-service@example.test' }),
    createSheetsClient: async () => ({ spreadsheets: { values: { batchUpdate: async ({ requestBody }) => {
      writes.push(...requestBody.data);
      return { data: { totalUpdatedCells: requestBody.data.length } };
    } } } })
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
    const imported = await request(base, '/api/worksheet/import', { url: 'https://docs.google.com/spreadsheets/d/fake/edit' });
    assert.equal(imported.questionCount, 1);
    await request(base, '/api/phase/start', {});

    const connect = (role, group) => {
      const client = createClient(base, { auth: { role, group }, transports: ['websocket'] });
      clients.push(client);
      return client;
    };
    const teacher = connect('teacher');
    const teamOne = connect('student', 1);
    const teamTwo = connect('student', 2);
    const [teacherInitial, oneInitial, twoInitial] = await Promise.all([nextEvent(teacher, 'state'), nextEvent(teamOne, 'state'), nextEvent(teamTwo, 'state')]);
    assert.equal(teacherInitial.phase, '搶答中');
    assert.equal(oneInitial.questions[0].number, '1');
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
  } finally {
    clients.forEach((client) => client.close());
    await new Promise((resolve) => service.io.close(resolve));
  }
});
