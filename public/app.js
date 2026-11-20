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
  document.querySelector('#phase').textContent = value.phase;
  if (currentRole === 'teacher') {
    const canEdit = value.phase === '準備中';
    document.querySelector('#group-count').disabled = !canEdit;
    document.querySelector('#group-form button').disabled = !canEdit;
    document.querySelector('#import').disabled = !canEdit;
    document.querySelector('#start').disabled = value.phase !== '準備中' || !value.questions.length;
    document.querySelector('#finish').disabled = value.phase !== '搶答中';
    document.querySelector('#writeback').disabled = value.phase !== '已結束';
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
      content.textContent = `答案：${entry.answers.join('、')}｜${entry.receivedAt}｜順位 ${entry.rank}${entry.successful ? '（搶答成功）' : ''}`;
      row.append(group, content);
      answerList.append(row);
    });
    const summary = document.querySelector('#import-summary');
    if (value.questions.length) summary.textContent = `共 ${value.questions.length} 題；每題小題數：${value.questions.map((question) => `${question.number}題 ${question.subquestions.length}小題`).join('、')}`;
    else summary.textContent = '';
  } else {
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
      heading.textContent = '搶答結果';
      results.replaceChildren(heading);
      (value.winners ?? []).forEach((winner) => {
        const row = document.createElement('article');
        row.className = 'result';
        const text = document.createElement('p');
        text.textContent = winner.group ? `第 ${winner.questionNumber} 題：第 ${winner.group} 組搶答成功，答案：${winner.answers.join('、')}` : `第 ${winner.questionNumber} 題：沒有組別提交答案`;
        row.append(text);
        results.append(row);
      });
    }
  }
  updateGroupOptions(value.groupCount || groupCount);
}

document.querySelector('#join').addEventListener('click', connect);
document.querySelector('#group-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { const response = await api('/api/groups', { method: 'POST', body: JSON.stringify({ groupCount: Number(document.querySelector('#group-count').value) }) }); updateGroupOptions(response.groupCount); showNotice('組數已更新。'); }
  catch (error) { showNotice(error.message, true); }
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

async function initialize() {
  const info = await api('/api/info');
  updateGroupOptions(info.groupCount);
  document.querySelector('#service-account').textContent = info.serviceAccountEmail
    ? `服務帳號：${info.serviceAccountEmail}。請先把試算表共用給這個 email（編輯者）。`
    : '尚未讀取到服務帳號。請確認專案根目錄 credentials.json 格式正確。';
}
initialize().catch((error) => showNotice(error.message, true));
