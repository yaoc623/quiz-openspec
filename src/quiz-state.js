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
    this.fairModeEnabled = false;
    this.fairDelaySeconds = 3;
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

  setFairMode(enabled, delaySeconds = this.fairDelaySeconds) {
    if (this.phase !== '準備中') throw new Error('只有準備階段可以設定公平模式。');
    if (typeof enabled !== 'boolean') throw new Error('公平模式必須選擇開啟或關閉。');
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1) throw new Error('每題延遲秒數必須是正整數。');
    this.fairModeEnabled = enabled;
    this.fairDelaySeconds = delaySeconds;
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
    this.fairModeEnabled = false;
    this.fairDelaySeconds = 3;
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
    const successfulCount = this.submissions.filter((item) => item.group === group && item.rank === 1).length;
    const penaltySeconds = this.fairModeEnabled ? successfulCount * this.fairDelaySeconds : 0;
    const judgedAtMs = receivedAtMs + penaltySeconds * 1000;
    const entry = {
      group, questionNumber: question.number, answers: [...answers], receivedAt: new Date(receivedAtMs).toISOString(), receivedAtMs,
      sequence: ++this.sequence, successfulCountAtSubmission: successfulCount, penaltySeconds,
      judgedAtMs, judgedAt: new Date(judgedAtMs).toISOString()
    };
    this.submissions.push(entry);
    this.recalculateRanks(question.number);
    return entry;
  }

  recalculateRanks(questionNumber) {
    const entries = this.submissions.filter((item) => item.questionNumber === questionNumber);
    entries.sort((a, b) => this.fairModeEnabled
      ? a.judgedAtMs - b.judgedAtMs || a.receivedAtMs - b.receivedAtMs || a.sequence - b.sequence
      : a.sequence - b.sequence);
    entries.forEach((entry, index) => { entry.rank = index + 1; });
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
    base.fairModeEnabled = this.fairModeEnabled;
    if (role === 'teacher') return { ...base, fairDelaySeconds: this.fairDelaySeconds, submissions: this.submissions.map((entry) => ({ ...entry, successful: entry.rank === 1 })), leaderboard: this.leaderboard() };
    const group = role?.group;
    if (this.phase === '已結束') {
      const winners = this.worksheet?.questions.map((question) => {
        const winner = this.submissions.find((item) => item.questionNumber === question.number && item.rank === 1);
        return winner ? { questionNumber: question.number, group: winner.group, answers: [...winner.answers] } : { questionNumber: question.number, group: null, answers: [] };
      }) ?? [];
      return { ...base, winners, leaderboard: this.leaderboard() };
    }
    return { ...base, submissions: this.submissions.filter((entry) => entry.group === group).map(({ group: entryGroup, questionNumber, answers, receivedAt }) => ({ group: entryGroup, questionNumber, answers: [...answers], receivedAt })) };
  }
}

module.exports = { QuizState };
