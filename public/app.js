const groupSelect = document.querySelector('#group');
const entryCard = document.querySelector('#entry-card');
const activityCard = document.querySelector('#activity-card');
const teacherTools = document.querySelector('#teacher-tools');
const studentWork = document.querySelector('#student-work');
const answerList = document.querySelector('#answer-list');
const results = document.querySelector('#results');
const revealStage = document.querySelector('#reveal-stage');
const notice = document.querySelector('#notice');
let socket;
let currentRole;
let latestState;
let groupCount = 4;
const answerDrafts = new Map();
const outgoingAnswers = new Map();
const answerStatuses = new Map();

function draftStorageKey() {
  return `quiz-drafts:${latestState?.activityId}:${currentRole?.studentId}`;
}

function saveDrafts() {
  try { globalThis.sessionStorage?.setItem(draftStorageKey(), JSON.stringify([...answerDrafts])); }
  catch { /* 儲存空間不可用時仍保留目前畫面的草稿。 */ }
}

function restoreDrafts() {
  try {
    for (const [number, answers] of JSON.parse(globalThis.sessionStorage?.getItem(draftStorageKey()) ?? '[]')) {
      answerDrafts.set(number, answers);
    }
  } catch { /* 無法讀取時以空白草稿開始。 */ }
}

function updateAnswerStatus(status) {
  if (status.activityId !== latestState?.activityId) return;
  const outgoing = outgoingAnswers.get(status.questionNumber);
  if (outgoing) clearTimeout(outgoing.retryTimer);
  outgoingAnswers.delete(status.questionNumber);
  answerStatuses.set(status.questionNumber, status);
  if (status.status !== '已截止') {
    answerDrafts.delete(status.questionNumber);
    saveDrafts();
  }
  renderState(latestState);
}

function sendAnswer(outgoing) {
  const { payload } = outgoing;
  if (outgoingAnswers.get(payload.questionNumber) !== outgoing || payload.activityId !== latestState?.activityId) return;
  clearTimeout(outgoing.retryTimer);
  outgoing.retryTimer = setTimeout(() => sendAnswer(outgoing), 2000);
  if (!socket.connected) return;
  socket.volatile.timeout(1800).emit('answer:submit', payload, (error, reply) => {
    if (error || reply?.retry || outgoingAnswers.get(payload.questionNumber) !== outgoing) return;
    updateAnswerStatus({ ...payload, ...reply, answers: reply.answers ?? payload.answers });
  });
}
let timerAnchorRemaining = null;
let timerAnchorClientTime = 0;
let timerAnchorDeadline = null;
let timerAnchorActivity = null;
let teacherRevealOpen = false;

function showNotice(message, error = false) {
  const target = currentRole ? notice : document.querySelector('#login-notice');
  target.textContent = message;
  target.style.color = error ? '#a33636' : '';
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失敗，請稍後再試。');
  return result;
}

function updateGroupOptions(count) {
  groupCount = count;
  groupSelect.replaceChildren();
  for (let group = 1; group <= count; group += 1) {
    const option = document.createElement('option');
    option.value = String(group);
    option.textContent = `第 ${group} 組`;
    groupSelect.append(option);
  }
  document.querySelector('#group-count').value = String(count);
}

function updateIdentity() {
  document.querySelector('#identity').textContent = currentRole === 'teacher' ? '老師'
    : `${currentRole.group ? `第 ${currentRole.group} 組` : '尚未選組'}｜${currentRole.studentId}`;
}

async function connect(identity) {
  currentRole = identity;
  if (identity !== 'teacher' && !identity.group) {
    document.querySelector('#student-id').value = identity.studentId;
    document.querySelector('#group-entry').classList.remove('hidden');
    currentRole = null;
    showNotice('新活動已開始，請選擇組別。');
    return;
  }
  socket = io();
  socket.on('connect_error', (error) => {
    if (error.message === '請先登入。') window.location.reload();
    else showNotice(error.message, true);
  });
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') window.location.reload();
  });
  socket.on('roster', (students) => {
    if (currentRole !== 'teacher' || !latestState) return;
    latestState.students = students;
    renderTeacherControls(latestState);
  });
  socket.on('answer:status', updateAnswerStatus);
  socket.on('state', (value) => {
    const newActivity = value.activityId !== latestState?.activityId;
    if (newActivity) {
      answerDrafts.clear();
      answerStatuses.clear();
      for (const outgoing of outgoingAnswers.values()) clearTimeout(outgoing.retryTimer);
      outgoingAnswers.clear();
    }
    if (value.phase === '已結束') answerDrafts.clear();
    if (value.identity) {
      currentRole = value.identity;
      if (!currentRole.group) {
        socket.disconnect();
        activityCard.classList.add('hidden');
        entryCard.classList.remove('hidden');
        connect(currentRole);
        return;
      }
      updateIdentity();
    }
    if (currentRole === 'teacher' && value.phase === '準備中' &&
      (value.activityId !== latestState?.activityId || !latestState)) {
      const limit = value.timer?.limitSeconds;
      const choice = limit == null ? '' : [30, 60, 120, 180].includes(limit) ? String(limit) : 'custom';
      document.querySelector('#timer-limit').value = choice;
      const custom = document.querySelector('#custom-seconds');
      custom.value = choice === 'custom' ? String(limit) : '';
      custom.classList.toggle('hidden', choice !== 'custom');
      document.querySelector('#per-question').checked = false;
      document.querySelector('#settle-hidden').checked = true;
    }
    latestState = value;
    if (currentRole !== 'teacher') {
      if (newActivity && value.phase !== '已結束') restoreDrafts();
      for (const entry of value.submissions ?? []) {
        answerStatuses.set(entry.questionNumber, entry);
        const outgoing = outgoingAnswers.get(entry.questionNumber);
        if (outgoing) clearTimeout(outgoing.retryTimer);
        outgoingAnswers.delete(entry.questionNumber);
        answerDrafts.delete(entry.questionNumber);
      }
      saveDrafts();
    }
    renderState(value);
  });
  entryCard.classList.add('hidden');
  activityCard.classList.remove('hidden');
  teacherTools.classList.toggle('hidden', currentRole !== 'teacher');
  updateIdentity();
  if (currentRole === 'teacher') initializeInfo().catch((error) => showNotice(error.message, true));
}

function createQuestionCard(question, canAnswer) {
  const card = document.createElement('article');
  card.className = 'question';
  card.dataset.questionNumber = question.number;
  const title = document.createElement('h3');
  title.textContent = `第 ${question.number} 題`;
  card.append(title);
  question.subquestions.forEach((subquestion, index) => {
    const label = document.createElement('label');
    label.textContent = subquestion.label ? `小題（${subquestion.label}）` : '答案';
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.answerIndex = String(index);
    input.autocomplete = 'off';
    input.maxLength = 8000;
    input.value = answerDrafts.get(question.number)?.[index] ?? '';
    input.addEventListener('input', () => {
      const draft = answerDrafts.get(question.number) ?? [];
      draft[index] = input.value;
      answerDrafts.set(question.number, draft);
      saveDrafts();
    });
    input.disabled = !canAnswer;
    card.append(label, input);
  });
  const button = document.createElement('button');
  button.textContent = '搶答！';
  button.disabled = !canAnswer;
  button.addEventListener('click', () => {
    const inputs = [...card.querySelectorAll('input')];
    const answers = inputs.map((input) => input.value);
    if (answers.some((answer) => !answer.trim())) return showNotice('請先填寫所有答案。', true);
    const payload = { activityId: latestState.activityId, questionNumber: question.number, answers };
    const outgoing = { payload, retryTimer: null };
    outgoingAnswers.set(question.number, outgoing);
    answerStatuses.set(question.number, { ...payload, status: '傳送中' });
    inputs.forEach((input) => { input.disabled = true; });
    button.disabled = true;
    button.textContent = '傳送中';
    sendAnswer(outgoing);
  });
  card.append(button);
  return card;
}

function renderState(value) {
  const now = performance.now();
  const remaining = value.timer?.remainingMs ?? null;
  const deadline = value.timer?.deadlineAt ?? null;
  const sameWindow = deadline !== null && deadline === timerAnchorDeadline && value.activityId === timerAnchorActivity;
  timerAnchorRemaining = value.phase === '搶答中' && sameWindow && timerAnchorRemaining !== null
    ? Math.min(remaining, Math.max(0, timerAnchorRemaining - (now - timerAnchorClientTime)))
    : remaining;
  timerAnchorClientTime = now;
  timerAnchorDeadline = deadline;
  timerAnchorActivity = value.activityId;
  document.querySelector('#phase').textContent = value.currentQuestionNumber && value.phase !== '已結束'
    ? `第 ${value.currentQuestionNumber} 題｜${value.phase}` : value.phase;
  document.querySelector('#import-status').textContent = value.questions.length ? '學習單狀態：已匯入' : '學習單狀態：未匯入';
  results.replaceChildren();
  if (currentRole === 'teacher') {
    const canEdit = value.phase === '準備中';
    document.querySelector('#group-count').disabled = !canEdit;
    document.querySelector('#group-form button').disabled = !canEdit;
    document.querySelector('#import').disabled = !canEdit;
    const betweenQuestions = value.phase === '題目已關閉';
    const start = document.querySelector('#start');
    start.disabled = !betweenQuestions && (!canEdit || !value.questions.length);
    start.textContent = betweenQuestions ? '開始下一題' : '開始搶答';
    const finish = document.querySelector('#finish');
    finish.disabled = value.phase !== '搶答中' && !betweenQuestions;
    finish.textContent = value.independentQuestions ? '結算搶答' : value.currentQuestionNumber && !betweenQuestions && value.phase === '搶答中' ? '關閉本題' : '結束搶答';
    document.querySelector('#writeback').disabled = value.phase !== '已結束' || value.writebackStatus === '寫入中';
    document.querySelector('#writeback-status').textContent = value.writebackStatus
      ? `Google Sheets ${value.writebackStatus}${value.writebackError ? `｜${value.writebackError}` : ''}` : '';
    document.querySelector('#download-csv').classList.toggle('hidden', value.phase !== '已結束');
    document.querySelector('#new-activity').classList.toggle('hidden', value.phase !== '已結束');
    document.querySelector('#open-reveal').classList.toggle('hidden', value.phase !== '已結束');
    document.querySelector('#publish-results').classList.toggle('hidden',
      value.phase !== '已結束' || !value.revealModeActive || value.revealIndex >= value.questions.length);
    document.querySelector('#timer-limit').disabled = !canEdit;
    document.querySelector('#custom-seconds').disabled = !canEdit;
    document.querySelector('#save-timer').disabled = !canEdit;
    document.querySelector('#per-question').disabled = !canEdit;
    document.querySelector('#fair-mode-enabled').checked = Boolean(value.fairModeEnabled);
    document.querySelector('#fair-delay').value = String(value.fairDelaySeconds ?? 3);
    document.querySelector('#fair-mode-enabled').disabled = !canEdit;
    document.querySelector('#fair-delay').disabled = !canEdit;
    document.querySelector('#save-fair-mode').disabled = !canEdit;
    answerList.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = '即時作答紀錄';
    answerList.append(heading);
    const ordered = [...value.submissions].sort((a, b) => a.questionNumber.localeCompare(b.questionNumber, 'zh-Hant', { numeric: true }) ||
      (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.sequence - b.sequence);
    ordered.forEach((entry) => {
      const row = document.createElement('article');
      row.className = 'submission';
      const group = document.createElement('strong');
      group.textContent = `${entry.studentId ? `學號 ${entry.studentId}・` : ''}第 ${entry.group} 組・第 ${entry.questionNumber} 題`;
      const content = document.createElement('p');
      const winnerLabel = entry.successful ? (entry.confirmed === false ? '（暫定第一名）' : '（搶答成功）') : '';
      content.textContent = value.fairModeEnabled
        ? `答案：${entry.answers.join('、')}｜實際時間 ${entry.receivedAt}｜加權 ${entry.penaltySeconds} 秒｜判定時間 ${entry.judgedAt}｜順位 ${entry.rejected ? '已駁回' : entry.rank}${winnerLabel}`
        : `答案：${entry.answers.join('、')}｜${entry.receivedAt}｜順位 ${entry.rejected ? '已駁回' : entry.rank}${winnerLabel}`;
      row.append(group, content);
      if (!canEdit) {
        const review = document.createElement('button');
        review.className = 'secondary';
        review.textContent = entry.rejected ? '取消駁回' : '駁回';
        review.disabled = entry.rejected ? false : !entry.successful;
        review.addEventListener('click', async () => {
          try {
            await api(`/api/submissions/${entry.sequence}/${entry.rejected ? 'restore' : 'reject'}`, { method: 'POST', body: '{}' });
            showNotice(entry.rejected ? '已取消駁回。' : '已駁回，順位已更新。');
          } catch (error) { showNotice(error.message, true); }
        });
        row.append(review);
      }
      answerList.append(row);
    });
    renderTeacherControls(value);
    renderLeaderboard(value.leaderboard);
    const summary = document.querySelector('#import-summary');
    if (value.questions.length) summary.textContent = `共 ${value.questions.length} 題；每題小題數：${value.questions.map((question) => `${question.number}題 ${question.subquestions.length}小題`).join('、')}`;
    else summary.textContent = '';
    if (value.phase === '已結束') {
      const fairResult = document.createElement('p');
      fairResult.textContent = value.fairModeEnabled ? '本輪使用公平模式' : '本輪未使用公平模式';
      results.append(fairResult);
    }
  } else {
    const fairStatus = document.querySelector('#fair-mode-status');
    fairStatus.textContent = '公平模式已開啟';
    fairStatus.classList.toggle('hidden', !value.fairModeEnabled);
    const activeInput = document.activeElement;
    const activeQuestion = activeInput?.dataset?.answerIndex !== undefined
      ? activeInput.closest('.question')?.dataset.questionNumber : undefined;
    studentWork.replaceChildren();
    answerList.replaceChildren();
    if (value.phase !== '已結束' || answerStatuses.size || value.submissions?.length) {
      const ownSubmissions = new Map((value.submissions ?? []).map((entry) => [entry.questionNumber, entry]));
      for (const [number, entry] of answerStatuses) ownSubmissions.set(number, entry);
      value.questions.forEach((question) => {
        const canAnswer = value.independentQuestions ? question.open : value.phase === '搶答中' && (!value.currentQuestionNumber || value.currentQuestionNumber === question.number);
        if (value.phase === '已結束' && !ownSubmissions.has(question.number)) return;
        const card = createQuestionCard(question, canAnswer);
        if (value.independentQuestions) appendQuestionTime(card, question, value);
        const saved = ownSubmissions.get(question.number);
        if (saved) {
          answerDrafts.delete(question.number);
          card.querySelectorAll('input').forEach((input, index) => { input.value = saved.answers?.[index] ?? ''; input.disabled = true; });
          card.querySelector('button').disabled = true;
          card.querySelector('button').textContent = saved.status ?? '已送出';
          const done = document.createElement('p');
          done.className = 'success';
          done.textContent = saved.status === '未計入' ? `未計入：${saved.error}`
            : saved.status === '已截止' ? '題目已截止' : '你的答案已鎖定';
          card.append(done);
        }
        studentWork.append(card);
        if (activeQuestion === question.number) {
          const replacement = card.querySelectorAll('input')[Number(activeInput.dataset.answerIndex)];
          if (replacement && !replacement.disabled) {
            replacement.focus({ preventScroll: true });
            replacement.setSelectionRange(activeInput.selectionStart, activeInput.selectionEnd);
          }
        }
      });
      if (value.phase === '準備中' || (value.independentQuestions && !value.questions.some((question) => question.open) && value.phase !== '已結束')) {
        const waiting = document.createElement('p');
        waiting.textContent = '等待老師發布題目';
        studentWork.append(waiting);
      }
      studentWork.classList.remove('hidden');
    } else studentWork.classList.add('hidden');
    if (value.phase === '已結束') {
      const heading = document.createElement('h3');
      heading.textContent = value.fairModeEnabled ? '搶答結果（公平模式）' : '搶答結果（未使用公平模式）';
      results.replaceChildren(heading);
      value.questions.forEach((question, index) => {
        const winner = (value.winners ?? []).find((item) => item.questionNumber === question.number);
        const row = document.createElement('article');
        row.className = 'result';
        const text = document.createElement('p');
        text.textContent = winner ? (winner.group ? `第 ${winner.questionNumber} 題：第 ${winner.group} 組搶答成功${winner.studentId ? `（學號 ${winner.studentId}）` : ''}，答案：${winner.answers.join('、')}` : `第 ${winner.questionNumber} 題：${winner.noCorrectAnswer ? '無人答對' : '沒有組別提交答案'}`) : `第 ${question.number} 題：尚未揭曉`;
        row.append(text);
        if (winner) {
          const team = document.createElement('p');
          team.textContent = winner.group === currentRole.group ? '我們組搶到了' : '我們組沒有搶到';
          row.append(team);
        }
        results.append(row);
      });
      (value.rejectedSubmissions ?? []).forEach((entry) => {
        const row = document.createElement('article');
        row.className = 'result';
        const text = document.createElement('p');
        text.textContent = `第 ${entry.questionNumber} 題：第 ${entry.group} 組答案已駁回`;
        row.append(text);
        results.append(row);
      });
      renderLeaderboard(value.leaderboard);
    }
  }
  renderTimer();
  renderReveal(value);
  updateGroupOptions(value.groupCount || groupCount);
}

function renderReveal(value) {
  revealStage.classList.add('hidden');
  if (value.phase !== '已結束' || (currentRole === 'teacher' && !teacherRevealOpen) || (currentRole !== 'teacher' && value.revealIndex < 0)) return;
  revealStage.classList.remove('hidden');
  revealStage.replaceChildren();
  const heading = document.createElement('h1');
  const index = value.revealIndex ?? -1;
  const questions = value.questions ?? [];
  if (index >= questions.length) {
    heading.textContent = '最終排行榜';
    revealStage.append(heading);
    (value.leaderboard ?? []).forEach((entry, place) => {
      const line = document.createElement('p');
      line.className = place < 3 ? `podium podium-${place + 1}` : '';
      line.textContent = `${place < 3 ? ['🥇', '🥈', '🥉'][place] : `${place + 1}.`} 第 ${entry.group} 組｜${entry.score} 分`;
      revealStage.append(line);
    });
  } else if (index < 0) {
    heading.textContent = '準備揭曉';
    revealStage.append(heading);
  } else {
    const question = questions[index];
    heading.textContent = `第 ${question.number} 題`;
    revealStage.append(heading);
    const winner = currentRole === 'teacher'
      ? (value.submissions ?? []).find((entry) => entry.questionNumber === question.number && entry.rank === 1 && !entry.rejected)
      : (value.winners ?? []).find((entry) => entry.questionNumber === question.number);
    const answer = document.createElement('p');
    answer.className = 'reveal-answer';
    answer.textContent = winner?.group ? `第 ${winner.group} 組｜${winner.studentId ? `學號 ${winner.studentId}｜` : ''}${winner.answers.join('、')}｜順位 1` : '無人答對';
    revealStage.append(answer);
  }
  if (currentRole === 'teacher') {
    const controls = document.createElement('div'); controls.className = 'reveal-controls';
    const prev = document.createElement('button'); prev.textContent = '上一題'; prev.disabled = index <= -1; prev.onclick = () => changeReveal(index - 1);
    const next = document.createElement('button'); next.textContent = index >= questions.length ? '已全部揭曉' : '下一題'; next.disabled = index >= questions.length; next.onclick = () => changeReveal(index + 1);
    const close = document.createElement('button'); close.textContent = '離開投影'; close.className = 'secondary'; close.onclick = () => { revealStage.classList.add('hidden'); document.exitFullscreen?.(); };
    controls.append(prev, next, close); revealStage.append(controls);
  }
}

async function changeReveal(index) {
  try { await api('/api/reveal', { method: 'POST', body: JSON.stringify({ index }) }); }
  catch (error) { showNotice(error.message, true); }
}

document.querySelector('#publish-results').addEventListener('click', () => changeReveal(latestState.questions.length));
document.querySelector('#open-reveal').addEventListener('click', () => {
  teacherRevealOpen = true; revealStage.classList.remove('hidden'); revealStage.requestFullscreen?.(); renderReveal(latestState);
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { teacherRevealOpen = false; revealStage.classList.add('hidden'); } });
document.addEventListener('keydown', (event) => {
  if (currentRole !== 'teacher' || revealStage.classList.contains('hidden') || !['ArrowRight', 'ArrowLeft'].includes(event.key)) return;
  event.preventDefault(); changeReveal((latestState?.revealIndex ?? -1) + (event.key === 'ArrowRight' ? 1 : -1));
});

function appendQuestionTime(container, question, state) {
  const status = document.createElement('span');
  status.textContent = question.open ? ' 開放中' : ' 未開放';
  if (question.open && question.deadlineAt != null) {
    status.dataset.deadline = String(performance.now() + question.deadlineAt - state.timer.serverNow);
    status.className = 'question-countdown';
  }
  container.append(status);
}

function renderTeacherControls(value) {
  const controls = document.querySelector('#question-controls');
  controls.replaceChildren();
  if (value.phase === '準備中' || (value.independentQuestions && value.phase !== '已結束')) {
    value.questions.forEach((question) => {
      const row = document.createElement('p');
      row.textContent = `第 ${question.number} 題 `;
      appendQuestionTime(row, question, value);
      const button = document.createElement('button');
      button.textContent = question.open ? '停止搶答' : '開始搶答';
      button.onclick = async () => {
        try {
          await api(`/api/questions/${encodeURIComponent(question.number)}/${question.open ? 'close' : 'open'}`, { method: 'POST', body: '{}' });
        } catch (error) { showNotice(error.message, true); }
      };
      row.append(button);
      controls.append(row);
    });
  }
  if (value.phase === '已結束') {
    for (const [index, question] of value.questions.entries()) {
      const visible = value.revealedQuestions ? value.revealedQuestions.includes(question.number)
        : !value.revealModeActive || index <= value.revealIndex;
      const button = document.createElement('button');
      button.textContent = `第 ${question.number} 題${visible ? '：已公布' : '：公布結果'}`;
      button.disabled = visible;
      button.onclick = async () => {
        try {
          await api(`/api/reveal/question/${encodeURIComponent(question.number)}`, { method: 'POST', body: JSON.stringify({ visible: true }) });
        } catch (error) { showNotice(error.message, true); }
      };
      controls.append(button);
    }
  }
  const roster = document.querySelector('#student-groups');
  roster.replaceChildren();
  for (const student of value.students ?? []) {
    const row = document.createElement('label');
    row.textContent = `學號 ${student.studentId} `;
    const select = document.createElement('select');
    for (let group = 1; group <= value.groupCount; group += 1) {
      const option = document.createElement('option');
      option.value = String(group);
      option.textContent = `第 ${group} 組`;
      select.append(option);
    }
    select.value = String(student.group);
    select.disabled = value.phase === '已結束' || value.submissions.some((entry) => entry.studentId === student.studentId);
    select.onchange = async () => {
      try {
        await api('/api/groups/student', { method: 'POST', body: JSON.stringify({ studentId: student.studentId, group: Number(select.value) }) });
      } catch (error) {
        select.value = String(student.group);
        showNotice(error.message, true);
      }
    };
    row.append(select);
    roster.append(row);
  }
}

function renderTimer() {
  for (const label of document.querySelectorAll('.question-countdown')) {
    label.textContent = ` 剩餘 ${Math.max(0, Math.ceil((Number(label.dataset.deadline) - performance.now()) / 1000))} 秒 `;
  }
  const display = document.querySelector('#timer-display');
  const phase = latestState?.phase;
  const limit = latestState?.timer?.limitSeconds;
  if (latestState?.independentQuestions && phase !== '已結束') {
    display.textContent = '各題獨立計時';
    display.classList.remove('urgent');
    return;
  }
  if (phase !== '搶答中' || timerAnchorRemaining === null) {
    if (phase === '題目已關閉' || phase === '已結束') display.textContent = phase;
    else if (limit == null) display.textContent = '不限時';
    else display.textContent = phase === '搶答中' ? '等待同步倒數' : `已設定 ${limit} 秒，等待開始`;
    display.classList.remove('urgent');
    return;
  }
  const remaining = Math.max(0, timerAnchorRemaining - (performance.now() - timerAnchorClientTime));
  const seconds = Math.ceil(remaining / 1000);
  display.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  display.classList.toggle('urgent', seconds <= 10);
}

function renderLeaderboard(rows) {
  const board = document.querySelector('#leaderboard');
  board.replaceChildren();
  board.classList.toggle('hidden', !rows);
  if (!rows) return;
  const heading = document.createElement('h3');
  heading.textContent = '排行榜';
  board.append(heading);
  rows.forEach((row, index) => {
    const item = document.createElement('p');
    item.textContent = `${index + 1}. 第 ${row.group} 組｜${row.score} 分`;
    board.append(item);
  });
}

document.querySelector('#student-login').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const groupEntry = document.querySelector('#group-entry');
    const studentId = document.querySelector('#student-id').value;
    const group = groupEntry.classList.contains('hidden') ? undefined : Number(groupSelect.value);
    const result = await api('/api/session/student', { method: 'POST', body: JSON.stringify({ studentId, group }) });
    if (result.requiresGroup) {
      groupEntry.classList.remove('hidden');
      return showNotice('請選擇本輪組別，再按學生登入。');
    }
    await connect(result.identity);
  } catch (error) { showNotice(error.message, true); }
});

document.querySelector('#student-id').addEventListener('input', () => {
  document.querySelector('#group-entry').classList.add('hidden');
});

document.querySelector('#teacher-login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = document.querySelector('#teacher-password');
  try {
    const result = await api('/api/session/teacher', { method: 'POST', body: JSON.stringify({
      username: document.querySelector('#teacher-username').value, password: password.value
    }) });
    await connect(result.identity);
  } catch (error) { showNotice(error.message, true); }
  finally { password.value = ''; }
});

document.querySelector('#logout').addEventListener('click', async () => {
  try {
    if (currentRole !== 'teacher') {
      answerDrafts.clear();
      saveDrafts();
    }
    await api('/api/session/logout', { method: 'POST', body: '{}' });
    window.location.reload();
  } catch (error) { showNotice(error.message, true); }
});
document.querySelector('#group-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { const response = await api('/api/groups', { method: 'POST', body: JSON.stringify({ groupCount: Number(document.querySelector('#group-count').value) }) }); updateGroupOptions(response.groupCount); showNotice('組數已更新。'); }
  catch (error) { showNotice(error.message, true); }
});
document.querySelector('#timer-limit').addEventListener('change', (event) => {
  document.querySelector('#custom-seconds').classList.toggle('hidden', event.target.value !== 'custom');
});
function readTimerLimit() {
  const choice = document.querySelector('#timer-limit').value;
  const seconds = choice === '' ? null : Number(choice === 'custom' ? document.querySelector('#custom-seconds').value : choice);
  if (seconds !== null && (!Number.isInteger(seconds) || seconds < 1)) throw new Error('自訂秒數必須是正整數。');
  return seconds;
}
document.querySelector('#save-timer').addEventListener('click', async () => {
  try {
    const seconds = readTimerLimit();
    await api('/api/timer', { method: 'POST', body: JSON.stringify({ limitSeconds: seconds }) });
    showNotice(seconds === null ? '已設定為不限時。' : `已設定 ${seconds} 秒。`);
  }
  catch (error) { showNotice(error.message, true); }
});
document.querySelector('#save-fair-mode').addEventListener('click', async () => {
  const enabled = document.querySelector('#fair-mode-enabled').checked;
  const delaySeconds = Number(document.querySelector('#fair-delay').value);
  if (!Number.isInteger(delaySeconds) || delaySeconds < 1) return showNotice('每題延遲秒數必須是正整數。', true);
  try {
    await api('/api/fair-mode', { method: 'POST', body: JSON.stringify({ enabled, delaySeconds }) });
    showNotice(enabled ? `公平模式已開啟，每題延遲 ${delaySeconds} 秒。` : '公平模式已關閉。');
  } catch (error) { showNotice(error.message, true); }
});
document.querySelector('#import').addEventListener('click', async () => {
  try {
    showNotice('正在掃描試算表…');
    const imported = await api('/api/worksheet/import', { method: 'POST', body: JSON.stringify({ url: document.querySelector('#sheet-url').value }) });
    document.querySelector('#import-summary').textContent = `工作表「${imported.sheet}」匯入完成，共 ${imported.questionCount} 題；小題數：${imported.questions.map((question) => `${question.number}題 ${question.subquestionCount}小題`).join('、')}`;
    showNotice('學習單匯入成功。');
  } catch (error) { showNotice(error.message, true); }
});
document.querySelector('#start').addEventListener('click', async () => {
  try {
    const nextQuestion = latestState?.phase === '題目已關閉';
    const settings = nextQuestion ? {} : {
      limitSeconds: readTimerLimit(),
      perQuestion: document.querySelector('#per-question').checked
    };
    await api(nextQuestion ? '/api/phase/next' : '/api/phase/start', { method: 'POST', body: JSON.stringify(settings) });
    showNotice('搶答已開始。');
  } catch (error) { showNotice(error.message, true); }
});
document.querySelector('#finish').addEventListener('click', async () => {
  try {
    const result = await api('/api/phase/finish', { method: 'POST', body: JSON.stringify({ reveal: document.querySelector('#settle-hidden').checked }) });
    showNotice(result.phase === '題目已關閉' ? '本題已關閉。' : '搶答已結束。');
  } catch (error) { showNotice(error.message, true); }
});
document.querySelector('#writeback').addEventListener('click', async () => { try { const result = await api('/api/worksheet/writeback', { method: 'POST', body: '{}' }); showNotice(result.message); } catch (error) { showNotice(error.message, true); } });
document.querySelector('#download-csv').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/results.csv');
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || '下載失敗，請稍後再試。');
    }
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || 'quiz-result.csv';
    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(blobUrl);
    showNotice('CSV 結果已開始下載。');
  } catch (error) { showNotice(error.message, true); }
});
document.querySelector('#new-activity').addEventListener('click', () => {
  if (!window.confirm('確定開始新活動？目前題目、作答與結果將清除，組數設定會保留。')) return;
  socket.emit('activity:new', {}, (reply) => {
    if (!reply.ok) return showNotice(reply.error, true);
    showNotice('本輪資料已清除，請匯入新的學習單。');
  });
});

async function initializeInfo() {
  const info = await api('/api/info');
  updateGroupOptions(info.groupCount);
  document.querySelector('#service-account').textContent = info.serviceAccountEmail
    ? `服務帳號：${info.serviceAccountEmail}。請先把試算表共用給這個 email（編輯者）。`
    : '尚未讀取到服務帳號。請確認專案根目錄 credentials.json 格式正確。';
}
async function initialize() {
  await initializeInfo();
  const { identity } = await api('/api/session');
  if (identity) await connect(identity);
}
initialize().catch((error) => showNotice(error.message, true));
setInterval(renderTimer, 250);
