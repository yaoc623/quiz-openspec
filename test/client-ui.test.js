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
}

function bootClient() {
  const ids = ['role', 'group', 'entry-card', 'activity-card', 'teacher-tools', 'student-work', 'answer-list', 'results', 'notice', 'phase', 'identity', 'group-count', 'group-form', 'import', 'finish', 'start', 'writeback', 'download-csv', 'new-activity', 'import-summary', 'import-status', 'join', 'service-account', 'sheet-url', 'timer-display', 'leaderboard', 'timer-limit', 'custom-seconds', 'save-timer', 'fair-mode-status', 'fair-mode-enabled', 'fair-delay', 'save-fair-mode', 'open-reveal', 'reveal-stage'];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  elements.get('role').value = 'student';
  elements.get('group').value = '1';
  const groupLabel = new FakeElement('group-label');
  const groupSubmit = new FakeElement('group-submit');
  const sockets = [];
  const createdElements = [];
  let confirmed = false;
  let confirmationText = '';
  const document = {
    querySelector(selector) {
      if (selector === 'label[for="group"]') return groupLabel;
      if (selector === '#group-form button') return groupSubmit;
      if (selector.startsWith('#')) return elements.get(selector.slice(1));
      throw new Error(`未支援的選擇器：${selector}`);
    },
    createElement() { const element = new FakeElement(); createdElements.push(element); return element; }
    ,addEventListener() {}
  };
  const context = {
    document,
    window: { confirm(message) { confirmationText = message; return confirmed; } },
    fetch: async () => ({ ok: true, json: async () => ({ groupCount: 4, serviceAccountEmail: '' }) }),
    URL: { createObjectURL() { return 'blob:csv'; }, revokeObjectURL() {} },
    setInterval: () => 1,
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
  return { elements, sockets, context, createdElements, setConfirmed(value) { confirmed = value; }, getConfirmationText() { return confirmationText; } };
}

async function flushInitialization() {
  await Promise.resolve();
  await Promise.resolve();
}

test('同輪推送保留題組草稿，換輪使用相同題號仍清空', async () => {
  const client = bootClient();
  await flushInitialization();
  client.elements.get('join').handlers.click();
  const socket = client.sockets[0];
  const state = { activityId: 'first', phase: '搶答中', groupCount: 4,
    questions: [{ number: '1', subquestions: [{ label: 'a' }, { label: 'b' }] }], submissions: [] };
  const inputs = () => client.elements.get('student-work').children[0].children.filter((child) => child.type === 'text');
  socket.receive('state', state);
  const [first, second] = inputs();
  first.value = '甲';
  first.handlers.input();
  second.value = '乙';
  second.handlers.input();
  socket.receive('state', { ...state });
  assert.deepEqual(inputs().map((input) => input.value), ['甲', '乙']);
  socket.receive('state', { ...state, activityId: 'second' });
  assert.deepEqual(inputs().map((input) => input.value), ['', '']);
});

test('老師的新活動按鈕只在已結束顯示，確認才送出且新狀態清空畫面', async () => {
  const client = bootClient();
  await flushInitialization();
  client.elements.get('role').value = 'teacher';
  client.elements.get('join').handlers.click();
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
  client.elements.get('join').handlers.click();
  const socket = client.sockets[0];
  socket.receive('state', { phase: '已結束', groupCount: 4, questions: [{ number: '1', subquestions: [] }], submissions: [], winners: [{ questionNumber: '1', group: 1, answers: ['舊答案'] }] });
  assert.equal(client.elements.get('results').children.length, 2);
  assert.equal(client.elements.get('new-activity').classList.contains('hidden'), true);

  socket.receive('state', { phase: '準備中', groupCount: 4, questions: [], submissions: [] });
  assert.equal(client.elements.get('import-status').textContent, '學習單狀態：未匯入');
  assert.equal(client.elements.get('results').children.length, 0);
  assert.equal(client.elements.get('student-work').children.length, 0);
  assert.equal(client.elements.get('student-work').classList.contains('hidden'), false);
});

test('老師可設定預設或自訂倒數，搶答期間顯示倒數和即時排行榜', async () => {
  const client = bootClient();
  await flushInitialization();
  client.elements.get('role').value = 'teacher';
  client.elements.get('join').handlers.click();
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
  client.elements.get('join').handlers.click();
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
  client.elements.get('join').handlers.click();
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
  client.elements.get('join').handlers.click();
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
  client.elements.get('join').handlers.click();
  const socket = client.sockets[0];
  socket.receive('state', { phase: '已結束', groupCount: 2, questions: [{ number: '1', subquestions: [] }], submissions: [
    { sequence: 1, group: 1, questionNumber: '1', answers: ['答案'], receivedAt: '時間', rank: null, rejected: true, successful: false },
    { sequence: 2, group: 2, questionNumber: '1', answers: ['候補'], receivedAt: '時間', rank: 1, rejected: false, successful: true }
  ], winners: [{ questionNumber: '1', group: null, answers: [], noCorrectAnswer: true }], rejectedSubmissions: [{ group: 1, questionNumber: '1', sequence: 1 }], leaderboard: [] });
  const rejectedRow = client.elements.get('answer-list').children[1];
  assert.match(rejectedRow.children[1].textContent, /已駁回/);
  assert.equal(rejectedRow.children[2].textContent, '取消駁回');
  assert.equal(rejectedRow.children[2].disabled, false);

  const studentClient = bootClient();
  await flushInitialization();
  studentClient.elements.get('join').handlers.click();
  studentClient.sockets[0].receive('state', { phase: '已結束', groupCount: 2, questions: [{ number: '1', subquestions: [] }], submissions: [], winners: [{ questionNumber: '1', group: null, answers: [], noCorrectAnswer: true }], rejectedSubmissions: [{ group: 1, questionNumber: '1', sequence: 1 }], leaderboard: [] });
  assert.match(studentClient.elements.get('results').children[1].children[0].textContent, /無人答對/);
  assert.match(studentClient.elements.get('results').children[2].children[0].textContent, /已駁回/);
});

test('老師只在活動結束後看見 CSV 下載並以教師角色取得檔案', async () => {
  const client = bootClient();
  await flushInitialization();
  client.elements.get('role').value = 'teacher';
  client.elements.get('join').handlers.click();
  const socket = client.sockets[0];
  const button = client.elements.get('download-csv');
  socket.receive('state', { phase: '搶答中', groupCount: 4, questions: [], submissions: [], timer: { remainingMs: null } });
  assert.equal(button.classList.contains('hidden'), true);
  socket.receive('state', { phase: '已結束', groupCount: 4, questions: [], submissions: [], winners: [], timer: { remainingMs: null } });
  assert.equal(button.classList.contains('hidden'), false);

  let request;
  client.context.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, headers: { get: () => 'attachment; filename="quiz-result-20261120-163456.csv"' }, blob: async () => ({}) };
  };
  await button.handlers.click();
  assert.equal(request.url, '/api/results.csv');
  assert.equal(request.options.headers['X-Quiz-Role'], 'teacher');
  const downloadLink = client.createdElements.find((element) => element.download);
  assert.equal(downloadLink.download, 'quiz-result-20261120-163456.csv');
  assert.equal(downloadLink.clicked, true);
  assert.match(client.elements.get('notice').textContent, /開始下載/);
});
