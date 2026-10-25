const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ================= SETTINGS (Render > Environment me badal sakte ho) =================
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // <-- Render me ADMIN_PASSWORD set karo
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const ADS_PER_TASK = num(process.env.ADS_PER_TASK, 25);        // 1 task = kitne ads
const REWARD_PER_TASK = num(process.env.REWARD_PER_TASK, 1);   // 1 task ka reward (Rs)
const MIN_TASKS = num(process.env.MIN_TASKS, 5);               // itne task ke baad hi withdraw
const AD_SECONDS = num(process.env.AD_SECONDS, 10);            // har ad kitni der dekhna hai
const STALE_MS = 3 * 60 * 1000;                                // 3 min koi activity nahi => incomplete
// =====================================================================================

const DB_FILE = path.join(__dirname, 'data.json');
let db = { users: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
// purane data ko naye format me badalna
db.users.forEach((u) => {
  if (u.tasksDone === undefined) {
    const done = u.status === 'completed' || u.status === 'paid';
    u.tasksDone = done ? 1 : 0;
    u.paidTasks = u.status === 'paid' ? 1 : 0;
    u.impressions = u.adsWatched || 0;
    if (done) { u.adsWatched = 0; u.status = 'registered'; }
  }
  u.payments = u.payments || [];
  u.impressions = u.impressions || 0;
});
const save = () => {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
};
const adminTokens = new Set();

const app = express();
app.use(express.json({ limit: '3mb' }));

// Pages: public/ folder me ho ya seedhe bahar (server.js ke saath), dono chalega.
// Poora folder serve nahi karte, taaki data.json aur server.js bahar na dikhein.
const pickPage = (f) => [path.join(__dirname, 'public', f), path.join(__dirname, f)].find((p) => fs.existsSync(p));
const page = (f) => (req, res) => {
  const p = pickPage(f);
  p ? res.sendFile(p) : res.status(404).send(f + ' nahi mili');
};
app.get(['/', '/index.html'], page('index.html'));
app.get('/admin.html', page('admin.html'));

// ---------- helpers ----------
function effStatus(u) {
  if (u.status === 'in_progress' && Date.now() - (u.lastActive || 0) > STALE_MS) {
    u.status = 'incomplete';
    u.adStart = null;
    save();
  }
  return u.status;
}
const byToken = (t) => db.users.find((u) => u.token === t);
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
function auth(req, res, next) {
  if (adminTokens.has(req.headers['x-admin'])) return next();
  res.status(401).json({ error: 'Admin login zaroori hai' });
}

// ---------- user APIs ----------
app.get('/api/config', (req, res) =>
  res.json({ adsPerTask: ADS_PER_TASK, seconds: AD_SECONDS, rewardPerTask: REWARD_PER_TASK, minTasks: MIN_TASKS }));

app.post('/api/register', (req, res) => {
  let { name, phone, qr } = req.body || {};
  name = String(name || '').trim().slice(0, 60);
  phone = String(phone || '').replace(/\D/g, '');
  if (name.length < 3) return res.status(400).json({ error: 'Poora naam likho (kam se kam 3 akshar)' });
  if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Sahi 10 digit mobile number daalo' });
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(String(qr || '')) || qr.length > 2.5e6)
    return res.status(400).json({ error: 'Bank / UPI QR scanner ki photo upload karo' });
  if (db.users.some((u) => u.phone === phone))
    return res.status(409).json({ error: 'Ye number pehle se register hai' });
  const u = {
    id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(16).toString('hex'),
    name, phone, qr, adsWatched: 0, status: 'registered', adStart: null,
    tasksDone: 0, paidTasks: 0, impressions: 0, payments: [], tick: null,
    createdAt: Date.now(), lastActive: Date.now(), lastTaskAt: null, paidAt: null,
  };
  db.users.push(u); save();
  res.json({ token: u.token });
});

app.get('/api/me', (req, res) => {
  const u = byToken(req.query.token);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.status === 'in_progress' || u.status === 'registered') u.lastActive = Date.now();
  res.json(publicUser(u));
});

app.post('/api/ad/start', (req, res) => {
  const u = byToken(req.body.token);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (effStatus(u) !== 'registered' && u.status !== 'in_progress')
    return res.status(409).json({ error: 'Task ab chalu nahi hai', status: u.status });
  if (Number(req.body.index) !== u.adsWatched) return res.status(409).json({ error: 'Galat ad number' });
  u.status = 'in_progress'; u.adStart = Date.now(); u.lastActive = Date.now(); save();
  res.json({ ok: true });
});

app.post('/api/ad/complete', (req, res) => {
  const u = byToken(req.body.token);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.status !== 'in_progress' || !u.adStart) return res.status(409).json({ error: 'Ad start nahi hua', status: u.status });
  if (Number(req.body.index) !== u.adsWatched) return res.status(409).json({ error: 'Galat ad number' });
  if (Date.now() - u.adStart < AD_SECONDS * 1000 - 700)
    return res.status(400).json({ error: 'Ad poora nahi dekha gaya' });
  u.adsWatched += 1; u.impressions += 1; u.adStart = null; u.lastActive = Date.now();
  let taskJustDone = false;
  if (u.adsWatched >= ADS_PER_TASK) {
    u.tasksDone += 1; u.adsWatched = 0; u.status = 'registered'; u.lastTaskAt = Date.now();
    taskJustDone = true;
  }
  save();
  res.json({ ...publicUser(u), taskJustDone });
});

app.post('/api/leave', (req, res) => {
  const u = byToken(req.body && req.body.token);
  if (u && u.status === 'in_progress') { u.status = 'incomplete'; u.adStart = null; save(); }
  res.json({ ok: true });
});

app.post('/api/restart', (req, res) => {
  const u = byToken(req.body.token);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.status !== 'incomplete') return res.status(409).json({ error: 'Restart ki zaroorat nahi' });
  u.adsWatched = 0; u.status = 'registered'; u.adStart = null; u.lastActive = Date.now(); save();
  res.json(publicUser(u));
});

app.post('/api/ack', (req, res) => {
  const u = byToken(req.body.token);
  if (!u) return res.status(404).json({ error: 'not found' });
  u.tick = null; save();
  res.json({ ok: true });
});

// ---------- admin APIs ----------
app.post('/api/admin/login', (req, res) => {
  const a = Buffer.from(String((req.body || {}).password || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Galat password' });
  const t = crypto.randomBytes(24).toString('hex');
  adminTokens.add(t);
  res.json({ token: t });
});

app.get('/api/admin/users', auth, (req, res) => {
  const users = db.users.map((u) => ({
    id: u.id, name: u.name, phone: u.phone, status: effStatus(u),
    adsWatched: u.adsWatched, tasksDone: u.tasksDone, paidTasks: u.paidTasks, unpaidTasks: unpaidOf(u),
    impressions: u.impressions, createdAt: u.createdAt, lastTaskAt: u.lastTaskAt, paidAt: u.paidAt,
    paidTotal: u.payments.reduce((s, p) => s + p.amount, 0),
  }));
  res.json({
    users: users.reverse(),
    cfg: { adsPerTask: ADS_PER_TASK, rewardPerTask: REWARD_PER_TASK, minTasks: MIN_TASKS },
  });
});

app.get('/api/admin/qr/:id', auth, (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User nahi mila' });
  res.json({ qr: u.qr });
});

app.post('/api/admin/pay/:id', auth, (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User nahi mila' });
  const unpaid = unpaidOf(u);
  if (unpaid < MIN_TASKS) return res.status(409).json({ error: 'Abhi withdraw ke liye task kam hain' });
  if (Number((req.body || {}).tasks) !== unpaid)
    return res.status(409).json({ error: 'User ne naya task poora kiya hai. List refresh karke dobara try karo' });
  const amount = unpaid * REWARD_PER_TASK;
  u.paidTasks = u.tasksDone; u.paidAt = Date.now();
  u.payments.push({ amount, tasks: unpaid, at: Date.now() });
  u.tick = { amount, at: Date.now() };
  save();
  res.json({ ok: true, amount });
});

app.delete('/api/admin/users/:id', auth, (req, res) => {
  db.users = db.users.filter((x) => x.id !== req.params.id); save();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(
  `AdReward chal raha hai: http://localhost:${PORT} | ${ADS_PER_TASK} ads = Rs${REWARD_PER_TASK} | withdraw ${MIN_TASKS} task ke baad`));
