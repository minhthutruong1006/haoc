// writer.js — BloggerWriter: 하오커뮤니케이션(하커) 3개 블로그스팟 자동 작성+게시 (로컬 웹앱)
// 실행: node writer.js                    → http://127.0.0.1:5044 (UI)
//       node writer.js --batch            → 5건 생성만
//       node writer.js --batch draft      → 5건 생성 후 Blogger에 초안 등록
//       node writer.js --batch publish    → 5건 생성 후 공개 발행
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const E = require('./engine');

// ★두 PC 공유(2026-09-23): 사용기록(_used_log 등)은 ../shared/haoc-sync.js가 Supabase로 공유하고,
//   같은 플랫폼 작업(생성·게시·다시쓰기)은 두 PC가 동시에 못 돌린다. 다른 PC가 오늘 이미 만든 블로그은 건너뜀.
const PLATFORM = 'blogger';
let SYNC = null; try { SYNC = require('../shared/haoc-sync'); } catch (e) { console.error('[공유] haoc-sync 없음 → 이 PC 로컬 기록만 사용: ' + e.message); }
let _oth = { t: 0, m: new Map() };
function OTHER(maxAge = 30000) { if (SYNC && Date.now() - _oth.t > maxAge) _oth = { t: Date.now(), m: SYNC.doneByOther(PLATFORM) }; return _oth.m; }

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
    const p = spawn('node', ['sync-posted.js', '--apply'], { cwd: 'E:\\haoc-tistory-auto' });
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', () => {});
    p.on('close', () => { jlog('  발행 대조: ' + (/갱신 완료/.test(out) ? '완료(postedRows 반영)' : '경고 — 갱신 확인 안 됨')); resolve(); });
    p.on('error', e => { jlog('  발행 대조 건너뜀(무시): ' + e.message.slice(0, 50)); resolve(); });
  });
}

// ★미게시 원고 이월(2026-08-28) — 전날(최근 7일) 생성만 하고 [게시]를 안 누른 원고는
//   버리지 않고 오늘 폴더로 옮겨 그대로 재사용한다(게시는 '오늘 폴더만' 규칙 유지).
//   발행 여부는 로컬 기록이 아니라 블로그 공개 피드의 실제 글 제목으로 판단한다(하루 1편 규칙과 같은 원칙).
//   피드 확인이 실패하면 그 블로그는 이월하지 않는다(중복 발행 방지가 우선).
const normT = s => String(s || '').replace(/\s+/g, ' ').trim();
async function feedTitles(account) {
  try {
    const r = await fetch(`https://${account}.blogspot.com/feeds/posts/default?alt=json&max-results=15`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return (((j || {}).feed || {}).entry || []).map(e => normT(e.title && e.title.$t));
  } catch { return null; }
}
async function carryOverDrafts(blogNos) {
  const cfg = E.loadCfg();
  const DRAFTS = cfg.draftsDir;
  const todayDir = path.join(DRAFTS, E.today());
  const carried = [];
  let dates = [];
  try { dates = fs.readdirSync(DRAFTS).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < E.today()).sort().reverse().slice(0, 7); } catch {}
  for (const n of blogNos) {
    const blog = cfg.blogs.find(b => b.no === n); if (!blog) continue;
    const todayFiles = fs.existsSync(todayDir) ? fs.readdirSync(todayDir) : [];
    if (todayFiles.some(f => f.endsWith('.html') && f.includes('_' + blog.account + '_'))) continue; // 오늘 원고 이미 있음
    let titles;
    for (const d of dates) {
      const dir = path.join(DRAFTS, d);
      let f;
      try { f = fs.readdirSync(dir).filter(x => x.endsWith('.html') && x.includes('_' + blog.account + '_')).sort().pop(); } catch {}
      if (!f) continue;
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      const title = normT(E.extractTitle(html));
      if (titles === undefined) titles = await feedTitles(blog.account);
      if (titles === null) { jlog(`  이월 보류(블로그${n} ${blog.account}): 피드 확인 실패 — 중복 발행 방지 위해 건너뜀`); break; }
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

async function jobGenerate(blogNos) {
  await refreshQuestions();          // ★항상 최신 질문 시트로
  await syncPosted();
  OTHER(0);
  blogNos = blogNos.filter(n => { const o = OTHER(); if (!o.has(String(n))) return true; jlog(`[블로그${n}] 오늘 다른 PC(${o.get(String(n))})가 이미 생성 → 건너뜀`); return false; });
  const carried = await carryOverDrafts(blogNos);  // ★생성 전에 미게시 원고부터 재사용
  if (carried.length) jlog(`이월 ${carried.length}건 — 해당 블로그는 새로 생성하지 않음`);
  blogNos = blogNos.filter(n => !carried.some(c => c.blog === n));
  const ctx = E.makeCtx(jlog);
  JOB.results = [...carried];
  for (const n of blogNos) {
    try {
      const r = await E.generateOne(n, ctx);
      JOB.results.push(r);
      if (!r.ok) jlog(`[블로그${n}] 보류: ${r.reason}`);
    } catch (e) {
      JOB.results.push({ ok: false, blog: n, reason: e.message.slice(0, 200) });
      jlog(`[블로그${n}] 오류: ${e.message.slice(0, 120)}`);
    }
  }
  if (SYNC) for (const r of JOB.results) if (r.ok && r.blog != null) SYNC.markDone(PLATFORM, r.blog);
  jlog(`생성 완료: ${JOB.results.filter(r => r.ok).length}/${blogNos.length}건 → ${path.join(E.loadCfg().draftsDir, E.today())}`);
  return JOB.results;
}

// 게시: 오늘 폴더의 HTML들을 Blogger API로.
// draft = 초안 등록(postId를 _posts.json에 기록) / publish = 공개 발행(★커스텀 퍼머링크 적용:
//   초안이 있으면 슬러그 제목으로 발행 후 한글 제목 복원, 없으면 즉시 발행 방식).
// ★하루 1편 보증(2026-08-15): 블로그마다 '오늘 이미 올라간 글'이 있으면 그 계정은 통째로 건너뛴다.
//   로컬 기록(_posts.json)만 믿으면 안 된다 — 발행은 됐는데 기록 직전에 죽는 경우(제목 patch 5xx 등)를 놓쳐
//   재시도 때 같은 글이 두 번 올라간다(8/15 haodesign04). 그래서 블로그 공개 피드를 직접 보고 판단한다.
//   발행 시각은 블로그마다 표준시 설정이 달라서, 절대 시각을 이 PC 기준 날짜로 환산해 비교한다.
async function accountsPostedToday(cfg) {
  const td = E.today();
  const set = new Set();
  await Promise.all((cfg.blogs || []).map(async (b) => {
    try {
      const r = await fetch(`https://${b.account}.blogspot.com/feeds/posts/default?alt=json&max-results=5`,
        { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      for (const e of (j.feed && j.feed.entry) || []) {
        const d = new Date((e.published && e.published.$t) || '');
        if (isNaN(d)) continue;
        const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (local === td) { set.add(b.account); break; }
      }
    } catch (e) { jlog(`  (하루1편 확인 실패: ${b.account} — ${String(e.message).slice(0, 40)})`); }
  }));
  return set;
}

async function jobPost(mode, onlyFile, force) {
  const poster = require('./poster');
  const cfg = await poster.resolveBlogIds();
  const dateDir = path.join(cfg.draftsDir || E.loadCfg().draftsDir, E.today());
  const mapFile = path.join(dateDir, '_posts.json');
  const posted = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : {};
  let files = fs.existsSync(dateDir) ? fs.readdirSync(dateDir).filter(f => f.endsWith('.html')) : [];
  if (onlyFile) files = files.filter(f => f === onlyFile);
  else {
    // ★계정별로 '최신 파일 1개'만 게시(하루 블로그당 1건). 폴더에 옛 원고가 섞여도 오게시 방지.
    const byAcct = {};
    for (const f of files) {
      const acct = (f.match(/_(haocommunication\d*)_/) || [])[1]; if (!acct) continue;
      const mt = fs.statSync(path.join(dateDir, f)).mtimeMs;
      if (!byAcct[acct] || mt > byAcct[acct].mt) byAcct[acct] = { f, mt };
    }
    const chosen = new Set(Object.values(byAcct).map(x => x.f));
    const dropped = files.filter(f => !chosen.has(f));
    if (dropped.length) jlog(`  (건너뜀 ${dropped.length}건: 계정당 최신 1건만 게시)`);
    files = files.filter(f => chosen.has(f));
  }
  const stagger = (cfg.publishStaggerMin ?? 15);
  // ★하루 1편: 오늘 이미 글이 올라간 블로그는 발행에서 제외(force=true면 무시하고 강행)
  const doneToday = (mode === 'publish' && !force) ? await accountsPostedToday(cfg) : new Set();
  if (doneToday.size) jlog(`  하루 1편 규칙: 오늘 이미 발행된 블로그 건너뜀 — ${[...doneToday].join(', ')}`);
  jlog(`게시 시작: ${files.length}건 | 모드=${mode}${mode === 'publish' ? ` | 간격 ${stagger}분` : ''}`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let publishedCount = 0;
  for (const f of files) {
    try {
      const html = fs.readFileSync(path.join(dateDir, f), 'utf8');
      const account = (f.match(/_(haocommunication\d*)_/) || [])[1];
      const blog = cfg.blogs.find(b => b.account === account);
      if (!blog) { jlog(`  건너뜀(계정 못 찾음): ${f.slice(0, 40)}`); continue; }
      const title = E.extractTitle(html);
      const labels = E.extractTags(html);
      const slug = E.extractSlug(html);
      // ★CRM CTA 추적링크(crm-notify.config ctaTrack=true + token 있을 때만 치환, 아니면 원문 그대로)
      // ★하단 배너+UTM(2026-09-16, post-footer): 배너 이미지는 Drive '하단배너' 폴더 → 티스토리가 저장한 URL 순, 없으면 배너 생략
      const footer = require('./post-footer');
      let bannerUrl = null; try { bannerUrl = await footer.hostedBannerUrl(); } catch (e) {}
      if (!bannerUrl) jlog('  배너 이미지 URL 없음 → 배너 없이 발행(Drive 하단배너 폴더에 이미지를 넣거나 티스토리를 먼저 발행하면 생김)');
      // ★썸네일 안전장치(2026-09-21, thumb-early): Blogger 관리자 목록 썸네일은 글 앞부분의 이미지만 잡는다 → 첫 이미지가 뒤에 있으면 도입부 끝으로 옮긴다
      const body = require('./crm-notify').ctaTrackHtml(footer.apply(require('./thumb-early').ensureEarlyImage(html.replace(/^<!--[\s\S]*?-->\s*/, ''), s => jlog('  ' + s)).replace(/(https:\/\/lh3\.googleusercontent\.com\/d\/[A-Za-z0-9_-]+)=w1200/g, '$1=s1200') /* ★옛 원고의 =w1200 주소도 발행 때 =s1200으로(관리자 글 목록 썸네일이 뜨게) */, { platform: 'blogspot', account, title, bannerUrl }), title);
      const rec = posted[f];
      let r;
      if (mode === 'draft') {
        if (rec && rec.id) { jlog(`  이미 초안 등록됨: ${f.slice(0, 35)}`); continue; }
        r = await poster.insertDraft(blog, { title, html: body, labels });
        posted[f] = { id: r.id, account, slug, publishedUrl: '' };
      } else { // publish — ★글 사이 15분(설정값) 간격
        if (rec && rec.publishedUrl) { jlog(`  이미 발행됨: ${f.slice(0, 35)}`); continue; }
        if (doneToday.has(account)) { jlog(`  건너뜀(하루 1편): ${account}은 오늘 이미 발행된 글이 있습니다`); continue; }
        if (publishedCount > 0 && stagger > 0) { jlog(`  ... 다음 발행까지 ${stagger}분 대기`); await sleep(stagger * 60000); }
        if (rec && rec.id) r = await poster.publishWithSlug(blog, rec.id, slug || rec.slug, title);
        else { r = await poster.insertPublish(blog, { title, html: body, labels, slug }); posted[f] = { id: r.id, account, slug }; }
        posted[f].publishedUrl = r.url || '';
        doneToday.add(account);  // 같은 실행 안에서도 한 계정 두 번 금지
        publishedCount++;
        // CRM 게시 현황 전송 — crm-notify.config.json 토큰 없으면 no-op, 실패해도 게시 흐름 무관
        try { require('./crm-notify').notifyCrm({ account, title, category: (labels && labels[0]) || '', url: r.url || '', status: 'posted', posted_at: new Date().toISOString() }).catch(() => {}); } catch (e) {}
      }
      fs.writeFileSync(mapFile, JSON.stringify(posted, null, 2), 'utf8');
      // ★제목 복원(patch)만 실패한 경우: 글은 이미 살아 있으므로 재발행하면 중복이 된다. 수동으로 제목만 고칠 것.
      if (r.titleFixFailed) jlog(`  ⚠ 제목 복원 실패 — 블로그에 제목이 슬러그(${slug})로 남아 있습니다. Blogger에서 제목만 '${title.slice(0, 30)}'로 고쳐주세요(재발행 금지: 중복 글 생김)`);
      jlog(`  OK ${account} [${r.status}] ${title.slice(0, 33)} | 라벨 ${labels.length}${r.url ? ' | ' + r.url : ''}`);
    } catch (e) { jlog(`  FAIL ${f.slice(0, 30)} | ${e.message.slice(0, 100)}`); }
  }
  jlog('게시 완료');
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
  const dDir = path.join(cfg.draftsDir, E.today());
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
    const dDir = path.join(cfg.draftsDir, E.today());
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
  JOB.running = true; JOB.kind = kind; JOB.logs = [];
  (SYNC && !/질문 새로고침|계정 테스트/.test(kind) ? () => SYNC.withLock(PLATFORM, kind, fn, jlog) : fn)().catch(e => jlog('잡 오류: ' + e.message)).finally(() => { JOB.running = false; });
  return true;
}

async function state(showCount) {
  const cfg = E.loadCfg();
  let picks = [], csvInfo = null;
  try {
    const st = fs.statSync(cfg.csvFile);
    csvInfo = { mtime: st.mtime.toISOString().replace('T', ' ').slice(0, 16) };
    const data = E.loadQuestions();
    // (화면 새로고침마다 공유 사용기록을 읽지 않도록 제거 — 2026-09-23)
    const dDir = path.join(cfg.draftsDir, E.today());
    const files = fs.existsSync(dDir) ? fs.readdirSync(dDir).filter(f => f.endsWith('.html')) : [];
    for (const b of cfg.blogs) {
      // ★질문·이미지를 미리 고르지 않는다(preview 제거) — 실제 생성한 원고가 있을 때만 내용 표시.
      let row = null, question = '', title = '', usedImgs = [], folder = '', score = null;
      const mine = files.filter(f => f.includes('_' + b.account + '_')).sort((x, y) =>
        fs.statSync(path.join(dDir, y)).mtimeMs - fs.statSync(path.join(dDir, x)).mtimeMs)[0];
      if (mine) {
        question = mine.replace(/\.html$/, '').split('_').slice(2).join('_');
        title = E.extractTitle(fs.readFileSync(path.join(dDir, mine), 'utf8'));
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
      picks.push({ no: b.no, topic: b.topic, display: b.display || b.topic, account: b.account, title, usedImgs, row, question, folder, score, imgN: 0 });
    }
  } catch (e) { csvInfo = { error: e.message }; }
  const dateDir = path.join(cfg.draftsDir, E.today());
  const todayFiles = fs.existsSync(dateDir) ? fs.readdirSync(dateDir).filter(f => f.endsWith('.html')) : [];
  let apiReady = false;
  try { const poster = require('./poster'); apiReady = !!poster.findClientSecret() && fs.existsSync(poster.TOKEN_FILE); } catch {}
  let accounts = null;
  try { accounts = require('./accounts').list(); } catch {}
  return { claude: !!E.CLAUDE, model: cfg.model, csv: csvInfo, apiReady, accounts,
    today: E.today(), todayFiles, picks, show: displayBlogs(showCount),
    job: { running: JOB.running, kind: JOB.kind, targets: JOB.targetBlogs || [], logs: JOB.logs.slice(-200), results: JOB.results } };
}

function body(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }

// ★미리보기용 발행 형태(2026-09-19): 발행 때 post-footer가 붙이는 UTM·하단 배너를 미리보기에도 똑같이 입힌다. 배너는 로컬 파일을 data URI로.
function previewWithFooter(html, fname, platform) {
  try {
    const footer = require('./post-footer');
    const account = (String(fname).match(/_(haocommunication\d*)_/) || [])[1] || '';
    const bf = footer.localBannerFile();
    const bannerUrl = bf ? 'data:image/png;base64,' + fs.readFileSync(bf).toString('base64') : null;
    return footer.apply(require('./thumb-early').ensureEarlyImage(html), { platform, account, title: E.extractTitle(html), bannerUrl });
  } catch (e) { return html; }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  try {
    if (url.pathname === '/') return send(200, fs.readFileSync(UI, 'utf8'), 'text/html; charset=utf-8');
    if (url.pathname === '/api/state') return send(200, await state(url.searchParams.get('count')));
    if (url.pathname === '/api/refresh-questions' && req.method === 'POST') {
      if (!runJob('질문 새로고침', () => new Promise(r => {
        const p = spawn('node', ['fetch-questions.js'], { cwd: 'E:\\haoc-tistory-auto' });
        p.stdout.on('data', d => jlog(String(d).trim()));
        p.on('close', () => r());
      }))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/generate' && req.method === 'POST') {
      const b = await body(req);
      const blogs = (b.blogs && b.blogs.length) ? b.blogs : blogsForCount(b.count);
      JOB.targetBlogs = blogs;
      if (!runJob('생성', () => { jlog(`생성 대상: 블로그 ${blogs.join(', ')} (${blogs.length}건)`); return jobGenerate(blogs); })) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    // ★원고별 다시쓰기(2026-09-21 운영자 지시): 오늘 원고 1편을 지우지 않고 보관함으로 옮긴 뒤 그 블로그 글만 새로 쓴다.
    //   mode 'same' = 같은 질문으로(사진은 새로 고름) / 'new' = 새 질문으로. 발행된 글은 거부. 실패하면 옛 원고를 되돌린다.
    if (url.pathname === '/api/rewrite' && req.method === 'POST') {
      const b = await body(req);
      const cfg = E.loadCfg();
      const file = path.basename(String(b.file || ''));
      const dateDir = path.join(cfg.draftsDir, E.today());
      const f = path.join(dateDir, file);
      if (!file || !fs.existsSync(f)) return send(400, { ok: false, msg: '오늘 원고가 없습니다: ' + file });
      const account = (file.match(/_(haocommunication\d*)_/) || [])[1] || '';
      const blog = cfg.blogs.find(x => x.account === account);
      if (!blog) return send(400, { ok: false, msg: '계정을 찾지 못했습니다: ' + file });
      const mode = b.mode === 'new' ? 'new' : 'same';
      JOB.targetBlogs = [blog.no];
      if (!runJob('다시쓰기', async () => {
        const RW = require('./rewrite-draft');
        const title = normT(E.extractTitle(fs.readFileSync(f, 'utf8')));
        jlog(`다시쓰기(${mode === 'new' ? '새 질문' : '같은 질문'}): 블로그${blog.no} ${account} — ${title.slice(0, 40)}`);
        let rec = null; try { rec = JSON.parse(fs.readFileSync(path.join(dateDir, '_posts.json'), 'utf8'))[file] || null; } catch {}
        if (rec && rec.publishedUrl) throw new Error('이미 발행된 글입니다(' + rec.publishedUrl + ') — 발행된 글은 다시쓰기 할 수 없습니다');
        const titles = await feedTitles(account);
        if (titles === null) throw new Error('블로그 피드 확인 실패 — 발행 여부를 알 수 없어 다시쓰기를 중단합니다(잠시 후 다시)');
        if (title && titles.some(t => t === title || (title.length > 10 && t.includes(title.slice(0, 20))))) throw new Error('이미 발행된 글입니다 — 발행된 글은 다시쓰기 할 수 없습니다');
        if (mode === 'new') { await refreshQuestions(); await syncPosted(); }
        const info = RW.prepare({ draftsDir: cfg.draftsDir, file, title, mode, usedLogFile: cfg.usedLog, log: jlog,
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

    if (url.pathname === '/api/post' && req.method === 'POST') {
      const b = await body(req);
      const mode = b.mode === 'publish' ? 'publish' : 'draft';
      // force=true 는 '하루 1편' 규칙을 무시하고 강행(수동 복구용). 기본은 규칙 적용.
      if (!runJob('게시(' + mode + ')', () => jobPost(mode, b.file, b.force === true))) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/generate-and-post' && req.method === 'POST') {
      const b = await body(req);
      const mode = b.mode === 'publish' ? 'publish' : 'draft';
      const gpBlogs = blogsForCount(b.count);
      JOB.targetBlogs = gpBlogs;
      if (!runJob('생성+게시(' + mode + ')', async () => {
        const rs = await jobGenerate(gpBlogs);
        if (rs.some(r => r.ok)) await jobPost(mode);
      })) return send(409, { ok: false, msg: '다른 작업 실행 중' });
      return send(200, { ok: true });
    }
    // ── Claude 다계정 관리 ──────────────────────────────
    if (url.pathname === '/api/account/switch' && req.method === 'POST') {
      const b = await body(req);
      const ok = require('./accounts').setActive(b.name);
      jlog(`계정 전환 → [${b.name}] ${ok ? 'OK' : '실패(없는 계정)'}`);
      return send(ok ? 200 : 400, { ok, msg: ok ? '' : '없는 계정' });
    }
    // 연동 1단계: 브라우저 OAuth URL 받기(로그인 프로세스는 코드 대기 상태로 유지)
    if (url.pathname === '/api/account/login' && req.method === 'POST') {
      const b = await body(req);
      const ACC = require('./accounts');
      const cur = await ACC.authStatus(b.name, E.CLAUDE, true);   // 이미 로그인돼 있으면 바로 알려준다
      if (cur.loggedIn) return send(200, { ok: true, loggedIn: true, email: cur.email, subscriptionType: cur.subscriptionType });
      const r = await ACC.loginStart(b.name, E.CLAUDE);
      jlog(`계정 [${b.name}] 연동 시작 — 브라우저 로그인 URL ${r.url ? '발급' : '대기'}`);
      return send(r.ok || r.url ? 200 : 400, r);
    }
    // 연동 2단계: 로그인 페이지의 코드 붙여넣기
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
      return send(200, previewWithFooter(fs.readFileSync(f, 'utf8'), path.basename(f), 'blogspot'), 'text/html; charset=utf-8');  // ★발행 형태 그대로(UTM+하단 배너)
    }
    send(404, { ok: false });
  } catch (e) { send(500, { ok: false, msg: e.message }); }
});

(async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === '--batch') {
    const mode = argv[1]; // 없으면 생성만
    console.log('배치 시작', E.today(), mode ? '(+게시 ' + mode + ')' : '(생성만)');
    const rs = await jobGenerate(E.loadCfg().blogs.map(b => b.no));
    if (mode && rs.some(r => r.ok)) await jobPost(mode === 'publish' ? 'publish' : 'draft');
    console.log('배치 종료:', JSON.stringify(rs.map(r => ({ blog: r.blog, ok: r.ok }))));
    process.exit(rs.every(r => r.ok) ? 0 : 2);
  }
  const port = E.loadCfg().port || 5044;
  server.listen(port, '127.0.0.1', () => console.log(`BloggerWriter: http://127.0.0.1:${port}  (claude: ${E.CLAUDE ? 'OK' : '없음'})`));
  // 시작 시 모든 계정의 로그인 상태(이메일·구독)를 한 번 갱신 → UI에 바로 표시(백그라운드, 실패해도 무시)
  try { require('./accounts').refreshAll(E.CLAUDE).catch(() => {}); } catch {}
})();
