const { io } = require('socket.io-client');

const teacherCredentials = { username: 'test-teacher', password: 'test-only-password' };
const teacherOptions = { teacherUsername: teacherCredentials.username, teacherPassword: teacherCredentials.password };
const teacherCookies = new Map();

function login(base, role, body) {
  return fetch(base + '/api/session/' + role, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
}

function teacherCookie(base) {
  if (!teacherCookies.has(base)) {
    teacherCookies.set(base, login(base, 'teacher', teacherCredentials)
      .then((response) => response.headers.get('set-cookie').split(';')[0]));
  }
  return teacherCookies.get(base);
}

function authenticatedClient(base, { auth: { role, group }, ...options }) {
  const client = io(base, { ...options, autoConnect: false });
  const cookie = role === 'teacher' ? teacherCookie(base)
    : login(base, 'student', { studentId: String(900000 + group), group })
      .then((response) => response.headers.get('set-cookie')?.split(';')[0]);
  cookie.then((value) => {
    client.io.opts.extraHeaders = value ? { cookie: value } : {};
    client.connect();
  });
  return client;
}

module.exports = { teacherOptions, teacherCredentials, teacherCookie, login, authenticatedClient };
