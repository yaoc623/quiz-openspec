function submitFixture(state, group, questionNumber, answers, receivedAtMs = state.now(), studentId = String(900000 + group)) {
  const number = String(questionNumber);
  if (state.phase !== '搶答中') throw new Error('目前不是搶答階段，無法提交答案。');
  if (state.isExpired(receivedAtMs)) throw new Error('搶答時間已到，無法提交答案。');
  const error = state.answerError(group, number, answers);
  if (error) throw new Error(error);
  const orderNs = String(BigInt(receivedAtMs) * 1000000n);
  const outcome = state.admit({ group, studentId, questionNumber: number, answers, receivedAtMs, receivedAtNs: orderNs, orderNs });
  if (outcome.previous) throw new Error('此學生已提交此題，不能重複提交。');
  if (outcome.closed) throw new Error('此題目前未開放作答。');
  state.processPending();
  return state.submissions.find((entry) => entry.sequence === outcome.receipt.sequence);
}

module.exports = { submitFixture };
