// Birthday Party Expense Calculator — zero-dependency server (Node 22.13+).
// Uses Node's built-in HTTP server and SQLite.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const SIGNUP_CODE = process.env.SIGNUP_CODE || 'birthdayYH';
const MAX_MEMBERS = 10;
const SESSION_DAYS = 30;
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
`);
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

// Address other devices on the same Wi-Fi can use to reach this computer, e.g. http://192.168.1.20:3000
const lanAddresses = Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
const lanAddress = lanAddresses.find(a => a.startsWith('192.168.')) || lanAddresses[0];
const LAN_URL = lanAddress ? `http://${lanAddress}:${PORT}` : null;

// ---------- Auth helpers ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function createSession(res, memberId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  db.prepare('INSERT INTO sessions (token, member_id, expires_at) VALUES (?, ?, ?)')
    .run(token, memberId, Date.now() + maxAge * 1000);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

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

// Accepts "100", "100.5", "$1,250.00" → integer cents. Commas are only allowed as thousands separators,
// so a decimal comma like "1,00" is rejected rather than silently read as $100.
function parseAmount(value) {
  const text = String(value ?? '').trim().replace(/^\$/, '');
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(parseFloat(text.replace(/,/g, '')) * 100);
  return cents > 0 && cents <= 100_000_000 ? cents : null;
}

// True only for dates that exist on the calendar, e.g. rejects 2026-13-45 and 2026-02-31.
function isValidDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(text + 'T00:00:00Z');
  return !isNaN(date) && date.toISOString().slice(0, 10) === text;
}

function parseExpense(body) {
  const description = String(body.description ?? '').trim();
  const amountCents = parseAmount(body.amount);
  const spentOn = String(body.spentOn ?? '').trim();
  if (!description || description.length > 100) return { error: 'Description is required (max 100 characters).' };
  if (amountCents === null) return { error: 'Enter a valid amount, e.g. 100 or 49.99.' };
  if (!isValidDate(spentOn)) return { error: 'Enter a valid date.' };
  return { description, amountCents, spentOn };
}

// ---------- Calculator ----------

// Costs are split equally across everyone who has signed up.
function buildSummary() {
  const members = db.prepare(`
    SELECT m.id, m.name, COALESCE(SUM(e.amount_cents), 0) AS paid
    FROM members m LEFT JOIN expenses e ON e.member_id = m.id
    GROUP BY m.id ORDER BY m.name COLLATE NOCASE, m.id
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

  return {
    totalCents: total,
    memberCount: count,
    maxMembers: MAX_MEMBERS,
    // Whole-cent base share; the first `shareRemainderCents` members (as listed) pay 1¢ more.
    perPersonCents: baseShare,
    shareRemainderCents: remainder,
    members: members.map(({ id, name, paid, share, balance }) =>
      ({ id, name, paidCents: paid, shareCents: share, balanceCents: balance })),
    settlements: settleUp(members),
  };
}

// Fewest payments that even everyone out. A group of k people whose balances sum to zero can settle
// among themselves in k − 1 payments, so the minimum is (people with a balance) minus the most
// zero-sum groups they can be split into. With at most MAX_MEMBERS people, trying every subset is cheap.
function settleUp(members) {
  const people = members.filter(m => m.balance !== 0);
  const full = (1 << people.length) - 1;
  const sum = new Array(full + 1).fill(0);
  const groups = new Array(full + 1).fill(0); // most zero-sum groups when adding people in the best order
  const last = new Array(full + 1).fill(-1);  // who was added last in that order
  for (let mask = 1; mask <= full; mask++) {
    for (let i = 0; i < people.length; i++) {
      const bit = 1 << i;
      if (!(mask & bit)) continue;
      sum[mask] = sum[mask ^ bit] + people[i].balance;
      if (last[mask] === -1 || groups[mask ^ bit] > groups[mask ^ (1 << last[mask])]) last[mask] = i;
    }
    groups[mask] = groups[mask ^ (1 << last[mask])] + (sum[mask] === 0 ? 1 : 0);
  }

  // Recover that order, then cut it wherever the running total returns to zero.
  const order = [];
  for (let mask = full; mask; mask ^= 1 << last[mask]) order.unshift(people[last[mask]]);
  const settlements = [];
  let group = [];
  let running = 0;
  for (const person of order) {
    group.push(person);
    running += person.balance;
    if (running === 0) {
      settlements.push(...settleGroup(group));
      group = [];
    }
  }
  return settlements;
}

// Biggest debtor pays biggest creditor. Each payment clears at least one person and the last clears
// two, so a zero-sum group of k people needs at most k − 1 payments.
function settleGroup(group) {
  const byLeft = (a, b) => b.left - a.left || a.id - b.id;
  const debtors = group.filter(m => m.balance < 0).map(m => ({ id: m.id, name: m.name, left: -m.balance })).sort(byLeft);
  const creditors = group.filter(m => m.balance > 0).map(m => ({ id: m.id, name: m.name, left: m.balance })).sort(byLeft);
  const settlements = [];
  for (let d = 0, c = 0; d < debtors.length && c < creditors.length;) {
    const amount = Math.min(debtors[d].left, creditors[c].left);
    settlements.push({
      fromId: debtors[d].id, from: debtors[d].name,
      toId: creditors[c].id, to: creditors[c].name,
      amountCents: amount,
    });
    debtors[d].left -= amount;
    creditors[c].left -= amount;
    if (debtors[d].left === 0) d++;
    if (creditors[c].left === 0) c++;
  }
  return settlements;
}

// ---------- HTTP plumbing ----------

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10_000) reject(Object.assign(new Error('Request too large'), { status: 413 }));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

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
    // Case-insensitive so phone auto-capitalisation ("BirthdayYH") still works.
    if (String(body.code ?? '').trim().toLowerCase() !== SIGNUP_CODE.toLowerCase()) {
      return sendJson(res, 403, { error: 'Wrong sign-up code.' });
    }
    if (!name || name.length > 40) return sendJson(res, 400, { error: 'Your name is required (max 40 characters).' });
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) return sendJson(res, 400, { error: 'Username: 3–30 letters, numbers, . _ or -' });
    if (password.length < 6) return sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
    if (db.prepare('SELECT COUNT(*) AS n FROM members').get().n >= MAX_MEMBERS) {
      return sendJson(res, 403, { error: `Sign-up is full (${MAX_MEMBERS} family members max).` });
    }
    if (db.prepare('SELECT 1 FROM members WHERE username = ?').get(username)) {
      return sendJson(res, 409, { error: 'That username is taken.' });
    }
    const { lastInsertRowid } = db.prepare('INSERT INTO members (name, username, password_hash) VALUES (?, ?, ?)')
      .run(name, username, hashPassword(password));
    createSession(res, Number(lastInsertRowid));
    return sendJson(res, 201, { ok: true });
  }

  if (method === 'POST' && url === '/api/login') {
    const body = await readJson(req);
    const row = db.prepare('SELECT id, password_hash FROM members WHERE username = ?').get(String(body.username ?? '').trim());
    if (!row || !verifyPassword(String(body.password ?? ''), row.password_hash)) {
      return sendJson(res, 401, { error: 'Wrong username or password.' });
    }
    createSession(res, row.id);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && url === '/api/logout') {
    const token = getCookie(req, 'sid');
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  // Everything below requires login.
  if (!me) return sendJson(res, 401, { error: 'Please log in.' });

  if (method === 'GET' && url === '/api/me') return sendJson(res, 200, me);

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

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) return await handleApi(req, res, currentMember(req));
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    serveStatic(req, res);
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎂 Birthday Expense Calculator running at http://localhost:${PORT}`);
  if (LAN_URL) console.log(`   Family on the same Wi-Fi can open ${LAN_URL}`);
  console.log(`   Sign-up code: ${SIGNUP_CODE}`);
});
