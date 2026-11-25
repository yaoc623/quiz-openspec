const { randomUUID } = require('node:crypto');

class QuizState {
  constructor(options = {}) {
    this.activityId = randomUUID();
    this.now = options.now ?? (() => Date.now());
    this.groupCount = 4;
    this.phase = '準備中';
    this.worksheet = null;
    this.submissions = [];
    this.sequence = 0;
    this.writebackCompleted = false;
    this.timerLimitSeconds = null;
    this.roundStartedAt = null;
    this.timerStartedAt = null;
    this.questionIndex = null;
    this.questionWindows = new Map();
    this.independentQuestions = false;
    this.deadlineAt = null;
    this.finishedAt = null;
    this.fairModeEnabled = false;
    this.fairDelaySeconds = 3;
    this.revealIndex = -1;
    this.revealModeActive = false;
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
    this.revealIndex = -1;
    this.revealModeActive = false;
  }

  setTimerLimit(seconds) {
    if (this.phase !== '準備中') throw new Error('只有準備階段可以設定搶答時間。');
    if (seconds !== null && (!Number.isSafeInteger(seconds * 1000) || !Number.isInteger(seconds) || seconds < 1 ||
      !Number.isSafeInteger(this.now() + seconds * 1000))) throw new Error('秒數必須是支援範圍內的正整數，或選擇不限時。');
    this.timerLimitSeconds = seconds;
  }

  setFairMode(enabled, delaySeconds = this.fairDelaySeconds) {
    if (this.phase !== '準備中') throw new Error('只有準備階段可以設定公平模式。');
    if (typeof enabled !== 'boolean') throw new Error('公平模式必須選擇開啟或關閉。');
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1) throw new Error('每題延遲秒數必須是正整數。');
    this.fairModeEnabled = enabled;
    this.fairDelaySeconds = delaySeconds;
  }

  start({ limitSeconds, perQuestion = false } = {}) {
    if (this.phase !== '準備中' || !this.worksheet?.questions.length) throw new Error('請先匯入學習單，再開始搶答。');
    if (typeof perQuestion !== 'boolean') throw new Error('請選擇有效的搶答模式。');
    if (limitSeconds !== undefined) this.setTimerLimit(limitSeconds);
    this.questionIndex = perQuestion ? 0 : null;
    this.roundStartedAt = this.now();
    this.openTimedWindow(this.roundStartedAt);
  }

  toggleQuestion(number, action) {
    if (this.phase === '已結束' || !this.worksheet?.questions.some((question) => question.number === number)) {
      throw new Error('題目不存在或活動已結算。');
    }
    if (!['open', 'close'].includes(action)) throw new Error('無效的題目操作。');
    if (!this.independentQuestions && this.phase !== '準備中') throw new Error('既有搶答模式已開始。');
    const previousWindow = this.questionWindows.get(number);
    if (action === 'close' && !previousWindow?.open) throw new Error('此題目前未開放。');
    this.independentQuestions = true;
    const now = this.now();
    this.roundStartedAt ??= now;
    this.phase = '搶答中';
    if (action === 'close') this.questionWindows.get(number).open = false;
    else if (!previousWindow?.open || (previousWindow.deadlineAt !== null && now >= previousWindow.deadlineAt)) {
      const deadlineAt = this.timerLimitSeconds === null ? null : now + this.timerLimitSeconds * 1000;
      this.questionWindows.set(number, { open: true, deadlineAt });
    }
  }

  expireQuestions(now) {
    let changed = false;
    for (const window of this.questionWindows.values()) {
      if (window.open && window.deadlineAt !== null && now >= window.deadlineAt) {
        window.open = false;
        changed = true;
      }
    }
    return changed;
  }

  nextDeadline() {
    if (this.phase !== '搶答中') return null;
    if (!this.independentQuestions) return this.deadlineAt;
    let earliest = null;
    for (const window of this.questionWindows.values()) {
      if (window.open && window.deadlineAt !== null && (earliest === null || window.deadlineAt < earliest)) {
        earliest = window.deadlineAt;
      }
    }
    return earliest;
  }

  openNextQuestion() {
    if (this.phase !== '題目已關閉') throw new Error('請先關閉目前題目。');
    this.questionIndex += 1;
    this.openTimedWindow(this.now());
  }

  openTimedWindow(now) {
    this.phase = '搶答中';
    this.timerStartedAt = now;
    this.deadlineAt = this.timerLimitSeconds === null ? null : now + this.timerLimitSeconds * 1000;
    this.finishedAt = null;
  }

  finish(now = this.now(), reveal = false) {
    if (this.independentQuestions && this.phase === '搶答中') {
      for (const window of this.questionWindows.values()) window.open = false;
      this.phase = '已結束';
      this.revealModeActive = reveal;
      this.finishedAt = now;
      return;
    }
    if (this.phase === '題目已關閉') {
      this.phase = '已結束';
      this.revealModeActive = reveal;
      return;
    }
    if (this.phase !== '搶答中') throw new Error('目前不是搶答階段。');
    const hasNext = this.questionIndex !== null && this.questionIndex + 1 < this.worksheet.questions.length;
    this.phase = hasNext ? '題目已關閉' : '已結束';
    if (!hasNext) this.revealModeActive = reveal;
    this.finishedAt = now;
  }

  isExpired(now) {
    return this.phase === '搶答中' && this.deadlineAt !== null && now >= this.deadlineAt;
  }

  resetActivity() {
    if (this.phase !== '已結束') throw new Error('只有已結束的活動可以開始新活動。');
    this.activityId = randomUUID();
    this.phase = '準備中';
    this.worksheet = null;
    this.submissions = [];
    this.sequence = 0;
    this.writebackCompleted = false;
    this.timerLimitSeconds = null;
    this.roundStartedAt = null;
    this.timerStartedAt = null;
    this.questionIndex = null;
    this.questionWindows = new Map();
    this.independentQuestions = false;
    this.deadlineAt = null;
    this.finishedAt = null;
    this.fairModeEnabled = false;
    this.fairDelaySeconds = 3;
    this.revealIndex = -1;
    this.revealModeActive = false;
  }

  markWritebackCompleted() {
    this.writebackCompleted = true;
  }

  setRevealIndex(index) {
    if (this.phase !== '已結束') throw new Error('活動結束後才能使用揭曉模式。');
    const max = this.worksheet?.questions.length ?? 0;
    if (!Number.isInteger(index) || index < -1 || index > max) throw new Error('揭曉題目超出範圍。');
    this.revealModeActive = true;
    this.revealIndex = index;
  }

  submit(group, questionNumber, answers, receivedAtMs = this.now(), studentId) {
    if (this.phase !== '搶答中') throw new Error('目前不是搶答階段，無法提交答案。');
    if (this.isExpired(receivedAtMs)) throw new Error('搶答時間已到，無法提交答案。');
    if (!Number.isInteger(group) || group < 1 || group > this.groupCount) throw new Error('組別無效。');
    const question = this.worksheet?.questions.find((item) => item.number === String(questionNumber));
    if (!question) throw new Error('題號不存在。');
    if (this.independentQuestions) {
      const window = this.questionWindows.get(question.number);
      if (!window?.open || (window.deadlineAt !== null && receivedAtMs >= window.deadlineAt)) {
        throw new Error('此題目前未開放作答。');
      }
    }
    if (this.questionIndex !== null && question !== this.worksheet.questions[this.questionIndex]) throw new Error('此題目前未開放作答。');
    if (!Array.isArray(answers) || answers.length !== question.subquestions.length || answers.some((value) => typeof value !== 'string' || !value.trim())) throw new Error('請一次填寫此題所有小題答案。');
    if (this.submissions.some((item) => (item.group === group || (studentId && item.studentId === studentId)) && item.questionNumber === question.number)) throw new Error('本組已提交此題，不能重複提交。');
    const successfulCount = this.submissions.filter((item) => item.group === group && item.rank === 1 && !item.rejected).length;
    const penaltySeconds = this.fairModeEnabled ? successfulCount * this.fairDelaySeconds : 0;
    const judgedAtMs = receivedAtMs + penaltySeconds * 1000;
    const entry = {
      group, ...(studentId ? { studentId } : {}), questionNumber: question.number, answers: [...answers], receivedAt: new Date(receivedAtMs).toISOString(), receivedAtMs,
      sequence: ++this.sequence, successfulCountAtSubmission: successfulCount, penaltySeconds,
      judgedAtMs, judgedAt: new Date(judgedAtMs).toISOString(), rejected: false
    };
    this.submissions.push(entry);
    this.recalculateRanks(question.number);
    return entry;
  }

  recalculateRanks(questionNumber) {
    const entries = this.submissions.filter((item) => item.questionNumber === questionNumber);
    const active = entries.filter((entry) => !entry.rejected);
    active.sort((a, b) => this.fairModeEnabled
      ? a.judgedAtMs - b.judgedAtMs || a.receivedAtMs - b.receivedAtMs || a.sequence - b.sequence
      : a.sequence - b.sequence);
    active.forEach((entry, index) => { entry.rank = index + 1; });
    entries.filter((entry) => entry.rejected).forEach((entry) => { entry.rank = null; });
  }

  reviewSubmission(sequence, reject) {
    if (this.phase === '準備中') throw new Error('只有開始活動後可以審核答案。');
    const entry = this.submissions.find((item) => item.sequence === Number(sequence));
    if (!entry) throw new Error('找不到這筆作答。');
    if (reject && (entry.rejected || entry.rank !== 1)) throw new Error('只能駁回目前成功答案。');
    if (!reject && !entry.rejected) throw new Error('這筆作答沒有被駁回。');
    entry.rejected = reject;
    this.writebackCompleted = false;
    this.recalculateRanks(entry.questionNumber);
    return entry;
  }

  timerSnapshot(now = this.now()) {
    const remainingMs = this.deadlineAt === null
      ? null
      : Math.max(0, this.deadlineAt - (this.finishedAt ?? now));
    return {
      limitSeconds: this.timerLimitSeconds,
      startedAt: this.timerStartedAt,
      deadlineAt: this.deadlineAt,
      serverNow: now,
      remainingMs
    };
  }

  leaderboard() {
    const rows = Array.from({ length: this.groupCount }, (_, index) => ({ group: index + 1, score: 0, totalSubmissionTimeMs: 0 }));
    for (const question of this.worksheet?.questions ?? []) {
      const winner = this.submissions.find((item) => item.questionNumber === question.number && item.rank === 1 && !item.rejected);
      if (winner) rows[winner.group - 1].score += 1;
    }
    for (const entry of this.submissions) {
      if (this.roundStartedAt !== null) rows[entry.group - 1].totalSubmissionTimeMs += Math.max(0, entry.receivedAtMs - this.roundStartedAt);
    }
    return rows.sort((a, b) => b.score - a.score || a.totalSubmissionTimeMs - b.totalSubmissionTimeMs || a.group - b.group);
  }

  publicState(role, now = this.now()) {
    const base = { activityId: this.activityId, groupCount: this.groupCount, phase: this.phase, questions: this.worksheet?.questions.map(({ number, subquestions }) => ({ number, subquestions: subquestions.map((item) => ({ label: item.label })) })) ?? [] };
    base.timer = this.timerSnapshot(now);
    base.currentQuestionNumber = this.worksheet?.questions[this.questionIndex]?.number ?? null;
    base.fairModeEnabled = this.fairModeEnabled;
    base.revealIndex = this.revealIndex;
    if (this.independentQuestions) {
      base.independentQuestions = true;
      base.questions = base.questions.map((question) => {
        const window = this.questionWindows.get(question.number);
        return { ...question, open: window?.open ?? false, deadlineAt: window?.deadlineAt ?? null };
      });
    }
    base.revealModeActive = this.revealModeActive;
    if (role === 'teacher') return { ...base, fairDelaySeconds: this.fairDelaySeconds, submissions: this.submissions.map((entry) => ({ ...entry, successful: entry.rank === 1 && !entry.rejected })), leaderboard: this.leaderboard() };
    const group = role?.group;
    const studentId = role?.studentId;
    if (studentId) {
      base.identity = { studentId, group };
      base.submissions = this.submissions.filter((entry) => entry.studentId === studentId)
        .map(({ group, questionNumber, answers }) => ({ group, questionNumber, answers: [...answers] }));
    }
    if (this.phase === '已結束') {
      const winners = this.worksheet?.questions.map((question) => {
        const winner = this.submissions.find((item) => item.questionNumber === question.number && item.rank === 1 && !item.rejected);
        return winner ? { questionNumber: question.number, group: winner.group, ...(winner.studentId ? { studentId: winner.studentId } : {}), answers: [...winner.answers] } : { questionNumber: question.number, group: null, answers: [], noCorrectAnswer: this.submissions.some((entry) => entry.questionNumber === question.number && entry.rejected) };
      }) ?? [];
      const rejectedSubmissions = this.submissions.filter((entry) => entry.rejected).map(({ group: rejectedGroup, questionNumber, sequence }) => ({ group: rejectedGroup, questionNumber, sequence }));
      if (!this.revealModeActive) return { ...base, winners, rejectedSubmissions, leaderboard: this.leaderboard() };
      const visibleWinners = this.revealIndex < 0 ? [] : winners.slice(0, this.revealIndex + 1);
      return { ...base, winners: visibleWinners, rejectedSubmissions: rejectedSubmissions.filter((entry) => this.worksheet.questions.findIndex((question) => question.number === entry.questionNumber) <= this.revealIndex), leaderboard: this.revealIndex >= (this.worksheet?.questions.length ?? 0) ? this.leaderboard() : undefined };
    }
    if (studentId) return base;
    return { ...base, submissions: this.submissions.filter((entry) => entry.group === group).map(({ group: entryGroup, questionNumber, answers, receivedAt, rejected }) => ({ group: entryGroup, questionNumber, answers: [...answers], receivedAt, rejected })) };
  }
}

module.exports = { QuizState };
