const roleSelect = document.querySelector('#role');
const groupSelect = document.querySelector('#group');
const entryCard = document.querySelector('#entry-card');
const activityCard = document.querySelector('#activity-card');
const teacherTools = document.querySelector('#teacher-tools');
const studentWork = document.querySelector('#student-work');
const answerList = document.querySelector('#answer-list');
const results = document.querySelector('#results');
const notice = document.querySelector('#notice');
let socket;
let currentRole;
let latestState;
let groupCount = 4;
let timerAnchorRemaining = null;
let timerAnchorClientTime = 0;

function showNotice(message, error = false) {
  notice.textContent = message;
  notice.style.color = error ? '#a33636' : '';
}

async function api(url, options = {}) {
  const roleHeader = currentRole === 'teacher' ? { 'X-Quiz-Role': 'teacher' } : {};
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...roleHeader, ...(options.headers ?? {}) } });
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

roleSelect.addEventListener('change', () => {
  document.querySelector('label[for="group"]').classList.toggle('hidden', roleSelect.value === 'teacher');
  groupSelect.classList.toggle('hidden', roleSelect.value === 'teacher');
});

async function connect() {
  currentRole = roleSelect.value === 'teacher' ? 'teacher' : { group: Number(groupSelect.value) };
  socket = io({ auth: { role: typeof currentRole === 'string' ? currentRole : 'student', group: typeof currentRole === 'string' ? undefined : currentRole.group } });
  socket.on('connect_error', (error) => showNotice(error.message, true));
  socket.on('state', (value) => { latestState = value; renderState(value); });
  entryCard.classList.add('hidden');
  activityCard.classList.remove('hidden');
  teacherTools.classList.toggle('hidden', currentRole !== 'teacher');
  document.querySelector('#identity').textContent = currentRole === 'teacher' ? '老師' : `第 ${currentRole.group} 組`;
}

function createQuestionCard(question) {
  const card = document.createElement('article');
  card.className = 'question';
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
    input.disabled = latestState?.phase !== '搶答中';
    card.append(label, input);
  });
  const button = document.createElement('button');
  button.textContent = '提交本題答案';
  button.disabled = latestState?.phase !== '搶答中';
  button.addEventListener('click', () => {
    const inputs = [...card.querySelectorAll('input')];
    socket.emit('answer:submit', { questionNumber: question.number, answers: inputs.map((input) => input.value) }, (reply) => {
      if (!reply.ok) return showNotice(reply.error, true);
      inputs.forEach((input) => { input.disabled = true; });
      button.disabled = true;
      showNotice(`第 ${question.number} 題已提交，順位 ${reply.entry.rank}。`);
    });
  });
  card.append(button);
  return card;
}

function renderState(value) {
  if (value.timer) { timerAnchorRemaining = value.timer.remainingMs; timerAnchorClientTime = Date.now(); }
  document.querySelector('#phase').textContent = value.phase;
  document.querySelector('#import-status').textContent = value.questions.length ? '學習單狀態：已匯入' : '學習單狀態：未匯入';
  results.replaceChildren();
  if (currentRole === 'teacher') {
    const canEdit = value.phase === '準備中';
    document.querySelector('#group-count').disabled = !canEdit;
    document.querySelector('#group-form button').disabled = !canEdit;
    document.querySelector('#import').disabled = !canEdit;
    document.querySelector('#start').disabled = value.phase !== '準備中' || !value.questions.length;
    document.querySelector('#finish').disabled = value.phase !== '搶答中';
    document.querySelector('#writeback').disabled = value.phase !== '已結束';
    document.querySelector('#download-csv').classList.toggle('hidden', value.phase !== '已結束');
    document.querySelector('#new-activity').classList.toggle('hidden', value.phase !== '已結束');
    document.querySelector('#timer-limit').disabled = !canEdit;
    document.querySelector('#custom-seconds').disabled = !canEdit;
    document.querySelector('#save-timer').disabled = !canEdit;
    document.querySelector('#fair-mode-enabled').checked = Boolean(value.fairModeEnabled);
    document.querySelector('#fair-delay').value = String(value.fairDelaySeconds ?? 3);
    document.querySelector('#fair-mode-enabled').disabled = !canEdit;
    document.querySelector('#fair-delay').disabled = !canEdit;
    document.querySelector('#save-fair-mode').disabled = !canEdit;
    answerList.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = '即時作答紀錄';
    answerList.append(heading);
    value.submissions.forEach((entry) => {
      const row = document.createElement('article');
      row.className = 'submission';
      const group = document.createElement('strong');
      group.textContent = `第 ${entry.group} 組・第 ${entry.questionNumber} 題`;
      const content = document.createElement('p');
      content.textContent = value.fairModeEnabled
        ? `答案：${entry.answers.join('、')}｜實際時間 ${entry.receivedAt}｜加權 ${entry.penaltySeconds} 秒｜判定時間 ${entry.judgedAt}｜順位 ${entry.rejected ? '已駁回' : entry.rank}${entry.successful ? '（搶答成功）' : ''}`
        : `答案：${entry.answers.join('、')}｜${entry.receivedAt}｜順位 ${entry.rejected ? '已駁回' : entry.rank}${entry.successful ? '（搶答成功）' : ''}`;
      row.append(group, content);
      if (value.phase === '搶答中' || value.phase === '已結束') {
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
    studentWork.replaceChildren();
    answerList.replaceChildren();
    if (value.phase !== '已結束') {
      const ownSubmissions = new Map((value.submissions ?? []).map((entry) => [entry.questionNumber, entry]));
      value.questions.forEach((question) => {
        const card = createQuestionCard(question);
        const saved = ownSubmissions.get(question.number);
        if (saved) {
          card.querySelectorAll('input').forEach((input, index) => { input.value = saved.answers[index] ?? ''; input.disabled = true; });
          card.querySelector('button').disabled = true;
          const done = document.createElement('p');
          done.className = 'success';
          done.textContent = '本組已提交';
          card.append(done);
        }
        studentWork.append(card);
      });
      studentWork.classList.remove('hidden');
    } else {
      studentWork.classList.add('hidden');
      const heading = document.createElement('h3');
      heading.textContent = value.fairModeEnabled ? '搶答結果（公平模式）' : '搶答結果（未使用公平模式）';
      results.replaceChildren(heading);
      (value.winners ?? []).forEach((winner) => {
        const row = document.createElement('article');
        row.className = 'result';
        const text = document.createElement('p');
        text.textContent = winner.group ? `第 ${winner.questionNumber} 題：第 ${winner.group} 組搶答成功，答案：${winner.answers.join('、')}` : `第 ${winner.questionNumber} 題：${winner.noCorrectAnswer ? '無人答對' : '沒有組別提交答案'}`;
        row.append(text);
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
  updateGroupOptions(value.groupCount || groupCount);
}

function renderTimer() {
  const display = document.querySelector('#timer-display');
  const running = latestState?.phase === '搶答中';
  if (timerAnchorRemaining === null || timerAnchorRemaining === undefined) {
    display.textContent = '不限時';
    display.classList.remove('urgent');
    return;
  }
  const remaining = Math.max(0, timerAnchorRemaining - (running ? Date.now() - timerAnchorClientTime : 0));
  const seconds = Math.ceil(remaining / 1000);
  display.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  display.classList.toggle('urgent', running && seconds <= 10);
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

document.querySelector('#join').addEventListener('click', connect);
document.querySelector('#group-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { const response = await api('/api/groups', { method: 'POST', body: JSON.stringify({ groupCount: Number(document.querySelector('#group-count').value) }) }); updateGroupOptions(response.groupCount); showNotice('組數已更新。'); }
  catch (error) { showNotice(error.message, true); }
});
document.querySelector('#timer-limit').addEventListener('change', (event) => {
  document.querySelector('#custom-seconds').classList.toggle('hidden', event.target.value !== 'custom');
});
document.querySelector('#save-timer').addEventListener('click', async () => {
  const choice = document.querySelector('#timer-limit').value;
  const seconds = choice === '' ? null : Number(choice === 'custom' ? document.querySelector('#custom-seconds').value : choice);
  if (seconds !== null && (!Number.isInteger(seconds) || seconds < 1)) return showNotice('自訂秒數必須是正整數。', true);
  try { await api('/api/timer', { method: 'POST', body: JSON.stringify({ limitSeconds: seconds }) }); showNotice(seconds === null ? '已設定為不限時。' : `已設定 ${seconds} 秒。`); }
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
document.querySelector('#start').addEventListener('click', async () => { try { await api('/api/phase/start', { method: 'POST', body: '{}' }); showNotice('搶答已開始。'); } catch (error) { showNotice(error.message, true); } });
document.querySelector('#finish').addEventListener('click', async () => { try { await api('/api/phase/finish', { method: 'POST', body: '{}' }); showNotice('搶答已結束。'); } catch (error) { showNotice(error.message, true); } });
document.querySelector('#writeback').addEventListener('click', async () => { try { const result = await api('/api/worksheet/writeback', { method: 'POST', body: '{}' }); showNotice(result.message); } catch (error) { showNotice(error.message, true); } });
document.querySelector('#download-csv').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/results.csv', { headers: { 'X-Quiz-Role': 'teacher' } });
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

async function initialize() {
  const info = await api('/api/info');
  updateGroupOptions(info.groupCount);
  document.querySelector('#service-account').textContent = info.serviceAccountEmail
    ? `服務帳號：${info.serviceAccountEmail}。請先把試算表共用給這個 email（編輯者）。`
    : '尚未讀取到服務帳號。請確認專案根目錄 credentials.json 格式正確。';
}
initialize().catch((error) => showNotice(error.message, true));
setInterval(renderTimer, 250);
