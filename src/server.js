const path = require('node:path');
const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');
const { QuizState } = require('./quiz-state');
const { loadCredentials, importWorksheet, createSheetsClient, writeWinningAnswers } = require('./worksheet-service');

function createQuizServer(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const state = new QuizState({ now: options.now });
  const credentialsPath = options.credentialsPath ?? path.join(process.cwd(), 'credentials.json');
  const readCredentials = options.readCredentials ?? (() => loadCredentials(credentialsPath));
  const worksheetImporter = options.importWorksheet ?? importWorksheet;
  const sheetsClientFactory = options.createSheetsClient ?? createSheetsClient;
  let currentSpreadsheetId = null;
  let currentSheetsClient = null;
  let serviceAccountEmail = '';
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const cancelTimeout = options.clearTimeout ?? clearTimeout;
  let deadlineTimer = null;

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  function sendState() {
    for (const socket of io.sockets.sockets.values()) {
      const role = socket.data.role;
      socket.emit('state', state.publicState(role));
    }
  }

  function clearDeadlineTimer() {
    if (deadlineTimer !== null) cancelTimeout(deadlineTimer);
    deadlineTimer = null;
  }

  function scheduleDeadline() {
    clearDeadlineTimer();
    if (state.phase !== '搶答中' || state.deadlineAt === null) return;
    const remaining = state.deadlineAt - (options.now?.() ?? Date.now());
    if (remaining <= 0) {
      state.finish();
      sendState();
      return;
    }
    deadlineTimer = scheduleTimeout(() => {
      deadlineTimer = null;
      scheduleDeadline();
    }, remaining);
  }

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
    if (req.get('x-quiz-role') !== 'teacher') return res.status(403).json({ error: '此操作僅限老師使用。' });
    next();
  }

  app.get('/api/info', (_req, res) => {
    try {
      const credentials = readCredentials();
      serviceAccountEmail = credentials.client_email;
    } catch {
      serviceAccountEmail = '';
    }
    res.json({ serviceAccountEmail, groupCount: state.groupCount, phase: state.phase, timer: state.timerSnapshot() });
  });

  app.post('/api/timer', requireTeacher, (req, res) => {
    try {
      const limit = req.body.limitSeconds === null ? null : Number(req.body.limitSeconds);
      state.setTimerLimit(limit);
      sendState();
      res.json({ timer: state.timerSnapshot() });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/groups', requireTeacher, (req, res) => {
    try {
      state.setGroupCount(Number(req.body.groupCount));
      sendState();
      res.json({ groupCount: state.groupCount });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/worksheet/import', requireTeacher, asyncRoute(async (req, res) => {
    const imported = await worksheetImporter(req.body.url, { credentialsPath, credentials: readCredentials() });
    state.setWorksheet(imported.parsed);
    currentSpreadsheetId = imported.spreadsheetId;
    currentSheetsClient = null;
    serviceAccountEmail = imported.serviceAccountEmail;
    sendState();
    res.json({ sheet: imported.parsed.sheet, questionCount: imported.parsed.questions.length, questions: imported.parsed.questions.map(({ number, subquestions }) => ({ number, subquestionCount: subquestions.length })) });
  }));

  app.post('/api/phase/start', requireTeacher, (req, res) => {
    try { state.start(); scheduleDeadline(); sendState(); res.json({ phase: state.phase, timer: state.timerSnapshot() }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/phase/finish', requireTeacher, (req, res) => {
    try { clearDeadlineTimer(); state.finish(); sendState(); res.json({ phase: state.phase }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/worksheet/writeback', requireTeacher, asyncRoute(async (_req, res) => {
    if (state.phase !== '已結束') throw new Error('活動結束後才能回寫答案。');
    if (!currentSpreadsheetId || !state.worksheet) throw new Error('尚未匯入學習單。');
    if (!currentSheetsClient) currentSheetsClient = await sheetsClientFactory(readCredentials());
    const result = await writeWinningAnswers(currentSheetsClient, currentSpreadsheetId, state.worksheet.questions, state.submissions);
    state.markWritebackCompleted();
    res.json({ message: `回寫完成，共更新 ${result.updatedCells} 個儲存格。`, ...result });
  }));

  io.use((socket, next) => {
    const role = socket.handshake.auth?.role;
    const group = Number(socket.handshake.auth?.group);
    if (role === 'teacher') socket.data.role = 'teacher';
    else if (role === 'student' && Number.isInteger(group) && group > 0) socket.data.role = { group };
    else return next(new Error('請先選擇老師或有效組別。'));
    next();
  });

  io.on('connection', (socket) => {
    socket.emit('state', state.publicState(socket.data.role));
    socket.on('activity:new', (_payload, acknowledge = () => {}) => {
      try {
        if (socket.data.role !== 'teacher') throw new Error('此操作僅限老師使用。');
        state.resetActivity();
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
        if (socket.data.role === 'teacher') throw new Error('老師不能提交學生答案。');
        if (state.phase === '搶答中' && state.deadlineAt !== null && (options.now?.() ?? Date.now()) >= state.deadlineAt) {
          clearDeadlineTimer();
          state.finish();
          sendState();
          throw new Error('搶答時間已到，活動已結束。');
        }
        const group = socket.data.role.group;
        const entry = state.submit(group, String(payload.questionNumber), payload.answers);
        acknowledge({ ok: true, entry });
        sendState();
      } catch (error) { acknowledge({ ok: false, error: error.message }); }
    });
  });

  return { app, server, io, state };
}

const { app, server, io, state } = createQuizServer();
const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  server.listen(port, '127.0.0.1', () => console.log(`課堂搶答系統已啟動：http://localhost:${port}`));
}

module.exports = { app, server, io, state, createQuizServer };
