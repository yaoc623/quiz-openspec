const path = require('node:path');
const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');
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
  let worksheetGeneration = 0;
  const credentialsPath = options.credentialsPath ?? path.join(process.cwd(), 'credentials.json');
  const readCredentials = options.readCredentials ?? (() => loadCredentials(credentialsPath));
  const worksheetImporter = options.importWorksheet ?? importWorksheet;
  const sheetsClientFactory = options.createSheetsClient ?? createSheetsClient;
  let currentSpreadsheetId = null;
  let currentSheetsClient = null;
  let serviceAccountEmail = '';
  let writebackInProgress = false;
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
    if (role === 'teacher') snapshot.students = roster();
    return snapshot;
  }

  function sendState() {
    const serverNow = now();
    for (const socket of io.sockets.sockets.values()) {
      const role = sessionRole(identity.get(socket.data.token));
      if (role) socket.emit('state', socketState(role, serverNow));
      else socket.disconnect(true);
    }
  }

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
    if (!identity.verifyTeacher(req.body.username, req.body.password)) {
      return res.status(401).json({ error: '教師帳號或密碼錯誤，或尚未設定。' });
    }
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
    if (state.expireQuestions(serverNow)) sendState();
    if (state.isExpired(serverNow)) {
      state.finish(serverNow, true);
      sendState();
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

  server.on('close', clearDeadlineTimer);

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
      sendState();
      res.json({ timer: state.timerSnapshot() });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/fair-mode', requireTeacher, (req, res) => {
    try {
      state.setFairMode(req.body.enabled, Number(req.body.delaySeconds));
      sendState();
      res.json({ fairModeEnabled: state.fairModeEnabled, fairDelaySeconds: state.fairDelaySeconds });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/groups', requireTeacher, (req, res) => {
    try {
      const count = Number(req.body.groupCount);
      if ([...identity.groups.values()].some((group) => group > count)) throw new Error('請先調整超出組數的學生組別。');
      state.setGroupCount(count);
      sendState();
      res.json({ groupCount: state.groupCount });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/groups/student', requireTeacher, (req, res) => {
    try {
      const id = identity.parseStudentId(req.body.studentId);
      const group = req.body.group;
      if (!identity.groups.has(id)) throw new Error('找不到本輪學生。');
      if (!Number.isInteger(group) || group < 1 || group > state.groupCount) throw new Error('組別無效。');
      if (state.phase === '已結束' || state.submissions.some((entry) => entry.studentId === id)) {
        throw new Error('學生已作答或活動已結束，無法換組。');
      }
      identity.groups.set(id, group);
      sendState();
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/questions/:number/:action', requireTeacher, (req, res) => {
    try {
      state.toggleQuestion(req.params.number, req.params.action);
      scheduleDeadline();
      sendState();
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
      sendState();
      res.json({ phase: state.phase, timer: state.timerSnapshot() });
    }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/phase/next', requireTeacher, (_req, res) => {
    try {
      state.openNextQuestion();
      scheduleDeadline();
      sendState();
      res.json({ phase: state.phase, timer: state.timerSnapshot() });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/phase/finish', requireTeacher, (req, res) => {
    try {
      state.finish(undefined, req.body?.reveal === true);
      scheduleDeadline();
      sendState();
      res.json({ phase: state.phase });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/reveal', requireTeacher, (req, res) => {
    try {
      state.setRevealIndex(Number(req.body.index));
      sendState();
      res.json({ revealIndex: state.revealIndex });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/submissions/:sequence/reject', requireTeacher, (req, res) => {
    if (writebackInProgress) return res.status(409).json({ error: writebackBusyMessage });
    try {
      const entry = state.reviewSubmission(req.params.sequence, true);
      sendState();
      res.json({ ok: true, entry: { sequence: entry.sequence, rank: entry.rank } });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/submissions/:sequence/restore', requireTeacher, (req, res) => {
    if (writebackInProgress) return res.status(409).json({ error: writebackBusyMessage });
    try {
      const entry = state.reviewSubmission(req.params.sequence, false);
      sendState();
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
    try {
      if (!currentSheetsClient) currentSheetsClient = await sheetsClientFactory(readCredentials());
      const result = await writeWinningAnswers(currentSheetsClient, currentSpreadsheetId, state.worksheet.questions, state.submissions);
      state.markWritebackCompleted();
      res.json({ message: `回寫完成，共更新 ${result.updatedCells} 個儲存格。`, ...result });
    } finally {
      writebackInProgress = false;
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
        sendState();
        acknowledge({ ok: true });
      } catch (error) {
        acknowledge({ ok: false, error: error.message });
      }
    });
    socket.on('answer:submit', (payload, acknowledge = () => {}) => {
      try {
        const student = sessionRole(identity.get(socket.data.token));
        if (!student?.group) throw new Error('請先以有效學生組別登入。');
        const receivedAt = now();
        if (state.isExpired(receivedAt)) {
          scheduleDeadline();
          throw new Error('搶答時間已到，無法提交答案。');
        }
        if (state.expireQuestions(receivedAt)) {
          scheduleDeadline();
          sendState();
        }
        state.submit(student.group, payload?.questionNumber, payload?.answers, receivedAt, student.studentId);
        acknowledge({ ok: true });
        sendState();
      } catch (error) { acknowledge({ ok: false, error: error.message }); }
    });
  });

  return { app, server, io, state };
}

if (require.main === module) {
  const environmentPath = path.join(process.cwd(), '.env');
  if (require('node:fs').existsSync(environmentPath)) process.loadEnvFile(environmentPath);
}
const { app, server, io, state } = createQuizServer(require.main === module ? {
  accountsPath: path.join(process.cwd(), '.quiz-data', 'students.json'),
  teacherUsername: process.env.QUIZ_TEACHER_USERNAME,
  teacherPassword: process.env.QUIZ_TEACHER_PASSWORD
} : {});
const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  server.listen(port, '127.0.0.1', () => console.log(`課堂搶答系統已啟動：http://localhost:${port}`));
}

module.exports = { app, server, io, state, createQuizServer };
