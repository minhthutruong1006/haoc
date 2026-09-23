// writer.js — HomepageWriter: 하오커뮤니케이션(하커) 홈페이지 칼럼(haoc.co.kr) 자동 작성+게시 (로컬 웹앱)
// 실행: node writer.js               → http://127.0.0.1:5045 (UI)
// ★원고는 순수 텍스트 .txt(첫 줄 #META JSON) — 게시는 poster_hp.js가 admin.html 칼럼 폼에 입력
//       node writer.js --batch am    → 오전 슬롯 생성+게시(공개)
//       node writer.js --batch pm     → 오후 슬롯 생성+게시(공개)
//       node writer.js --batch all    → 오늘 2슬롯 생성+게시
//       node writer.js --batch gen     → 생성만(게시 안 함)
const http = require('http');
const fs = require('fs');
const path = require('path');
const E = require('./engine');

// ★두 PC 공유(2026-09-23): 사용기록(_used_log 등)은 ../shared/haoc-sync.js가 Supabase로 공유하고,
//   같은 플랫폼 작업(생성·게시·다시쓰기)은 두 PC가 동시에 못 돌린다. 다른 PC가 오늘 이미 만든 슬롯은 건너뜀.
const PLATFORM = 'homepage';
let SYNC = null; try { SYNC = require('../shared/haoc-sync'); } catch (e) { console.error('[공유] haoc-sync 없음 → 이 PC 로컬 기록만 사용: ' + e.message); }
let _oth = { t: 0, m: new Map() };
function OTHER(maxAge = 30000) { if (SYNC && Date.now() - _oth.t > maxAge) _oth = { t: Date.now(), m: SYNC.doneByOther(PLATFORM) }; return _oth.m; }
const HP = require('./poster_hp');

const UI = path.join(__dirname, 'writer-ui.html');
const JOB = { running: false, kind: '', logs: [], results: [] };
// ★로그를 파일에도 남긴다 — 서버를 재시작하면 메모리 로그(JOB.logs)가 사라져 사후 추적이 불가능하기 때문.
const LOGFILE = require('path').join(__dirname, 'job.log');
function flog(m) { try { fs.appendFileSync(LOGFILE, '[' + new Date().toISOString() + '] ' + m + '\n'); } catch {} }
function jlog(m) { JOB.logs.push(`[${new Date().toTimeString().slice(0, 8)}] ${m}`); if (JOB.logs.length > 500) JOB.logs.shift(); console.log(m); flog(m); }

// ★생성 전 '발행 대조' — 3개 플랫폼 공용 sync-posted.js(E:\haoc-tistory-auto)를 실행해
//   이미 공개된 글을 postedRows(영구 제외)에 반영한다. 질문 재선택·플랫폼 간 중복 방지.
// ★질문 시트 자동 새로고침(2026-09-19 운영자 지시): 글을 쓰기 전에 항상 구글시트에서 질문 목록을 다시 받는다(실패하면 기존 목록으로 진행).
function refreshQuestions() {
  return new Promise((resolve) => {
    jlog('질문 시트 새로고침...');
    let out = '', done = false; const fin = (m) => { if (done) return; done = true; jlog('  질문 시트: ' + m); resolve(); };
    let p; try { p = require('child_process').spawn('node', ['fetch-questions.js'], { cwd: 'E:\\haoc-tistory-auto' }); } catch (e) { return fin('건너뜀(' + String(e.message).slice(0, 40) + ')'); }
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', () => {});
    p.on('close', () => fin(/저장:/.test(out) ? '최신으로 갱신 — ' + ((out.match(/블록별 질문 수:[^\n]*/) || [''])[0]) : '갱신 확인 안 됨 — 기존 목록으로 진행'));
    p.on('error', e => fin('건너뜀(' + String(e.message).slice(0, 40) + ')'));
    setTimeout(() => { try { p.kill(); } catch (e) {} fin('시간 초과 — 기존 목록으로 진행'); }, 60000);
  });
}
function syncPosted() {
  return new Promise((resolve) => {
    jlog('발행 대조(sync-posted --apply) 실행...');
    let out = '';
    const p = require('child_process').spawn('node', ['sync-posted.js', '--apply'], { cwd: 'E:\\haoc-tistory-auto' });
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', () => {});
    p.on('close', () => { jlog('  발행 대조: ' + (/갱신 완료/.test(out) ? '완료(postedRows 반영)' : '경고 — 갱신 확인 안 됨')); resolve(); });
    p.on('error', e => { jlog('  발행 대조 건너뜀(무시): ' + e.message.slice(0, 50)); resolve(); });
  });
}

// ★미게시 원고 이월(2026-08-28) — 전날(최근 7일) 생성만 하고 [게시]를 안 누른 원고는
//   버리지 않고 오늘 폴더로 옮겨 그대로 재사용한다(게시는 '오늘 폴더만' 규칙 유지).
//   게시 여부는 그 날짜 폴더의 _posts.json(done)과 홈페이지 칼럼 목록의 실제 제목으로 이중 확인하고,
//   목록 확인이 실패하면 이월하지 않는다(중복 게시 방지가 우선).
const normT = s => String(s || '').replace(/\s+/g, ' ').trim();
async function columnTitles(site) {
  try { return (await E.homePosts(E.siteCfg(site).postsKey)).map(p => normT(p.title)); } catch { return null; }
}
async function carryOverDrafts(slots, allowed) {
  const cfg = E.loadCfg();
  const todayDir = path.join(cfg.draftsDir, E.today());
  const carried = [];
  let dates = [];
  try { dates = fs.readdirSync(cfg.draftsDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < E.today()).sort().reverse().slice(0, 7); } catch {}
  let titles;
  for (let i = 0; i < slots.length; i++) {
    if (allowed && !allowed.has(i)) continue; // 이번 편수 선택에 안 든 슬롯은 이월 보류(원고는 옛 폴더에 유지, 2026-09-05)
    const label = slots[i].label;
    titles = undefined;  // 사이트마다 발행 목록이 다르다
    const todayFiles = fs.existsSync(todayDir) ? fs.readdirSync(todayDir) : [];
    if (todayFiles.some(f => f.endsWith('.txt') && f.startsWith(label + '_'))) continue; // 오늘 원고 이미 있음
    outer:
    for (const d of dates) {
      const dir = path.join(cfg.draftsDir, d);
      let posted = {};
      try { posted = JSON.parse(fs.readFileSync(path.join(dir, '_posts.json'), 'utf8')); } catch {}
      let cand = [];
      try { cand = fs.readdirSync(dir).filter(x => x.endsWith('.txt') && x.startsWith(label + '_')).sort().reverse(); } catch {}
      for (const f of cand) {
        if (posted[f] && posted[f].done) continue; // 이 폴더에서 이미 게시됨
        const html = fs.readFileSync(path.join(dir, f), 'utf8');
        const title = normT(E.extractTitle(html));
        if (titles === undefined) titles = await columnTitles(slots[i].site);
        if (titles === null) { jlog(`  이월 보류(${label}): 칼럼 목록 확인 실패 — 중복 게시 방지 위해 건너뜀`); break outer; }
        if (!title || titles.some(t => t === title || (title.length > 10 && t.includes(title.slice(0, 20))))) continue; // 이미 게시된 원고
        fs.mkdirSync(todayDir, { recursive: true });
        fs.renameSync(path.join(dir, f), path.join(todayDir, f));
        const base = f.replace(/\.txt$/, '').split('_').slice(0, 2).join('_');
        for (const x of fs.readdirSync(dir)) {  // 원고가 참조하는 이미지·대표이미지도 같이 이동
          if (x.endsWith('.txt') || x === '_posts.json') continue;
          if (html.includes(x) || x === `${base}_thumb.jpg` || x.startsWith(base + '_')) { try { fs.renameSync(path.join(dir, x), path.join(todayDir, x)); } catch {} }
        }
        try {  // 사용내역 블록도 옮겨 UI 표시 유지
          const rep = fs.readFileSync(path.join(dir, '사용내역.txt'), 'utf8');
          const blk = rep.split('■').filter(x => title && x.includes(title.slice(0, 20))).pop();
          if (blk) fs.appendFileSync(path.join(todayDir, '사용내역.txt'), `■(${d} 이월)` + blk, 'utf8');
        } catch {}
        jlog(`[${label}] 이월: ${d}의 미게시 원고 재사용 — ${title.slice(0, 40)}`);
        carried.push({ ok: true, slot: i, slotLabel: label, topic: f.split('_')[1] || '', file: path.join(todayDir, f), fname: f, title, carried: d });
        break outer;
      }
    }
  }
  return carried;
}

// ★생성 편수 조절(2026-09-05 운영자 지시): count(1~슬롯수)를 주면 하루 총량(이월 포함)이 그 수가 되게 한다.
//   슬롯(오전/오후)은 날마다 번갈아 쓴다 — 지난번 마지막 슬롯의 다음부터 순환(_gen_rotation.json),
//   오늘 원고가 이미 있는 슬롯은 건너뛴다. 이월도 여기서 고른 슬롯에만 허용된다.
const ROT_FILE = path.join(__dirname, '_gen_rotation.json');
function slotsForCount(slots, countArg) {
  const count = parseInt(countArg, 10);
  if (!count || count >= slots.length) return null; // 제한 없음
  OTHER(0);
  let last = -1;
  try { last = parseInt(JSON.parse(fs.readFileSync(ROT_FILE, 'utf8')).last, 10); } catch {}
  if (isNaN(last)) last = -1;
  const order = slots.map((_, i) => (last + 1 + i) % slots.length);
  const dDir = path.join(E.loadCfg().draftsDir, E.today());
  const files = fs.existsSync(dDir) ? fs.readdirSync(dDir).filter(f => /^[^_]+_.+\.txt$/.test(f) && f !== '사용내역.txt') : [];
  const has = i => OTHER().has(String(slots[i].label)) || files.some(f => f.startsWith(slots[i].label + '_'));
  let sel = order.filter(i => !has(i));
  if (!sel.length) sel = order;
  sel = sel.slice(0, Math.max(1, count));
  try { fs.writeFileSync(ROT_FILE, JSON.stringify({ last: sel[sel.length - 1], at: new Date().toISOString() })); } catch {}
  jlog(`생성 편수 제한: ${count}건 → 슬롯 ${sel.map(i => slots[i].label).join(', ')} (날마다 순환)`);
  return new Set(sel);
}

// ★화면 표시용(2026-09-05): 선택한 건수만큼 '오늘의 슬롯'만 표에 보여준다(순환 저장 안 함).
//   오늘 원고 있는 슬롯 + 지금 생성 중인 대상 + 부족하면 순환 순서로 채움.
function displaySlots(slots, n) {
  const nSlots = slots.length;
  const all = Array.from({ length: nSlots }, (_, i) => i);
  n = parseInt(n, 10);
  if (!nSlots || !n || n >= nSlots) return all;
  const dDir = path.join(E.loadCfg().draftsDir, E.today());
  const files = fs.existsSync(dDir) ? fs.readdirSync(dDir).filter(f => /^[^_]+_.+\.txt$/.test(f) && f !== '사용내역.txt') : [];
  const has = i => OTHER().has(String(slots[i].label)) || files.some(f => f.startsWith(slots[i].label + '_'));
  let list = all.filter(has);
  if (JOB.running && /생성/.test(JOB.kind)) for (const t of (JOB.targetSlots || [])) if (!list.includes(t)) list.push(t);
  if (list.length < n) {
    let last = -1; try { last = parseInt(JSON.parse(fs.readFileSync(ROT_FILE, 'utf8')).last, 10); } catch {}
    if (isNaN(last)) last = -1;
    for (let i = 1; i <= nSlots && list.length < n; i++) { const s = (last + i) % nSlots; if (!list.includes(s)) list.push(s); }
  }
  return list.sort((a, b) => a - b);
}

async function jobGenerate(slotFilter, countArg) {
  await refreshQuestions();          // ★항상 최신 질문 시트로
  await syncPosted();
  const ctx = E.makeCtx(jlog);
  const slots = E.todaysSlots(E.loadCfg(), ctx.cycle, false);
  JOB.results = [];
  if (!slots.length) { jlog('오늘(일요일)은 게시 없음'); return []; }
  const allowed = slotsForCount(slots, countArg);          // ★이월 전에 오늘 몫 슬롯부터 정한다
  JOB.targetSlots = allowed ? [...allowed] : slots.map((_, i) => i);
  const carried = await carryOverDrafts(slots, allowed);   // ★생성 전에 미게시 원고부터 재사용(선택 슬롯만)
  if (carried.length) jlog(`이월 ${carried.length}건 — 해당 슬롯은 새로 생성하지 않음`);
  JOB.results = [...carried];
  for (let i = 0; i < slots.length; i++) {
    if (slotFilter != null && i !== slotFilter) continue;
    if (allowed && !allowed.has(i)) continue;
    if (carried.some(c => c.slot === i)) continue;
    if (OTHER(0).has(String(slots[i].label))) { jlog(`[슬롯${i}] 오늘 다른 PC(${OTHER().get(String(slots[i].label))})가 이미 생성 → 건너뜀`); continue; }
    try { const r = await E.generateSlot(slots[i], i, ctx); JOB.results.push(r); if (!r.ok) jlog(`[슬롯${i}] 보류: ${r.reason}`); }
    catch (e) { JOB.results.push({ ok: false, slot: i, topic: slots[i].topic, reason: e.message.slice(0, 150) }); jlog(`[슬롯${i}] 오류: ${e.message.slice(0, 100)}`); }
  }
  if (SYNC) for (const r of JOB.results) if (r.ok && r.slot != null && slots[r.slot]) SYNC.markDone(PLATFORM, slots[r.slot].label);
  jlog(`생성 완료: ${JOB.results.filter(r => r.ok).length}건`);
  return JOB.results;
}

// 오늘 폴더의 원고를 홈페이지에 게시. onlyFile/slotFilter로 범위 제한, isDisplay로 숨김 테스트.
async function jobPost({ onlyFname, isDisplay = true } = {}) {
  const cfg = E.loadCfg();
  if (isDisplay === false) { jlog('하오커뮤니케이션 관리자 칼럼은 공개/숨김 구분이 없습니다(저장=즉시 공개). 숨김 테스트는 지원하지 않아 게시를 중단합니다.'); return; }
  const dateDir = path.join(cfg.draftsDir, E.today());
  const mapFile = path.join(dateDir, '_posts.json');
  const posted = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : {};
  let files = fs.existsSync(dateDir) ? fs.readdirSync(dateDir).filter(f => /^[^_]+_.+\.txt$/.test(f) && f !== '사용내역.txt') : [];
  if (onlyFname) files = files.filter(f => f === onlyFname);
  else {
    // ★슬롯(사이트)별로 '최신 파일 1개'만 게시 — 폴더에 옛 원고가 섞여도 오게시 방지.
    const bySlot = {};
    for (const f of files) {
      const slot = f.split('_')[0]; // 오전/오후
      const mt = fs.statSync(path.join(dateDir, f)).mtimeMs;
      if (!bySlot[slot] || mt > bySlot[slot].mt) bySlot[slot] = { f, mt };
    }
    const chosen = new Set(Object.values(bySlot).map(x => x.f));
    const dropped = files.filter(f => !chosen.has(f));
    if (dropped.length) jlog(`  (건너뜀 ${dropped.length}건: 슬롯당 최신 1건만 게시)`);
    files = files.filter(f => chosen.has(f));
  }
  const posts = [];
  for (const f of files) {
    if (posted[f] && posted[f].done) { jlog(`  이미 게시됨: ${f.slice(0, 30)}`); continue; }
    const text = fs.readFileSync(path.join(dateDir, f), 'utf8');
    const meta = E.extractMeta(text) || {};
    // 대표이미지 = META.thumb(예: 오전_디자인_thumb.jpg) — 정보글은 없음
    const thumb = meta.thumb && fs.existsSync(path.join(dateDir, meta.thumb)) ? path.join(dateDir, meta.thumb) : '';
    posts.push({ fname: f, site: meta.site || f.split('_')[0], title: E.extractTitle(text), date: meta.date || E.today().replace(/-/g, '.'), summary: meta.summary || '', keywords: meta.keywords || '', slug: meta.slug || '', body: E.extractBody(text), section: meta.topic || '', thumbAbs: thumb, isDisplay });
  }
  if (!posts.length) { jlog('게시할 원고 없음'); return; }
  jlog(`게시 시작: ${posts.length}건 (관리자 칼럼 폼 입력 → 저장=공개)`);
  const res = await HP.postArticles(posts, jlog);
  res.forEach((r, i) => { if (r.ok) { posted[posts[i].fname] = { done: true, id: r.id || null, url: r.url || '', dup: !!r.dup }; } });
  fs.writeFileSync(mapFile, JSON.stringify(posted, null, 2), 'utf8');
  // CRM 게시 현황 전송(공개 게시만) — crm-notify.config.json 토큰 없으면 no-op, 실패해도 게시 흐름 무관
  try { const _crm = require('./crm-notify'); res.forEach((r, i) => { if (r.ok && !r.dup) _crm.notifyCrm({ title: posts[i].title, category: posts[i].section || '', url: r.url || '', status: 'posted', posted_at: new Date().toISOString() }).catch(() => {}); }); } catch (e) {}
  jlog('게시 완료');
}

function runJob(kind, fn) {
  if (JOB.running) return false;
  JOB.running = true; JOB.kind = kind; JOB.logs = [];
  (SYNC && !/질문 새로고침|계정 테스트/.test(kind) ? () => SYNC.withLock(PLATFORM, kind, fn, jlog) : fn)().catch(e => jlog('잡 오류: ' + e.message)).finally(() => { JOB.running = false; });
  return true;
}

function state(showCount) {
  const cfg = E.loadCfg();
  let preview = [], csvInfo = null, err = null;
  try {
    const st = fs.statSync(cfg.csvFile);
    csvInfo = { mtime: st.mtime.toISOString().replace('T', ' ').slice(0, 16) };
    preview = SYNC ? SYNC.relaxed(() => E.previewToday()) : E.previewToday();  // 화면 표시는 30초 캐시
    // ★오늘 쓴 원고가 있으면 슬롯별 제목·분류·used로 옮길 파일을 함께 보여준다
    const dDir = path.join(cfg.draftsDir, E.today());
    const files = fs.existsSync(dDir) ? fs.readdirSync(dDir).filter(f => /^[^_]+_.+\.txt$/.test(f) && f !== '사용내역.txt') : [];
    let rep = '';
    try { rep = fs.readFileSync(path.join(dDir, '사용내역.txt'), 'utf8'); } catch {}
    preview = preview.map(p => {
      const mine = files.filter(f => f.startsWith(p.slotLabel + '_')).sort((x, y) =>
        fs.statSync(path.join(dDir, y)).mtimeMs - fs.statSync(path.join(dDir, x)).mtimeMs)[0];
      // ★질문을 미리 보여주지 않는다 — 실제 생성한 원고가 있을 때만 내용 표시. 그전엔 질문·행 빈칸.
      if (!mine) return { ...p, question: '', row: null };
      const h = fs.readFileSync(path.join(dDir, mine), 'utf8');
      const title = E.extractTitle(h);
      const question = mine.replace(/\.txt$/, '').split('_').slice(2).join('_');
      let usedImgs = [];
      const blk = rep.split('■').filter(x => x.includes(title.slice(0, 20)) || x.includes(question.slice(0, 18))).pop();
      const m = blk && (blk.match(/실제 사용한 파일\([0-9]+장\):\s*([^\n(]+)/) || blk.match(/이미지 파일:\s*([^\n(]+)/));
      if (m) usedImgs = m[1].split(',').map(s => s.trim()).filter(Boolean);
      const mr = blk && blk.match(/(\d+)번째 질문/);
      const msc = blk && blk.match(/SEO\/AEO\/GEO 채점:\s*(\d+)\/20\s*\(SEO\s*(\d+)\/7\s*·\s*AEO\s*(\d+)\/7\s*·\s*GEO\s*(\d+)\/6\)/);
      const score = msc ? { total: +msc[1], seo: +msc[2], aeo: +msc[3], geo: +msc[4] } : null;
      return { ...p, title, fname: mine, section: E.extractSection(h), usedImgs, question, row: mr ? parseInt(mr[1], 10) : p.row, score };
    });
  } catch (e) { err = e.message; }
  const dateDir = path.join(cfg.draftsDir, E.today());
  const todayFiles = fs.existsSync(dateDir) ? fs.readdirSync(dateDir).filter(f => /^[^_]+_.+\.txt$/.test(f) && f !== '사용내역.txt') : [];
  const wd = ['', '월', '화', '수', '목', '금', '토', '일'][E.weekday()];
  return { claude: !!E.CLAUDE, model: cfg.model, csv: csvInfo, err, today: E.today(), weekday: wd, preview, todayFiles,
    show: displaySlots(E.todaysSlots(cfg, E.loadCycle(), false), showCount), targets: JOB.targetSlots || [],
    accounts: (() => { try { return require('./accounts').list(); } catch { return null; } })(),
    job: { running: JOB.running, kind: JOB.kind, logs: JOB.logs.slice(-200), results: JOB.results } };
}

function body(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  try {
    if (url.pathname === '/') return send(200, fs.readFileSync(UI, 'utf8'), 'text/html; charset=utf-8');
    if (url.pathname === '/api/state') return send(200, state(url.searchParams.get('count')));
    if (url.pathname === '/api/refresh-questions' && req.method === 'POST') {
      if (!runJob('질문 새로고침', () => new Promise(r => { const p = require('child_process').spawn('node', ['fetch-questions.js'], { cwd: 'E:\\haoc-tistory-auto' }); p.stdout.on('data', d => jlog(String(d).trim())); p.on('close', () => r()); }))) return send(409, { ok: false });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/generate' && req.method === 'POST') {
      const b = await body(req);
      if (!runJob('생성', () => jobGenerate(b.slot, b.count))) return send(409, { ok: false, msg: '실행 중' });
      return send(200, { ok: true });
    }
    // ★원고별 다시쓰기(2026-09-21 운영자 지시): 오늘 원고 1편을 지우지 않고 보관함으로 옮긴 뒤 그 슬롯(사이트) 글만 새로 쓴다.
    //   mode 'same' = 같은 질문으로(사진은 새로 고름) / 'new' = 새 질문으로. 게시된 글은 거부. 실패하면 옛 원고를 되돌린다.
    if (url.pathname === '/api/rewrite' && req.method === 'POST') {
      const b = await body(req);
      const cfg = E.loadCfg();
      const file = path.basename(String(b.file || ''));
      const dateDir = path.join(cfg.draftsDir, E.today());
      const f = path.join(dateDir, file);
      if (!file || !fs.existsSync(f)) return send(400, { ok: false, msg: '오늘 원고가 없습니다: ' + file });
      const mode = b.mode === 'new' ? 'new' : 'same';
      if (!runJob('다시쓰기', async () => {
        const RW = require('./rewrite-draft');
        const label = file.split('_')[0];
        const title = normT(E.extractTitle(fs.readFileSync(f, 'utf8')));
        jlog(`다시쓰기(${mode === 'new' ? '새 질문' : '같은 질문'}): ${label} — ${title.slice(0, 40)}`);
        let rec = null; try { rec = JSON.parse(fs.readFileSync(path.join(dateDir, '_posts.json'), 'utf8'))[file] || null; } catch {}
        if (rec && rec.done) throw new Error('이미 홈페이지에 게시된 글입니다 — 게시된 글은 다시쓰기 할 수 없습니다');
        if (mode === 'new') { await refreshQuestions(); await syncPosted(); }
        const ctx = E.makeCtx(jlog);
        const slots = E.todaysSlots(cfg, ctx.cycle, false);
        const idx = slots.findIndex(s => (s.label || s.site) === label);
        if (idx < 0) throw new Error('오늘 슬롯에서 이 사이트를 찾지 못했습니다: ' + label);
        const titles = await columnTitles(slots[idx].site);
        if (titles === null) throw new Error('홈페이지 칼럼 목록 확인 실패 — 게시 여부를 알 수 없어 다시쓰기를 중단합니다(잠시 후 다시)');
        if (title && titles.some(t => t === title)) throw new Error('이미 홈페이지에 게시된 글입니다 — 게시된 글은 다시쓰기 할 수 없습니다');
        JOB.targetSlots = [idx];
        const info = RW.prepare({ draftsDir: cfg.draftsDir, file, title, mode, usedLogFile: cfg.usedLog, log: jlog,
          usedKey: sk => { const t = (cfg.topics || {})[sk] || (cfg.topics || {})[slots[idx].topic]; return t ? t.no : null; } });
        let r;
        try { r = await E.generateSlot(slots[idx], idx, ctx, mode === 'same' ? { question: info.question, row: info.row } : {}); }
        catch (e) { r = { ok: false, slot: idx, topic: slots[idx].topic, reason: e.message.slice(0, 150) }; }
        JOB.results = [r];
        if (!r.ok) { jlog(`[슬롯${idx}] 보류: ${r.reason}`); RW.restore(info, jlog); return; }
        RW.finish(info, jlog);
      })) return send(409, { ok: false, msg: '실행 중' });
      return send(200, { ok: true });
    }
    // ★제목 자동 다시 짓기(2026-09-07 운영자 지시): 버튼 한 번이면 AI가 새 제목을 지어 즉시 교체.
    //   본문·사진은 그대로(제목 문자열만 전부 치환). b.title을 주면 그 제목으로 직접 교체(수동 경로).
    if (url.pathname === '/api/retitle' && req.method === 'POST') {
      const b = await body(req);
      const f = path.join(E.loadCfg().draftsDir, E.today(), path.basename(String(b.file || '')));
      if (!b.file || !fs.existsSync(f)) return send(400, { ok: false, msg: '오늘 원고가 없습니다: ' + (b.file || '') });
      const cur = String(E.extractTitle(fs.readFileSync(f, 'utf8')) || '').trim();
      if (!cur) return send(400, { ok: false, msg: '현재 제목을 찾지 못했습니다' });
      const apply = (next) => {
        next = String(next || '').trim();
        if (!next || next === cur) throw new Error('새 제목이 비어 있거나 기존과 같습니다');
        const html = fs.readFileSync(f, 'utf8');
        const n = html.split(cur).length - 1;
        if (!n) throw new Error('원고 안에서 제목 문자열을 찾지 못했습니다');
        fs.writeFileSync(f, html.split(cur).join(next), 'utf8');
        jlog(`제목 수정(${n}곳): "${cur.slice(0, 40)}" → "${next.slice(0, 40)}"`);
      };
      if (b.title) { try { apply(b.title); } catch (e) { return send(400, { ok: false, msg: e.message }); } return send(200, { ok: true }); }
      if (!runJob('제목 다시 짓기', async () => {
        const cfg = E.loadCfg();
        const question = path.basename(f).replace(/\.txt$/, '').split('_').slice(2).join('_');
        const out = await E.runClaude(
`아래 홈페이지 칼럼의 제목을 새로 짓는다. 출력은 '새 제목 한 줄'만 — 설명·따옴표·번호 금지.

[질문(글의 근거)] ${question}
[기존 제목] ${cur}

[규칙]
- 질문의 핵심을 간추려 짧고·깔끔하고·자연스럽게(소리 내어 읽어 어색하면 다시).
- SEO 노출 최우선: 기존 제목에 들어 있는 산출물/서비스 키워드(카탈로그 제작/홈페이지 제작/제품 촬영/인스타 운영 등)와 정부사업명(수출바우처/혁신바우처/판로개척지원사업 등)을 반드시 그대로 유지하고 가급적 앞쪽에 둔다.
- 기존 제목과 표현·각도가 뚜렷이 달라야 한다(단어 몇 개만 바꾸는 수준 금지).
- 금지어: '법'·'방법'(절차·방법형), 군더더기(완벽정리/총정리/노하우/가이드). '수행기관/원스톱/~하는 곳/~찾는다면' 표현은 허용.
- 같은 단어를 제목에서 두 번 쓰지 않고, 질문에 없는 업종을 붙이지 않는다. AEO·GEO도 함께 충족하되 SEO 노출이 최우선.
- 브랜드명·"| 하오커뮤니케이션" 같은 꼬리표 금지. 공백 포함 26~32자(검색결과에서 잘리지 않는 길이).`,
          { ...cfg, model: cfg.judgeModel || 'sonnet' }, jlog);
        const next = String(out || '').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop()
          .replace(/^["'\`“”\[\(]+|["'\`“”\]\)]+$/g, '').trim();
        if (!next || next.length > 60) throw new Error('AI가 제목을 제대로 내놓지 않음: ' + String(out).slice(0, 80));
        apply(next);
      })) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }

    if (url.pathname === '/api/post' && req.method === 'POST') {
      const b = await body(req);
      if (!runJob('게시', () => jobPost({ onlyFname: b.file, isDisplay: b.isDisplay !== false }))) return send(409, { ok: false, msg: '실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/generate-and-post' && req.method === 'POST') {
      const b = await body(req);
      if (!runJob('생성+게시', async () => { const rs = await jobGenerate(b.slot, b.count); if (rs.some(r => r.ok)) await jobPost({ isDisplay: b.isDisplay !== false }); }))
        return send(409, { ok: false, msg: '실행 중' });
      return send(200, { ok: true });
    }
    // ── Claude 다계정 관리(3개 프로그램 공용) ──────────────
    if (url.pathname === '/api/account/switch' && req.method === 'POST') {
      const b = await body(req);
      const ok = require('./accounts').setActive(b.name);
      jlog(`계정 전환 → [${b.name}] ${ok ? 'OK' : '실패(없는 계정)'}`);
      return send(ok ? 200 : 400, { ok, msg: ok ? '' : '없는 계정' });
    }
    if (url.pathname === '/api/account/login' && req.method === 'POST') {
      const b = await body(req);
      const ACC = require('./accounts');
      const cur = await ACC.authStatus(b.name, E.CLAUDE, true);
      if (cur.loggedIn) return send(200, { ok: true, loggedIn: true, email: cur.email, subscriptionType: cur.subscriptionType });
      const r = await ACC.loginStart(b.name, E.CLAUDE);
      jlog(`계정 [${b.name}] 연동 시작 — 로그인 URL ${r.url ? '발급' : '대기'}`);
      return send(r.ok || r.url ? 200 : 400, r);
    }
    if (url.pathname === '/api/account/code' && req.method === 'POST') {
      const b = await body(req);
      const r = await require('./accounts').loginCode(b.name, b.code, E.CLAUDE);
      if (r.loggedIn) jlog(`계정 [${b.name}] 연동 완료 — ${r.email || ''} (${r.subscriptionType || ''})`);
      return send(r.error ? 400 : 200, r);
    }
    if (url.pathname === '/api/account/logout' && req.method === 'POST') {
      const b = await body(req);
      const r = await require('./accounts').logout(b.name, E.CLAUDE, !!b.remove);
      jlog(`계정 [${b.name}] ${b.remove ? '삭제' : '로그아웃'} ${r.ok ? 'OK' : '실패'}`);
      return send(r.ok ? 200 : 400, r);
    }
    if (url.pathname === '/api/account/refresh' && req.method === 'POST') {
      const acc = await require('./accounts').refreshAll(E.CLAUDE);
      return send(200, { ok: true, accounts: acc });
    }
    if (url.pathname === '/api/account/test' && req.method === 'POST') {
      const b = await body(req);
      if (!runJob('계정 테스트(' + b.name + ')', () => require('./accounts').test(b.name, E.CLAUDE, E.loadCfg().model, jlog)))
        return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/preview') {
      const f = path.join(E.loadCfg().draftsDir, E.today(), path.basename(url.searchParams.get('f') || ''));
      if (!fs.existsSync(f)) return send(404, '없음', 'text/plain; charset=utf-8');
      const text = fs.readFileSync(f, 'utf8');
      const meta = E.extractMeta(text) || {};
      const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const paras = E.extractBody(text).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
        .map(p => /^■/.test(p) ? `<h2 style="font-size:20px;margin:28px 0 8px;color:#111">${esc(p)}</h2>` : `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
      const thumb = meta.thumb ? `<p><img src="/img?f=${encodeURIComponent(meta.thumb)}" style="max-width:100%;border-radius:8px"></p>` : '<p style="color:#999">(정보글 — 대표이미지 없음)</p>';
      return send(200, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(meta.headline || '')}</title></head><body style="max-width:760px;margin:30px auto;padding:0 16px;font:17px/1.9 'Malgun Gothic',sans-serif;color:#333"><h1 style="font-size:24px;line-height:1.4">${esc(meta.headline || '')}</h1><p style="color:#888;font-size:14px">${esc(meta.date || '')} · 요약: ${esc(meta.summary || '')}</p>${thumb}${paras}</body></html>`, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/img') {
      const f = path.join(E.loadCfg().draftsDir, E.today(), path.basename(url.searchParams.get('f') || ''));
      if (!fs.existsSync(f)) return send(404, '없음', 'text/plain; charset=utf-8');
      const MIME = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
      return res.end(fs.readFileSync(f));
    }
    send(404, { ok: false });
  } catch (e) { send(500, { ok: false, msg: e.message }); }
});

(async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === '--batch') {
    const mode = argv[1] || 'gen'; // am|pm|all|gen | am-gen|pm-gen (gen=생성만, 게시 안 함)
    console.log('배치 시작', E.today(), '| 모드', mode);
    const slotFilter = /^s(\d)/.test(mode) ? parseInt(mode.slice(1, 2), 10) : null;  // s0-gen ~ s4-gen = 슬롯 하나만
    const doPost = !/gen/.test(mode); // 'gen' 포함이면 생성만
    const rs = await jobGenerate(slotFilter);
    if (doPost && rs.some(r => r.ok)) await jobPost({ isDisplay: true });
    console.log('배치 종료:', JSON.stringify(rs.map(r => ({ slot: r.slot, topic: r.topic, ok: r.ok }))));
    process.exit(rs.every(r => r.ok) ? 0 : 2);
  }
  const port = E.loadCfg().port || 5045;
  server.listen(port, '127.0.0.1', () => console.log(`HomepageWriter: http://127.0.0.1:${port}  (claude: ${E.CLAUDE ? 'OK' : '없음'})`));
  try { require('./accounts').refreshAll(E.CLAUDE).catch(() => {}); } catch {}
})();
