// Quick end-to-end test: AD_SECONDS=1 node server.js  (alag terminal me), phir: node test.js
const B = 'http://localhost:' + (process.env.PORT || 3000);
const j = async (u, m = 'GET', b, h = {}) => {
  const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, j: await r.json() };
};
const ok = (c, t) => { console.log((c ? 'PASS ' : 'FAIL ') + t); if (!c) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const qr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const phone = '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  let r = await j('/api/register', 'POST', { name: 'Test User', phone: '123', qr });
  ok(r.s === 400, 'galat number reject');
  r = await j('/api/register', 'POST', { name: 'Test User', phone, qr });
  ok(r.s === 200, 'register'); const token = r.j.token;
  r = await j('/api/register', 'POST', { name: 'Test User', phone, qr });
  ok(r.s === 409, 'duplicate number reject');
  // jaldi complete (cheating) reject
  await j('/api/ad/start', 'POST', { token, index: 0 });
  r = await j('/api/ad/complete', 'POST', { token, index: 0 });
  ok(r.s === 400, 'timer se pehle complete reject');
  await sleep(1200);
  r = await j('/api/ad/complete', 'POST', { token, index: 0 });
  ok(r.s === 200 && r.j.adsWatched === 1, 'ad 1 complete');
  // beech me leave => incomplete
  await j('/api/ad/start', 'POST', { token, index: 1 });
  await j('/api/leave', 'POST', { token });
  r = await j('/api/me?token=' + token);
  ok(r.j.status === 'incomplete', 'beech me chhodne par incomplete');
  r = await j('/api/restart', 'POST', { token });
  ok(r.j.adsWatched === 0, 'restart => 0');
  for (let i = 0; i < 25; i++) {
    await j('/api/ad/start', 'POST', { token, index: i }); await sleep(1100);
    r = await j('/api/ad/complete', 'POST', { token, index: i });
  }
  ok(r.j.status === 'completed' && r.j.adsWatched === 25, '25 ads => completed');
  r = await j('/api/admin/users');
  ok(r.s === 401, 'admin bina login block');
  const a = await j('/api/admin/login', 'POST', { password: process.env.ADMIN_PASSWORD || 'admin123' });
  ok(a.s === 200, 'admin login');
  r = await j('/api/admin/users', 'GET', null, { 'x-admin': a.j.token });
  const u = r.j.users.find((x) => x.phone === phone);
  ok(u && u.status === 'completed' && u.qr.startsWith('data:image'), 'admin me user + QR dikha');
  r = await j('/api/admin/pay/' + u.id, 'POST', null, { 'x-admin': a.j.token });
  ok(r.s === 200, 'pay / green tick bheja');
  r = await j('/api/me?token=' + token);
  ok(r.j.status === 'paid', 'user ko status paid mila');
  await j('/api/admin/users/' + u.id, 'DELETE', null, { 'x-admin': a.j.token });
})();
