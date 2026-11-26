const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual, createHash } = require('node:crypto');

const cookieName = 'quiz_session';
const lifetime = 12 * 60 * 60 * 1000;

function createIdentity({ accountsPath, teacherUsername, teacherPassword }) {
  let accounts = new Set();
  if (accountsPath && fs.existsSync(accountsPath)) {
    accounts = new Set(JSON.parse(fs.readFileSync(accountsPath, 'utf8')));
  }
  const sessions = new Map();
  const groups = new Map();
  const hash = (value) => createHash('sha256').update(value).digest();

  function parseStudentId(value) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!/^[0-9]{1,32}$/.test(id)) throw new Error('請輸入有效的數字學號。');
    return id;
  }

  function addAccount(id) {
    if (accounts.has(id)) return;
    const next = new Set(accounts).add(id);
    if (accountsPath) {
      fs.mkdirSync(path.dirname(accountsPath), { recursive: true });
      const temporary = accountsPath + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify([...next]), { mode: 0o600 });
      fs.renameSync(temporary, accountsPath);
    }
    accounts = next;
  }

  function token(headers) {
    return headers.cookie?.split(';').map((item) => item.trim())
      .find((item) => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  }

  function get(key) {
    const session = sessions.get(key);
    if (session && session.expiresAt > Date.now()) return session;
    sessions.delete(key);
    return null;
  }

  function issue(res, identity) {
    for (const key of sessions.keys()) get(key);
    const key = randomBytes(32).toString('hex');
    sessions.set(key, { ...identity, expiresAt: Date.now() + lifetime });
    res.cookie(cookieName, key, { httpOnly: true, sameSite: 'strict', maxAge: lifetime });
  }

  return {
    token, get, issue, groups, parseStudentId, addAccount,
    revoke(key) { sessions.delete(key); },
    clearCookie(res) { res.clearCookie(cookieName, { httpOnly: true, sameSite: 'strict' }); },
    verifyTeacher(username, password) {
      return Boolean(teacherUsername && teacherPassword && username === teacherUsername &&
        typeof password === 'string' && timingSafeEqual(hash(password), hash(teacherPassword)));
    }
  };
}

module.exports = { createIdentity };
