const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.style = {};
    this.dataset = {};
    this.disabled = false;
    this.children = [];
    this.handlers = {};
    const classes = new Set(['new-activity', 'leaderboard', 'custom-seconds', 'fair-mode-status'].includes(id) ? ['hidden'] : []);
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !classes.has(name) : force;
        if (shouldAdd) classes.add(name); else classes.delete(name);
        return shouldAdd;
      }
    };
  }

  addEventListener(name, callback) { this.handlers[name] = callback; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  click() { this.clicked = true; }
  querySelectorAll(tag) { return this.children.filter((child) => child.tag === tag); }
  querySelector(tag) { return this.querySelectorAll(tag)[0]; }
}

function bootClient() {
  const ids = ['role', 'group', 'entry-card', 'activity-card', 'teacher-tools', 'student-work', 'answer-list', 'results', 'notice', 'phase', 'identity', 'group-count', 'group-form', 'import', 'finish', 'start', 'writeback', 'download-csv', 'new-activity', 'import-summary', 'import-status', 'join', 'service-account', 'sheet-url', 'timer-display', 'leaderboard', 'timer-limit', 'custom-seconds', 'save-timer', 'fair-mode-status', 'fair-mode-enabled', 'fair-delay', 'save-fair-mode', 'open-reveal', 'reveal-stage'];
  const elements = new Map([...ids, 'per-question', 'student-login', 'teacher-login', 'student-id', 'logout', 'question-controls', 'student-groups', 'login-notice', 'settle-hidden', 'publish-results', 'writeback-status'].map((id) => [id, new FakeElement(id)]));
  elements.get('per-question').checked = false;
  elements.get('role').value = 'student';
  elements.get('group').value = '1';
  const groupLabel = new FakeElement('group-label');
  const groupSubmit = new FakeElement('group-submit');
  const sockets = [];
  const createdElements = [];
  let confirmed = false;
  let confirmationText = '';
  let clock = 0;
  let timerTick;
  const document = {
    querySelector(selector) {
      if (selector === 'label[for="group"]') return groupLabel;
      if (selector === '#group-form button') return groupSubmit;
      if (selector.startsWith('#')) return elements.get(selector.slice(1));
      throw new Error(`未支援的選擇器：${selector}`);
    },
    querySelectorAll() { return []; },
    createElement(tag) { const element = new FakeElement(); element.tag = tag; createdElements.push(element); return element; }
    ,addEventListener() {}
  };
  const context = {
    document,
    window: { confirm(message) { confirmationText = message; return confirmed; } },
    fetch: async () => ({ ok: true, json: async () => ({ groupCount: 4, serviceAccountEmail: '' }) }),
    URL: { createObjectURL() { return 'blob:csv'; }, revokeObjectURL() {} },
    performance: { now: () => clock },
    setInterval(callback) { timerTick = callback; return 1; },
    io: () => {
      const socket = {
        handlers: {},
        emitted: [],
        on(name, callback) { this.handlers[name] = callback; },
        emit(name, payload, callback) { this.emitted.push({ name, payload }); callback?.({ ok: true }); },
        receive(name, payload) { this.handlers[name](payload); }
      };
      sockets.push(socket);
      return socket;
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), context);
  const join = () => vm.runInNewContext(
    'connect(document.querySelector("#role").value === "teacher" ? "teacher" : {studentId: "900001", group: 1})',
    context
  );
  return { join, elements, sockets, context, createdElements, advance(ms) { clock += ms; timerTick(); }, setConfirmed(value) { confirmed = value; }, getConfirmationText() { return confirmationText; } };
}

async function flushInitialization() {
  await new Promise(setImmediate);
}

test('教師與學生依階段顯示已設定時限、倒數及停止狀態', async () => {
  for (const role of ['teacher', 'student']) {
    const client = bootClient();
    await flushInitialization();
    client.elements.get('role').value = role;
    await client.join();
    const socket = client.sockets[0];
    const display = client.elements.get('timer-display');
    const state = { activityId: 'round', groupCount: 4, questions: [], submissions: [] };
    const receive = (phase, limitSeconds, remainingMs = null) => socket.receive('state', {
      ...state, phase, timer: { limitSeconds, remainingMs, deadlineAt: remainingMs === null ? null : 60000 }
    });

    receive('準備中', null);
    assert.equal(display.textContent, '不限時');
    receive('準備中', 60);
    assert.equal(display.textContent, '已設定 60 秒，等待開始');
    client.advance(2000);
    assert.equal(display.textContent, '已設定 60 秒，等待開始');
    receive('搶答中', 60, 60000);
    assert.equal(display.textContent, '01:00');
    client.advance(50000);
    assert.equal(display.textContent, '00:10');
    assert.equal(display.classList.contains('urgent'), true);
    receive('題目已關閉', 60, 10000);
    assert.equal(display.textContent, '題目已關閉');
    assert.equal(display.classList.contains('urgent'), false);
    receive('已結束', 60, 0);
    assert.equal(display.textContent, '已結束');
    receive('搶答中', null);
    assert.equal(display.textContent, '不限時');
    receive('已結束', null);
    assert.equal(display.textContent, '已結束');
  }
});

test('自訂 10 秒可直接開始，倒數不因同輪推送延長', async () => {
  const client = bootClient();
  await flushInitialization();
  const calls = [];
  client.context.fetch = async (url, options) => {
    if (options.body) calls.push([url, JSON.parse(options.body)]);
    return { ok: true, json: async () => ({}) };
  };
  client.elements.get('role').value = 'teacher';
  await client.join();
  const socket = client.sockets[0];
  const state = { activityId: 'round', groupCount: 4, questions: [{ number: '1', subquestions: [] }], submissions: [] };
  socket.receive('state', { ...state, phase: '準備中' });
  client.elements.get('timer-limit').value = 'custom';
  client.elements.get('custom-seconds').value = '0';
  await client.elements.get('start').handlers.click();
  assert.deepEqual(calls, []);
  client.elements.get('custom-seconds').value = '10';
  await client.elements.get('start').handlers.click();
  assert.deepEqual(calls, [['/api/phase/start', { limitSeconds: 10, perQuestion: false }]]);
  const live = { ...state, phase: '搶答中', timer: { deadlineAt: 11000, remainingMs: 10000 } };
  const display = client.elements.get('timer-display');
  socket.receive('state', live);
  assert.equal(display.textContent, '00:10');
  client.advance(2000);
  assert.equal(display.textContent, '00:08');
  socket.receive('state', { ...live, timer: { ...live.timer, remainingMs: 9500 } });
  assert.equal(display.textContent, '00:08');
  socket.receive('state', { ...live, phase: '題目已關閉', timer: { ...live.timer, remainingMs: 8000 } });
  client.advance(3000);
  assert.equal(display.textContent, '題目已關閉');
  await client.elements.get('start').handlers.click();
  assert.deepEqual(calls[1], ['/api/phase/next', {}]);
  socket.receive('state', { ...live, timer: { deadlineAt: 16000, remainingMs: 10000 } });
  assert.equal(display.textContent, '00:10');
  client.advance(10000);
  assert.equal(display.textContent, '00:00');
});

test('同輪推送保留身分、題組草稿及送出權限，換輪仍清空舊草稿', async () => {
  const client = bootClient();
  await flushInitialization();
  client.join();
  const socket = client.sockets[0];
  const state = { activityId: 'first', phase: '搶答中', groupCount: 4,
    identity: { studentId: '000012', group: 2 },
    questions: [{ number: '1', subquestions: [{ label: 'a' }, { label: 'b' }] }], submissions: [] };
  const inputs = () => client.elements.get('student-work').children[0].children.filter((child) => child.type === 'text');
  socket.receive('state', state);
  assert.equal(client.elements.get('identity').textContent, '第 2 組｜000012');
  const [first, second] = inputs();
  first.value = '甲';
  first.handlers.input();
  second.value = '乙';
  second.handlers.input();
  socket.receive('state', { ...state });
  assert.deepEqual(inputs().map((input) => input.value), ['甲', '乙']);
  assert.ok(inputs().every((input) => !input.disabled));
  assert.equal(client.elements.get('student-work').children[0].querySelector('button').disabled, false);
  socket.receive('state', { ...state, activityId: 'second' });
  assert.deepEqual(inputs().map((input) => input.value), ['', '']);
  assert.equal(client.elements.get('identity').textContent, '第 2 組｜000012');
});

test('老師的新活動按鈕只在已結束顯示，確認才送出且新狀態清空畫面', async () => {
  const client = bootClient();
  await flushInitialization();
  client.elements.get('role').value = 'teacher';
  client.join();
  const socket = client.sockets[0];
  socket.receive('state', { phase: '搶答中', groupCount: 6, questions: [{ number: '1', subquestions: [] }], submissions: [] });
  const button = client.elements.get('new-activity');
  assert.equal(button.classList.contains('hidden'), true);
  socket.receive('state', { phase: '已結束', groupCount: 6, questions: [{ number: '1', subquestions: [] }], submissions: [], winners: [] });
  assert.equal(button.classList.contains('hidden'), false);

  client.setConfirmed(false);
  button.handlers.click();
  assert.match(client.getConfirmationText(), /題目、作答與結果將清除/);
  assert.equal(socket.emitted.length, 0);

  client.setConfirmed(true);
  button.handlers.click();
  assert.deepEqual(socket.emitted.map((entry) => entry.name), ['activity:new']);
  socket.receive('state', { phase: '準備中', groupCount: 6, questions: [], submissions: [] });
  assert.equal(client.elements.get('import-status').textContent, '學習單狀態：未匯入');
  assert.equal(client.elements.get('group-count').value, '6');
  assert.equal(client.elements.get('import-summary').textContent, '');
  assert.equal(client.elements.get('results').children.length, 0);
});

test('學生收到新活動狀態後不再顯示舊結果且不會看到老師操作', async () => {
  const client = bootClient();
  await flushInitialization();
  client.elements.get('group').value = '2';
  client.join();
  const socket = client.sockets[0];
  socket.receive('state', { phase: '已結束', groupCount: 4, questions: [{ number: '1', subquestions: [] }], submissions: [], winners: [{ questionNumber: '1', group: 1, answers: ['舊答案'] }] });
  assert.equal(client.elements.get('results').children.length, 2);
  assert.equal(client.elements.get('new-activity').classList.contains('hidden'), true);

  socket.receive('state', { phase: '準備中', groupCount: 4, questions: [], submissions: [] });
  assert.equal(client.elements.get('import-status').textContent, '學習單狀態：未匯入');
  assert.equal(client.elements.get('results').children.length, 0);
  assert.equal(client.elements.get('student-work').children[0].textContent, '等待老師發布題目');
  assert.equal(client.elements.get('student-work').classList.contains('hidden'), false);
});

test('老師可設定預設或自訂倒數，搶答期間顯示倒數和即時排行榜', async () => {
  const client = bootClient();
  await flushInitialization();
  client.elements.get('role').value = 'teacher';
  client.join();
  const socket = client.sockets[0];
  socket.receive('state', { phase: '搶答中', groupCount: 4, questions: [], submissions: [], leaderboard: [{ group: 2, score: 1 }], timer: { remainingMs: 9000, serverNow: Date.now() } });
  assert.match(client.elements.get('timer-display').textContent, /00:09/);
  assert.equal(client.elements.get('timer-display').classList.contains('urgent'), true);
  assert.equal(client.elements.get('leaderboard').classList.contains('hidden'), false);
  assert.match(client.elements.get('leaderboard').children[1].textContent, /第 2 組/);

  client.elements.get('timer-limit').value = 'custom';
  client.elements.get('timer-limit').handlers.change({ target: { value: 'custom' } });
  assert.equal(client.elements.get('custom-seconds').classList.contains('hidden'), false);
  client.elements.get('custom-seconds').value = '0';
  client.elements.get('save-timer').handlers.click();
  await flushInitialization();
  assert.match(client.elements.get('notice').textContent, /正整數/);
});

test('學生搶答中不顯示即時排行榜，結束後顯示相同最終排行榜', async () => {
  const client = bootClient();
  await flushInitialization();
  client.join();
  const socket = client.sockets[0];
  socket.receive('state', { phase: '搶答中', groupCount: 4, questions: [], submissions: [], timer: { remainingMs: null } });
  assert.equal(client.elements.get('leaderboard').classList.contains('hidden'), true);
  socket.receive('state', { phase: '已結束', groupCount: 4, questions: [], submissions: [], winners: [], leaderboard: [{ group: 3, score: 2 }], timer: { remainingMs: null } });
  assert.equal(client.elements.get('leaderboard').classList.contains('hidden'), false);
  assert.match(client.elements.get('leaderboard').children[1].textContent, /第 3 組/);
});

test('老師可設定公平模式並在搶答列看到計算明細', async () => {
  const client = bootClient();
  await flushInitialization();
  client.elements.get('role').value = 'teacher';
  client.join();
  client.elements.get('fair-mode-enabled').checked = true;
  client.elements.get('fair-delay').value = '5';
  await client.elements.get('save-fair-mode').handlers.click();
  assert.equal(client.elements.get('notice').textContent, '公平模式已開啟，每題延遲 5 秒。');
  const socket = client.sockets[0];
  socket.receive('state', { phase: '搶答中', groupCount: 4, questions: [], submissions: [{ group: 1, questionNumber: '1', answers: ['答案'], receivedAt: '實際時間', penaltySeconds: 6, judgedAt: '判定時間', rank: 1, successful: true }], fairModeEnabled: true, fairDelaySeconds: 5, timer: { remainingMs: null } });
  assert.equal(client.elements.get('fair-mode-enabled').disabled, true);
  assert.match(client.elements.get('answer-list').children[1].children[1].textContent, /實際時間.*加權 6 秒.*判定時間.*順位 1/);
});

test('學生只看到公平模式開啟狀態，結果頁標明模式', async () => {
  const client = bootClient();
  await flushInitialization();
  client.join();
  const socket = client.sockets[0];
  socket.receive('state', { phase: '搶答中', groupCount: 4, questions: [], submissions: [], fairModeEnabled: true, timer: { remainingMs: null } });
  assert.equal(client.elements.get('fair-mode-status').classList.contains('hidden'), false);
  socket.receive('state', { phase: '已結束', groupCount: 4, questions: [], submissions: [], winners: [{ questionNumber: '1', group: 1, answers: ['答案'] }], fairModeEnabled: true, timer: { remainingMs: null } });
  assert.match(client.elements.get('results').children[0].textContent, /公平模式/);
  assert.match(client.elements.get('fair-mode-status').textContent, /公平模式已開啟/);
});

test('老師作答列可駁回成功答案並取消駁回，學生結果顯示無人答對', async () => {
  const client = bootClient();
  await flushInitialization();
  client.elements.get('role').value = 'teacher';
  client.join();
  const socket = client.sockets[0];
  socket.receive('state', { phase: '已結束', groupCount: 2, questions: [{ number: '1', subquestions: [] }], submissions: [
    { sequence: 1, group: 1, questionNumber: '1', answers: ['答案'], receivedAt: '時間', rank: null, rejected: true, successful: false },
    { sequence: 2, group: 2, questionNumber: '1', answers: ['候補'], receivedAt: '時間', rank: 1, rejected: false, successful: true }
  ], winners: [{ questionNumber: '1', group: null, answers: [], noCorrectAnswer: true }], rejectedSubmissions: [{ group: 1, questionNumber: '1', sequence: 1 }], leaderboard: [] });
  const rejectedRow = client.elements.get('answer-list').children[2];
  assert.match(rejectedRow.children[1].textContent, /已駁回/);
  assert.equal(rejectedRow.children[2].textContent, '取消駁回');
  assert.equal(rejectedRow.children[2].disabled, false);

  const studentClient = bootClient();
  await flushInitialization();
  studentClient.join();
  studentClient.sockets[0].receive('state', { phase: '已結束', groupCount: 2, questions: [{ number: '1', subquestions: [] }], submissions: [], winners: [{ questionNumber: '1', group: null, answers: [], noCorrectAnswer: true }], rejectedSubmissions: [{ group: 1, questionNumber: '1', sequence: 1 }], leaderboard: [] });
  assert.match(studentClient.elements.get('results').children[1].children[0].textContent, /無人答對/);
  assert.match(studentClient.elements.get('results').children[2].children[0].textContent, /已駁回/);
});

test('老師只在活動結束後看見 CSV 下載並使用同源 Session 取得檔案', async () => {
  const client = bootClient();
  await flushInitialization();
  client.elements.get('role').value = 'teacher';
  client.join();
  const socket = client.sockets[0];
  const button = client.elements.get('download-csv');
  socket.receive('state', { phase: '搶答中', groupCount: 4, questions: [], submissions: [], timer: { remainingMs: null } });
  assert.equal(button.classList.contains('hidden'), true);
  socket.receive('state', { phase: '已結束', groupCount: 4, questions: [], submissions: [], winners: [], timer: { remainingMs: null } });
  assert.equal(button.classList.contains('hidden'), false);

  await flushInitialization();
  let request;
  client.context.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, headers: { get: () => 'attachment; filename="quiz-result-20261120-163456.csv"' }, blob: async () => ({}) };
  };
  await button.handlers.click();
  assert.equal(request.url, '/api/results.csv');
  assert.equal(request.options, undefined);
  const downloadLink = client.createdElements.find((element) => element.download);
  assert.equal(downloadLink.download, 'quiz-result-20261120-163456.csv');
  assert.equal(downloadLink.clicked, true);
  assert.match(client.elements.get('notice').textContent, /開始下載/);
});

test('學生先檢查題組，傳送中鎖定，未回覆用相同內容重送，未計入保持鎖定', async () => {
  const client = bootClient();
  await flushInitialization();
  await client.join();
  const socket = client.sockets[0];
  const attempts = [];
  const retry = new Map();
  client.context.setTimeout = (callback) => {
    retry.set(callback, callback);
    return callback;
  };
  client.context.clearTimeout = (callback) => retry.delete(callback);
  socket.connected = true;
  socket.volatile = { timeout: () => ({ emit: (_event, payload, acknowledge) => attempts.push({ payload, acknowledge }) }) };
  socket.receive('state', { activityId: 'round', phase: '搶答中', independentQuestions: true,
    groupCount: 4, questions: [{ number: '1', open: true, subquestions: [{ label: 'a' }, { label: 'b' }] }], submissions: [] });
  const work = client.elements.get('student-work');
  const card = work.children[0];
  const button = card.querySelector('button');
  const inputs = card.querySelectorAll('input');
  inputs[0].value = '第一小題';
  button.handlers.click();
  assert.equal(attempts.length, 0);
  assert.equal(button.disabled, false);
  inputs[1].value = '第二小題';
  button.handlers.click();
  assert.equal(button.textContent, '傳送中');
  assert.ok(inputs.every((input) => input.disabled));
  attempts[0].acknowledge(new Error('逾時'));
  [...retry.values()][0]();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].payload, attempts[1].payload);
  assert.deepEqual(JSON.parse(JSON.stringify(attempts[1].payload)), { activityId: 'round', questionNumber: '1', answers: ['第一小題', '第二小題'] });
  attempts[1].acknowledge(null, { ok: true, status: '未計入', error: '驗證失敗' });
  assert.ok(work.children[0].querySelector('button').disabled);
  assert.ok(work.children[0].children.some((element) => element.textContent === '未計入：驗證失敗'));
  assert.equal(retry.size, 0);
});
