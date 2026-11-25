const { randomUUID } = require('node:crypto');

class QuizState {
  constructor(options = {}) {
    this.activityId = randomUUID();
    this.now = options.now ?? (() => Date.now());
    this.groupCount = 4;
    this.phase = '準備中';
    this.worksheet = null;
    this.submissions = [];
    this.pending = [];
    this.receipts = [];
    this.revealedQuestions = null;
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
    this.pending = [];
    this.receipts = [];
    this.revealedQuestions = null;
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
    if (!Number.isSafeInteger(delaySeconds * 1000) || !Number.isInteger(delaySeconds) || delaySeconds < 1) throw new Error('每題延遲秒數必須是正整數。');
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
    this.pending = [];
    this.receipts = [];
    this.revealedQuestions = null;
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
    this.revealedQuestions = null;
  }

  revealQuestion(number, visible) {
    if (this.phase !== '已結束' || !this.worksheet.questions.some((question) => question.number === number)) {
      throw new Error('活動結算後才能公布題目。');
    }
    this.revealedQuestions ??= this.worksheet.questions.filter((_question, index) =>
      !this.revealModeActive || index <= this.revealIndex).map((question) => question.number);
    this.revealModeActive = true;
    const visibleQuestions = new Set(this.revealedQuestions);
    if (visible) visibleQuestions.add(number);
    else visibleQuestions.delete(number);
    this.revealedQuestions = [...visibleQuestions];
  }

  snapshot() {
    const { now, questionWindows, ...data } = this;
    return { ...data, questionWindows: [...questionWindows] };
  }

  restore(data) {
    Object.assign(this, data, { questionWindows: new Map(data.questionWindows) });
    for (const entry of [...this.receipts, ...this.pending, ...this.submissions]) entry.activityId ??= this.activityId;
  }

  questionIsOpen(number) {
    if (this.phase !== '搶答中') return false;
    if (this.independentQuestions) return this.questionWindows.get(number)?.open === true;
    return this.questionIndex === null || this.worksheet.questions[this.questionIndex]?.number === number;
  }

  isConfirmed(number) {
    return !this.questionIsOpen(number) && !this.pending.some((receipt) => receipt.questionNumber === number);
  }

  answerError(group, number, answers) {
    const question = this.worksheet?.questions.find((item) => item.number === number);
    if (!Number.isInteger(group) || group < 1 || group > this.groupCount) return '組別無效。';
    if (!question || !Array.isArray(answers) || answers.length !== question.subquestions.length ||
        answers.some((value) => typeof value !== 'string' || !value.trim() || value.length > 8000)) {
      return '請一次填寫此題所有小題答案（每小題上限 8000 字）。';
    }
    return null;
  }

  admit({ group, studentId, questionNumber, answers, receivedAtMs, receivedAtNs, orderNs }) {
    if (typeof studentId !== 'string' || !/^[0-9]{1,32}$/.test(studentId)) throw new Error('需要有效的登入學號。');
    const previous = this.receipts.find((item) => item.activityId === this.activityId &&
      item.studentId === studentId && item.questionNumber === questionNumber);
    if (previous) {
      return { previous };
    }
    const sequence = ++this.sequence;
    const question = this.worksheet?.questions.find((item) => item.number === questionNumber);
    if (!question || !this.questionIsOpen(questionNumber) || this.isExpired(receivedAtMs) ||
        (this.independentQuestions && this.questionWindows.get(questionNumber).deadlineAt !== null &&
          receivedAtMs >= this.questionWindows.get(questionNumber).deadlineAt)) return { closed: true };
    const successfulCountAtSubmission = this.submissions.filter((item) => item.group === group &&
      item.rank === 1 && this.isConfirmed(item.questionNumber)).length;
    const penaltySeconds = this.fairModeEnabled ? successfulCountAtSubmission * this.fairDelaySeconds : 0;
    const receipt = {
      activityId: this.activityId, studentId, group, questionNumber, answers, sequence, receivedAtMs, receivedAtNs, orderNs,
      successfulCountAtSubmission, penaltySeconds, status: '已送出'
    };
    this.receipts.push(receipt);
    this.pending.push(receipt);
    return { receipt };
  }

  processPending() {
    const affected = new Set();
    const processed = this.pending.splice(0);
    for (const pending of processed) {
      const receipt = this.receipts.find((item) => item.sequence === pending.sequence);
      const error = this.answerError(receipt.group, receipt.questionNumber, receipt.answers);
      if (error) {
        receipt.status = '未計入';
        receipt.error = error;
        continue;
      }
      const judgedAtMs = receipt.receivedAtMs + receipt.penaltySeconds * 1000;
      this.submissions.push({
        ...receipt, receivedAt: new Date(receipt.receivedAtMs).toISOString(),
        judgedAtMs, judgedAt: new Date(judgedAtMs).toISOString(),
        judgedNs: String(BigInt(receipt.orderNs) + BigInt(receipt.penaltySeconds) * 1000000000n),
        rejected: false, reviews: []
      });
      affected.add(receipt.questionNumber);
    }
    for (const number of affected) this.recalculateRanks(number);
    return processed;
  }

  recalculateRanks(questionNumber) {
    const entries = this.submissions.filter((item) => item.questionNumber === questionNumber);
    const active = entries.filter((entry) => !entry.rejected);
    active.sort((a, b) => {
      const first = BigInt(a.judgedNs);
      const second = BigInt(b.judgedNs);
      return first === second ? a.sequence - b.sequence : first < second ? -1 : 1;
    });
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
    entry.reviews.push({ rejected: reject, at: new Date(this.now()).toISOString() });
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
      if (winner && this.isConfirmed(question.number)) rows[winner.group - 1].score += 1;
    }
    for (const entry of this.submissions) {
      if (!entry.rejected && this.roundStartedAt !== null) rows[entry.group - 1].totalSubmissionTimeMs += Math.max(0, entry.receivedAtMs - this.roundStartedAt);
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
    base.revealedQuestions = this.revealedQuestions;
    if (role === 'teacher') return { ...base, fairDelaySeconds: this.fairDelaySeconds, submissions: this.submissions.map((entry) => ({ ...entry, successful: entry.rank === 1 && !entry.rejected, confirmed: this.isConfirmed(entry.questionNumber) })), leaderboard: this.leaderboard() };
    const group = role?.group;
    const studentId = role?.studentId;
    if (!studentId) return base;
    base.identity = { studentId, group };
    base.submissions = this.receipts.filter((entry) => entry.activityId === this.activityId && entry.studentId === studentId)
      .map(({ group, questionNumber, answers, status, error }) => ({ group, questionNumber, answers, status, error }));
    if (this.phase === '已結束') {
      const winners = this.worksheet?.questions.map((question) => {
        const winner = this.submissions.find((item) => item.questionNumber === question.number && item.rank === 1 && !item.rejected);
        return winner ? { questionNumber: question.number, group: winner.group, ...(winner.studentId ? { studentId: winner.studentId } : {}), answers: [...winner.answers] } : { questionNumber: question.number, group: null, answers: [], noCorrectAnswer: this.submissions.some((entry) => entry.questionNumber === question.number && entry.rejected) };
      }) ?? [];
      const rejectedSubmissions = this.submissions.filter((entry) => entry.rejected).map(({ group: rejectedGroup, questionNumber, sequence }) => ({ group: rejectedGroup, questionNumber, sequence }));
      if (!this.revealModeActive) return { ...base, winners, rejectedSubmissions, leaderboard: this.leaderboard() };
      const visibleNumbers = new Set(this.revealedQuestions ??
        (this.revealIndex < 0 ? [] : winners.slice(0, this.revealIndex + 1).map((entry) => entry.questionNumber)));
      const visibleWinners = winners.filter((entry) => visibleNumbers.has(entry.questionNumber));
      const allRevealed = this.revealedQuestions ? visibleWinners.length === winners.length : this.revealIndex >= winners.length;
      return { ...base, winners: visibleWinners, rejectedSubmissions: rejectedSubmissions.filter((entry) =>
        visibleNumbers.has(entry.questionNumber)), leaderboard: allRevealed ? this.leaderboard() : undefined };
    }
    return base;
  }
}

module.exports = { QuizState };
