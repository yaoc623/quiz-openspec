const HEADER_NAMES = { number: '題號', prompt: '題目', answer: '作答' };

function rangeBounds(range) {
  return {
    startRow: range.startRowIndex ?? 0,
    endRow: range.endRowIndex ?? Number.MAX_SAFE_INTEGER,
    startColumn: range.startColumnIndex ?? 0,
    endColumn: range.endColumnIndex ?? Number.MAX_SAFE_INTEGER
  };
}

function mergeForCell(merges, row, column) {
  return merges.find((merge) => {
    const b = rangeBounds(merge);
    return row >= b.startRow && row < b.endRow && column >= b.startColumn && column < b.endColumn;
  });
}

function textAt(rows, row, column) {
  return String(rows[row]?.[column] ?? '').trim();
}

function findHeader(rows) {
  for (let row = 0; row < rows.length; row += 1) {
    const normalized = (rows[row] ?? []).map((value) => String(value ?? '').trim());
    const number = normalized.indexOf(HEADER_NAMES.number);
    const prompt = normalized.indexOf(HEADER_NAMES.prompt);
    const answer = normalized.indexOf(HEADER_NAMES.answer);
    if (number >= 0 && prompt >= 0 && answer >= 0) return { row, number, prompt, answer };
  }
  return null;
}

function parseWorksheet({ title, rows, merges = [] }) {
  const header = findHeader(rows);
  if (!header) return null;
  const questions = [];
  const questionByNumber = new Map();
  for (let row = header.row + 1; row < rows.length; row += 1) {
    const prompt = textAt(rows, row, header.prompt);
    if (!prompt) continue;
    let number = textAt(rows, row, header.number);
    if (!number) {
      const numberMerge = mergeForCell(merges, row, header.number);
      if (numberMerge) number = textAt(rows, rangeBounds(numberMerge).startRow, rangeBounds(numberMerge).startColumn);
    }
    if (!number) throw new Error(`第 ${row + 1} 列有題目內容，但找不到題號或合併題號儲存格。`);

    const answerLabel = textAt(rows, row, header.answer);
    const groupMatch = answerLabel.match(/[（(]\s*([^）)]+)\s*[）)]/);
    let question = questionByNumber.get(number);
    if (!question) {
      question = { number, subquestions: [] };
      questionByNumber.set(number, question);
      questions.push(question);
    }
    let targetRow = row;
    let targetColumn = header.answer;
    if (groupMatch) {
      targetColumn = header.answer + 1;
    } else {
      const answerMerge = mergeForCell(merges, row, header.answer);
      if (answerMerge) {
        const bounds = rangeBounds(answerMerge);
        targetRow = bounds.startRow;
        targetColumn = bounds.startColumn;
      }
    }
    question.subquestions.push({
      label: groupMatch ? groupMatch[1].trim() : '',
      target: { sheet: title, row: targetRow, column: targetColumn }
    });
  }
  if (!questions.length) return null;
  return { sheet: title, header, questions };
}

function parseWorksheets(worksheets) {
  for (const worksheet of worksheets) {
    const parsed = parseWorksheet(worksheet);
    if (parsed) return parsed;
  }
  throw new Error('找不到同一列同時包含「題號」、「題目」及「作答」的工作表，請檢查學習單格式。');
}

module.exports = { findHeader, parseWorksheet, parseWorksheets, rangeBounds };
