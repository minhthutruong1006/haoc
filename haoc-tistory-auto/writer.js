// writer.js — TistoryWriter: 하오커뮤니케이션(하커) 3개 티스토리 자동 작성+게시 (로컬 웹앱)
// 실행: node writer.js            → http://127.0.0.1:5043 (UI)
//       node writer.js --batch            → 5건 생성만(게시는 08:00 예약작업)
//       node writer.js --batch publish    → 5건 생성 후 즉시 공개 게시(15분 간격)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DRAFTS_DIR } = require('./config');
const E = require('./engine');

// ★두 PC 공유(2026-09-23): 사용기록(_used_log 등)은 ../shared/haoc-sync.js가 Supabase로 공유하고,
//   같은 플랫폼 작업(생성·게시·다시쓰기)은 두 PC가 동시에 못 돌린다. 다른 PC가 오늘 이미 만든 블로그은 건너뜀.
const PLATFORM = 'tistory';
let SYNC = null; try { SYNC = require('../shared/haoc-sync'); } catch (e) { console.error('[공유] haoc-sync 없음 → 이 PC 로컬 기록만 사용: ' + e.message); }
let _oth = { t: 0, m: new Map() };
function OTHER(maxAge = 30000) { if (SYNC && Date.now() - _oth.t > maxAge) _oth = { t: Date.now(), m: SYNC.doneByOther(PLATFORM) }; return _oth.m; }

const UI = path.join(__dirname, 'writer-ui.html');

// ── 잡 상태 (한 번에 1개 잡) ─────────────────────────────
const JOB = { running: false, kind: '', logs: [], results: [], startedAt: 0 };
// ★로그를 파일에도 남긴다 — 서버를 재시작하면 메모리 로그(JOB.logs)가 사라져 사후 추적이 불가능하기 때문.
const LOGFILE = require('path').join(__dirname, 'job.log');
function flog(m) { try { fs.appendFileSync(LOGFILE, '[' + new Date().toISOString() + '] ' + m + '\n'); } catch {} }
function jlog(m) { JOB.logs.push(`[${new Date().toTimeString().slice(0, 8)}] ${m}`); if (JOB.logs.length > 500) JOB.logs.shift(); console.log(m); flog(m); }

// ── 생성 잡 ──────────────────────────────────────────────
// ★생성 전 '발행 대조' — 3개 플랫폼에 이미 공개된 글을 postedRows(영구 제외)에 반영한다.
//   (예전엔 08시 배치의 sync-posted.js가 하던 일. 배치를 없앤 뒤로 수동 생성에는 빠져 있어
//    질문이 재선택·플랫폼 간 중복되는 버그가 있었음 → 매 생성마다 자동 실행하도록 넣음.)
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
    const p = spawn('node', ['sync-posted.js', '--apply'], { cwd: __dirname });
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', () => {});
    p.on('close', () => { jlog('  발행 대조: ' + (/갱신 완료/.test(out) ? '완료(postedRows 반영)' : '경고 — 갱신 확인 안 됨')); resolve(); });
    p.on('error', e => { jlog('  발행 대조 건너뜀(무시): ' + e.message.slice(0, 50)); resolve(); });
  });
}

// ★미게시 원고 이월(2026-08-28) — 전날(최근 7일) 생성만 하고 [게시]를 안 누른 원고는
//   버리지 않고 오늘 폴더로 옮겨 그대로 재사용한다(게시는 '오늘 폴더만' 규칙 유지).
//   발행 여부는 로컬 기록이 아니라 블로그 RSS의 실제 공개 글 제목으로 판단한다(하루 1편 규칙과 같은 원칙).
//   RSS 확인이 실패하면 그 블로그는 이월하지 않는다(중복 발행 방지가 우선).
const normT = s => String(s || '').replace(/\s+/g, ' ').trim();
async function feedTitles(account) {
  try {
    const r = await fetch(`https://${account}.tistory.com/rss`, { signal: AbortSignal.timeout(10000) });
    const xml = await r.text();
    return [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)].map(m => normT(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')));
  } catch { return null; }
}
async function carryOverDrafts(blogNos) {
  const cfg = E.loadCfg();
  const todayDir = path.join(DRAFTS_DIR, E.today());
  const carried = [];
  let dates = [];
  try { dates = fs.readdirSync(DRAFTS_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < E.today()).sort().reverse().slice(0, 7); } catch {}
  for (const n of blogNos) {
    const blog = cfg.blogs.find(b => b.no === n); if (!blog) continue;
    const todayFiles = fs.existsSync(todayDir) ? fs.readdirSync(todayDir) : [];
    if (todayFiles.some(f => f.endsWith('.html') && f.includes('_' + blog.account + '_'))) continue; // 오늘 원고 이미 있음
    let titles;
    for (const d of dates) {
      const dir = path.join(DRAFTS_DIR, d);
      let f;
      try { f = fs.readdirSync(dir).filter(x => x.endsWith('.html') && x.includes('_' + blog.account + '_')).sort().pop(); } catch {}
      if (!f) continue;
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      const title = normT(E.extractTitle(html));
      if (titles === undefined) titles = await feedTitles(blog.account);
      if (titles === null) { jlog(`  이월 보류(블로그${n} ${blog.account}): RSS 확인 실패 — 중복 발행 방지 위해 건너뜀`); break; }
      if (!title || titles.some(t => t === title || (title.length > 10 && t.includes(title.slice(0, 20))))) break; // 이미 발행된 원고
      fs.mkdirSync(todayDir, { recursive: true });
      fs.renameSync(path.join(dir, f), path.join(todayDir, f));
      for (const x of fs.readdirSync(dir)) {  // 원고가 참조하는 이미지도 같이 이동
        if (x.endsWith('.html') || x.endsWith('.txt') || x.endsWith('.json')) continue;
        if (html.includes(x)) { try { fs.renameSync(path.join(dir, x), path.join(todayDir, x)); } catch {} }
      }
      try {  // 사용내역 블록도 옮겨 UI 표시(순번·점수) 유지
        const rep = fs.readFileSync(path.join(dir, '사용내역.txt'), 'utf8');
        const blk = rep.split('■').filter(x => title && x.includes(title.slice(0, 20))).pop();
        if (blk) fs.appendFileSync(path.join(todayDir, '사용내역.txt'), `■(${d} 이월)` + blk, 'utf8');
      } catch {}
      jlog(`[블로그${n} ${blog.account}] 이월: ${d}의 미게시 원고 재사용 — ${title.slice(0, 40)}`);
      carried.push({ ok: true, blog: n, account: blog.account, file: path.join(todayDir, f), title,
        question: f.replace(/\.html$/, '').split('_').slice(2).join('_'), carried: d });
      break;
    }
  }
  return carried;
}

async function jobGenerate(blogNos, overrides = {}) {
  await refreshQuestions();          // ★항상 최신 질문 시트로
  await syncPosted();               // ★질문 고르기 전에 발행 현황 반영
  OTHER(0);
  blogNos = blogNos.filter(n => { const o = OTHER(); if (!o.has(String(n))) return true; jlog(`[블로그${n}] 오늘 다른 PC(${o.get(String(n))})가 이미 생성 → 건너뜀`); return false; });
  const carried = await carryOverDrafts(blogNos);  // ★생성 전에 미게시 원고부터 재사용
  if (carried.length) jlog(`이월 ${carried.length}건 — 해당 블로그는 새로 생성하지 않음`);
  blogNos = blogNos.filter(n => !carried.some(c => c.blog === n));
  const ctx = E.makeCtx(jlog);      // 그 다음 최신 로그를 읽는다
  JOB.results = [...carried];
  for (const n of blogNos) {
    try {
      const r = await E.generateOne(n, ctx, overrides[n] || {});
      JOB.results.push(r);
      if (!r.ok) jlog(`[블로그${n}] 보류: ${r.reason}`);
    } catch (e) {
      JOB.results.push({ ok: false, blog: n, reason: e.message.slice(0, 200) });
      jlog(`[블로그${n}] 오류: ${e.message.slice(0, 120)}`);
    }
  }
  const ok = JOB.results.filter(r => r.ok).length;
  if (SYNC) for (const r of JOB.results) if (r.ok && r.blog != null) SYNC.markDone(PLATFORM, r.blog);
  jlog(`생성 완료: ${ok}/${blogNos.length}건 → ${path.join(DRAFTS_DIR, E.today())}`);
  return JOB.results;
}

// ── 게시 잡 (검증된 watcher.js 를 서브프로세스로) ─────────
function jobPost(target, mode, stagger) {
  return new Promise((resolve) => {
    // ★간격은 UI가 안 보내면 config의 publishStaggerMin(=5분)을 쓴다(예전엔 15분으로 하드코딩돼 있었음).
    const gap = stagger || E.loadCfg().publishStaggerMin || 5;
    jlog(`게시 시작: ${target || '(오늘 폴더)'} | 모드=${mode} | 간격=${gap}분`);
    const p = spawn('node', ['watcher.js', target || '', mode, String(gap)], { cwd: __dirname });
    p.stdout.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => jlog('  ' + l)));
    p.stderr.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => jlog('  ! ' + l)));
    p.on('close', c => { jlog(`게시 프로세스 종료(code ${c})`); resolve(c); });
  });
}

// ★생성 편수 조절(2026-09-05 운영자 지시): UI가 count(1~5)를 보내면 하루 총량이 그 수가 되게 한다.
//   5개 블로그(주제)는 날마다 번갈아 쓴다 — 지난번 마지막 블로그의 '다음 번호'부터 순환(_gen_rotation.json).
//   오늘 원고가 이미 있는 블로그는 건너뛰고, 이월도 여기서 고른 블로그에만 허용된다(jobGenerate가 이 목록을 그대로 씀).
const ROT_FILE = path.join(__dirname, '_gen_rotation.json');
function blogsForCount(n) {
  OTHER(0);
  // ★하루 1편 요일 번갈아(2026-09-15 운영자 지시): count=1이면 3블로그(디자인→웹→마케팅)를 날마다 순환.
  //   같은 날 다시 눌러도 같은 블로그(오늘 원고가 이미 있으면 다음 빈 블로그). _gen_rotation.json에 {last, date, sel} 기록.
  const cfg = E.loadCfg();
  const all = cfg.blogs.map(b => b.no);
  n = parseInt(n, 10);
  if (!n || n >= all.length) return all;
  let rot = {};
  try { rot = JSON.parse(fs.readFileSync(ROT_FILE, 'utf8')); } catch {}
  const dDir = path.join(DRAFTS_DIR, E.today());
  const files = fs.existsSync(dDir) ? fs.readdirSync(dDir).filter(f => f.endsWith('.html')) : [];
  const has = no => { const b = (cfg.blogs || []).find(x => x.no === no); return OTHER().has(String(no)) || (!!b && files.some(f => f.includes('_' + b.account + '_'))); };
  if (rot.date === E.today() && Array.isArray(rot.sel) && rot.sel.length === Math.max(1, n) && !rot.sel.some(has)) return rot.sel;
  const last = (rot.date === E.today() && rot.prevLast != null) ? rot.prevLast : (parseInt(rot.last, 10) || 0);
  const start = all.indexOf(last); // 없으면 -1 → 1번부터
  const order = all.map((_, i) => all[(start + 1 + i) % all.length]);
  let sel = order;
  const empty = order.filter(no => !has(no));
  if (empty.length) sel = empty;
  sel = sel.slice(0, Math.max(1, n));
  try { fs.writeFileSync(ROT_FILE, JSON.stringify({ last: sel[sel.length - 1], prevLast: last, date: E.today(), sel, at: new Date().toISOString() })); } catch {}
  return sel;
}

// ★화면 표시용(2026-09-05): 선택한 건수만큼 '오늘의 블로그'만 표에 보여준다(순환 저장 안 함).
//   오늘 원고 있는 블로그 + 지금 생성 중인 대상 + 부족하면 순환 순서로 채움.
function displayBlogs(n) {
  const all = E.loadCfg().blogs.map(b => b.no);
  n = parseInt(n, 10);
  if (!n || n >= all.length) return all;
  let list = [];
  try {
    const cfg = E.loadCfg();
    const dDir = path.join(DRAFTS_DIR, E.today());
    const files = fs.existsSync(dDir) ? fs.readdirSync(dDir).filter(f => f.endsWith('.html')) : [];
    const has = no => { const b = (cfg.blogs || []).find(x => x.no === no); return OTHER().has(String(no)) || (!!b && files.some(f => f.includes('_' + b.account + '_'))); };
    list = all.filter(has);
  } catch {}
  if (JOB.running && /생성/.test(JOB.kind)) for (const t of (JOB.targetBlogs || [])) if (!list.includes(t)) list.push(t);
  if (list.length < n) {
    let last = 0; try { last = parseInt(JSON.parse(fs.readFileSync(ROT_FILE, 'utf8')).last, 10) || 0; } catch {}
    const start = all.indexOf(last);
    for (let i = 1; i <= all.length && list.length < n; i++) { const b = all[(start + i) % all.length]; if (!list.includes(b)) list.push(b); }
  }
  return list.sort((a, b) => a - b);
}

function runJob(kind, fn) {
  if (JOB.running) return false;
  JOB.running = true; JOB.kind = kind; JOB.logs = []; JOB.startedAt = Date.now();
  (SYNC && !/질문 새로고침|계정 테스트/.test(kind) ? () => SYNC.withLock(PLATFORM, kind, fn, jlog) : fn)().catch(e => jlog('잡 오류: ' + e.message)).finally(() => { JOB.running = false; });
  return true;
}

// ── 상태 조회 ────────────────────────────────────────────
async function state(showCount) {
  const cfg = E.loadCfg();
  let picks = [], csvInfo = null;
  try {
    const st = fs.statSync(cfg.csvFile);
    csvInfo = { mtime: st.mtime.toISOString().replace('T', ' ').slice(0, 16), size: st.size };
    const data = E.loadQuestions();
    // (화면 새로고침마다 공유 사용기록을 읽지 않도록 제거 — 2026-09-23)
    picks = [];
    const dDir = path.join(DRAFTS_DIR, E.today());
    const files = fs.existsSync(dDir) ? fs.readdirSync(dDir).filter(f => f.endsWith('.html')) : [];
    for (const b of cfg.blogs) {
      // ★질문·이미지를 미리 고르지 않는다(preview 제거) — '오늘 5건 생성'을 눌러 실제 생성한
      //   원고가 있을 때만 그 내용(질문·제목·카테고리·이미지)을 보여준다. 그전엔 전부 빈칸.
      let row = null, question = '', title = '', section = '', usedImgs = [], folder = '', imgN = 0, score = null;
      const mine = files.filter(f => f.includes('_' + b.account + '_')).sort((x, y) =>
        fs.statSync(path.join(dDir, y)).mtimeMs - fs.statSync(path.join(dDir, x)).mtimeMs)[0];
      if (mine) {
        // 파일명에서 질문 텍스트 복원(형식: 주제_계정_질문.html)
        question = mine.replace(/\.html$/, '').split('_').slice(2).join('_');
        const h = fs.readFileSync(path.join(dDir, mine), 'utf8');
        title = E.extractTitle ? E.extractTitle(h) : ((h.match(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || '');
        section = E.extractSection(h);
        try {
          const rep = fs.readFileSync(path.join(dDir, '사용내역.txt'), 'utf8');
          const blk = rep.split('■').filter(x => x.includes(title.slice(0, 20)) || x.includes(question.slice(0, 18))).pop();
          if (blk) {
            const mf = blk.match(/실제 사용한 파일\([0-9]+장\):\s*([^\n(]+)/) || blk.match(/이미지 파일:\s*([^\n(]+)/);
            if (mf) usedImgs = mf[1].split(',').map(s => s.trim());
            const mr = blk.match(/(\d+)번째 질문/); if (mr) row = parseInt(mr[1], 10);
            const mp = blk.match(/(?:위치:.*?>|이미지 폴더:)\s*([^\n(]+)/); if (mp) folder = mp[1].trim();
            const msc = blk.match(/SEO\/AEO\/GEO 채점:\s*(\d+)\/20\s*\(SEO\s*(\d+)\/7\s*·\s*AEO\s*(\d+)\/7\s*·\s*GEO\s*(\d+)\/6\)/);
            if (msc) score = { total: +msc[1], seo: +msc[2], aeo: +msc[3], geo: +msc[4] };
          }
        } catch {}
      }
      picks.push({ no: b.no, topic: b.topic, display: b.display || b.topic, account: b.account,
        row, question, title, section, usedImgs, folder, imgN, score });
    }
  } catch (e) { csvInfo = { error: e.message }; }
  const dateDir = path.join(DRAFTS_DIR, E.today());
  const todayFiles = fs.existsSync(dateDir) ? fs.readdirSync(dateDir).filter(f => f.endsWith('.html')) : [];
  return { claude: !!E.CLAUDE, claudePath: E.CLAUDE || '', model: cfg.model, csv: csvInfo,
    accounts: (() => { try { return require('./accounts').list(); } catch { return null; } })(),
    today: E.today(), todayFiles, picks, show: displayBlogs(showCount),
    job: { running: JOB.running, kind: JOB.kind, targets: JOB.targetBlogs || [], logs: JOB.logs.slice(-200), results: JOB.results } };
}

// ── HTTP 서버 ────────────────────────────────────────────
function body(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }
// ★미리보기용 발행 형태(2026-09-19): 발행 때 post-footer가 붙이는 UTM·하단 배너를 미리보기에도 똑같이 입힌다. 배너는 로컬 파일을 data URI로.
function previewWithFooter(html, fname, platform) {
  try {
    const footer = require('./post-footer');
    const account = (String(fname).match(/_(haocommunication\d*)_/) || [])[1] || '';
    const bf = footer.localBannerFile();
    const bannerUrl = bf ? 'data:image/png;base64,' + fs.readFileSync(bf).toString('base64') : null;
    return footer.apply(html, { platform, account, title: E.extractTitle(html), bannerUrl });
  } catch (e) { return html; }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  try {
    if (url.pathname === '/') return send(200, fs.readFileSync(UI, 'utf8'), MIME['.html']);
    if (url.pathname === '/api/state') return send(200, await state(url.searchParams.get('count')));

    if (url.pathname === '/api/refresh-questions' && req.method === 'POST') {
      if (!runJob('질문 새로고침', () => new Promise(r => {
        const p = spawn('node', ['fetch-questions.js'], { cwd: __dirname });
        p.stdout.on('data', d => jlog(String(d).trim()));
        p.on('close', () => r());
      }))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }

    if (url.pathname === '/api/generate' && req.method === 'POST') {
      const b = await body(req);
      const blogs = (b.blogs && b.blogs.length) ? b.blogs : blogsForCount(b.count);
      JOB.targetBlogs = blogs;
      if (!runJob('생성', () => { jlog(`생성 대상: 블로그 ${blogs.join(', ')} (${blogs.length}건)`); return jobGenerate(blogs, b.overrides || {}); })) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }

    // ★제목 자동 다시 짓기(2026-09-07 운영자 지시): 버튼 한 번이면 AI가 새 제목을 지어 즉시 교체.
    //   본문·사진은 그대로(제목 문자열만 전부 치환). b.title을 주면 그 제목으로 직접 교체(수동 경로).
    if (url.pathname === '/api/retitle' && req.method === 'POST') {
      const b = await body(req);
      const f = path.join(DRAFTS_DIR, E.today(), path.basename(String(b.file || '')));
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
        const question = path.basename(f).replace(/\.html$/, '').split('_').slice(2).join('_');
        const out = await E.runClaude(
`아래 블로그 글의 제목을 새로 짓는다. 출력은 '새 제목 한 줄'만 — 설명·따옴표·번호 금지.

[질문(글의 근거)] ${question}
[기존 제목] ${cur}

[규칙]
- 질문의 핵심을 간추려 짧고·깔끔하고·자연스럽게(소리 내어 읽어 어색하면 다시).
- SEO 노출 최우선: 기존 제목에 들어 있는 산출물/서비스 키워드(카탈로그 제작/홈페이지 제작/제품 촬영/인스타 운영 등)와 정부사업명(수출바우처/혁신바우처/판로개척지원사업 등)을 반드시 그대로 유지하고 가급적 앞쪽에 둔다.
- 기존 제목과 표현·각도가 뚜렷이 달라야 한다(단어 몇 개만 바꾸는 수준 금지).
- 금지어: '법'·'방법'(절차·방법형), 군더더기(완벽정리/총정리/노하우/가이드). '수행기관/원스톱/~하는 곳/~찾는다면' 표현은 허용.
- 같은 단어를 제목에서 두 번 쓰지 않고, 질문에 없는 업종을 붙이지 않는다. AEO·GEO도 함께 충족하되 SEO 노출이 최우선.
- 브랜드명·"| 하오커뮤니케이션" 같은 꼬리표 금지. 공백 포함 26~32자.`,
          { ...cfg, model: cfg.judgeModel || 'sonnet' }, jlog);
        const next = String(out || '').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop()
          .replace(/^["'\`“”\[\(]+|["'\`“”\]\)]+$/g, '').trim();
        if (!next || next.length > 60) throw new Error('AI가 제목을 제대로 내놓지 않음: ' + String(out).slice(0, 80));
        apply(next);
      })) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }

    // ★원고별 다시쓰기(2026-09-21 운영자 지시): 오늘 원고 1편을 지우지 않고 보관함으로 옮긴 뒤 그 블로그 글만 새로 쓴다.
    //   mode 'same' = 같은 질문으로(사진은 새로 고름) / 'new' = 새 질문으로. 발행된 글은 거부. 실패하면 옛 원고를 되돌린다.
    if (url.pathname === '/api/rewrite' && req.method === 'POST') {
      const b = await body(req);
      const file = path.basename(String(b.file || ''));
      const f = path.join(DRAFTS_DIR, E.today(), file);
      if (!file || !fs.existsSync(f)) return send(400, { ok: false, msg: '오늘 원고가 없습니다: ' + file });
      const cfg = E.loadCfg();
      const account = (file.match(/_(haocommunication\d*)_/) || [])[1] || '';
      const blog = cfg.blogs.find(x => x.account === account);
      if (!blog) return send(400, { ok: false, msg: '계정을 찾지 못했습니다: ' + file });
      const mode = b.mode === 'new' ? 'new' : 'same';
      JOB.targetBlogs = [blog.no];
      if (!runJob('다시쓰기', async () => {
        const RW = require('./rewrite-draft');
        const title = normT(E.extractTitle(fs.readFileSync(f, 'utf8')));
        jlog(`다시쓰기(${mode === 'new' ? '새 질문' : '같은 질문'}): 블로그${blog.no} ${account} — ${title.slice(0, 40)}`);
        const titles = await feedTitles(account);
        if (titles === null) throw new Error('블로그 RSS 확인 실패 — 발행 여부를 알 수 없어 다시쓰기를 중단합니다(잠시 후 다시)');
        if (title && titles.some(t => t === title || (title.length > 10 && t.includes(title.slice(0, 20))))) throw new Error('이미 발행된 글입니다 — 발행된 글은 다시쓰기 할 수 없습니다');
        if (mode === 'new') { await refreshQuestions(); await syncPosted(); }
        const info = RW.prepare({ draftsDir: DRAFTS_DIR, file, title, mode, usedLogFile: cfg.usedLog, log: jlog,
          usedKey: sk => { const bl = (blog.blocks || []).find(x => x.sheetBlock === sk) || (blog.blocks || [])[0]; return bl && bl.usedNo != null ? bl.usedNo : blog.no; } });
        let r;
        try {
          const ctx = E.makeCtx(jlog);
          r = await E.generateOne(blog.no, ctx, mode === 'same' ? { question: info.question, row: info.row, block: info.usedKey } : {});
        } catch (e) { r = { ok: false, blog: blog.no, reason: e.message.slice(0, 200) }; }
        JOB.results = [r];
        if (!r.ok) { jlog(`[블로그${blog.no}] 보류: ${r.reason}`); RW.restore(info, jlog); return; }
        RW.finish(info, jlog);
      })) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }

    if (url.pathname === '/api/post' && req.method === 'POST') {
      const b = await body(req);
      const mode = ['draft', 'ptest', 'publish'].includes(b.mode) ? b.mode : 'draft';
      const target = b.file ? path.join(DRAFTS_DIR, E.today(), b.file) : path.join(DRAFTS_DIR, E.today());
      if (!fs.existsSync(target)) return send(400, { ok: false, msg: '오늘 원고가 없습니다: ' + target });
      if (!runJob('게시(' + mode + ')', () => jobPost(target, mode, b.stagger))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }

    if (url.pathname === '/api/generate-and-post' && req.method === 'POST') {
      const b = await body(req);
      const mode = ['draft', 'ptest', 'publish'].includes(b.mode) ? b.mode : 'draft';
      const gpBlogs = blogsForCount(b.count);
      JOB.targetBlogs = gpBlogs;
      if (!runJob('생성+게시(' + mode + ')', async () => {
        const rs = await jobGenerate(gpBlogs);
        if (rs.some(r => r.ok)) await jobPost(path.join(DRAFTS_DIR, E.today()), mode, b.stagger);
        else jlog('생성된 글이 없어 게시 생략');
      })) return send(409, { ok: false, msg: '다른 작업 실행 중' });
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
      const f = path.join(DRAFTS_DIR, E.today(), path.basename(url.searchParams.get('f') || ''));
      if (!fs.existsSync(f)) return send(404, '없음', 'text/plain; charset=utf-8');
      let html = fs.readFileSync(f, 'utf8');
      html = html.replace(/\[\[IMG:\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?))?\]\]/g, (_, file, alt) =>
        `<p><img src="/img?f=${encodeURIComponent(file.trim())}" alt="${(alt || '').trim()}" style="max-width:100%;height:auto;"></p>`);
      html = previewWithFooter(html, path.basename(f), 'tistory');  // ★발행 형태 그대로(UTM+하단 배너)
      return send(200, html, MIME['.html']);
    }
    if (url.pathname === '/img') {
      const f = path.join(DRAFTS_DIR, E.today(), path.basename(url.searchParams.get('f') || ''));
      if (!fs.existsSync(f)) return send(404, '없음', 'text/plain; charset=utf-8');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
      return res.end(fs.readFileSync(f));
    }
    send(404, { ok: false });
  } catch (e) { send(500, { ok: false, msg: e.message }); }
});

// ── CLI 배치 모드 ────────────────────────────────────────
(async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === '--batch') {
    const mode = argv[1]; // 없으면 생성만
    console.log('배치 시작', E.today(), mode ? '(+게시 ' + mode + ')' : '(생성만)');
    const rs = await jobGenerate(E.loadCfg().blogs.map(b => b.no));
    if (mode && rs.some(r => r.ok)) await jobPost(path.join(DRAFTS_DIR, E.today()), mode, 15);
    console.log('배치 종료:', JSON.stringify(rs.map(r => ({ blog: r.blog, ok: r.ok }))));
    process.exit(rs.every(r => r.ok) ? 0 : 2);
  }
  const port = E.loadCfg().port || 5043;
  server.listen(port, '127.0.0.1', () => console.log(`TistoryWriter: http://127.0.0.1:${port}  (claude: ${E.CLAUDE ? 'OK' : '없음'})`));
  try { require('./accounts').refreshAll(E.CLAUDE).catch(() => {}); } catch {}
})();
