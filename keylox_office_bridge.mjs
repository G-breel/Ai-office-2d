#!/usr/bin/env node
/**
 * Keylox Office Bridge
 * ====================
 * Nyambungin aktivitas OpenCode BENERAN ke kantor pixel (keylox_office.html).
 *
 * Idenya: 1 sesi OpenCode = 1 karakter.
 *  - Sesinya lagi kerja (ada tool jalan / masih streaming) -> karakter jalan ke meja & kerja
 *  - Sesinya diem (kelar, gak ada aktivitas)                -> karakter istirahat di lounge
 *  - Diem kelamaan (default > 30 menit)                      -> karakter keluar kantor (pulang)
 *
 * Sumber data: DB OpenCode (SQLite, read-only via node:sqlite).
 *   session_v2        -> daftar sesi + kapan terakhir update / kapan idle
 *   session_message   -> isi pesan assistant (agent, model, content[].type='tool'|'reasoning'|...)
 *
 * Pemakaian:
 *   node keylox_office_bridge.mjs                       # jalan di http://127.0.0.1:4399
 *   node keylox_office_bridge.mjs --port 5000
 *   node keylox_office_bridge.mjs --fake                # mode demo (buat tes UI tanpa aktivitas nyata)
 *   node keylox_office_bridge.mjs --open                # sekalian buka browser
 *
 * Endpoint:
 *   GET /         -> halaman kantornya
 *   GET /state    -> JSON { now, mode, sessions[], stats{} }   (di-refresh tiap poll)
 *   GET /events   -> SSE, kirim state tiap ada perubahan
 *   GET /health   -> { ok, db, poll, uptimeMs }
 *
 * Catatan: bridge ini CUMA BACA database (query_only), gak nulis apapun ke OpenCode.
 */
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = join(HERE, 'keylox_office.html');

/* ------------------------------------------------------------------ */
/* Args                                                                */
/* ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
const has = (name) => argv.includes('--' + name);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : def;
};

const PORT = Number(arg('port', process.env.KEYLOX_OFFICE_PORT || 4399));
const POLL_MS = Number(arg('poll', 1000));
const REST_AFTER_MS = Number(arg('rest-after', 6000));      // diem > 6s = istirahat
const AWAY_AFTER_MS = Number(arg('away-after', 30 * 60_000)); // diem > 30 mnt = pulang
const STREAM_MAX_MS = Number(arg('stream-max', 25_000));    // pesan belum 'completed' tapi udah lama = sesi mati
const TOOL_MAX_MS = Number(arg('tool-max', 10 * 60_000));   // tool 'running' kelamaan (build panjang) = masih dihitung kerja
const MAX_SESSIONS = Number(arg('max', 8));
const PROJECT_FILTER = String(arg('project', '')).toLowerCase();
const DB_OVERRIDE = arg('db', '');
const FAKE = has('fake');
const OPEN = has('open') || has('open-browser');
const QUIET = has('quiet');

/* ------------------------------------------------------------------ */
/* Util                                                                */
/* ------------------------------------------------------------------ */
const log = (...a) => { if (!QUIET) console.log(new Date().toLocaleTimeString('id-ID'), ...a); };
const short = (s, n) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim().slice(0, n));
const baseName = (p) => (p ? basename(String(p).replace(/[\\/]+$/, '')) : '');
function hostOf(url) { try { return new URL(url).host; } catch { return short(url, 24); } }

/* ------------------------------------------------------------------ */
/* Baca DB OpenCode                                                    */
/* ------------------------------------------------------------------ */
function resolveDb() {
  const cands = [
    DB_OVERRIDE,
    process.env.OPENCODE_DB,
    process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db') : '',
    join(homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db') : '',
    process.env.APPDATA ? join(process.env.APPDATA, 'opencode', 'opencode.db') : ''
  ].filter(Boolean);
  return cands.find((p) => existsSync(p));
}

let db = null;
let dbPath = null;
let q = null; // prepared statements

function openDb() {
  dbPath = resolveDb();
  if (!dbPath) throw new Error('DB OpenCode gak ketemu. Pakai --db <path> atau set OPENCODE_DB.');
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
  } catch {
    // fallback: buka normal, tapi pastikan cuma query (gak nulis)
    db = new DatabaseSync(dbPath, { timeout: 2000 });
    db.exec('PRAGMA query_only = 1');
  }
  try { db.exec('PRAGMA busy_timeout = 2000'); } catch {}
  q = {
    sessions: db.prepare(`
      SELECT s.id, s.title, s.time_created, s.time_updated, s.time_idle, s.time_archived, s.parent_id,
             p.name AS project_name, p.worktree AS project_dir
      FROM session_v2 s
      LEFT JOIN project p ON p.id = s.project_id
      WHERE s.time_archived IS NULL
      ORDER BY s.time_updated DESC
      LIMIT 16
    `)
  };
  return dbPath;
}

/** Ambil pesan assistant terbaru per sesi (dibaca sekali per poll). */
function latestAssistantMessages(sessionIds) {
  const out = new Map();
  if (!sessionIds.length) return out;
  const ph = sessionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT session_id, id, type, seq, time_updated, data
    FROM session_message
    WHERE type = 'assistant' AND session_id IN (${ph})
    ORDER BY time_updated DESC
    LIMIT 150
  `).all(...sessionIds);
  for (const r of rows) {
    if (!out.has(r.session_id)) out.set(r.session_id, r);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Terjemahin aktivitas jadi "task" yang kebaca manusia                 */
/* ------------------------------------------------------------------ */
function describeTool(name, input) {
  input = input || {};
  const cmd = String(input.command || '');
  switch (name) {
    case 'shell': case 'bash': return 'bash: ' + short(cmd, 44);
    case 'edit': case 'write': return name + ': ' + baseName(input.filePath || input.path);
    case 'read': return 'baca: ' + baseName(input.filePath || input.path);
    case 'glob': return 'cari file: ' + short(input.pattern, 34);
    case 'grep': return 'grep: ' + short(input.pattern, 34);
    case 'webfetch': return 'fetch: ' + hostOf(input.url);
    case 'websearch': return 'search: ' + short(input.query, 34);
    case 'task': return 'sub-agent: ' + short(input.description || input.prompt, 30);
    case 'skill': return 'skill: ' + short(input.id || input.skill, 24);
    case 'todowrite': return 'update todo';
    case 'question': return 'nanya user';
    case 'apply_patch': return 'patch: ' + baseName(input.filePath || input.path);
    default: return name + (input.description ? ': ' + short(input.description, 30) : '');
  }
}

/** Ringkas 1 baris session_message jadi { busy, task, kind } */
function summarize(messageRow, now, session) {
  const empty = { busy: false, toolRunning: false, task: null, kind: 'diem', lastAt: null };
  if (!messageRow) return empty;
  let data;
  try { data = JSON.parse(messageRow.data); } catch { return empty; }

  const content = Array.isArray(data.content) ? data.content : [];
  const last = content[content.length - 1];
  const lastAt = (data.time && (data.time.streamed || data.time.completed)) || messageRow.time_updated;
  const staleMs = Math.max(0, now - lastAt);
  const streaming = !(data.time && data.time.completed);

  // Kalau sesi udah ditandai idle SETELAH aktivitas terakhir, jangan percaya
  // pesan/tool yang kelihatan "masih jalan" — itu sisa sesi yang mati di tengah.
  const idleAfterActivity = !!(session && session.time_idle && session.time_idle > lastAt);

  // tool yang masih jalan?
  let runningTool = null;
  for (let i = content.length - 1; i >= 0; i--) {
    const c = content[i];
    if (c && c.type === 'tool') {
      const st = c.state && c.state.status;
      if (st === 'running' || st === 'pending') runningTool = c;
      break;
    }
  }

  // file terakhir yang diedit (buat deteksi konflik antar sesi)
  let currentFile = null;
  for (let i = content.length - 1; i >= 0; i--) {
    const c = content[i];
    if (c && c.type === 'tool') {
      const inp = c.state && c.state.input;
      const fp = inp && (inp.filePath || inp.path || inp.file);
      if (fp) { currentFile = String(fp); break; }
    }
  }

  let task = null, kind = 'diem';
  if (runningTool) {
    task = describeTool(runningTool.name, runningTool.state && runningTool.state.input);
    kind = 'tool';
  } else if (last && last.type === 'reasoning') {
    task = 'mikir…'; kind = 'thinking';
  } else if (last && last.type === 'text') {
    task = 'nulis jawaban…'; kind = 'writing';
  } else if (streaming) {
    task = 'kerja…'; kind = 'streaming';
  } else if (last && last.type === 'tool') {
    task = short(describeTool(last.name, last.state && last.state.input), 40);
    kind = 'idle-tool';
  }

  const toolRunning = !!runningTool && !idleAfterActivity && staleMs < TOOL_MAX_MS;
  const busy = !idleAfterActivity && (toolRunning || (streaming && staleMs < STREAM_MAX_MS));
  return {
    busy,
    toolRunning,
    task,
    kind,
    lastAt,
    agent: data.agent || null,
    model: data.model && data.model.id ? data.model.id : null,
    tokens: data.tokens || null,
    cost: typeof data.cost === 'number' ? data.cost : null,
    currentFile,
    lastTool: last && last.type === 'tool' ? last.name : null,
    lastToolStatus: last && last.type === 'tool' && last.state ? last.state.status : null
  };
}

/* ------------------------------------------------------------------ */
/* State builder                                                       */
/* ------------------------------------------------------------------ */
const memo = new Map(); // session_id -> riwayat buat smoothing + counter
const stats = { stepsCompleted: 0, startedAt: Date.now(), collab: 0, conflicts: 0 };

function buildState() {
  const now = Date.now();
  const raw = FAKE ? fakeSessions(now) : readReal(now);

  // urutin: yang kerja dulu, terus paling baru
  const sessions = raw
    .filter((s) => PROJECT_FILTER ? String(s.projectDir || '').toLowerCase().includes(PROJECT_FILTER) : true)
    .sort((a, b) => (b.state === 'working') - (a.state === 'working') || b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);

  const working = sessions.filter((s) => s.state === 'working').length;
  const resting = sessions.filter((s) => s.state === 'resting').length;
  const away = sessions.filter((s) => s.state === 'away').length;
  const collab = sessions.filter((s) => s.collab).length;
  const conflict = sessions.filter((s) => s.conflict).length;

  return {
    now,
    source: FAKE ? 'fake' : 'live',
    db: dbPath,
    pollMs: POLL_MS,
    thresholds: { restAfterMs: REST_AFTER_MS, awayAfterMs: AWAY_AFTER_MS },
    stats: { ...stats, sessions: sessions.length, working, resting, away, collab, conflict },
    sessions
  };
}

function readReal(now) {
  const out = [];
  const rows = q.sessions.all();
  const msgs = latestAssistantMessages(rows.map((r) => r.id));

  for (const s of rows) {
    const m = summarize(msgs.get(s.id), now, s);
    const base = memo.get(s.id) || {};

    if (m.busy) {
      base.lastBusy = now;
      if (!base.busySince) base.busySince = now;
    } else {
      base.busySince = 0;
    }
    // hitung "step" yang kelar (tool jalan -> berhenti jalan)
    if (base.prevToolRunning === true && m.toolRunning === false) stats.stepsCompleted++;
    base.prevToolRunning = m.toolRunning;
    if (m.task) base.lastTask = m.task;
    memo.set(s.id, base);

    const sinceBusy = now - (base.lastBusy || m.lastAt || s.time_updated);
    let state = 'resting';
    if (m.busy || sinceBusy < REST_AFTER_MS) state = 'working';
    else if (sinceBusy > AWAY_AFTER_MS) state = 'away';

    out.push({
      id: s.id,
      agent: m.agent || (s.title || 'agent'),
      name: prettifyAgent(m.agent || s.title || 'agent'),
      title: short(s.title || '(tanpa judul)', 60),
      project: s.project_name || baseName(s.project_dir || ''),
      projectDir: s.project_dir || '',
      model: m.model,
      state,
      task: m.busy ? (m.task || 'kerja…') : (state === 'resting' ? null : base.lastTask || null),
      lastTask: base.lastTask || null,
      kind: m.kind,
      busyMs: base.busySince ? now - base.busySince : 0,
      quietMs: Math.max(0, Math.round(sinceBusy)),
      updatedAt: s.time_updated,
      idleAt: s.time_idle || null,
      parent: s.parent_id || null,
      cost: m.cost,
      tokens: m.tokens,
      currentFile: m.currentFile || null
    });
  }

  // deteksi kolaborasi & konflik antar sesi yang lagi kerja
  const working = out.filter((s) => s.state === 'working');
  const byProject = {};
  working.forEach((s) => {
    if (!byProject[s.project]) byProject[s.project] = [];
    byProject[s.project].push(s);
  });
  const byFile = {};
  working.forEach((s) => {
    if (s.currentFile) {
      if (!byFile[s.currentFile]) byFile[s.currentFile] = [];
      byFile[s.currentFile].push(s);
    }
  });
  let collabCount = 0, conflictCount = 0;
  working.forEach((s) => {
    const peers = (byProject[s.project] || []).filter((p) => p.id !== s.id);
    s.collab = peers.length >= 1;
    s.collabWith = peers.map((p) => p.id);
    if (s.collab) collabCount++;
    if (s.currentFile && (byFile[s.currentFile] || []).length >= 2) {
      s.conflict = true;
      s.conflictWith = (byFile[s.currentFile] || []).filter((p) => p.id !== s.id).map((p) => p.id);
      conflictCount++;
    } else {
      s.conflict = false;
      s.conflictWith = [];
    }
  });
  // sesi yang gak kerja gak punya collab/conflict
  out.forEach((s) => {
    if (s.state !== 'working') { s.collab = false; s.collabWith = []; s.conflict = false; s.conflictWith = []; }
  });
  stats.collab = collabCount;
  stats.conflicts = conflictCount;
  return out;
}

function prettifyAgent(a) {
  const s = String(a || 'agent').replace(/[-_]+/g, ' ').trim();
  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/* ------------------------------------------------------------------ */
/* Mode fake: buat ngetes UI tanpa aktivitas nyata                      */
/* ------------------------------------------------------------------ */
const FAKE_DEFS = [
  { id: 'fake-1', agent: 'build', title: 'Kerjain web Keylox', project: 'keylox' },
  { id: 'fake-2', agent: 'senior-developer', title: 'Refactor timeline', project: 'keylox' },
  { id: 'fake-3', agent: 'code-reviewer', title: 'Review PR #12', project: 'keylox' },
  { id: 'fake-4', agent: 'data-engineer', title: 'Pipeline export', project: 'keylox' },
  { id: 'fake-5', agent: 'technical-writer', title: 'Nulis docs', project: 'keylox' }
];
const FAKE_TOOLS = [
  ['edit', { filePath: 'C:/apk/laragon/www/keylox/keylox_desktop/src/renderer/App.tsx' }],
  ['shell', { command: 'npm run build:renderer 2>&1 | Select-Object -Last 20' }],
  ['read', { filePath: 'C:/apk/laragon/www/keylox/keylox_office.html' }],
  ['grep', { pattern: 'session_v2|session_message' }],
  ['write', { filePath: 'C:/apk/laragon/www/keylox/keylox/docs/superapp/10-roadmap.md' }],
  ['glob', { pattern: '**/*.mjs' }],
  ['webfetch', { url: 'https://opencode.ai/v2/docs/build/plugins' }],
  ['task', { description: 'scan semua komponen React' }]
];
function fakeSessions(now) {
  return FAKE_DEFS.map((d, i) => {
    const period = 26000, phase = i * 5200;
    const t = ((now + phase) % period);
    const working = t < 15000;
    const tool = FAKE_TOOLS[Math.floor(((now + phase) / 4000) % FAKE_TOOLS.length)];
    const quietMs = working ? t % 1500 : t - 15000;
    const state = working ? 'working' : (quietMs > 8 * 60_000 ? 'away' : 'resting');
    return {
      id: d.id, agent: d.agent, name: prettifyAgent(d.agent), title: d.title, project: d.project,
      projectDir: 'fake', model: 'deepseek-v4.1-flash-free',
      state,
      task: working ? describeTool(tool[0], tool[1]) : null,
      lastTask: describeTool(tool[0], tool[1]),
      kind: working ? 'tool' : 'diem',
      quietMs: Math.round(quietMs),
      updatedAt: now - quietMs,
      cost: 0.01 * i, tokens: null, parent: null,
      currentFile: working ? (tool[1].filePath || null) : null,
      collab: working && i < 2,
      collabWith: working && i < 2 ? [FAKE_DEFS[i === 0 ? 1 : 0].id] : [],
      conflict: working && i === 0,
      conflictWith: working && i === 0 ? [FAKE_DEFS[1].id] : []
    };
  });
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */
let current = null;
let lastJson = '';
const sseClients = new Set();

function pageHtml() {
  return readFileSync(PAGE_PATH);
}

function refresh() {
  try {
    current = buildState();
  } catch (err) {
    current = { now: Date.now(), source: FAKE ? 'fake' : 'live', error: String(err && err.message || err), sessions: [], stats: { sessions: 0, working: 0, resting: 0, away: 0, collab: 0, conflict: 0, stepsCompleted: stats.stepsCompleted } };
  }
  const json = JSON.stringify(current);
  if (json !== lastJson) {
    lastJson = json;
    for (const res of sseClients) { try { res.write(`data: ${json}\n\n`); } catch {} }
    const busy = current.sessions.filter((s) => s.state === 'working');
    log(`sesi ${current.sessions.length} | kerja ${busy.length} | istirahat ${current.stats.resting} | pulang ${current.stats.away}`
      + (busy.length ? '  →  ' + busy.map((s) => s.name + ': ' + (s.task || '')).join(' | ') : ''));
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (url === '/' || url === '/index.html' || url === '/office') {
    let html;
    try { html = pageHtml(); } catch (e) { res.writeHead(500, CORS); return res.end('keylox_office.html gak kebaca: ' + e.message); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
    return res.end(html);
  }

  if (url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
    return res.end(JSON.stringify(current || buildState()));
  }

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      ...CORS
    });
    res.write(`data: ${JSON.stringify(current || buildState())}\n\n`);
    sseClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ ok: true, mode: FAKE ? 'fake' : 'live', db: dbPath, pollMs: POLL_MS, uptimeMs: Date.now() - stats.startedAt, clients: sseClients.size }));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS });
  res.end('404 — coba / , /state , /events , /health');
});

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
function main() {
  if (!FAKE) {
    try {
      openDb();
      log('DB OpenCode:', dbPath);
    } catch (err) {
      console.error('\n[bridge] Gagal buka DB:', err.message);
      console.error('         Jalanin pakai --fake kalau cuma mau tes tampilan.\n');
      process.exit(1);
    }
  }
  refresh();
  setInterval(refresh, POLL_MS).unref?.();

  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/`;
    log(`Keylox Office Bridge nyala → ${url}  (mode ${FAKE ? 'FAKE/demo' : 'LIVE'})`);
    log('Ctrl+C buat stop.  Halaman juga bisa dibuka langsung dari file (auto nyambung ke port ini).');
    if (OPEN) {
      try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); } catch {}
    }
  });
}

main();
