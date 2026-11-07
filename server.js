/* Process Safety Tracker – tiny Node server (Express).
   Stores data in Neon Postgres when DATABASE_URL is set (persistent, serverless-safe),
   otherwise falls back to JSON + uploaded files on disk (local dev / disk hosts).
   Environment variables (all optional):
     DATABASE_URL                                                    (Neon Postgres)
     PORT, DATA_DIR, APP_PASSWORD, PUBLIC_URL, CORS_ORIGIN, SEED_DEMO=false
     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, MAIL_FROM   (any SMTP provider)
     RESEND_API_KEY, MAIL_FROM                                           (or Resend)            */
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PS = require('./public/shared.js');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads');
const FILE = path.join(DATA, 'state.json');
fs.mkdirSync(UP, { recursive: true });

const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_DB = !!DATABASE_URL;
let pool = null;
if (USE_DB) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
}

/* ---------- state ---------- */
const COLS = ['sce', 'insp', 'ovr', 'act', 'kpi', 'log'];
let state = null;
let saveChain = Promise.resolve();
let readyPromise = null;

function freshState() {
  const demo = process.env.SEED_DEMO !== 'false';
  return { rev: 1, lastDigest: '', db: demo ? PS.seed(PS.todayISO(PS.DEFAULT_SETTINGS.timezone)) : { sce: [], insp: [], ovr: [], act: [], kpi: [], log: [] }, settings: Object.assign({}, PS.DEFAULT_SETTINGS, { demo }) };
}
function normalize(s) {
  COLS.forEach(c => { s.db[c] = s.db[c] || []; });
  return s;
}

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS tracker_state (
    id int PRIMARY KEY,
    rev int NOT NULL DEFAULT 1,
    last_digest text NOT NULL DEFAULT '',
    db jsonb NOT NULL DEFAULT '{}'::jsonb,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS documents (
    id text PRIMARY KEY,
    orig_name text NOT NULL DEFAULT '',
    mimetype text NOT NULL DEFAULT 'application/octet-stream',
    size int NOT NULL DEFAULT 0,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await pool.query('SELECT rev, last_digest, db, settings FROM tracker_state WHERE id = 1');
  if (rows.length) {
    const r = rows[0];
    state = normalize({ rev: r.rev, lastDigest: r.last_digest || '', db: r.db, settings: Object.assign({}, PS.DEFAULT_SETTINGS, r.settings || {}) });
  } else {
    state = normalize(freshState());
    state.rev = 0;
    await persistDb();
  }
}
function init() {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (USE_DB) { await initDb(); }
      else {
        try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { state = null; }
        if (!state) { state = normalize(freshState()); persistFile(); }
        else normalize(state);
      }
    })();
  }
  return readyPromise;
}
function persistFile() { state.rev++; const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, FILE); }
async function persistDb() {
  state.rev++;
  await pool.query(
    `INSERT INTO tracker_state (id, rev, last_digest, db, settings, updated_at)
     VALUES (1, $1, $2, $3::jsonb, $4::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET rev = EXCLUDED.rev, last_digest = EXCLUDED.last_digest, db = EXCLUDED.db, settings = EXCLUDED.settings, updated_at = now()`,
    [state.rev, state.lastDigest || '', JSON.stringify(state.db), JSON.stringify(state.settings)]
  );
}
function save() {
  saveChain = saveChain.then(() => USE_DB ? persistDb() : Promise.resolve(persistFile())).catch(e => console.error('save failed:', e.message));
  return saveChain;
}
init().catch(e => console.error('init failed:', e.message));

/* ---------- email ---------- */
const hasSMTP = () => !!process.env.SMTP_HOST, hasResend = () => !!process.env.RESEND_API_KEY;
async function sendMail(to, subject, text, html) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  if (!from) throw new Error('Set MAIL_FROM (the address emails are sent from).');
  const list = Array.isArray(to) ? to : [to];
  if (hasResend()) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: list, subject, text, html }) });
    if (!r.ok) throw new Error('Resend rejected the message: ' + (await r.text()).slice(0, 200));
    return;
  }
  if (!hasSMTP()) throw new Error('No email provider configured. Set SMTP_HOST/SMTP_USER/SMTP_PASS or RESEND_API_KEY on the server.');
  const port = +process.env.SMTP_PORT || 587;
  const tx = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465, auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
  await tx.sendMail({ from, to: list.join(','), subject, text, html });
}
async function postWebhook(text) {
  const u = state.settings.webhook; if (!u) return false;
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error('Webhook returned ' + r.status);
  return true;
}
const publicUrl = req => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (process.env.RAILWAY_PUBLIC_DOMAIN && 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN) || (req && (req.protocol + '://' + req.get('host'))) || '';

async function sendDigest(link) {
  const S = state.settings, t = PS.todayISO(S.timezone), sent = [];
  const d = PS.buildDigest(state.db, S, t, { link });
  if (S.recipients.length) { await sendMail(S.recipients, d.subject, d.text, d.html); sent.push(...S.recipients); }
  if (S.notifyOwners) {
    const owners = [...new Set(state.db.act.filter(a => a.ownerEmail && a.status !== 'Closed').map(a => a.ownerEmail.toLowerCase()))];
    for (const o of owners) { if (S.recipients.map(x => x.toLowerCase()).includes(o)) continue; const od = PS.buildDigest(state.db, S, t, { link, ownerEmail: o }); if (od.count) { await sendMail(o, od.subject, od.text, od.html); sent.push(o); } }
  }
  const hook = await postWebhook(d.subject + '\n\n' + d.text);
  if (!sent.length && !hook) throw new Error('Add at least one recipient (or a webhook) in Settings first.');
  return { sent, webhook: hook, subject: d.subject };
}
async function instantAlert(subject, line) {
  const S = state.settings; if (!S.instantAlerts || !S.recipients.length || !(hasSMTP() || hasResend())) return;
  try { await sendMail(S.recipients, `[${S.project}] ${subject}`, line, `<p style="font-family:Arial,sans-serif">${PS.esc(line)}</p>`); } catch (e) { console.error('instant alert failed:', e.message); }
}
const hourIn = tz => { try { return +new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()) % 24; } catch (e) { return new Date().getHours(); } };
setInterval(async () => {
  try {
    await init();
    const S = state.settings; if (!S.digestEnabled || !(S.recipients.length || S.webhook) || !(hasSMTP() || hasResend() || S.webhook)) return;
    const t = PS.todayISO(S.timezone); if (state.lastDigest === t || hourIn(S.timezone) !== +S.digestHour) return;
    state.lastDigest = t; await save();
    try { const r = await sendDigest(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ''); console.log('Daily digest sent to', r.sent.join(', ')); } catch (e) { console.error('Daily digest failed:', e.message); }
  } catch (e) { console.error('digest check failed:', e.message); }
}, 5 * 60 * 1000);

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'X-Content-Type-Options': 'nosniff' }); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });
app.use(express.json({ limit: '12mb' }));

const PW = process.env.APP_PASSWORD || '';
const TOKEN = PW ? crypto.createHash('sha256').update(PW + '|ps-tracker').digest('hex') : '';
const attempts = new Map();
const guard = (req, res, next) => {
  if (!PW) return next();
  const t = (req.get('Authorization') || '').replace(/^Bearer /, '') || req.query.token || '';
  if (t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN))) return next();
  res.status(401).json({ error: 'Sign in required' });
};

app.get('/api/health', async (req, res) => {
  let dbOk = !USE_DB;
  try { await init(); dbOk = !!state; } catch (e) { dbOk = false; }
  res.json({ app: 'ps-tracker', ok: dbOk, db: USE_DB ? 'postgres' : 'file', auth: !!PW, email: { smtp: hasSMTP(), resend: hasResend() } });
});
app.post('/api/login', (req, res) => {
  const ip = req.ip, now = Date.now(), a = (attempts.get(ip) || []).filter(x => now - x < 60000);
  if (a.length >= 10) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
  a.push(now); attempts.set(ip, a);
  if (!PW || req.body.password === PW) return res.json({ token: TOKEN });
  res.status(401).json({ error: 'Wrong password' });
});

app.use('/api', async (req, res, next) => {
  try { await init(); } catch (e) { return res.status(503).json({ error: 'Database unavailable: ' + e.message }); }
  next();
});
app.use('/api', (req, res, next) => (req.path === '/health' || req.path === '/login') ? next() : guard(req, res, next));
app.get('/api/state', (req, res) => res.json({ db: state.db, settings: state.settings, rev: state.rev }));
app.put('/api/settings', async (req, res) => { state.settings = Object.assign({}, PS.DEFAULT_SETTINGS, req.body); await save(); res.json({ rev: state.rev }); });
app.post('/api/import', async (req, res) => {
  const { db, settings } = req.body || {}; if (!db) return res.status(400).json({ error: 'Missing data' });
  const keep = new Set(); COLS.forEach(c => (db[c] || []).forEach(r => (r.docs || []).forEach(d => d.kind === 'file' && keep.add(d.id))));
  state.db = {}; COLS.forEach(c => state.db[c] = Array.isArray(db[c]) ? db[c] : []);
  if (settings) state.settings = Object.assign({}, PS.DEFAULT_SETTINGS, settings);
  if (USE_DB) {
    if (keep.size === 0) await pool.query('DELETE FROM documents');
    else await pool.query('DELETE FROM documents WHERE NOT (id = ANY($1::text[]))', [Array.from(keep)]);
  } else {
    fs.readdirSync(UP).forEach(f => { if (!keep.has(f.split('.')[0])) fs.unlink(path.join(UP, f), () => {}); });
  }
  await save(); res.json({ rev: state.rev });
});

/* documents */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/api/docs', (req, res) => upload.single('file')(req, res, async err => {
  if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is over 25 MB.' : err.message });
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const id = crypto.randomBytes(10).toString('hex');
  try {
    if (USE_DB) {
      await pool.query('INSERT INTO documents (id, orig_name, mimetype, size, data) VALUES ($1,$2,$3,$4,$5)', [id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer]);
    } else {
      const fname = id + path.extname(req.file.originalname).replace(/[^.\w]/g, '').slice(0, 8);
      fs.writeFileSync(path.join(UP, fname), req.file.buffer);
    }
    res.json({ id, name: req.file.originalname, size: req.file.size, type: req.file.mimetype });
  } catch (e) { res.status(500).json({ error: e.message }); }
}));
const findDocFile = id => /^[a-f0-9]+$/.test(id) ? fs.readdirSync(UP).find(f => f.split('.')[0] === id) : null;
app.get('/api/docs/:id/:name', async (req, res) => {
  const { id, name } = req.params;
  if (USE_DB) {
    const { rows } = await pool.query('SELECT orig_name, mimetype, data FROM documents WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).send('File not found');
    res.set('Content-Type', rows[0].mimetype || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name || rows[0].orig_name || 'file')}`);
    return res.send(rows[0].data);
  }
  const f = findDocFile(id); if (!f) return res.status(404).send('File not found'); res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`); res.sendFile(path.join(UP, f));
});
app.delete('/api/docs/:id', async (req, res) => {
  const { id } = req.params;
  if (USE_DB) { await pool.query('DELETE FROM documents WHERE id = $1', [id]); return res.sendStatus(204); }
  const f = findDocFile(id); if (f) fs.unlinkSync(path.join(UP, f)); res.sendStatus(204);
});

/* email */
app.post('/api/email/test', async (req, res) => {
  try { const S = state.settings; if (!S.recipients.length) throw new Error('Add at least one recipient first.');
    await sendMail(S.recipients, `[Test] ${S.project}`, 'This is a test message from your Process Safety Tracker. Notifications are working.', '<p style="font-family:Arial,sans-serif">This is a test message from your Process Safety Tracker. <b>Notifications are working.</b></p>');
    res.json({ message: 'Test email sent to ' + S.recipients.join(', ') }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/email/digest', async (req, res) => {
  try { const r = await sendDigest((req.body && req.body.link) || publicUrl(req)); res.json({ message: `Digest sent to ${r.sent.length} recipient${r.sent.length === 1 ? '' : 's'}${r.webhook ? ' and webhook' : ''}` }); } catch (e) { res.status(400).json({ error: e.message }); }
});

/* records */
app.put('/api/:col/:id', async (req, res) => {
  const { col, id } = req.params; if (!COLS.includes(col)) return res.sendStatus(404);
  const rec = Object.assign({}, req.body, { id }), arr = state.db[col], i = arr.findIndex(r => r.id === id), prev = i >= 0 ? arr[i] : null;
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  if (col === 'log' && arr.length > 500) arr.splice(0, arr.length - 500);
  await save(); res.json({ rev: state.rev });
  if (col === 'act' && !prev && rec.risk === 'H' && rec.status !== 'Closed') instantAlert('New high-risk action: ' + rec.tag, `A high-risk action was added for ${rec.tag}: ${rec.desc}. Owner: ${rec.owner || 'unassigned'}. Target: ${PS.fmtDate(rec.target)}.`);
  if (col === 'insp' && rec.result === 'Fail' && (!prev || prev.result !== 'Fail')) instantAlert('Test failed: ' + rec.tag, `${rec.tag} (${rec.type}) failed its last test. Raise a defect and confirm compensating measures.`);
  if (col === 'ovr' && !prev && rec.risk !== 'Yes' && rec.status !== 'Closed') instantAlert('Override without risk assessment: ' + rec.tag, `An override on ${rec.tag} was recorded without a risk assessment.`);
});
app.delete('/api/:col/:id', async (req, res) => {
  const { col, id } = req.params; if (!COLS.includes(col)) return res.sendStatus(404);
  state.db[col] = state.db[col].filter(r => r.id !== id); await save(); res.json({ rev: state.rev });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

module.exports = app;
if (require.main === module) {
  init().then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`Process Safety Tracker running on port ${PORT}${PW ? ' (password protected)' : ' (no password set: set APP_PASSWORD)'}`));
  }).catch(e => { console.error('startup failed:', e.message); process.exit(1); });
}
