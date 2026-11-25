const CSV_HEADERS = ['題號', '小題號', '組別', '答案', '實際送出時間', '判定時間', '搶答順位', '狀態', '是否使用公平模式', '學號', '審核狀態', '是否獲勝'];

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

function csvFilename(value) {
  const timestamp = taiwanTimestamp(value);
  return `quiz-result-${timestamp.slice(0, 10).replaceAll('-', '')}-${timestamp.slice(11, 19).replaceAll(':', '')}.csv`;
}

function buildQuizCsv(state, exportedAt = Date.now()) {
  if (state.phase !== '已結束' || !state.worksheet) throw new Error('活動結束且已匯入學習單後才能下載 CSV。');
  const rows = [CSV_HEADERS];
  for (const question of state.worksheet.questions) {
    const subquestions = question.subquestions.length > 1
      ? question.subquestions.map((item, index) => item.label || String(index + 1))
      : [''];
    for (let index = 0; index < subquestions.length; index += 1) {
      for (let group = 1; group <= state.groupCount; group += 1) {
        const submission = state.submissions.find((entry) => entry.questionNumber === question.number && entry.group === group);
        let answer = '';
        let receivedAt = '';
        let judgedAt = '';
        let rank = '';
        let status = '未作答';
        if (submission) {
          answer = submission.answers[index] ?? '';
          receivedAt = taiwanTimestamp(submission.receivedAtMs);
          judgedAt = taiwanTimestamp(submission.judgedAtMs);
          rank = submission.rank ?? '';
          status = submission.rejected ? '已駁回' : submission.rank === 1 ? '成功' : '未成功';
        }
        rows.push([
          question.number, subquestions[index], group, answer, receivedAt, judgedAt, rank, status,
          state.fairModeEnabled ? '是' : '否', submission?.studentId ?? '',
          submission ? (submission.rejected ? '已駁回' : '有效') : '', submission?.rank === 1 ? '是' : '否'
        ]);
      }
    }
  }
  return { filename: csvFilename(exportedAt), content: `\uFEFF${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n` };
}

module.exports = { buildQuizCsv, csvField, csvFilename, taiwanTimestamp };
