const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // <-- CHANGE KARO
const TOTAL_ADS = 25;
const AD_SECONDS = Number(process.env.AD_SECONDS || 10); // har ad kitni der dekhna hai
const REWARD = 5;
const STALE_MS = 3 * 60 * 1000; // 3 min koi activity nahi => incomplete

const DB_FILE = path.join(__dirname, 'data.json');
let db = { users: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
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
  if ((u.status === 'in_progress') && Date.now() - (u.lastActive || 0) > STALE_MS) {
    u.status = 'incomplete';
    u.adStart = null;
    save();
  }
  return u.status;
}
const byToken = (t) => db.users.find((u) => u.token === t);
const publicUser = (u) => ({
  name: u.name, adsWatched: u.adsWatched, status: effStatus(u), total: TOTAL_ADS, reward: REWARD,
});
function auth(req, res, next) {
  if (adminTokens.has(req.headers['x-admin'])) return next();
  res.status(401).json({ error: 'Admin login zaroori hai' });
}

// ---------- user APIs ----------
app.get('/api/config', (req, res) => res.json({ total: TOTAL_ADS, seconds: AD_SECONDS, reward: REWARD }));

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
    createdAt: Date.now(), lastActive: Date.now(), completedAt: null, paidAt: null,
  };
  db.users.push(u); save();
  res.json({ token: u.token });
});

app.get('/api/me', (req, res) => {
  const u = byToken(req.query.token);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.status === 'in_progress' || u.status === 'registered') { u.lastActive = Date.now(); }
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
  u.adsWatched += 1; u.adStart = null; u.lastActive = Date.now();
  if (u.adsWatched >= TOTAL_ADS) { u.status = 'completed'; u.completedAt = Date.now(); }
  save();
  res.json(publicUser(u));
});

app.post('/api/leave', (req, res) => {
  const u = byToken(req.body && req.body.token);
  if (u && u.status === 'in_progress' && u.adsWatched < TOTAL_ADS) { u.status = 'incomplete'; u.adStart = null; save(); }
  res.json({ ok: true });
});

app.post('/api/restart', (req, res) => {
  const u = byToken(req.body.token);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.status !== 'incomplete') return res.status(409).json({ error: 'Restart ki zaroorat nahi' });
  u.adsWatched = 0; u.status = 'registered'; u.adStart = null; u.lastActive = Date.now(); save();
  res.json(publicUser(u));
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
    id: u.id, name: u.name, phone: u.phone, qr: u.qr, adsWatched: u.adsWatched, status: effStatus(u),
    createdAt: u.createdAt, completedAt: u.completedAt, paidAt: u.paidAt,
  }));
  res.json({ users: users.reverse(), total: TOTAL_ADS, reward: REWARD });
});

app.post('/api/admin/pay/:id', auth, (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User nahi mila' });
  if (u.status !== 'completed') return res.status(409).json({ error: 'Is user ka task poora nahi hai' });
  u.status = 'paid'; u.paidAt = Date.now(); save();
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth, (req, res) => {
  db.users = db.users.filter((x) => x.id !== req.params.id); save();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`AdReward chal raha hai: http://localhost:${PORT}  |  Admin: http://localhost:${PORT}/admin.html`));
