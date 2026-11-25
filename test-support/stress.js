const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { io } = require('socket.io-client');
const { createQuizServer } = require('../src/server');
const { login, teacherCookie, teacherOptions } = require('./login');

async function run() {
  const count = 100;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-stress-'));
  const service = createQuizServer({ ...teacherOptions, activityPath: path.join(directory, 'activity.json') });
  const clients = [];
  try {
    service.state.setWorksheet({ questions: [{ number: '1', subquestions: [{}] }, { number: '2', subquestions: [{}] }] });
    service.state.setFairMode(true, 3);
    service.state.setTimerLimit(3);
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const base = 'http://127.0.0.1:' + service.server.address().port;
    async function startClient(studentId, group) {
      const response = await login(base, 'student', { studentId, group });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie').split(';')[0];
      const client = io(base, { transports: ['websocket'], extraHeaders: { cookie }, reconnection: false });
      clients.push(client);
      await once(client, 'state');
      return client;
    }
    const students = await Promise.all(Array.from({ length: count }, (_, index) =>
      startClient(String(800000 + index), index % 4 + 1)));
    const duplicate = await startClient('800000', 4);
    const teacher = await teacherCookie(base);
    const control = (number, action) => fetch(base + '/api/questions/' + number + '/' + action, {
      method: 'POST', headers: { cookie: teacher }
    });
    const submit = (client, number, answer) => client.timeout(5000).emitWithAck('answer:submit', {
      activityId: service.state.activityId, questionNumber: number, answers: [answer]
    });
    assert.equal((await control('1', 'open')).status, 200);
    const started = performance.now();
    const results = await Promise.all(students.map((client, index) => submit(client, '1', '測試 ' + index)));
    const elapsedMs = Math.round(performance.now() - started);
    assert.equal((await control('1', 'close')).status, 200);
    const retry = await submit(duplicate, '1', '不同內容不得取代原件');
    const firstQuestion = service.state.submissions.filter((entry) => entry.questionNumber === '1');
    const duplicateCount = firstQuestion.length - new Set(firstQuestion.map((entry) => entry.studentId)).size;
    const missing = count - new Set(firstQuestion.map((entry) => entry.studentId)).size;
    const successful = results.filter((result) => result.ok).length;
    console.log(JSON.stringify({
      attempted: count, successful, failed: count - successful, duplicateRetries: 1,
      duplicateAccepted: duplicateCount, missing, elapsedMs, pending: service.state.pending.length
    }));
    assert.equal(retry.status, '已送出');
    assert.deepEqual(retry.answers, ['測試 0']);
    assert.equal(successful, count);
    assert.equal(duplicateCount, 0);
    assert.equal(missing, 0);
    assert.ok(elapsedMs < 3000);
    assert.equal(new Set(firstQuestion.map((entry) => entry.sequence)).size, count);
    assert.equal(firstQuestion.filter((entry) => entry.rank === 1).length, 1);
    assert.ok(firstQuestion.every((entry, index) => entry.rank === index + 1 && BigInt(entry.receivedAtNs) > 0n));
    assert.equal(service.state.pending.length, 0);
    const winner = firstQuestion.find((entry) => entry.rank === 1);
    assert.equal((await control('2', 'open')).status, 200);
    const index = Number(winner.studentId) - 800000;
    assert.equal((await submit(students[index], '2', '公平延遲')).ok, true);
    assert.equal((await control('2', 'close')).status, 200);
    assert.equal(service.state.submissions.at(-1).penaltySeconds, 3);
    assert.equal((await submit(students[(index + 1) % count], '2', '已截止')).status, '已截止');
  } finally {
    clients.forEach((client) => client.close());
    await service.io.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
