const { google } = require('googleapis');
const { parseWorksheets } = require('./worksheet-parser');

function spreadsheetIdFromUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('請輸入有效的 Google 試算表網址。'); }
  if (!['docs.google.com', 'sheets.google.com'].includes(url.hostname)) throw new Error('網址必須是 Google 試算表網址。');
  const match = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error('無法從網址讀取試算表 ID。');
  return match[1];
}

function loadCredentials(filePath) {
  const fs = require('node:fs');
  try {
    const credentials = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!credentials.client_email || !credentials.private_key) throw new Error('缺少服務帳號欄位');
    return credentials;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到 credentials.json，請將 Google 服務帳號憑證放在專案根目錄。');
    throw new Error('credentials.json 格式錯誤，請確認使用有效的 Google 服務帳號 JSON 憑證。');
  }
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function targetA1(target) {
  return `'${target.sheet.replace(/'/g, "''")}'!${columnName(target.column)}${target.row + 1}`;
}

async function createSheetsClient(credentials) {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

async function readWorksheetData(sheets, spreadsheetId) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: false,
    fields: 'sheets(properties(title),merges)'
  });
  const worksheets = await Promise.all((metadata.data.sheets ?? []).map(async (sheet) => {
    const title = sheet.properties.title;
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${title.replace(/'/g, "''")}'` });
    return { title, rows: response.data.values ?? [], merges: sheet.merges ?? [] };
  }));
  return parseWorksheets(worksheets);
}

async function importWorksheet(url, options = {}) {
  const credentials = options.credentials ?? loadCredentials(options.credentialsPath ?? require('node:path').join(process.cwd(), 'credentials.json'));
  const sheets = options.sheets ?? await createSheetsClient(credentials);
  const spreadsheetId = spreadsheetIdFromUrl(url);
  const parsed = await readWorksheetData(sheets, spreadsheetId);
  return { spreadsheetId, parsed, serviceAccountEmail: credentials.client_email };
}

async function writeWinningAnswers(sheets, spreadsheetId, questions, submissions) {
  const data = [];
  for (const question of questions) {
    const winner = submissions
      .filter((entry) => entry.questionNumber === question.number && !entry.rejected)
      .sort((a, b) => a.rank - b.rank)[0];
    if (!winner) continue;
    question.subquestions.forEach((subquestion, index) => {
      data.push({ range: targetA1(subquestion.target), values: [[winner.answers[index]]] });
    });
  }
  if (!data.length) return { updatedCells: 0 };
  const result = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data }
  });
  return { updatedCells: result.data.totalUpdatedCells ?? data.length };
}

module.exports = { spreadsheetIdFromUrl, loadCredentials, columnName, targetA1, createSheetsClient, readWorksheetData, importWorksheet, writeWinningAnswers };
