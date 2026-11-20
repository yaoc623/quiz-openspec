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
    const classes = new Set(id === 'new-activity' ? ['hidden'] : []);
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
}

function bootClient() {
  const ids = ['role', 'group', 'entry-card', 'activity-card', 'teacher-tools', 'student-work', 'answer-list', 'results', 'notice', 'phase', 'identity', 'group-count', 'group-form', 'import', 'finish', 'start', 'writeback', 'new-activity', 'import-summary', 'import-status', 'join', 'service-account', 'sheet-url'];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  elements.get('role').value = 'student';
  elements.get('group').value = '1';
  const groupLabel = new FakeElement('group-label');
  const groupSubmit = new FakeElement('group-submit');
  const sockets = [];
  let confirmed = false;
  let confirmationText = '';
  const document = {
    querySelector(selector) {
      if (selector === 'label[for="group"]') return groupLabel;
      if (selector === '#group-form button') return groupSubmit;
      if (selector.startsWith('#')) return elements.get(selector.slice(1));
      throw new Error(`未支援的選擇器：${selector}`);
    },
    createElement() { return new FakeElement(); }
  };
  const context = {
    document,
    window: { confirm(message) { confirmationText = message; return confirmed; } },
    fetch: async () => ({ ok: true, json: async () => ({ groupCount: 4, serviceAccountEmail: '' }) }),
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
  return { elements, sockets, context, setConfirmed(value) { confirmed = value; }, getConfirmationText() { return confirmationText; } };
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
