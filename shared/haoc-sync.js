// 하커 두 PC 공유 상태 (2026-09-23)
//   작성기·sync-posted 맨 위에서 require하면, sync.config.json의 files에 적힌 파일(_used_log.json 등)을
//   fs.readFileSync / fs.writeFileSync 할 때 로컬 대신 Supabase(두 PC 공용)를 읽고 쓴다. 엔진 코드는 그대로.
//   - 읽기: Supabase 최신값(1.5초 캐시). 받은 값은 로컬 파일에도 그대로 복사(백업·오프라인용).
//   - 쓰기: 로컬에 먼저 쓰고 Supabase에 _rev 낙관적 잠금으로 반영. 다른 PC가 그 사이 바꿨으면 3방향 병합(JSON) 후 재시도.
//   - 인터넷이 끊기면 로컬 파일로 계속 동작하고, 못 올린 변경은 .pending/에 남겼다가 다음 연결 때 병합해 올린다.
//   - 플랫폼 작업 잠금(lock/withLock): 두 PC가 같은 플랫폼 생성·게시를 동시에 돌리지 못하게 한다.
//   - 오늘 생성 기록(markDone/doneByOther): 다른 PC가 오늘 이미 만든 블로그·슬롯은 건너뛴다.
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const CFG_FILE = path.join(__dirname, 'sync.config.json');
const REMOTE = path.join(__dirname, 'haoc-sync-remote.js');
const PENDING_DIR = path.join(__dirname, '.pending');
const STATE_DIR = path.join(__dirname, 'state');
const origRead = fs.readFileSync;
const origWrite = fs.writeFileSync;

let cfg = {};
try { cfg = JSON.parse(origRead(CFG_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch { cfg = { enabled: false }; }
const ENABLED = cfg.enabled !== false && !!cfg.supabaseUrl && process.env.HAOC_SYNC !== 'off';
const CACHE_MS = cfg.cacheMs || 1500;
const HOST = os.hostname();
const MACHINE = (() => {
  const f = path.join(__dirname, '.machine-id');
  try { const s = origRead(f, 'utf8').trim(); if (s) return s; } catch {}
  const id = HOST + '-' + Math.random().toString(36).slice(2, 8);
  try { origWrite(f, id, 'utf8'); } catch {}
  return id;
})();

function warn(msg) { try { console.error('[공유] ' + msg); } catch {} }
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

// ── 경로 매칭 (정션 E:\haoc-* → E:\haoc\haoc-* 를 같은 파일로 본다) ──
const realDirCache = new Map();
function norm(p) {
  if (typeof p !== 'string') return null;
  const abs = path.resolve(p);
  const dir = path.dirname(abs);
  let rd = realDirCache.get(dir);
  if (rd === undefined) { try { rd = fs.realpathSync.native(dir); } catch { rd = dir; } realDirCache.set(dir, rd); }
  return path.join(rd, path.basename(abs)).toLowerCase();
}
const MAP = new Map();
function register(p, key, cacheMs) { const n = norm(p); if (n) MAP.set(n, { key, path: p, cacheMs }); }
if (ENABLED) {
  for (const f of cfg.files || []) register(f.path, f.key, f.cacheMs);
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
}
function match(p) { if (!ENABLED || typeof p !== 'string' || !MAP.size) return null; return MAP.get(norm(p)) || null; }

// ── Supabase 동기 호출(자식 프로세스) ──
function remote(op, key, payload) {
  const out = cp.execFileSync(process.execPath, [REMOTE, op, key], {
    input: JSON.stringify(payload || {}), timeout: (cfg.timeoutMs || 10000) + 8000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  const r = JSON.parse(String(out));
  if (!r.ok) throw new Error(r.error || 'remote error');
  return r;
}
function wrap(rev, text) { return { _rev: rev, text, host: HOST, machine: MACHINE, at: new Date().toISOString() }; }

// ── 3방향 JSON 병합: 내가 바꾼 부분만 상대 최신값에 얹는다 ──
const J = x => JSON.stringify(x);
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
function merge3(b, o, t) {
  if (J(o) === J(b)) return t;
  if (J(t) === J(b) || J(o) === J(t)) return o;
  if (isObj(o) && isObj(t)) {
    const B = isObj(b) ? b : {};
    const r = {};
    for (const k of new Set([...Object.keys(B), ...Object.keys(o), ...Object.keys(t)])) {
      const inB = k in B, inO = k in o, inT = k in t;
      if (inB && !inO && J(t[k]) === J(B[k])) continue;   // 내가 지움
      if (inB && !inT && J(o[k]) === J(B[k])) continue;   // 상대가 지움
      const v = !inO ? t[k] : !inT ? o[k] : merge3(B[k], o[k], t[k]);
      if (v !== undefined) r[k] = v;
    }
    return r;
  }
  if (Array.isArray(o) && Array.isArray(t)) {
    const bs = new Set((Array.isArray(b) ? b : []).map(J));
    const os_ = new Set(o.map(J));
    const removed = new Set([...bs].filter(x => !os_.has(x)));
    const seen = new Set(), out = [];
    for (const x of t) { const k = J(x); if (removed.has(k) || seen.has(k)) continue; seen.add(k); out.push(x); }
    for (const x of o) { const k = J(x); if (bs.has(k) || seen.has(k)) continue; seen.add(k); out.push(x); }
    if (out.every(x => typeof x === 'number')) out.sort((x, y) => x - y);
    return out;
  }
  return o; // 같은 값을 둘 다 바꿨으면 내 값
}
function mergeText(baseText, oursText, theirsText) {
  if (theirsText == null) return oursText;
  try {
    const b = baseText != null ? JSON.parse(String(baseText).replace(/^\uFEFF/, '')) : undefined;
    const o = JSON.parse(String(oursText).replace(/^\uFEFF/, ''));
    const t = JSON.parse(String(theirsText).replace(/^\uFEFF/, ''));
    const m = merge3(b, o, t);
    return J(m) === J(o) ? oursText : JSON.stringify(m, null, 2);
  } catch { return oursText; }
}

// 화면 표시용 읽기는 30초 캐시로(질문 선점 같은 실제 작업은 1.5초) — relaxed(fn)
let RELAX = 0;
function relaxed(fn) { const old = RELAX; RELAX = 30000; try { return fn(); } finally { RELAX = old; } }

// ── 키별 상태 ──
const S = {};  // key → { rev, text(원격 기준), at }
function st(key) { return S[key] || (S[key] = { rev: null, text: null, at: 0 }); }
function pendingFile(key) { return path.join(PENDING_DIR, key + '.json'); }
function savePending(key, base, text) {
  try {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    let old = null; try { old = JSON.parse(origRead(pendingFile(key), 'utf8')); } catch {}
    origWrite(pendingFile(key), JSON.stringify({ base: old ? old.base : base, text, at: new Date().toISOString() }), 'utf8');
  } catch {}
}

// Supabase에 text를 올린다(충돌 시 병합). 최종으로 올라간 text를 돌려준다.
function push(m, text, baseGuess) {
  const s = st(m.key);
  for (let i = 0; i < 8; i++) {
    if (s.rev == null) {
      const cur = remote('get', m.key).v;
      if (!cur) {
        if (remote('insert', m.key, { v: wrap(1, text) }).applied) { Object.assign(s, { rev: 1, text, at: Date.now() }); return text; }
        continue;
      }
      text = mergeText(baseGuess, text, cur.text);
      Object.assign(s, { rev: cur._rev, text: cur.text });
    }
    const next = (parseInt(s.rev, 10) || 0) + 1;
    if (remote('cas', m.key, { rev: s.rev, v: wrap(next, text) }).applied) { Object.assign(s, { rev: next, text, at: Date.now() }); return text; }
    const cur = remote('get', m.key).v;   // 다른 PC가 먼저 바꿈 → 병합 후 재시도
    if (!cur) { s.rev = null; continue; }
    text = mergeText(s.text, text, cur.text);
    Object.assign(s, { rev: cur._rev, text: cur.text });
  }
  throw new Error('충돌 재시도 초과: ' + m.key);
}

// Supabase 최신 text(없으면 로컬로 씨앗 심기). 통신 실패면 null.
function pull(m) {
  const s = st(m.key);
  if (Date.now() - s.at < Math.max(m.cacheMs || CACHE_MS, RELAX)) { if (s.text != null) return s.text; if (s.missing) return null; }
  let cur;
  try { cur = remote('get', m.key).v; }
  catch (e) { warn(`${m.key} 읽기 실패 → 로컬 파일 사용 (${String(e.message).slice(0, 80)})`); return null; }
  if (!cur) {
    let local = null; try { local = origRead(m.path, 'utf8'); } catch {}
    if (local == null) { Object.assign(s, { missing: true, at: Date.now() }); return null; }
    try { push(Object.assign({}, m), local, null); } catch (e) { warn(`${m.key} 첫 업로드 실패: ${e.message}`); return null; }
    return st(m.key).text;
  }
  Object.assign(s, { rev: cur._rev, text: cur.text, at: Date.now(), missing: false });
  // 오프라인 동안 못 올린 변경 반영
  let pend = null; try { pend = JSON.parse(origRead(pendingFile(m.key), 'utf8')); } catch {}
  if (pend) {
    try { push(m, mergeText(pend.base, pend.text, cur.text), pend.base); fs.unlinkSync(pendingFile(m.key)); warn(`${m.key} 오프라인 변경 반영 완료`); }
    catch (e) { warn(`${m.key} 오프라인 변경 반영 실패: ${e.message}`); }
  }
  try { if (origRead(m.path, 'utf8') !== s.text) origWrite(m.path, s.text, 'utf8'); } catch { try { origWrite(m.path, s.text, 'utf8'); } catch {} }
  return s.text;
}

if (ENABLED) {
  fs.readFileSync = function (p, options) {
    const m = match(p);
    if (!m) return origRead.apply(fs, arguments);
    const text = pull(m);
    if (text == null) return origRead.apply(fs, arguments);
    const enc = typeof options === 'string' ? options : options && options.encoding;
    return enc ? text : Buffer.from(text, 'utf8');
  };
  fs.writeFileSync = function (p, data, options) {
    const m = match(p);
    if (!m) return origWrite.apply(fs, arguments);
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let prev = null; try { prev = origRead(p, 'utf8'); } catch {}
    const r = origWrite.apply(fs, arguments);
    try {
      const final = push(m, text, prev);
      if (final !== text) origWrite(p, final, 'utf8');
    } catch (e) {
      warn(`${m.key} 올리기 실패 → 로컬에만 저장, 다음 연결 때 반영 (${String(e.message).slice(0, 80)})`);
      savePending(m.key, st(m.key).text != null ? st(m.key).text : prev, text);
    }
    return r;
  };
}

// ── 오늘 생성 기록 (다른 PC가 오늘 이미 만든 블로그/슬롯) ──
function doneFile(platform) {
  const p = path.join(STATE_DIR, 'gen_done_' + platform + '.json');
  if (ENABLED && !match(p)) register(p, 'gen_done_' + platform);
  return p;
}
function readDone(platform) {
  let d = {}; try { d = JSON.parse(fs.readFileSync(doneFile(platform), 'utf8')); } catch {}
  if (d.date !== today()) d = { date: today(), items: [] };
  if (!Array.isArray(d.items)) d.items = [];
  return d;
}
function markDone(platform, id) {
  if (!ENABLED) return;
  try {
    const d = readDone(platform);
    d.items = d.items.filter(x => !(x.id === String(id) && x.machine === MACHINE));
    d.items.push({ id: String(id), machine: MACHINE, host: HOST, at: new Date().toISOString() });
    fs.writeFileSync(doneFile(platform), JSON.stringify(d, null, 2), 'utf8');
  } catch (e) { warn('생성 기록 실패: ' + e.message); }
}
// → Map(id → 다른 PC 이름)
function doneByOther(platform) {
  const m = new Map();
  if (!ENABLED) return m;
  try { for (const x of readDone(platform).items) if (x.machine !== MACHINE) m.set(String(x.id), x.host || x.machine); } catch {}
  return m;
}

// ── 플랫폼 작업 잠금 (비동기) ──
const LOCK_TTL = cfg.lockTtlMs || 15 * 60 * 1000;
const held = new Map(); // name → timer
async function lock(name, label) {
  if (!ENABLED) return { ok: true };
  const R = require(REMOTE);
  const key = 'lock_' + name;
  const mine = () => ({ owner: MACHINE, host: HOST, label: label || '', until: Date.now() + LOCK_TTL });
  let got = false;
  for (let i = 0; i < 5 && !got; i++) {
    let cur;
    try { cur = await R.get(key); } catch (e) { warn('잠금 확인 실패(로컬로 진행): ' + e.message); return { ok: true, offline: true }; }
    if (!cur) { got = await R.insert(key, { _rev: 1, ...mine() }); continue; }
    if (cur.owner && cur.owner !== MACHINE && cur.until > Date.now()) return { ok: false, by: cur.host || cur.owner, label: cur.label, until: cur.until };
    got = await R.cas(key, cur._rev, { _rev: (cur._rev || 0) + 1, ...mine() });
  }
  if (!got) return { ok: false, by: '?', label: '잠금 경합', until: Date.now() };
  if (!held.has(name)) {
    const t = setInterval(async () => {   // 작업이 길어도 잠금 유지
      try { const c = await R.get(key); if (c && c.owner === MACHINE) await R.cas(key, c._rev, { ...c, _rev: c._rev + 1, until: Date.now() + LOCK_TTL }); } catch {}
    }, Math.min(3 * 60 * 1000, LOCK_TTL / 3));
    t.unref && t.unref();
    held.set(name, t);
  }
  return { ok: true };
}
async function unlock(name) {
  if (!ENABLED) return;
  const t = held.get(name); if (t) clearInterval(t); held.delete(name);
  try {
    const R = require(REMOTE);
    const c = await R.get('lock_' + name);
    if (c && c.owner === MACHINE) await R.cas('lock_' + name, c._rev, { _rev: c._rev + 1, owner: null, host: '', label: '', until: 0 });
  } catch (e) { warn('잠금 해제 실패(15분 뒤 자동 만료): ' + e.message); }
}
// fn을 잠금 안에서 실행. 다른 PC가 쓰는 중이면 log로 알리고 건너뜀.
async function withLock(name, label, fn, log) {
  const r = await lock(name, label);
  if (!r.ok) {
    const until = new Date(r.until).toTimeString().slice(0, 5);
    (log || warn)(`⛔ 다른 PC(${r.by})가 '${r.label}' 작업 중이라 건너뜀 — 끝난 뒤 다시 누르세요 (잠금 만료 ${until})`);
    return null;
  }
  try { return await fn(); } finally { await unlock(name); }
}

module.exports = { relaxed, enabled: ENABLED, machine: MACHINE, host: HOST, markDone, doneByOther, lock, unlock, withLock, merge3, mergeText };
