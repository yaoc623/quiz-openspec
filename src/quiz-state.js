class QuizState {
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.groupCount = 4;
    this.phase = '準備中';
    this.worksheet = null;
    this.submissions = [];
    this.sequence = 0;
    this.writebackCompleted = false;
    this.timerLimitSeconds = null;
    this.roundStartedAt = null;
    this.deadlineAt = null;
    this.finishedAt = null;
  }

  setGroupCount(count) {
    if (this.phase !== '準備中' || !Number.isInteger(count) || count < 1) throw new Error('組數必須是在準備階段設定的正整數。');
    this.groupCount = count;
  }

  setWorksheet(worksheet) {
    if (this.phase !== '準備中') throw new Error('只有準備階段可以匯入學習單。');
    this.worksheet = worksheet;
    this.submissions = [];
    this.sequence = 0;
    this.writebackCompleted = false;
  }

  setTimerLimit(seconds) {
    if (this.phase !== '準備中') throw new Error('只有準備階段可以設定搶答時間。');
    if (seconds !== null && (!Number.isInteger(seconds) || seconds < 1)) throw new Error('秒數必須是正整數，或選擇不限時。');
    this.timerLimitSeconds = seconds;
  }

  start() {
    if (this.phase !== '準備中' || !this.worksheet) throw new Error('請先匯入學習單，再開始搶答。');
    this.phase = '搶答中';
    this.roundStartedAt = this.now();
    this.deadlineAt = this.timerLimitSeconds === null ? null : this.roundStartedAt + this.timerLimitSeconds * 1000;
    this.finishedAt = null;
  }

  finish() {
    if (this.phase !== '搶答中') throw new Error('目前不是搶答階段。');
    this.phase = '已結束';
    this.finishedAt = this.now();
  }

  resetActivity() {
    if (this.phase !== '已結束') throw new Error('只有已結束的活動可以開始新活動。');
    this.phase = '準備中';
    this.worksheet = null;
    this.submissions = [];
    this.sequence = 0;
    this.writebackCompleted = false;
    this.timerLimitSeconds = null;
    this.roundStartedAt = null;
    this.deadlineAt = null;
    this.finishedAt = null;
  }

  markWritebackCompleted() {
    this.writebackCompleted = true;
  }

  submit(group, questionNumber, answers) {
    if (this.phase !== '搶答中') throw new Error('目前不是搶答階段，無法提交答案。');
    if (!Number.isInteger(group) || group < 1 || group > this.groupCount) throw new Error('組別無效。');
    const question = this.worksheet?.questions.find((item) => item.number === String(questionNumber));
    if (!question) throw new Error('題號不存在。');
    if (!Array.isArray(answers) || answers.length !== question.subquestions.length || answers.some((value) => typeof value !== 'string')) throw new Error('請一次填寫此題所有小題答案。');
    if (this.submissions.some((item) => item.group === group && item.questionNumber === question.number)) throw new Error('本組已提交此題，不能重複提交。');
    const receivedAtMs = this.now();
    const entry = { group, questionNumber: question.number, answers: [...answers], receivedAt: new Date(receivedAtMs).toISOString(), receivedAtMs, sequence: ++this.sequence };
    entry.rank = this.submissions.filter((item) => item.questionNumber === question.number).length + 1;
    this.submissions.push(entry);
    return entry;
  }

  timerSnapshot(now = this.now()) {
    const remainingMs = this.deadlineAt === null
      ? null
      : Math.max(0, this.deadlineAt - (this.phase === '已結束' ? this.finishedAt ?? now : now));
    return {
      limitSeconds: this.timerLimitSeconds,
      startedAt: this.roundStartedAt,
      deadlineAt: this.deadlineAt,
      serverNow: now,
      remainingMs
    };
  }

  leaderboard() {
    const rows = Array.from({ length: this.groupCount }, (_, index) => ({ group: index + 1, score: 0, totalSubmissionTimeMs: 0 }));
    for (const question of this.worksheet?.questions ?? []) {
      const winner = this.submissions.find((item) => item.questionNumber === question.number && item.rank === 1);
      if (winner) rows[winner.group - 1].score += 1;
    }
    for (const entry of this.submissions) {
      if (this.roundStartedAt !== null) rows[entry.group - 1].totalSubmissionTimeMs += Math.max(0, entry.receivedAtMs - this.roundStartedAt);
    }
    return rows.sort((a, b) => b.score - a.score || a.totalSubmissionTimeMs - b.totalSubmissionTimeMs || a.group - b.group);
  }

  publicState(role, now = this.now()) {
    const base = { groupCount: this.groupCount, phase: this.phase, questions: this.worksheet?.questions.map(({ number, subquestions }) => ({ number, subquestions: subquestions.map((item) => ({ label: item.label })) })) ?? [] };
    base.timer = this.timerSnapshot(now);
    if (role === 'teacher') return { ...base, submissions: this.submissions.map((entry) => ({ ...entry, successful: entry.rank === 1 })), leaderboard: this.leaderboard() };
    const group = role?.group;
    if (this.phase === '已結束') {
      const winners = this.worksheet?.questions.map((question) => {
        const winner = this.submissions.find((item) => item.questionNumber === question.number && item.rank === 1);
        return winner ? { questionNumber: question.number, group: winner.group, answers: [...winner.answers] } : { questionNumber: question.number, group: null, answers: [] };
      }) ?? [];
      return { ...base, winners, leaderboard: this.leaderboard() };
    }
    return { ...base, submissions: this.submissions.filter((entry) => entry.group === group).map((entry) => ({ ...entry })) };
  }
}

module.exports = { QuizState };
