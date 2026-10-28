const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ================= SETTINGS (Render > Environment me badal sakte ho) =================
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // <-- Render me ADMIN_PASSWORD set karo
const DATABASE_URL = process.env.DATABASE_URL || '';              // <-- Render me DATABASE_URL set karo (postgres://...)
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const ADS_PER_TASK = num(process.env.ADS_PER_TASK, 25);        // 1 task = kitne ads
const REWARD_PER_TASK = num(process.env.REWARD_PER_TASK, 1);   // 1 task ka reward (Rs)
const MIN_TASKS = num(process.env.MIN_TASKS, 5);               // itne task ke baad hi withdraw
const AD_SECONDS = num(process.env.AD_SECONDS, 5);             // har ad kitni der dekhna hai
const STALE_MS = num(process.env.STALE_SECONDS, 90) * 1000;    // itni der page band raha => task incomplete
const ADMIN_TTL_MS = 12 * 3600e3;                              // admin login 12 ghante chalta hai
// =====================================================================================

// ---------- storage: Postgres (real) ya data.json (sirf local test) ----------
const DB_FILE = path.join(__dirname, 'data.json');
const users = [];               // memory cache (QR photo cache me nahi rakhte)
const tokIdx = new Map();       // token -> user (tez lookup)
let pool = null;

const stripQr = (u) => { const { qr, ...rest } = u; return rest; };
function normalize(u) {
  if (u.tasksDone === undefined) {
    const done = u.status === 'completed' || u.status === 'paid';
    u.tasksDone = done ? 1 : 0;
    u.paidTasks = u.status === 'paid' ? 1 : 0;
    u.impressions = u.adsWatched || 0;
    if (done) { u.adsWatched = 0; u.status = 'registered'; }
  }
  u.payments = u.payments || [];
  u.impressions = u.impressions || 0;
  return u;
}
function addToCache(u) { users.push(u); tokIdx.set(u.token, u); }
function dropFromCache(u) { const i = users.indexOf(u); if (i >= 0) users.splice(i, 1); tokIdx.delete(u.token); }

async function initStore() {
  if (!DATABASE_URL) {
    console.warn('\n!!! WARNING: DATABASE_URL set nahi hai. Data data.json me save ho raha hai jo Render par restart par mit jata hai.\n');
    try { JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).users.forEach((u) => addToCache(normalize(u))); } catch (e) {}
    return;
  }
  const { Pool } = require('pg');
  const url = DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const local = /@(localhost|127\.0\.0\.1)/.test(url);
  pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
  pool.on('error', (e) => console.error('DB pool error:', e.message));
  await pool.query(`create table if not exists users (
    id text primary key, token text unique not null, phone text unique not null, upi text unique,
    qr text, data jsonb not null, updated_at timestamptz default now())`);
  // pehli baar: purani data.json ka data database me daal do
  const cnt = Number((await pool.query('select count(*) as c from users')).rows[0].c);
  if (cnt === 0 && fs.existsSync(DB_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).users || [];
      for (const raw of old) {
        const u = normalize(raw);
        await pool.query('insert into users (id,token,phone,upi,qr,data) values ($1,$2,$3,$4,$5,$6) on conflict do nothing',
          [u.id, u.token, u.phone, u.upi || null, u.qr || null, JSON.stringify(stripQr(u))]);
      }
      console.log('data.json se ' + old.length + ' users database me import hue');
    } catch (e) { console.error('import failed:', e.message); }
  }
  const rows = (await pool.query('select data from users order by updated_at')).rows;
  rows.forEach((r) => addToCache(normalize(typeof r.data === 'string' ? JSON.parse(r.data) : r.data)));
  console.log('Database connected, ' + rows.length + ' users loaded');
}

let chain = Promise.resolve();    // saves ek ke baad ek, order me
function save(u) {
  let p;
  if (pool) {
    const snap = JSON.stringify(stripQr(u));
    p = chain.then(() => pool.query('update users set data = $2, updated_at = now() where id = $1', [u.id, snap]));
    chain = p.catch(() => {});
  } else {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ users }));
    fs.renameSync(tmp, DB_FILE);
    p = Promise.resolve();
  }
  p.catch((e) => console.error('DB save failed:', e.message));
  return p;
}
async function insertUser(u) {            // duplicate par unique-violation (23505) throw hota hai
  if (pool) {
    await pool.query('insert into users (id,token,phone,upi,qr,data) values ($1,$2,$3,$4,$5,$6)',
      [u.id, u.token, u.phone, u.upi, u.qr, JSON.stringify(stripQr(u))]);
    delete u.qr;
  } else save(u);
}
async function removeUser(u) {
  if (pool) await pool.query('delete from users where id = $1', [u.id]);
  dropFromCache(u);
  if (!pool) save(u);
}
async function getQr(u) {
  if (!pool) return u.qr;
  const r = await pool.query('select qr from users where id = $1', [u.id]);
  return r.rows[0] && r.rows[0].qr;
}

// ---------- app + rate limit ----------
const app = express();
app.set('trust proxy', 1); // Render / proxy ke peeche asli IP milne ke liye
const hits = new Map();
const recent = (key, windowMs) => (hits.get(key) || []).filter((t) => Date.now() - t < windowMs);
const blocked = (key, max, windowMs) => recent(key, windowMs).length >= max;
const record = (key, windowMs = 3600e3) => { const a = recent(key, windowMs); a.push(Date.now()); hits.set(key, a); };
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 3600e3) hits.delete(k); }, 600e3).unref();
app.use(express.json({ limit: '3mb' }));
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

// Pages: public/ folder me ho ya seedhe bahar (server.js ke saath), dono chalega.
const pickPage = (f) => [path.join(__dirname, 'public', f), path.join(__dirname, f)].find((p) => fs.existsSync(p));
const page = (f) => (req, res) => {
  const p = pickPage(f);
  p ? res.sendFile(p) : res.status(404).send(f + ' not found');
};
app.get(['/', '/index.html'], page('index.html'));
app.get('/admin.html', page('admin.html'));
// QR padhne wali library apne hi server se (bahar ke CDN par depend nahi)
app.get('/jsqr.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/javascript').sendFile(require.resolve('jsqr'));
});

// ---------- admin token (signed, restart ke baad bhi chalta hai) ----------
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('adreward|' + ADMIN_PASSWORD + '|' + DATABASE_URL).digest('hex');
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function makeAdminToken() { const p = String(Date.now() + ADMIN_TTL_MS); return p + '.' + sign(p); }
function validAdminToken(t) {
  const [p, s] = String(t || '').split('.');
  if (!p || !s || !(Number(p) > Date.now())) return false;
  const a = Buffer.from(s), b = Buffer.from(sign(p));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function auth(req, res, next) {
  if (validAdminToken(req.headers['x-admin'])) return next();
  res.status(401).json({ error: 'Admin login required' });
}

// ---------- helpers ----------
function effStatus(u) {
  if (u.status === 'in_progress' && Date.now() - (u.lastActive || 0) > STALE_MS) {
    u.status = 'incomplete';
    u.adStart = null;
    save(u);
  }
  return u.status;
}
const byToken = (t) => tokIdx.get(String(t || ''));
const unpaidOf = (u) => u.tasksDone - u.paidTasks;
const publicUser = (u) => ({
  name: u.name,
  status: effStatus(u),
  adsWatched: u.adsWatched,
  tasksDone: u.tasksDone,
  unpaidTasks: unpaidOf(u),
  payable: unpaidOf(u) >= MIN_TASKS,
  tick: u.tick || null,
});

// ---------- user APIs ----------
app.get('/api/config', (req, res) =>
  res.json({ adsPerTask: ADS_PER_TASK, seconds: AD_SECONDS, rewardPerTask: REWARD_PER_TASK, minTasks: MIN_TASKS }));

app.post('/api/register', ah(async (req, res) => {
  const ip = req.ip;
  if (blocked('regok:' + ip, 20, 3600e3) || blocked('regbad:' + ip, 40, 3600e3))
    return res.status(429).json({ error: 'Too many attempts from this network. Please try again after some time.' });
  const bad = (code, error) => { record('regbad:' + ip); return res.status(code).json({ error }); };
  const b = req.body || {};
  if (b.website) { record('regbad:' + ip); return res.json({ token: crypto.randomBytes(16).toString('hex') }); }
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const phone = String(b.phone || '').replace(/\D/g, '');
  const upi = String(b.upi || '').trim().toLowerCase();
  const qr = String(b.qr || '');
  if (!/^[\p{L}][\p{L} .'-]{2,59}$/u.test(name)) return bad(400, 'Enter your full name using letters only (at least 3 characters).');
  if (!/^[6-9]\d{9}$/.test(phone)) return bad(400, 'Enter a valid 10-digit Indian mobile number.');
  if (!/^[a-z0-9._-]{2,100}@[a-z]{2,40}$/.test(upi)) return bad(400, 'Could not read a valid UPI ID from the QR. Upload a clear UPI QR.');
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(qr) || qr.length > 2.5e6) return bad(400, 'Upload a valid QR image.');
  if (b.agree !== true) return bad(400, 'Please accept the rules to continue.');
  if (users.some((u) => u.phone === phone)) return bad(409, 'This mobile number is already registered.');
  if (users.some((u) => (u.upi || '') === upi)) return bad(409, 'This UPI ID is already registered with another account.');
  const u = {
    id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(16).toString('hex'),
    name, phone, upi, qr, adsWatched: 0, status: 'registered', adStart: null,
    tasksDone: 0, paidTasks: 0, impressions: 0, payments: [], tick: null,
    createdAt: Date.now(), lastActive: Date.now(), lastTaskAt: null, paidAt: null,
  };
  try { await insertUser(u); }
  catch (e) {
    if (e.code === '23505') return bad(409, /upi/i.test(e.detail || e.message || '') ? 'This UPI ID is already registered with another account.' : 'This mobile number is already registered.');
    throw e;
  }
  addToCache(u);
  record('regok:' + ip);
  res.json({ token: u.token, name: u.name });
}));

app.get('/api/me', (req, res) => {
  const u = byToken(req.query.token);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  effStatus(u);
  if (u.status === 'in_progress' || u.status === 'registered') u.lastActive = Date.now();
  res.json(publicUser(u));
});

app.post('/api/ad/start', (req, res) => {
  const u = byToken(req.body.token);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (effStatus(u) !== 'registered' && u.status !== 'in_progress')
    return res.status(409).json({ error: 'Task is not active right now', status: u.status });
  if (Number(req.body.index) !== u.adsWatched) return res.status(409).json({ error: 'Wrong ad number' });
  u.status = 'in_progress'; u.adStart = Date.now(); u.lastActive = Date.now(); save(u);
  res.json({ ok: true });
});

app.post('/api/ad/complete', (req, res) => {
  const u = byToken(req.body.token);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (u.status !== 'in_progress' || !u.adStart) return res.status(409).json({ error: 'Ad was not started', status: u.status });
  if (Number(req.body.index) !== u.adsWatched) return res.status(409).json({ error: 'Wrong ad number' });
  if (Date.now() - u.adStart < AD_SECONDS * 1000 - 700)
    return res.status(400).json({ error: 'Ad was not watched fully' });
  u.adsWatched += 1; u.impressions += 1; u.adStart = null; u.lastActive = Date.now();
  let taskJustDone = false;
  if (u.adsWatched >= ADS_PER_TASK) {
    u.tasksDone += 1; u.adsWatched = 0; u.status = 'registered'; u.lastTaskAt = Date.now();
    taskJustDone = true;
  }
  save(u);
  res.json({ ...publicUser(u), taskJustDone });
});

app.post('/api/leave', (req, res) => {
  const u = byToken(req.body && req.body.token);
  if (u && u.status === 'in_progress') { u.status = 'incomplete'; u.adStart = null; save(u); }
  res.json({ ok: true });
});

app.post('/api/restart', (req, res) => {
  const u = byToken(req.body.token);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (u.status !== 'incomplete') return res.status(409).json({ error: 'No restart needed' });
  u.adsWatched = 0; u.status = 'registered'; u.adStart = null; u.lastActive = Date.now(); save(u);
  res.json(publicUser(u));
});

app.post('/api/ack', (req, res) => {
  const u = byToken(req.body.token);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  u.tick = null; save(u);
  res.json({ ok: true });
});

// ---------- admin APIs ----------
app.post('/api/admin/login', (req, res) => {
  const key = 'adm:' + req.ip;
  if (blocked(key, 10, 15 * 60e3)) return res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });
  const a = crypto.createHash('sha256').update(String((req.body || {}).password || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) { record(key, 15 * 60e3); return res.status(401).json({ error: 'Wrong password' }); }
  res.json({ token: makeAdminToken() });
});

app.get('/api/admin/users', auth, (req, res) => {
  const list = users.map((u) => ({
    id: u.id, name: u.name, phone: u.phone, upi: u.upi || '', status: effStatus(u),
    adsWatched: u.adsWatched, tasksDone: u.tasksDone, paidTasks: u.paidTasks, unpaidTasks: unpaidOf(u),
    impressions: u.impressions, createdAt: u.createdAt, lastTaskAt: u.lastTaskAt, paidAt: u.paidAt,
    paidTotal: u.payments.reduce((s, p) => s + p.amount, 0),
  }));
  res.json({
    users: list.reverse(),
    cfg: { adsPerTask: ADS_PER_TASK, rewardPerTask: REWARD_PER_TASK, minTasks: MIN_TASKS },
  });
});

app.get('/api/admin/qr/:id', auth, ah(async (req, res) => {
  const u = users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ qr: await getQr(u) });
}));

app.post('/api/admin/pay/:id', auth, ah(async (req, res) => {
  const u = users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const unpaid = unpaidOf(u);
  if (unpaid < MIN_TASKS) return res.status(409).json({ error: 'Not enough tasks to withdraw yet' });
  if (Number((req.body || {}).tasks) !== unpaid)
    return res.status(409).json({ error: 'User completed a new task. Refresh the list and try again' });
  const amount = unpaid * REWARD_PER_TASK;
  const prev = { paidTasks: u.paidTasks, paidAt: u.paidAt, tick: u.tick, payments: u.payments };
  u.paidTasks = u.tasksDone; u.paidAt = Date.now();
  u.payments = [...u.payments, { amount, tasks: unpaid, at: Date.now() }];
  u.tick = { amount, at: Date.now() };
  try { await save(u); }
  catch (e) { Object.assign(u, prev); throw e; }
  res.json({ ok: true, amount });
}));

app.delete('/api/admin/users/:id', auth, ah(async (req, res) => {
  const u = users.find((x) => x.id === req.params.id);
  if (u) await removeUser(u);
  res.json({ ok: true });
}));

initStore()
  .then(() => app.listen(PORT, () => console.log(
    `AdReward running on http://localhost:${PORT} | ${ADS_PER_TASK} ads = Rs${REWARD_PER_TASK} | withdraw after ${MIN_TASKS} tasks | storage: ${pool ? 'PostgreSQL' : 'data.json (NOT SAFE)'}`)))
  .catch((e) => { console.error('Could not start. Database error:', e.message); process.exit(1); });
