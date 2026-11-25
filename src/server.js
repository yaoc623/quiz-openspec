const path = require('node:path');
const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');
const { createActivityStore } = require('./activity-store');
const { createIdentity } = require('./identity');
const { QuizState } = require('./quiz-state');
const { buildQuizCsv } = require('./csv-export');
const { loadCredentials, importWorksheet, createSheetsClient, writeWinningAnswers } = require('./worksheet-service');

function createQuizServer(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const sameOrigin = (headers) => !headers.origin || headers.origin === 'http://' + headers.host;
  const io = new Server(server, { allowRequest: (req, callback) => callback(null, sameOrigin(req.headers)) });
  const state = new QuizState({ now: options.now });
  const identity = createIdentity(options);
  const store = createActivityStore(options.activityPath);
  const restored = store.load();
  if (restored) {
    state.restore(restored.state);
    for (const [studentId, group] of restored.groups) identity.groups.set(studentId, group);
  }
  let worksheetGeneration = 0;
  const credentialsPath = options.credentialsPath ?? path.join(process.cwd(), 'credentials.json');
  const readCredentials = options.readCredentials ?? (() => loadCredentials(credentialsPath));
  const worksheetImporter = options.importWorksheet ?? importWorksheet;
  const sheetsClientFactory = options.createSheetsClient ?? createSheetsClient;
  let currentSpreadsheetId = restored?.spreadsheetId ?? null;
  let currentSheetsClient = null;
  let serviceAccountEmail = '';
  let writebackInProgress = false;
  let writebackStatus = state.writebackCompleted ? '完成' : '';
  let writebackError = '';
  let answerTask = null;
  let teacherPush = null;
  const teacherPushMs = 300;
  const loginFailures = new Map();
  const monotonic = options.hrtime ?? (() => process.hrtime.bigint());
  const startedNs = monotonic();
  const startedAt = (options.now ?? Date.now)();
  let lastOrderNs = BigInt(restored?.lastOrderNs ?? 0);
  const wallEpochNs = BigInt(startedAt) * 1000000n;
  const orderingEpochNs = wallEpochNs > lastOrderNs ? wallEpochNs : lastOrderNs + 1n;
  const writebackBusyMessage = '回填進行中，請等待完成後再操作。';
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const cancelTimeout = options.clearTimeout ?? clearTimeout;
  let deadlineTimer = null;
  let deadlineGeneration = 0;
  const now = options.now ?? Date.now;

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  function sessionRole(session) {
    if (!session) return null;
    if (session.role === 'teacher') return 'teacher';
    return { studentId: session.studentId, group: identity.groups.get(session.studentId) ?? null };
  }

  function roster() {
    return [...identity.groups].map(([studentId, group]) => ({ studentId, group }));
  }

  function socketState(role, serverNow = now()) {
    const snapshot = state.publicState(role, serverNow);
    if (role === 'teacher') {
      snapshot.students = roster();
      snapshot.writebackStatus = writebackStatus;
      snapshot.writebackError = writebackError;
    }
    return snapshot;
  }

  function persist() {
    store.save({ state: state.snapshot(), groups: [...identity.groups], spreadsheetId: currentSpreadsheetId, lastOrderNs: String(lastOrderNs) });
  }

  function sendState(audience) {
    const serverNow = now();
    for (const socket of io.sockets.sockets.values()) {
      const role = sessionRole(identity.get(socket.data.token));
      if (!role) socket.disconnect(true);
      else if (!audience || (audience === 'teacher') === (role === 'teacher')) socket.emit('state', socketState(role, serverNow));
    }
  }

  function publish() {
    persist();
    if (teacherPush !== null) clearTimeout(teacherPush);
    teacherPush = null;
    sendState();
  }

  function queueTeacherPush() {
    if (teacherPush !== null) return;
    teacherPush = setTimeout(() => {
      teacherPush = null;
      sendState('teacher');
    }, teacherPushMs);
  }

  function drainAnswers() {
    if (answerTask !== null) clearImmediate(answerTask);
    answerTask = null;
    if (!state.pending.length) return;
    const before = options.activityPath ? structuredClone(state.snapshot()) : null;
    const processed = state.processPending();
    try {
      persist();
    } catch (error) {
      if (before) state.restore(before);
      throw error;
    }
    for (const received of processed) {
      const receipt = state.receipts.find(({ sequence }) => sequence === received.sequence);
      for (const socket of io.sockets.sockets.values()) {
        const session = identity.get(socket.data.token);
        if (session?.studentId === receipt.studentId) socket.emit('answer:status', {
          activityId: state.activityId, questionNumber: receipt.questionNumber,
          answers: receipt.answers, status: receipt.status, error: receipt.error
        });
      }
    }
    sendState('student');
    queueTeacherPush();
  }

  function scheduleAnswers() {
    if (answerTask !== null) return;
    answerTask = setImmediate(() => {
      try { drainAnswers(); }
      catch {
        console.error('作答資料暫時無法寫入，將保留佇列等待重試。');
        if (queueRetry !== null) clearTimeout(queueRetry);
        queueRetry = setTimeout(() => { queueRetry = null; scheduleAnswers(); }, 1000);
      }
    });
  }

  let queueRetry = null;

  function revoke(req) {
    const token = identity.token(req.headers);
    identity.revoke(token);
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.token === token) socket.disconnect(true);
    }
  }

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'POST' && !sameOrigin(req.headers)) return res.status(403).json({ error: '請從本網站操作。' });
    next();
  });

  app.get('/api/session', (req, res) => {
    res.json({ identity: sessionRole(identity.get(identity.token(req.headers))) });
  });

  app.post('/api/session/teacher', (req, res) => {
    if (!options.teacherUsername || !options.teacherPassword) {
      return res.status(503).json({ error: '請先在 .env 設定 TEACHER_USERNAME 與 TEACHER_PASSWORD，再重新啟動。' });
    }
    const source = req.ip;
    const time = Date.now();
    for (const [ip, failure] of loginFailures) {
      if (failure.until <= time) loginFailures.delete(ip);
    }
    const failure = loginFailures.get(source) ?? { count: 0, until: time + 60000 };
    if (failure.count >= 5) {
      res.set('Retry-After', String(Math.ceil((failure.until - time) / 1000)));
      return res.status(429).json({ error: '教師登入失敗次數過多，請稍後再試。' });
    }
    if (!identity.verifyTeacher(req.body?.username, req.body?.password)) {
      failure.count += 1;
      loginFailures.set(source, failure);
      return res.status(401).json({ error: '教師帳號或密碼錯誤。' });
    }
    loginFailures.delete(source);
    revoke(req);
    identity.issue(res, { role: 'teacher' });
    res.json({ identity: 'teacher' });
  });

  app.post('/api/session/student', (req, res) => {
    try {
      const studentId = identity.parseStudentId(req.body.studentId);
      let group = identity.groups.get(studentId);
      const joiningActivity = group === undefined;
      if (group === undefined) {
        if (req.body.group == null) return res.json({ requiresGroup: true });
        group = req.body.group;
        if (!Number.isInteger(group) || group < 1 || group > state.groupCount) throw new Error('組別無效。');
        identity.addAccount(studentId);
        identity.groups.set(studentId, group);
        try { persist(); }
        catch (error) { identity.groups.delete(studentId); throw error; }
      }
      revoke(req);
      identity.issue(res, { role: 'student', studentId });
      res.json({ identity: { studentId, group } });
      if (joiningActivity) {
        for (const socket of io.sockets.sockets.values()) {
          if (identity.get(socket.data.token)?.role === 'teacher') socket.emit('roster', roster());
        }
      }
    } catch (error) {
      res.status(400).json({ error: error.code ? '學生帳號無法儲存。' : error.message });
    }
  });

  app.post('/api/session/logout', (req, res) => {
    revoke(req);
    identity.clearCookie(res);
    res.json({ ok: true });
  });

  function clearDeadlineTimer() {
    deadlineGeneration += 1;
    if (deadlineTimer !== null) cancelTimeout(deadlineTimer);
    deadlineTimer = null;
  }

  function scheduleDeadline() {
    clearDeadlineTimer();
    const serverNow = now();
    let changed = state.expireQuestions(serverNow);
    if (state.isExpired(serverNow)) {
      state.finish(serverNow, true);
      changed = true;
    }
    if (changed) {
      drainAnswers();
      publish();
    }
    const deadline = state.nextDeadline();
    if (deadline === null) return;
    const remaining = deadline - serverNow;
    const generation = deadlineGeneration;
    deadlineTimer = scheduleTimeout(() => {
      if (generation !== deadlineGeneration) return;
      deadlineTimer = null;
      scheduleDeadline();
    }, Math.min(remaining, 2_147_483_647));
  }

  server.on('close', () => {
    clearDeadlineTimer();
    if (answerTask !== null) clearImmediate(answerTask);
    if (teacherPush !== null) clearTimeout(teacherPush);
    if (queueRetry !== null) clearTimeout(queueRetry);
  });

  function asyncRoute(handler) {
    return (req, res) => Promise.resolve(handler(req, res)).catch((error) => {
      const message = error.message || '';
      const userMessage = /找不到|格式錯誤|請輸入|網址必須|無法從|只有準備|活動結束|尚未匯入|請先匯入/.test(message)
        ? message
        : 'Google 試算表操作失敗，請確認 credentials.json 格式及服務帳號的試算表編輯權限。';
      res.status(400).json({ error: userMessage });
    });
  }

  function requireTeacher(req, res, next) {
    if (identity.get(identity.token(req.headers))?.role !== 'teacher') return res.status(403).json({ error: '此操作僅限老師使用。' });
    next();
  }

  app.get('/api/info', (req, res) => {
    try {
      if (identity.get(identity.token(req.headers))?.role !== 'teacher') return res.json({ groupCount: state.groupCount });
      const credentials = readCredentials();
      serviceAccountEmail = credentials.client_email;
    } catch {
      serviceAccountEmail = '';
    }
    res.json({ serviceAccountEmail, groupCount: state.groupCount, phase: state.phase, timer: state.timerSnapshot() });
  });

  app.post('/api/timer', requireTeacher, (req, res) => {
    try {
      state.setTimerLimit(req.body.limitSeconds);
      publish();
      res.json({ timer: state.timerSnapshot() });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/fair-mode', requireTeacher, (req, res) => {
    try {
      state.setFairMode(req.body.enabled, Number(req.body.delaySeconds));
      publish();
      res.json({ fairModeEnabled: state.fairModeEnabled, fairDelaySeconds: state.fairDelaySeconds });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/groups', requireTeacher, (req, res) => {
    try {
      const count = Number(req.body.groupCount);
      if ([...identity.groups.values()].some((group) => group > count)) throw new Error('請先調整超出組數的學生組別。');
      state.setGroupCount(count);
      publish();
      res.json({ groupCount: state.groupCount });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/groups/student', requireTeacher, (req, res) => {
    try {
      const id = identity.parseStudentId(req.body.studentId);
      const group = req.body.group;
      if (!identity.groups.has(id)) throw new Error('找不到本輪學生。');
      if (!Number.isInteger(group) || group < 1 || group > state.groupCount) throw new Error('組別無效。');
      if (state.phase === '已結束' || state.receipts.some((entry) => entry.studentId === id)) {
        throw new Error('學生已作答或活動已結束，無法換組。');
      }
      identity.groups.set(id, group);
      publish();
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/questions/:number/:action', requireTeacher, (req, res) => {
    try {
      state.toggleQuestion(req.params.number, req.params.action);
      if (req.params.action === 'close') drainAnswers();
      scheduleDeadline();
      publish();
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/worksheet/import', requireTeacher, asyncRoute(async (req, res) => {
    const generation = ++worksheetGeneration;
    const imported = await worksheetImporter(req.body.url, { credentialsPath, credentials: readCredentials() });
    if (generation !== worksheetGeneration) return res.status(409).json({ error: '已有更新的匯入操作。' });
    state.setWorksheet(imported.parsed);
    currentSpreadsheetId = imported.spreadsheetId;
    currentSheetsClient = null;
    serviceAccountEmail = imported.serviceAccountEmail;
    sendState();
    res.json({ sheet: imported.parsed.sheet, questionCount: imported.parsed.questions.length, questions: imported.parsed.questions.map(({ number, subquestions }) => ({ number, subquestionCount: subquestions.length })) });
  }));

  app.post('/api/phase/start', requireTeacher, (req, res) => {
    try {
      state.start(req.body);
      scheduleDeadline();
      publish();
      res.json({ phase: state.phase, timer: state.timerSnapshot() });
    }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/phase/next', requireTeacher, (_req, res) => {
    try {
      state.openNextQuestion();
      scheduleDeadline();
      publish();
      res.json({ phase: state.phase, timer: state.timerSnapshot() });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/phase/finish', requireTeacher, (req, res) => {
    try {
      state.finish(undefined, req.body?.reveal === true);
      drainAnswers();
      scheduleDeadline();
      publish();
      res.json({ phase: state.phase });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/reveal', requireTeacher, (req, res) => {
    try {
      state.setRevealIndex(Number(req.body.index));
      publish();
      res.json({ revealIndex: state.revealIndex });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/reveal/question/:number', requireTeacher, (req, res) => {
    try {
      if (typeof req.body.visible !== 'boolean') throw new Error('請指定是否公布。');
      state.revealQuestion(req.params.number, req.body.visible);
      publish();
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/submissions/:sequence/reject', requireTeacher, (req, res) => {
    if (writebackInProgress) return res.status(409).json({ error: writebackBusyMessage });
    try {
      const entry = state.reviewSubmission(req.params.sequence, true);
      writebackStatus = '';
      writebackError = '';
      publish();
      res.json({ ok: true, entry: { sequence: entry.sequence, rank: entry.rank } });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/submissions/:sequence/restore', requireTeacher, (req, res) => {
    if (writebackInProgress) return res.status(409).json({ error: writebackBusyMessage });
    try {
      const entry = state.reviewSubmission(req.params.sequence, false);
      writebackStatus = '';
      writebackError = '';
      publish();
      res.json({ ok: true, entry: { sequence: entry.sequence, rank: entry.rank } });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/api/results.csv', requireTeacher, (req, res) => {
    try {
      const exported = buildQuizCsv(state, options.now?.() ?? Date.now());
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exported.filename}"`
      });
      res.send(exported.content);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/worksheet/writeback', requireTeacher, asyncRoute(async (_req, res) => {
    if (writebackInProgress) return res.status(409).json({ error: writebackBusyMessage });
    if (state.phase !== '已結束') throw new Error('活動結束後才能回寫答案。');
    if (!currentSpreadsheetId || !state.worksheet) throw new Error('尚未匯入學習單。');
    writebackInProgress = true;
    writebackStatus = '寫入中';
    writebackError = '';
    sendState('teacher');
    try {
      if (!currentSheetsClient) currentSheetsClient = await sheetsClientFactory(readCredentials());
      const result = await writeWinningAnswers(currentSheetsClient, currentSpreadsheetId, state.worksheet.questions, state.submissions, {
        retry: options.retrySheets
      });
      state.markWritebackCompleted();
      writebackStatus = '完成';
      persist();
      res.json({ message: `回寫完成，共更新 ${result.updatedCells} 個儲存格。`, ...result });
    } catch (error) {
      writebackStatus = '失敗';
      const status = Number(error.response?.status ?? error.status ?? error.code);
      writebackError = Number.isInteger(status) ? `Google Sheets 回填失敗（代碼 ${status}），請檢查權限後重新寫入。`
        : 'Google 試算表操作失敗，請確認憑證、連線及編輯權限後重新寫入。';
      return res.status(400).json({ error: writebackError });
    } finally {
      writebackInProgress = false;
      sendState('teacher');
    }
  }));

  io.use((socket, next) => {
    const token = identity.token(socket.request.headers);
    if (!identity.get(token)) return next(new Error('請先登入。'));
    socket.data.token = token;
    next();
  });

  io.on('connection', (socket) => {
    const role = sessionRole(identity.get(socket.data.token));
    if (!role) return socket.disconnect(true);
    socket.emit('state', socketState(role));
    socket.on('activity:new', (_payload, acknowledge = () => {}) => {
      try {
        if (identity.get(socket.data.token)?.role !== 'teacher') throw new Error('此操作僅限老師使用。');
        if (writebackInProgress) throw new Error(writebackBusyMessage);
        state.resetActivity();
        identity.groups.clear();
        worksheetGeneration += 1;
        clearDeadlineTimer();
        currentSpreadsheetId = null;
        currentSheetsClient = null;
        writebackStatus = '';
        writebackError = '';
        publish();
        acknowledge({ ok: true });
      } catch (error) {
        acknowledge({ ok: false, error: error.message });
      }
    });
    socket.on('answer:submit', (payload, acknowledge) => {
      const received = monotonic();
      const receivedAtMs = now();
      if (typeof acknowledge !== 'function') acknowledge = () => {};
      const student = sessionRole(identity.get(socket.data.token));
      if (!student?.group) return acknowledge({ ok: false, status: '已截止', error: '請先以有效學生組別登入。' });
      if (payload?.activityId !== state.activityId) return acknowledge({ ok: false, status: '已截止', error: '此活動已更換。' });
      const projected = orderingEpochNs + received - startedNs;
      lastOrderNs = projected > lastOrderNs ? projected : lastOrderNs + 1n;
      const expired = state.isExpired(receivedAtMs);
      const outcome = state.admit({
        ...student, questionNumber: String(payload?.questionNumber ?? ''), answers: payload?.answers ?? null,
        receivedAtMs, receivedAtNs: String(received), orderNs: String(lastOrderNs)
      });
      if (outcome.previous) return acknowledge({ ok: true, status: outcome.previous.status, error: outcome.previous.error, answers: outcome.previous.answers });
      if (outcome.closed) {
        acknowledge({ ok: false, status: '已截止', error: expired ? '搶答時間已到，無法提交答案。' : '此題目前未開放作答。' });
        if (expired || state.expireQuestions(receivedAtMs)) {
          drainAnswers();
          scheduleDeadline();
          publish();
        }
        return;
      }
      try {
        persist();
      } catch {
        state.receipts.pop();
        state.pending.pop();
        return acknowledge({ retry: true });
      }
      acknowledge({ ok: true, status: '已送出' });
      for (const peer of io.sockets.sockets.values()) {
        if (identity.get(peer.data.token)?.studentId === student.studentId) peer.emit('answer:status', {
          activityId: state.activityId, questionNumber: outcome.receipt.questionNumber,
          answers: outcome.receipt.answers, status: outcome.receipt.status
        });
      }
      scheduleAnswers();
    });
  });

  if (restored) {
    drainAnswers();
    scheduleDeadline();
  }

  return { app, server, io, state };
}

if (require.main === module) {
  const environmentPath = path.join(process.cwd(), '.env');
  if (require('node:fs').existsSync(environmentPath)) process.loadEnvFile(environmentPath);
}
const { app, server, io, state } = createQuizServer(require.main === module ? {
  activityPath: path.join(process.cwd(), '.quiz-data', 'activity.json'),
  accountsPath: path.join(process.cwd(), '.quiz-data', 'students.json'),
  teacherUsername: process.env.TEACHER_USERNAME,
  teacherPassword: process.env.TEACHER_PASSWORD
} : {});
const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  server.listen(port, '127.0.0.1', () => console.log(`課堂搶答系統已啟動：http://localhost:${port}`));
}

module.exports = { app, server, io, state, createQuizServer };
