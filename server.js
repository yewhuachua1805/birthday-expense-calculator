// Birthday Party Expense Calculator — zero-dependency server (Node 22.13+).
// Uses Node's built-in HTTP server and SQLite.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
// Only this computer can connect by default. Set HOST=0.0.0.0 to let phones on the same Wi-Fi in (plain HTTP).
const HOST = process.env.HOST || '127.0.0.1';
// Set TRUST_PROXY=1 when running behind an HTTPS reverse proxy (Render, Railway, Fly.io…) so
// X-Forwarded-For / X-Forwarded-Proto are used for rate limiting and the Secure cookie flag.
const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY).toLowerCase());
const MAX_MEMBERS = 10;
const SESSION_DAYS = 30;
const MIN_PASSWORD_LENGTH = 8;
const MAX_BODY_BYTES = 10_000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Database ----------

const db = new DatabaseSync(path.join(__dirname, 'party.db'));

// Earlier versions of this app used different tables. Clear them out if they're empty; never touch real data.
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
const memberColumns = tables.includes('members') ? db.prepare('PRAGMA table_info(members)').all().map(c => c.name) : [];
if (tables.includes('users') || memberColumns.includes('email')) {
  const rowCount = ['users', 'members', 'expenses'].filter(t => tables.includes(t))
    .reduce((n, t) => n + db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0);
  if (rowCount > 0) {
    console.error('party.db was created by an older version of this app and contains data.\n' +
      'Back it up or delete it, then start the server again.');
    process.exit(1);
  }
  db.exec('DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS expenses; DROP TABLE IF EXISTS members; DROP TABLE IF EXISTS users;');
}

db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS members (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id           INTEGER PRIMARY KEY,
    member_id    INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    description  TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    spent_on     TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const purgeExpiredSessions = () => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
purgeExpiredSessions();

// The sign-up code comes from SIGNUP_CODE, or is generated randomly on first run and kept in party.db.
let signupCodeIsNew = false;
const SIGNUP_CODE = process.env.SIGNUP_CODE?.trim() || (() => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'signup_code'").get();
  if (row) return row.value;
  const code = crypto.randomBytes(5).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('signup_code', ?)").run(code);
  signupCodeIsNew = true;
  return code;
})();
// `node server.js --show-code` prints the sign-up code and exits, for the organiser who missed it.
if (process.argv.includes('--show-code')) {
  console.log(SIGNUP_CODE);
  process.exit(0);
}

// Address other devices on the same Wi-Fi can use to reach this computer, e.g. http://192.168.1.20:3000
// Only offered when the server actually listens on the network (HOST=0.0.0.0).
const isLoopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const lanAddresses = isLoopbackHost ? [] : Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
const lanAddress = lanAddresses.find(a => a.startsWith('192.168.')) || lanAddresses[0];
const LAN_URL = lanAddress ? `http://${lanAddress}:${PORT}` : null;

// ---------- Auth helpers ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

// Checked when the username doesn't exist, so a login takes the same time either way.
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

function safeEqual(a, b) {
  const digest = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  return TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function clientIp(req) {
  // The last X-Forwarded-For entry is the one added by our own proxy; earlier ones can be spoofed.
  const forwarded = TRUST_PROXY && req.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',').pop().trim() : req.socket.remoteAddress;
}

function setSessionCookie(req, res, value, maxAge) {
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function createSession(req, res, memberId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  db.prepare('INSERT INTO sessions (token, member_id, expires_at) VALUES (?, ?, ?)')
    .run(token, memberId, Date.now() + maxAge * 1000);
  setSessionCookie(req, res, token, maxAge);
}

// ---------- Rate limiting ----------

// Failed attempts per key ("ip:…", "user:…", "code:…") within a 15-minute window. In memory only.
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = { ip: 20, user: 5, code: 10 };
const failures = new Map();

function retryAfterSeconds(...keys) {
  const now = Date.now();
  const waits = keys.map(key => {
    const f = failures.get(key);
    return f && f.resetAt > now && f.count >= MAX_FAILURES[key.split(':')[0]] ? f.resetAt - now : 0;
  });
  return Math.ceil(Math.max(...waits) / 1000);
}

function recordFailure(...keys) {
  const now = Date.now();
  for (const key of keys) {
    const f = failures.get(key);
    if (f && f.resetAt > now) f.count++;
    else failures.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
  }
}

function tooManyAttempts(res, seconds) {
  res.setHeader('Retry-After', String(seconds));
  return sendJson(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).` });
}

// Housekeeping: forget old rate-limit entries and purge expired sessions.
setInterval(() => {
  const now = Date.now();
  for (const [key, f] of failures) if (f.resetAt <= now) failures.delete(key);
  purgeExpiredSessions();
}, 10 * 60 * 1000).unref();

function getCookie(req, name) {
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

function currentMember(req) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  return db.prepare(`
    SELECT m.id, m.name
    FROM sessions s JOIN members m ON m.id = s.member_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, Date.now()) || null;
}

// ---------- Validation ----------

// Accepts "100", "100.5", "$1,250.00" → integer cents.
function parseAmount(value) {
  const text = String(value ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(parseFloat(text) * 100);
  return cents > 0 && cents <= 100_000_000 ? cents : null;
}

function parseExpense(body) {
  const description = String(body.description ?? '').trim();
  const amountCents = parseAmount(body.amount);
  const spentOn = String(body.spentOn ?? '').trim();
  if (!description || description.length > 100) return { error: 'Description is required (max 100 characters).' };
  if (amountCents === null) return { error: 'Enter a valid amount, e.g. 100 or 49.99.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) return { error: 'Enter a valid date.' };
  return { description, amountCents, spentOn };
}

// ---------- Calculator ----------

// Costs are split equally across everyone who has signed up.
function buildSummary() {
  const members = db.prepare(`
    SELECT m.id, m.name, COALESCE(SUM(e.amount_cents), 0) AS paid
    FROM members m LEFT JOIN expenses e ON e.member_id = m.id
    GROUP BY m.id ORDER BY m.name COLLATE NOCASE
  `).all();

  const total = members.reduce((sum, m) => sum + m.paid, 0);
  const count = members.length;
  const baseShare = count ? Math.floor(total / count) : 0;
  const remainder = count ? total % count : 0;

  // Spread leftover cents so shares always add up exactly to the total.
  members.forEach((m, i) => {
    m.share = baseShare + (i < remainder ? 1 : 0);
    m.balance = m.paid - m.share; // positive = is owed money, negative = owes money
  });

  // Greedy matching of biggest debtor to biggest creditor → minimal number of payments.
  const debtors = members.filter(m => m.balance < 0).map(m => ({ name: m.name, left: -m.balance }))
    .sort((a, b) => b.left - a.left);
  const creditors = members.filter(m => m.balance > 0).map(m => ({ name: m.name, left: m.balance }))
    .sort((a, b) => b.left - a.left);
  const settlements = [];
  for (let d = 0, c = 0; d < debtors.length && c < creditors.length;) {
    const amount = Math.min(debtors[d].left, creditors[c].left);
    settlements.push({ from: debtors[d].name, to: creditors[c].name, amountCents: amount });
    debtors[d].left -= amount;
    creditors[c].left -= amount;
    if (debtors[d].left === 0) d++;
    if (creditors[c].left === 0) c++;
  }

  return {
    totalCents: total,
    memberCount: count,
    maxMembers: MAX_MEMBERS,
    perPersonCents: count ? total / count : 0,
    members: members.map(({ id, name, paid, share, balance }) =>
      ({ id, name, paidCents: paid, shareCents: share, balanceCents: balance })),
    settlements,
  };
}

// ---------- HTTP plumbing ----------

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// Resolves to a plain JSON object. Stops reading as soon as the body passes MAX_BODY_BYTES.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => reject(Object.assign(new Error('Request too large'), { status: 413 }));
    const invalid = () => reject(Object.assign(new Error('Invalid JSON.'), { status: 400 }));
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return tooLarge();
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) return chunks.push(chunk);
      req.removeAllListeners('data');
      req.pause();
      tooLarge();
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let value;
      try { value = text ? JSON.parse(text) : {}; } catch { return invalid(); }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
      resolve(value);
    });
    req.on('error', reject);
  });
}

// The organiser is whoever signed up first.
const organiserId = () => db.prepare('SELECT MIN(id) AS id FROM members').get().id;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': `${MIME[path.extname(filePath)] || 'application/octet-stream'}; charset=utf-8` });
    res.end(data);
  });
}

// ---------- API routes ----------

async function handleApi(req, res, me) {
  const { method } = req;
  const url = req.url.split('?')[0];

  if (method === 'POST' && url === '/api/register') {
    const body = await readJson(req);
    const name = String(body.name ?? '').trim();
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const codeKey = `code:${clientIp(req)}`;
    const wait = retryAfterSeconds(codeKey);
    if (wait) return tooManyAttempts(res, wait);
    if (!safeEqual(String(body.code ?? '').trim(), SIGNUP_CODE)) {
      recordFailure(codeKey);
      return sendJson(res, 403, { error: 'Wrong sign-up code.' });
    }
    if (!name || name.length > 40) return sendJson(res, 400, { error: 'Your name is required (max 40 characters).' });
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) return sendJson(res, 400, { error: 'Username: 3–30 letters, numbers, . _ or -' });
    if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
      return sendJson(res, 400, { error: `Password must be ${MIN_PASSWORD_LENGTH}–200 characters.` });
    }
    if (password.toLowerCase() === username.toLowerCase()) {
      return sendJson(res, 400, { error: 'Password can’t be the same as your username.' });
    }
    // Hash first, then check and insert with no await in between so two sign-ups can't race past the limit.
    const passwordHash = await hashPassword(password);
    if (db.prepare('SELECT COUNT(*) AS n FROM members').get().n >= MAX_MEMBERS) {
      return sendJson(res, 403, { error: `Sign-up is full (${MAX_MEMBERS} family members max).` });
    }
    if (db.prepare('SELECT 1 FROM members WHERE username = ?').get(username)) {
      return sendJson(res, 409, { error: 'That username is taken.' });
    }
    const { lastInsertRowid } = db.prepare('INSERT INTO members (name, username, password_hash) VALUES (?, ?, ?)')
      .run(name, username, passwordHash);
    createSession(req, res, Number(lastInsertRowid));
    return sendJson(res, 201, { ok: true });
  }

  if (method === 'POST' && url === '/api/login') {
    const body = await readJson(req);
    const username = String(body.username ?? '').trim();
    const keys = [`ip:${clientIp(req)}`, `user:${username.toLowerCase()}`];
    const wait = retryAfterSeconds(...keys);
    if (wait) return tooManyAttempts(res, wait);
    const row = db.prepare('SELECT id, password_hash FROM members WHERE username = ?').get(username);
    // Always run scrypt so unknown and known usernames take the same time.
    const ok = await verifyPassword(String(body.password ?? ''), row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) {
      recordFailure(...keys);
      return sendJson(res, 401, { error: 'Wrong username or password.' });
    }
    failures.delete(keys[1]);
    createSession(req, res, row.id);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && url === '/api/logout') {
    const token = getCookie(req, 'sid');
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    setSessionCookie(req, res, '', 0);
    return sendJson(res, 200, { ok: true });
  }

  // Everything below requires login.
  if (!me) return sendJson(res, 401, { error: 'Please log in.' });

  if (method === 'GET' && url === '/api/me') return sendJson(res, 200, { ...me, isOrganiser: me.id === organiserId() });

  // Deleting your account removes your login, sessions and expenses (ON DELETE CASCADE).
  // Wiping the party (organiser only) removes every member, session and expense.
  if (method === 'DELETE' && (url === '/api/me' || url === '/api/party')) {
    const body = await readJson(req);
    if (url === '/api/party' && me.id !== organiserId()) {
      return sendJson(res, 403, { error: 'Only the organiser (the first person to sign up) can wipe the party data.' });
    }
    const { password_hash } = db.prepare('SELECT password_hash FROM members WHERE id = ?').get(me.id);
    if (!(await verifyPassword(String(body.password ?? ''), password_hash))) {
      return sendJson(res, 403, { error: 'Wrong password.' });
    }
    if (url === '/api/me') db.prepare('DELETE FROM members WHERE id = ?').run(me.id);
    else db.exec('BEGIN; DELETE FROM expenses; DELETE FROM sessions; DELETE FROM members; COMMIT;');
    setSessionCookie(req, res, '', 0);
    return sendJson(res, 200, { ok: true });
  }

  // What to share with family members who haven't signed up yet.
  if (method === 'GET' && url === '/api/invite') return sendJson(res, 200, { code: SIGNUP_CODE, lanUrl: LAN_URL });

  if (method === 'GET' && url === '/api/summary') return sendJson(res, 200, buildSummary());

  if (method === 'GET' && url === '/api/expenses') {
    const rows = db.prepare(`
      SELECT e.id, e.description, e.amount_cents AS amountCents, e.spent_on AS spentOn,
             e.member_id AS memberId, m.name AS paidBy
      FROM expenses e JOIN members m ON m.id = e.member_id
      ORDER BY e.spent_on DESC, e.id DESC
    `).all();
    return sendJson(res, 200, rows);
  }

  if (method === 'POST' && url === '/api/expenses') {
    const parsed = parseExpense(await readJson(req));
    if (parsed.error) return sendJson(res, 400, parsed);
    db.prepare('INSERT INTO expenses (member_id, description, amount_cents, spent_on) VALUES (?, ?, ?, ?)')
      .run(me.id, parsed.description, parsed.amountCents, parsed.spentOn);
    return sendJson(res, 201, { ok: true });
  }

  const idMatch = url.match(/^\/api\/expenses\/(\d+)$/);
  if (idMatch && (method === 'PUT' || method === 'DELETE')) {
    const id = Number(idMatch[1]);
    const expense = db.prepare('SELECT member_id FROM expenses WHERE id = ?').get(id);
    if (!expense) return sendJson(res, 404, { error: 'Expense not found.' });
    if (expense.member_id !== me.id) return sendJson(res, 403, { error: 'You can only change your own expenses.' });

    if (method === 'DELETE') {
      db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }
    const parsed = parseExpense(await readJson(req));
    if (parsed.error) return sendJson(res, 400, parsed);
    db.prepare('UPDATE expenses SET description = ?, amount_cents = ?, spent_on = ? WHERE id = ?')
      .run(parsed.description, parsed.amountCents, parsed.spentOn, id);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ---------- Server ----------

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const server = http.createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    if (req.url.startsWith('/api/')) return await handleApi(req, res, currentMember(req));
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    serveStatic(req, res);
  } catch (err) {
    if (!err.status) console.error(err);
    if (err.status === 413) {
      // Don't read the rest of an oversized upload; close the connection once the reply is sent.
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
    }
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🎂 Birthday Expense Calculator running at http://localhost:${PORT}`);
  if (LAN_URL) console.log(`   Family on the same Wi-Fi can open ${LAN_URL} (plain HTTP — use only on a trusted network)`);
  else if (isLoopbackHost) console.log('   Only this computer can connect. Set HOST=0.0.0.0 to allow phones on the same Wi-Fi.');
  // Printed once, when the code is first generated. After that, logged-in members see it in the app.
  if (signupCodeIsNew) console.log(`   Sign-up code (generated, shown only this once): ${SIGNUP_CODE}`);
});
