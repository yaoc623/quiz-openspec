const CSV_HEADERS = ['題號', '流水號', '收件時間（毫秒）', '學號', '組別', '答案', '延遲（秒）', '判定時間', '順位', '是否第一名', '是否駁回'];

function taiwanTimestamp(value) {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}`;
}

function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function safeText(value) {
  const text = String(value ?? '');
  return /^[\t\r\n]|^[\s\uFEFF]*[=+@＝＋－＠-]/u.test(text) ? "'" + text : text;
}

function csvFilename(value) {
  const timestamp = taiwanTimestamp(value);
  return `quiz-result-${timestamp.slice(0, 10).replaceAll('-', '')}-${timestamp.slice(11, 19).replaceAll(':', '')}.csv`;
}

function buildQuizCsv(state, exportedAt = Date.now()) {
  if (state.phase !== '已結束' || !state.worksheet) throw new Error('活動結束且已匯入學習單後才能下載 CSV。');
  const rows = [CSV_HEADERS];
  for (const submission of [...state.submissions].sort((a, b) => a.sequence - b.sequence)) {
    const answers = submission.answers.length > 1 ? JSON.stringify(submission.answers) : submission.answers[0];
    rows.push([
      safeText(submission.questionNumber), submission.sequence, taiwanTimestamp(submission.receivedAtMs),
      submission.studentId, submission.group, safeText(answers), submission.penaltySeconds ?? 0,
      taiwanTimestamp(submission.judgedAtMs), submission.rank, submission.rank === 1 && !submission.rejected ? '是' : '否',
      submission.rejected ? '是' : '否'
    ]);
  }
  return { filename: csvFilename(exportedAt), content: `\uFEFF${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n` };
}

module.exports = { buildQuizCsv, csvField, csvFilename, taiwanTimestamp };
