// engine.js (blogspot) — 질문/FAQ/이미지 자동 선택 → claude -p 작성 → 검증 → 저장
// 티스토리(E:\haoc-tistory-auto)와 질문 CSV·사용 로그(_used_log.json)를 공유해 두 플랫폼 중복을 막는다.
// ★하오커뮤니케이션(haoc.co.kr)판(2026-09-14): 하오디자인 블로그스팟 엔진(C:\blogger-auto) 복제 + 블록 다중 질문·글 유형(info/portfolio)·평면 Drive 폴더·브랜드 규칙.
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const ACC = require('./accounts');  // Claude 다계정 전환/페일오버

const CFG_FILE = path.join(__dirname, 'writer_config.json');
function loadCfg() { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^﻿/, '')); }

// ── claude.exe 탐지 (티스토리판과 동일) ──────────────────
function findClaude() {
  const cands = [];
  const push = (p) => { try { if (p && fs.existsSync(p)) cands.push(p); } catch {} };
  try { push(execSync('where claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim()); } catch {}
  push(path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe'));
  push(path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'));
  const pkgRoot = path.join(process.env.LOCALAPPDATA || '', 'Packages');
  try {
    for (const d of fs.readdirSync(pkgRoot).filter(n => n.startsWith('Claude_'))) {
      const cc = path.join(pkgRoot, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code');
      try {
        const vers = fs.readdirSync(cc).filter(v => /^\d/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const v of vers) push(path.join(cc, v, 'claude.exe'));
      } catch {}
    }
  } catch {}
  return cands[0] || null;
}
const CLAUDE = findClaude();

// ── CSV 파서 (티스토리판과 동일 구조: 데이터는 4행부터) ──
function parseCSV(text) {
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function loadQuestions() {
  const cfg = loadCfg();
  return parseCSV(fs.readFileSync(cfg.csvFile, 'utf8')).slice(3);
}

// ── 공유 사용 로그 ───────────────────────────────────────
function loadUsedLog() {
  try { return JSON.parse(fs.readFileSync(loadCfg().usedLog, 'utf8')); } catch { return {}; }
}
function saveUsedLog(log) { fs.writeFileSync(loadCfg().usedLog, JSON.stringify(log, null, 2), 'utf8'); }
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 플랫폼 간 폴더 중복 방지 ───────────────────────────────
// 3개 프로그램이 같은 _used_log.json을 공유한다. 폴더를 고르는 즉시 '오늘 찜' 목록에 디스크로 기록해
// 다른 플랫폼(동시 실행 포함)이 같은 폴더·같은 이미지를 고르지 못하게 한다.
// '오늘 이미 쓴 폴더'만 하드 제외 — 같은 날 3개 플랫폼이 같은 폴더를 고르는 것을 막는다.
function claimedFoldersToday(cfg) {
  let log = {};
  try { log = JSON.parse(fs.readFileSync(cfg.usedLog, 'utf8')); } catch {}
  const set = new Set();
  const td = today();
  // ★재사용 정책(2026-07-31 변경): '3일 지나면 재사용'을 폐기 → '미사용을 다 쓴 뒤에만 재사용'.
  //   여기서는 '오늘 이미 쓴 폴더'만 하드 제외(같은 날 3플랫폼이 같은 폴더를 겹쳐 쓰는 것 방지).
  //   어제 이전에 쓴 폴더는 후보에 남기되, sortByLastUse가 '미사용 폴더를 항상 먼저' 돌려주므로
  //   미사용이 하나라도 남으면 재사용되지 않고, 미사용이 바닥나야 가장 오래전에 쓴 폴더부터 다시 쓴다.
  //   (cfg.imageReuseDays는 더 이상 쓰지 않음)
  for (const e of (log.globalUsedFolders || [])) {
    if (e && typeof e === 'object' && e.v && e.date === td) set.add(e.v);
  }
  const c = log.folderClaims;
  if (c && c.date === td) for (const n of (c.names || [])) set.add(n);
  return set;
}
function folderLastUse(cfg) {
  let log = {};
  try { log = JSON.parse(fs.readFileSync(cfg.usedLog, 'utf8')); } catch {}
  const m = new Map();
  for (const e of (log.globalUsedFolders || [])) {
    const v = (typeof e === 'string') ? e : (e && e.v);
    if (!v) continue;
    const d = (typeof e === 'string') ? '0000-00-00' : ((e && e.date) || '0000-00-00');
    const prev = m.get(v);
    if (prev === undefined || d > prev) m.set(v, d);
  }
  return m;
}
// ★내용 일치 우선(2026-08-10 정책): 질문·제목에서 업종 신호를 찾아, 폴더명이 같은 업종군에 걸리는 폴더를 앞세운다.
//   일치 폴더가 없으면 기존 순서 그대로 진행(가장 비슷한 이미지 사용 + alt를 글 주제에 맞춰 보정 — 프롬프트 정책과 한 쌍).
const INDUSTRY_SYN = [
  // ★하오커뮤니케이션 문맥 — 질문·제목의 '업종' 신호와 (하오디자인·하오스튜디오) 프로젝트 폴더명을 맞춘다
  ['뷰티', '화장품', '코스메', '코스메틱', '미용', '에스테', '스킨', '헤어', '네일', '살롱', '마스크팩', '앰플'],
  ['병원', '의원', '치과', '한의원', '메디', '클리닉', '약품', '제약', '요양', '보철', '헬스', '의료기기', '의료'],
  ['전시', '박람회', '엑스포', '부스', '컨벤션', '갤러리', '상담회', '바이어'],
  ['식품', '푸드', '음료', '카페', '베이커리', '농산', '수산', '축산', '주류', '반찬', '김치', '건강기능', '건기식', '영양', '홍삼', '차'],
  ['교육', '학원', '스쿨', '대학', '유치원', '청소년', '도서', '출판'],
  ['공장', '산업', '기계', '부품', '테크', '전자', '솔루션', '엔지니어', '드론', '검사', '장비', '계측', '제조', '금속', '설비', '자동차'],
  ['IT', '소프트웨어', '플랫폼', '앱', 'SaaS', '스타트업'],
  ['호텔', '리조트', '관광', '여행', '레저'],
  ['금융', '보험', '은행', '세무', '법무', '법률', '컨설팅'],
  ['건설', '건축', '인테리어', '부동산', '조경', '가구'],
  ['패션', '의류', '잡화', '주얼리', '액세서리', '신발'],
  ['반려', '펫', '애견', '유아', '아동', '키즈', '장난감'],
  ['관공서', '시청', '군청', '도청', '공단', '재단', '협회', '학회', '기관'],
  // ★서비스 종류(2026-09-18 하오커뮤니케이션 마케팅·웹 폴더): 질문의 서비스 단어와 폴더명을 맞춘다
  ['sns', '인스타', '릴스', '숏폼', '틱톡', '피드'],
  ['블로그', '포스팅', '상위노출'],
  ['인플루언서', '체험단', '바이어', '상담회', '전시회', '박람회', '부스', '해외'],
];
function preferContentMatch(folders, text) {
  const t = String(text || '').toLowerCase();
  if (!t) return folders;
  const groups = INDUSTRY_SYN.filter(g => g.some(k => t.includes(k)));
  if (!groups.length) return folders;
  const hit = f => groups.some(g => g.some(k => String(f.name || '').toLowerCase().includes(k)));
  const front = folders.filter(hit);
  return front.length ? front.concat(folders.filter(f => !hit(f))) : folders;
}
function sortByLastUse(folders, cfg) {
  const m = folderLastUse(cfg);
  const keyDate = f => [m.get(f.id), m.get(f.dir), m.get(f.name)].filter(Boolean).sort().pop() || '';
  return folders.map((f, i) => ({ f, i, d: keyDate(f) }))
                .sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : x.i - y.i))
                .map(o => o.f);
}
// ── 내용 중복(md5) 안전망 헬퍼: 폴더명이 달라도 같은 이미지를 담았으면 잡는다 ──
const crypto = require('crypto');
const ALL_DRAFT_DIRS = [
  'E:\\하커_tistory_원고',
  'E:\\하커_blogspot_원고',
  'E:\\하커_homepage_원고',
];
function fileMd5(p) { try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } }
// 최근 sinceDays일(3개 플랫폼) 원고 폴더의 이미지 md5 집합(썸네일 제외).
function recentImageMd5Set(sinceDays) {
  // ★2026-09-18: '실제로 글에 쓴 사진'(_used_images.json의 md5)만 중복으로 본다.
  //   예전엔 원고 폴더에 남은 후보 webp(안 쓴 것)까지 세어, 평면 폴더(웹)가 매번 6/6 중복 → 폴더 없음 → 정보글로 떨어졌다.
  const set = new Set();
  const cutoff = new Date(Date.now() - (sinceDays || 10) * 86400000).toISOString().slice(0, 10);
  for (const x of loadUsedImages(loadCfg())) if (x && x.md5 && (!x.date || x.date >= cutoff)) set.add(x.md5);
  return set;
}
// 고른 폴더를 globalUsedFolders에 {v,date:오늘}로 즉시 기록(디스크+메모리). 크로스플랫폼 race 방지 + LRU 기록 겸용.
function recordFolderUse(cfg, memLog, folder) {
  // ★하위 폴더 기록(2026-09-04): 이미지가 하위 폴더에서 나왔으면 그 하위 폴더도 같이 기록 —
  //   상위 폴더는 미사용 하위 폴더가 남아 있으면 다시 골라도 되지만, 한 번 쓴 하위 폴더는 재사용하지 않는다.
  const vals = [folder.dir, folder.id, folder.name].concat((folder.subFolders || []).flatMap(s => [s.id, s.name]));
  const entries = vals.filter(Boolean).map(v => ({ v, date: today() }));
  if (!entries.length) return;
  try {
    const l = JSON.parse(fs.readFileSync(cfg.usedLog, 'utf8'));
    l.globalUsedFolders = (l.globalUsedFolders || []).concat(entries);
    fs.writeFileSync(cfg.usedLog, JSON.stringify(l, null, 2));
  } catch {}
  if (memLog) memLog.globalUsedFolders = (memLog.globalUsedFolders || []).concat(entries);
}
function claimFolderToday(cfg, folder) {
  let log = {};
  try { log = JSON.parse(fs.readFileSync(cfg.usedLog, 'utf8')); } catch {}
  if (!log.folderClaims || log.folderClaims.date !== today()) log.folderClaims = { date: today(), names: [] };
  for (const v of [folder.id, folder.dir, folder.name].concat((folder.subFolders || []).flatMap(s => [s.id, s.name])).filter(Boolean))
    if (!log.folderClaims.names.includes(v)) log.folderClaims.names.push(v);
  try { fs.writeFileSync(cfg.usedLog, JSON.stringify(log, null, 2)); } catch {}
}


// ── 사용 행 판정(3개 프로그램 공용 규칙: postedRows=영구, writtenRows=3일 임시) ──
const WRITTEN_HOLD_DAYS = 3;
function usedRowSet(usedLog, blogNo) {
  // ★2026-09-18 운영자 지시: 영구 제외는 '발행 확인된 행(postedRows)'뿐. 원고만 쓴 행은 '오늘 고른 것'만 막는다(당일 3플랫폼 중복 방지).
  //   날짜가 지난 미발행 원고는 draftAlive(q)가 '원고 파일이 아직 남아 있는지'로 판단한다 — 원고를 지우면 그 질문은 다시 쓸 수 있다.
  const b = usedLog['blog' + blogNo] || {};
  const out = new Set(b.postedRows || []);
  for (const w of (b.writtenRows || [])) {
    if (w && typeof w === 'object' && w.row != null && w.date === today()) out.add(w.row);
  }
  return out;
}
// 아직 살아 있는(미발행) 원고가 있는 질문인가 — 3플랫폼 원고 폴더의 최근 10일 날짜 폴더에서 파일명에 질문이 들어 있는지 본다(보관함·발행완료 폴더는 제외).
let _aliveCache = { t: 0, names: [] };
function aliveDraftNames() {
  if (Date.now() - _aliveCache.t < 15000) return _aliveCache.names;
  const names = [];
  const cutoff = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  for (const base of ALL_DRAFT_DIRS) {
    let days = []; try { days = fs.readdirSync(base); } catch {}
    for (const d of days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < cutoff) continue;
      let files = []; try { files = fs.readdirSync(path.join(base, d)); } catch {}
      for (const f of files) if (/\.(html|txt)$/i.test(f) && f !== '사용내역.txt') names.push(f);
    }
  }
  _aliveCache = { t: Date.now(), names };
  return names;
}
function draftAlive(q) {
  const key = safeName(String(q || '')); if (key.length < 6) return false;
  return aliveDraftNames().some(n => n.includes(key));
}
// 블록/토픽 설정의 excludeQuestionPatterns(정규식 문자열 배열)에 걸리는 질문은 쓰지 않는다 — 예: 웹 주제의 '상세페이지' 질문
// ★질문 '내용' 기준 사용 판정(2026-09-19): 발행된 질문과 내용이 같으면 어느 열·어느 행에 있든 제외(3플랫폼·5블록 공통).
//   반대로 행 번호는 '발행됨'인데 그 행의 질문이 시트에서 다른 질문으로 바뀌었으면(postedMap에 적힌 내용과 다름) 새 질문으로 본다.
function normQ(q) { return String(q || '').replace(/\s+/g, ' ').replace(/[?？!.\s]+$/, '').trim(); }
function rowUsedQ(usedLog, key, n, q, used) {
  const nq = normQ(q);
  for (const k of Object.keys(usedLog || {})) {
    if (!/^blog\d+$/.test(k)) continue;
    const pm = (usedLog[k] || {}).postedMap || {};
    for (const r of Object.keys(pm)) if (normQ(pm[r]) === nq) return true;
  }
  if (!used.has(n)) return false;
  const b = (usedLog || {})['blog' + key] || {};
  const claimedToday = (b.writtenRows || []).some(w => w && typeof w === 'object' && w.row === n && w.date === today());
  const pm = b.postedMap || {};
  if (!claimedToday && (b.postedRows || []).includes(n) && pm[n] && normQ(pm[n]) !== nq) return false;  // 시트에서 교체된 새 질문
  return true;
}
function questionExcluded(conf, q) {
  const pats = (conf && conf.excludeQuestionPatterns) || [];
  return pats.some(p => { try { return new RegExp(p, 'i').test(q); } catch { return false; } });
}
function markWritten(usedLog, blogNo, row) {
  const key = 'blog' + blogNo;
  usedLog[key] = usedLog[key] || {};
  const w = (usedLog[key].writtenRows || []).filter(x => (typeof x === 'number' ? x : x.row) !== row);
  w.push({ row, date: today() });
  usedLog[key].writtenRows = w;
  usedLog[key].usedRows = [...new Set([...(usedLog[key].usedRows || []), row])];
}
function markPosted(usedLog, blogNo, row) {
  const key = 'blog' + blogNo;
  usedLog[key] = usedLog[key] || {};
  usedLog[key].postedRows = [...new Set([...(usedLog[key].postedRows || []), row])].sort((a, b) => a - b);
}


// ★질문 선점(2026-09-15): 고른 즉시 디스크의 _used_log.json을 새로 읽어 writtenRows에 기록한다(3일 임시).
//   예전엔 글이 다 써진 뒤에야 기록해, 그 수 분 동안 다른 플랫폼(동시 실행)이 같은 질문을 골라 중복이 났다.
function claimRow(cfg, memLog, usedKey, row) {
  if (!row) return;
  try {
    const l = JSON.parse(fs.readFileSync(cfg.usedLog, 'utf8'));
    markWritten(l, usedKey, row);
    fs.writeFileSync(cfg.usedLog, JSON.stringify(l, null, 2), 'utf8');
    if (memLog) { memLog['blog' + usedKey] = l['blog' + usedKey]; }
  } catch { try { markWritten(memLog, usedKey, row); } catch {} }
}

// ── 질문 선택 (3플랫폼 공용 로그) ──
function pickQuestion(blog, data, usedLog) {
  // ★하오커뮤니케이션(2026-09-14): blog.blocks = 질문 블록(CSV 열) 여러 개 지원 — 남은 질문이 가장 많은 블록부터 골라 균형을 맞춘다.
  //   usedNo = 사용기록 키(블록 기준 고정: 1=정부지원사업·2=디자인·3=웹·4=스튜디오·5=마케팅) — 3플랫폼이 같은 키를 써서 질문 중복을 막는다.
  const blocks = blog.blocks || [{ usedNo: blog.no, sheetBlock: blog.sheetBlock, qCol: blog.qCol, checkCol: blog.checkCol, rowFrom: blog.rowFrom, rowTo: blog.rowTo }];
  const stats = [];
  for (const bl of blocks) {
    const used = usedRowSet(usedLog, bl.usedNo != null ? bl.usedNo : blog.no);
    let remain = 0, first = null;
    for (let n = (bl.rowFrom || 1); n <= (bl.rowTo || 300); n++) {
      const r = data[n - 1]; if (!r) continue;
      const q = (r[bl.qCol - 1] || '').trim();
      const chk = (r[bl.checkCol - 1] || '').trim().toUpperCase();
      if (!q || chk === 'TRUE' || rowUsedQ(usedLog, (bl.usedNo != null ? bl.usedNo : blog.no), n, q, used) || draftAlive(q) || questionExcluded(bl, q)) continue;  // ★미발행 원고가 살아 있는 질문·제외 패턴 질문은 건너뜀
      remain++; if (!first) first = { row: n, question: q };
    }
    if (first) stats.push({ bl, remain, first });
  }
  if (!stats.length) return null; // 소진
  stats.sort((a, b) => b.remain - a.remain);
  return { row: stats[0].first.row, question: stats[0].first.question, block: stats[0].bl };
}

// ── FAQ 후보 (공유 faqLog 3일 제외) ─────────────────────
// ★FAQ 다양화(2026-07-28): 최근 14일 제외 + LRU 순 제공 + 풀 고갈 시 완화(티스토리판과 동일).
function faqCandidates(blog, data, usedLog, targetQ, todaysFaqs) {
  const key = blog.sheetBlock || blog.topic || ('col' + blog.qCol);
  const log = (usedLog.faqLog || {})[key] || [];
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const lastUse = new Map();
  for (const e of log) { const p = lastUse.get(e.q); if (!p || e.date > p) lastUse.set(e.q, e.date); }
  const all = [];
  for (let n = 1; n <= 300; n++) {
    const r = data[n - 1]; if (!r) break;
    const q = (r[blog.qCol - 1] || '').trim();
    if (!q || q === targetQ || todaysFaqs.has(q)) continue;
    all.push({ q, last: lastUse.get(q) || '' });
  }
  let pool = all.filter(x => !x.last || x.last < cutoff);
  if (pool.length < 15) pool = all;
  pool.sort((a, b) => (a.last < b.last ? -1 : a.last > b.last ? 1 : 0));
  return { key, candidates: pool.slice(0, 40).map(x => x.q) };
}

// ── Drive 공개 폴더 이미지 (티스토리판과 동일 로직) ───────
const IMG_EXT = /\.(jpe?g|png|webp)$/i;
const DRIVE_CACHE = new Map();
async function driveList(folderId) {
  const c = DRIVE_CACHE.get(folderId);
  if (c && Date.now() - c.t < 10 * 60000) return c.entries;
  const r = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}#list`,
    { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`drive 폴더 조회 HTTP ${r.status}`);
  const html = await r.text();
  const entries = [];
  const re = /<div class="flip-entry" id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?flip-entry-title">([^<]*)</g;
  let m;
  while ((m = re.exec(html))) entries.push({ id: m[1], name: m[3].trim(), isFolder: m[2].includes('/folders/') });
  DRIVE_CACHE.set(folderId, { t: Date.now(), entries });
  return entries;
}
const YEARISH = /^(19|20)\d{2}([\s~\-–—]+\d{2,4})?$/;
// ★컨테이너 폴더(2026-09-04): 연도(2023/2024-2025/2026)·poster·'New folder'처럼 프로젝트가 아니라
//   프로젝트들을 '담는' 폴더는 재귀로 펼쳐 그 안의 프로젝트 폴더를 후보에 넣는다(최대 3단계).
const isContainerFolder = n => YEARISH.test(n) || /^poster$/i.test(n) || /^new\s*folder/i.test(n);
async function driveProjectFolders(blog, cfg) {
  const out = [];
  const excluded = n => cfg.excludeFolderPatterns.some(p => n.toLowerCase().includes(p.toLowerCase()));
  async function expand(cat, folderId, depth) {
    let entries = [];
    try { entries = await driveList(folderId); } catch { return; }
    for (const e of entries.filter(x => x.isFolder)) {
      if (excluded(e.name)) continue;
      if (depth < 3 && isContainerFolder(e.name)) await expand(cat, e.id, depth + 1);
      else out.push({ cat, name: e.name, id: e.id });
    }
  }
  for (const cat of blog.categories) {
    const rootId = (cfg.imageCategoriesDrive || {})[cat];
    if (!rootId) continue;
    const before = out.length;
    await expand(cat, rootId, 1);
    // ★평면 폴더(2026-09-14): 루트에 프로젝트 하위 폴더가 없고 사진이 직접 들어 있으면(예: 하오스튜디오 '상세페이지') 루트 자체를 프로젝트 폴더로 쓴다.
    if (out.length === before) {
      try { const items = await driveList(rootId); if (items.filter(x => !x.isFolder && IMG_EXT.test(x.name)).length >= 2) out.push({ cat, name: cat, id: rootId, flat: true }); } catch {}
    }
  }
  return out;
}
// ★깊은 이미지 수집(2026-09-04): 프로젝트 폴더 직속 이미지 + 하위 폴더(2단계까지) 이미지를 모두 모은다.
//   상당수 프로젝트 폴더가 이미지를 자기 하위 폴더에만 담고 있어(직속 0~1장) 통째로 건너뛰어졌다.
async function driveListImagesDeep(folderId, cfg, depth, src) {
  let entries = [];
  try { entries = await driveList(folderId); } catch { return []; }
  // src = 이미지가 나온 '프로젝트 폴더 바로 아래 하위 폴더'(직속이면 null) — 하위 폴더 단위 사용기록·재사용 금지용
  const files = entries.filter(x => !x.isFolder && IMG_EXT.test(x.name)).map(x => ({ ...x, src: src || null }));
  if (depth > 1) {
    for (const d of entries.filter(x => x.isFolder)) {
      if (cfg.excludeFolderPatterns.some(p => d.name.toLowerCase().includes(p.toLowerCase()))) continue;
      files.push(...await driveListImagesDeep(d.id, cfg, depth - 1, src || { id: d.id, name: d.name }));
    }
  }
  return files;
}
// ★목업 우선 정렬: 입체·그림자 있는 연출 컷(mockup)을 앞에, PDF에서 뽑은 납작한 원본 페이지(_page-0001)를 뒤로.
// 알파벳순으로만 뽑으면 숫자로 시작하는 원본 스캔이 항상 앞을 차지해 목업이 후보에 못 든다.
const MOCKUP_RE = /mock\s*-?\s*ups?|목업|psd\s*template|template\s*psd/i;
const RAWPAGE_RE = /[_\-\s]page[_\-\s]?\d{2,}/i;
function imageRank(name) {
  if (MOCKUP_RE.test(name)) return 0;   // 목업 = 최우선
  if (RAWPAGE_RE.test(name)) return 2;  // 원본 페이지 스캔 = 최후순위
  return 1;                             // 그 외(thum 등)
}
function sortByMockup(files) {
  return files.sort((a, b) => (imageRank(a.name) - imageRank(b.name)) || a.name.localeCompare(b.name));
}
const MOCKUP_SCAN_LIMIT = 12;  // 목업 폴더를 찾아 최대 몇 개 폴더까지 뒤져볼지
// ★목업 강제(2026-09-16 운영자 지시): writer_config.mockupOnlyCategories(디자인 인쇄물 6폴더)에 든 카테고리는
//   파일명이 목업(mockup/목업)인 사진만 후보로 쓴다. 목업 파일이 없는 폴더는 건너뛰고(비목업 폴더 폴백 없음),
//   눈검사까지 끝내 목업이 없으면 원고를 저장하지 않는다(보류). 촬영·웹·마케팅 폴더는 기존 눈검사만 적용.
function mockupOnlyCat(cfg, cat) { return !!cat && (cfg.mockupOnlyCategories || []).includes(cat); }
// ★파일 단위 사용기록·주제 맞춤(2026-09-18 운영자 지시: "사진은 제목·내용과 맞게", 웹 평면 폴더가 매번 같은 6장→중복→정보글로 떨어지던 문제)
//   실제로 글에 쓴 사진만 {id,name,md5,date}로 _used_images.json(사용로그와 같은 폴더, 3플랫폼 공유)에 남긴다. _used_log.json은 통째로 덮어쓰이므로 별도 파일.
function usedImagesFile(cfg) { return path.join(path.dirname(cfg.usedLog), '_used_images.json'); }
function loadUsedImages(cfg) { try { const a = JSON.parse(fs.readFileSync(usedImagesFile(cfg), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function recordUsedImages(cfg, items) {
  if (!items || !items.length) return;
  try {
    const cur = loadUsedImages(cfg);
    for (const x of items) cur.push({ id: x.id || '', name: x.name || '', md5: (x.abs && fileMd5(x.abs)) || '', date: today() });
    fs.writeFileSync(usedImagesFile(cfg), JSON.stringify(cur, null, 2), 'utf8');
  } catch {}
}
// 질문 단어가 파일명에 얼마나 들어 있는지(간단 토큰 겹침) — 같은 폴더 안에서 주제와 가까운 파일을 앞세운다
function nameRelevance(name, q) {
  const n = String(name || '').toLowerCase(); let score = 0;
  for (const t of (String(q || '').toLowerCase().match(/[가-힣a-z0-9]{2,}/g) || [])) if (n.includes(t)) score += t.length;
  return score;
}
function rankByQuestion(files, q) {
  if (!q) return files;
  return files.map((f, i) => ({ f, i, r: nameRelevance(f.name, q) })).sort((a, b) => (imageRank(a.f.name) - imageRank(b.f.name)) || (b.r - a.r) || (a.i - b.i)).map(x => x.f);
}
// 눈검사가 돌려준 '주제와 잘 맞는 순서(best)'대로 후보를 재정렬(best에 없는 파일은 뒤로)
function orderByBest(list, best) {
  if (!best || !best.length) return list;
  const pos = (n) => { const i = best.indexOf(n); return i < 0 ? 999 : i; };
  return list.slice().sort((a, b) => pos(imgName(a)) - pos(imgName(b)));
}
const MOCKUP_ONLY_SCAN_LIMIT = 80;  // 목업 강제 카테고리에서 목업 폴더를 찾아 최대 몇 폴더까지 뒤질지

// ★산출물 매칭(2026-07-27): 질문이 말하는 인쇄물 '형태'에 맞는 이미지 카테고리만 쓴다.
//   업종(병원/뷰티 등)은 달라도 되지만 산출물 형태(포스터/리플렛/브로슈어…)는 반드시 일치해야 한다.
//   질문에 형태 단어가 없으면 null → 기존 카테고리 전체 사용.
const PRODUCT_CATS = [
  // ★하오커뮤니케이션(2026-09-14): 질문·제목이 말하는 '산출물/서비스 형태'에 맞는 이미지 카테고리만 쓴다.
  //   인쇄물(하오디자인 폴더)과 촬영(하오스튜디오 폴더)을 한 표에서 매칭. 형태 단어가 없으면 null → (auto 블록은 정보글, 그 외는 블록 기본 카테고리).
  { re: /포스터|현수막|배너|전단지|전단/i, cats: ['포스터'] },
  { re: /리플렛|리플릿/i, cats: ['리플렛'] },
  { re: /팜플렛|팸플릿|팜플릿/i, cats: ['팜플렛', '리플렛'] },
  { re: /카탈로그|카달로그|카다로그|룩북/i, cats: ['catalogue', 'brochure'] },
  { re: /브로슈어|브로셔|회사\s*소개서|제품\s*소개서|안내\s*책자|책자|사례집|도록|작품집|화보집/i, cats: ['brochure', 'catalogue'] },
  { re: /패키지|포장|라벨|단상자/i, cats: ['패키지'] },
  { re: /상세\s*페이지/i, cats: ['상세페이지', '제품촬영', '화장품촬영', '건강식품촬영', '식품촬영'] },
  { re: /촬영|화보|누끼|모델\s*컷|연출\s*컷|제품\s*사진|사진\s*보정|리터칭|스튜디오/i, cats: ['제품촬영', '화장품촬영', '건강식품촬영', '식품촬영'] },
];
function productCategoriesFor(text) {
  const hit = new Set();
  for (const p of PRODUCT_CATS) if (p.re.test(text || '')) p.cats.forEach(c => hit.add(c));
  return hit.size ? [...hit] : null;
}


async function pickImages(blog, cfg, usedLog, skip) {
  const used = claimedFoldersToday(cfg);  // ★공유 로그 + 오늘 다른 플랫폼이 찜한 폴더(디스크에서 새로 읽음)
  const skipSet = new Set(skip || []);   // 목업이 없어 탈락시킨 폴더
  const allFolders = (await driveProjectFolders(blog, cfg)).filter(f => !skipSet.has(f.name));
  // ★웹·마케팅(writer_config.fileLevelReuseCategories)은 폴더 단위가 아니라 사진 단위로 재사용을 막는다(2026-09-18) — 사진 20~37장짜리 폴더가 하루 한 번 쓰였다고 통째로 잠기면 주제에 맞는 폴더를 못 고른다.
  const _fileLevel = f => (cfg.fileLevelReuseCategories || []).includes(f.cat);
  let folders = allFolders.filter(f => _fileLevel(f) || (!used.has(f.id) && !used.has(f.name)));
  if (!folders.length) folders = allFolders;  // ★오늘까지 전부 소진 → 오늘 쓴 폴더도 재사용(최후 폴백)
  if (blog.industryKeywords.length) {
    folders = folders.filter(f => blog.industryKeywords.some(k => f.name.toLowerCase().includes(k.toLowerCase())));
    if (!folders.length) return null;
  }
  folders = sortByLastUse(folders, cfg);  // 오래 안 쓴 폴더 먼저 → 날짜 넘는 중복 최소화
  folders = preferContentMatch(folders, blog._q);  // ★질문 업종과 폴더명이 맞으면 그 폴더 우선
  // ★목업이 2장 이상 있는 폴더를 먼저 찾는다. 목업 없는 폴더에 걸리면 결국 납작한 원본 스캔만 나오기 때문.
  //   MOCKUP_SCAN_LIMIT개까지 뒤져보고 없으면 조건 없이 첫 폴더로 폴백(이미지 고갈 방지).
  const take = (f, files) => {  // 찜 안 함(pollution 방지) — globalUsedFolders로 중복 방지
    const picked = files.slice(0, Math.min(files.length > 12 ? 8 : 6, files.length));
    // ★이번에 이미지를 꺼낸 하위 폴더 목록 — recordFolderUse가 같이 기록해 하위 폴더 단위로 재사용을 막는다
    const subFolders = [...new Map(picked.filter(x => x.src).map(x => [x.src.id, x.src])).values()];
    return { folder: { ...f, subFolders }, images: picked };
  };
  let fallback = null, scanned = 0, strictScanned = 0;
  const usedSub = folderLastUse(cfg);  // 하위 폴더 사용기록(상시) — 한 번 쓴 하위 폴더는 다시 쓰지 않는다
  for (const f of folders) {
    let files = await driveListImagesDeep(f.id, cfg, 2);  // ★하위 폴더에만 이미지가 있는 프로젝트도 잡는다
    // ★하위 폴더 재사용 금지(2026-09-04): 상위 폴더는 다시 골라도, 이미 쓴 하위 폴더의 이미지는 제외
    files = files.filter(x => !x.src || (!usedSub.has(x.src.id) && !usedSub.has(x.src.name) && !used.has(x.src.id) && !used.has(x.src.name)));
    { const _ui = new Set(loadUsedImages(cfg).map(x => x.id).filter(Boolean)); const _fresh = files.filter(x => !_ui.has(x.id)); if (_fresh.length) files = _fresh; }  // ★이미 글에 쓴 사진은 후보에서 제외(전부 썼으면 재사용) — 평면 폴더도 매번 다른 사진
    const strict = mockupOnlyCat(cfg, f.cat);
    if (strict) {  // ★목업 강제: 목업 파일명만 후보, 없으면 이 폴더는 건너뜀(비목업 폴백 없음)
      files = files.filter(x => imageRank(x.name) === 0);
      if (!files.length) { if (++strictScanned >= MOCKUP_ONLY_SCAN_LIMIT) break; continue; }
      sortByMockup(files);
      return take(f, files);
    }
    if (files.length < 2) continue;
    sortByMockup(files);
    files = rankByQuestion(files, blog._q);  // ★질문과 파일명이 맞는 사진을 앞세움
    if (files.filter(x => imageRank(x.name) === 0).length >= 2) return take(f, files);  // 목업 폴더 — 바로 채택
    if (!fallback) fallback = { f, files };
    if (++scanned >= MOCKUP_SCAN_LIMIT) break;
  }
  return fallback ? take(fallback.f, fallback.files) : null;
}
// 이미지: 게시용은 lh3 공개 CDN URL, 열람용은 로컬 다운로드 사본
// ★=s1200 형식(2026-09-19): =w1200이면 Blogger가 썸네일 주소를 =s72-w1200-c 로 잘못 조립해(1200x1200·423KB) 관리자 글 목록 썸네일이 안 뜬다. =s1200이면 =s72-c(72x72)로 정상 치환된다.
function imgUrl(id) { return `https://lh3.googleusercontent.com/d/${id}=s1200`; }
async function stageImages(images, outDir, prefix) {
  const staged = [];
  for (let i = 0; i < images.length; i++) {
    const raw = path.join(outDir, `_dl_${prefix}_${i + 1}.bin`);
    let buf;
    for (let attempt = 1; attempt <= 3; attempt++) {  // ★일시적 네트워크(terminated 등) 재시도 — 한 장 실패로 글 전체가 죽지 않게
      try {
        const r = await fetch(`https://drive.google.com/uc?export=download&id=${images[i].id}`,
          { redirect: 'follow', signal: AbortSignal.timeout(90000) });
        buf = Buffer.from(await r.arrayBuffer());
        if (buf[0] === 0x3c) throw new Error('drive 파일 접근 불가(공유 확인) ' + images[i].id);
        break;
      } catch (e) {
        if (/접근 불가/.test(e.message) || attempt === 3) throw e;
        await new Promise(res => setTimeout(res, 800 * attempt));
      }
    }
    fs.writeFileSync(raw, buf);
    const out = path.join(outDir, `${prefix}_${i + 1}.webp`);
    let abs = raw;
    try {
      execSync(`ffmpeg -y -i "${raw}" -vf "scale='min(1200,iw)':-2" "${out}"`, { stdio: 'ignore' });
      if (fs.existsSync(out) && fs.statSync(out).size > 1000) { fs.unlinkSync(raw); abs = out; }
    } catch {}
    if (abs === raw) { const cp = path.join(outDir, `${prefix}_${i + 1}${path.extname(images[i].name) || '.jpg'}`); fs.renameSync(raw, cp); abs = cp; }
    staged.push({ id: images[i].id, name: images[i].name, url: imgUrl(images[i].id), abs });
  }
  return staged;
}

const SB_URL_DEFAULT = 'https://oaqrjrrgntlqmyxxovfn.supabase.co';
const SB_ANON_DEFAULT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9hcXJqcnJnbnRscW15eHhvdmZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NjQzMTUsImV4cCI6MjA5NzE0MDMxNX0.3bOfZOXVKSoI9ELfE7ZjWETuxvjpNYHdCBSIMrbAGtU';
async function homePosts() {
  const cfg = loadCfg();
  const key = cfg.supabaseAnonKey || SB_ANON_DEFAULT;
  const r = await fetch((cfg.supabaseUrl || SB_URL_DEFAULT) + '/rest/v1/overrides?select=v&k=eq.hv_posts',
    { headers: { apikey: key, Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(12000) });
  const j = await r.json();
  let v = j && j[0] && j[0].v; if (typeof v === 'string') v = JSON.parse(v);
  return Array.isArray(v) ? v : [];
}
async function homeColumnLinks() {
  try {
    return (await homePosts()).slice(0, 15)
      .map(p => ({ title: String(p.title || '').replace(/\s+/g, ' ').trim(), url: `https://haoc.co.kr/column-${p.id}.html` }))
      .filter(x => x.title.length > 6);
  } catch { return []; }
}

// ── 관련 글: 그 블로그 자신의 blogspot JSON 피드 ─────────
async function feedLinks(account) {
  try {
    const r = await fetch(`https://${account}.blogspot.com/feeds/posts/default?alt=json&max-results=30`,
      { signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    const items = [];
    for (const e of (j.feed && j.feed.entry) || []) {
      const alt = (e.link || []).find(l => l.rel === 'alternate');
      if (alt && alt.href) items.push({ title: (e.title && e.title.$t || '').trim(), url: alt.href });
      if (items.length >= 6) break;
    }
    return items;
  } catch { return []; }
}

// ── 프롬프트 조립 ────────────────────────────────────────
const SUBJECT_OF = { '정부지원사업': '정부지원사업(질문이 말하는 산출물/서비스 분야 중심)', '디자인': '홍보물 디자인', '웹': '홈페이지 제작', '스튜디오': '스튜디오 촬영', '마케팅': '마케팅' };
function buildPrompt(cfg, blog, target, faq, staged, links, homeCols) {
  const engine = fs.readFileSync(cfg.enginePrompt, 'utf8');
  const mode = staged.length ? 'portfolio' : 'info';
  const imgList = staged.map((s, i) =>
    `${i + 1}. 본문 삽입용 태그(그대로 사용, alt만 채울 것): <img src="${s.url}" alt="[여기에 완성형 alt - 하오커뮤니케이션 디자인 작업]" style="max-width:100%; height:auto;">\n   실제 파일(Read로 반드시 열어볼 것): ${s.abs}`).join('\n');
  const linkList = links.length ? links.map(l => `- ${l.title} : ${l.url}`).join('\n') : '(가져온 글 없음 — 관련 글 링크는 생략한다)';
  const homeList = (homeCols || []).length ? homeCols.map(l => `- ${l.title} : ${l.url}`).join('\n') : '(없음)';
  const faqList = faq.candidates.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const subject = SUBJECT_OF[blog.sheetBlock] || blog.sheetBlock || blog.topic;
  const td = today();
  const imageBlock = mode === 'portfolio'
    ? `■ [글 유형] 포트폴리오 — 이미지 후보 ★${staged.length}장 전부 Read로 열어보고 이 중 ★정확히 1장만 골라 쓴다(첫 H2 섹션 이후에 배치, 더 넣지 말 것):
${imgList}
 ① ★개인정보가 보이는 이미지는 쓰지 않는다 — 담당자 이름·이메일·전화번호·QR코드·명함·주소가 찍힌 면 제외.
 ② 산출물(인쇄물 연출 컷) 또는 촬영 결과물(제품·연출 컷)이 또렷한 사진 우선. 납작한 PDF 페이지·작업 중 컷은 피한다.
 ③ ★업종이 글 주제와 달라도 된다(산출물/서비스 '종류'만 맞으면 됨).
 ④ alt는 '이 글 주제(제목)'에 맞춰 완성형 문장으로 — 사진에 보이는 형태를 근거로, 업종·산출물 명칭은 제목을 따른다. 고객사·브랜드명 금지. ★맨 끝에 "- 하오커뮤니케이션 디자인 작업"/"- 하오커뮤니케이션 제작"/"- 하오커뮤니케이션 작업물" 중 하나.
 ⑤ 고른 이미지의 <img> 태그만 그대로 사용(URL 변경·생성 금지).`
    : `■ [글 유형] 정보글 — 사진이 없다. ★<img> 태그를 하나도 넣지 않는다. 본문 흐름이 이미지 없이도 완결되게 쓰고, 없는 프로젝트·고객사를 사례처럼 지어내지 않는다(예시는 "예를 들어 ○○ 기업이라면" 가정형).`;
  return `${engine}

---
[자동 주입 블록]

■ 오늘의 타겟 질문 — 이 질문이 글의 근거다. 이 질문을 한 사람이 만족할 '답'이 되는 글을 쓴다:
${target.question}

■ [주제] ${subject}
■ [발행처] https://${blog.account}.blogspot.com/  (스키마 @id·BreadcrumbList item·내부 링크 기준)
■ 오늘 날짜(발행일): ${td} → datePublished·dateModified와 글 URL의 /${td.slice(0, 4)}/${td.slice(5, 7)}/ 에 사용
■ 이 블로그의 고정 주제 라벨(keywords 첫 번째 라벨로 필수): ${blog.topic}
■ 슬러그(identifier)에 넣을 주제 영문 힌트: ${blog.slugTopic || 'haoc'}

■ FAQ 후보 — 같은 주제의 질문 목록. 이 목록을 소스1로 5개를 고르거나 발전시킨다(어미는 존댓말 의문형 ~요?):
${faqList}

${imageBlock}

■ 관련 글 목록([발행처] 블로그의 실제 최신 글 — 주제가 이어지는 것만 '함께 보면 좋은 글'에 1~2개, 없으면 생략):
${linkList}
■ 본사 칼럼(haoc.co.kr) 실제 글 — 주제가 정말 이어질 때만 1개까지 추가 가능(없으면 생략):
${homeList}

지금 작성하라.`;
}

// ── claude -p (비동기) ───────────────────────────────────
// claude.exe 1회 호출(주어진 계정 env로). 성공=응답문자열, 실패=throw(오류 메시지에 원인 텍스트 포함).
function spawnClaudeOnce(prompt, cfg, env) {
  const args = ['-p', '--model', cfg.model || 'opus', '--allowedTools', 'Read'];
  return new Promise((resolve, reject) => {
    const p = spawn(CLAUDE, args, { windowsHide: true, env });
    let out = '', err = '';
    const to = setTimeout(() => { try { p.kill(); } catch {} reject(new Error(`claude 시간 초과(${cfg.claudeTimeoutSec || 600}초)`)); }, (cfg.claudeTimeoutSec || 600) * 1000);
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(to); reject(e); });
    p.on('close', (code) => {
      clearTimeout(to);
      const c = out + '\n' + err;
      if (/Not logged in|Please run \/login/i.test(c)) return reject(new Error('Not logged in (login 필요)'));
      // ★한도/제한: claude가 짧은 안내문만 내고 종료(대개 exit≠0, 메시지가 stdout에 실림 — 예 "You've hit your weekly limit").
      //   정상 원고는 길기(수천 자) 때문에 'exit≠0 또는 300자 미만'일 때만 한도로 판정해 페일오버시킨다.
      if (ACC.isSwitchable(c) && (code !== 0 || out.trim().length < 300))
        return reject(new Error('usage limit: ' + c.replace(/\s+/g, ' ').trim().slice(0, 140)));
      if (!out.trim()) return reject(new Error('claude 빈 응답 ' + err.slice(0, 150)));
      resolve(out.trim());
    });
    p.stdin.write(prompt); p.stdin.end();
  });
}

// ★다계정 자동 페일오버: active 계정으로 시도 → 로그인/한도 오류면 그 계정을 잠시 쉬게 하고
//   건강한 다음 계정으로 전환해 재시도. 전환 불가·다른 오류면 그대로 throw.
async function runClaude(prompt, cfg, log) {
  if (!CLAUDE) return Promise.reject(new Error('claude 실행파일을 찾지 못했습니다.'));
  const tried = new Set();
  let name = ACC.activeName();
  let lastErr;
  for (let i = 0; i < 8; i++) {
    tried.add(name);
    log && log(`  claude 실행 (${cfg.model}) · 계정 [${name}] ...`);
    try {
      return await spawnClaudeOnce(prompt, cfg, ACC.envFor(name));
    } catch (e) {
      lastErr = e;
      if (!ACC.isSwitchable(e.message)) throw e;  // 로그인/한도 외(시간초과·네트워크 등)는 상위 재시도에 맡김
      ACC.markCooldown(name, /weekly/i.test(e.message) ? 12 * 3600 * 1000 : undefined);  // 주간 한도면 오래 쉬게
      const next = ACC.nextHealthy(name);
      log && log(`  ⚠ 계정 [${name}] 사용 불가(${e.message.slice(0, 45)}) → ${next ? `계정 [${next}]로 전환` : '전환할 계정 없음'}`);
      if (!next || tried.has(next)) throw new Error(`모든 계정 소진/미로그인: ${e.message.slice(0, 80)}`);
      ACC.setActive(next);  // 다음 글부터도 이 계정이 기본이 되게 유지
      name = next;
    }
  }
  throw lastErr || new Error('claude 호출 실패');
}

// ★보조 판정(사진 눈검사·사진 교체 계획·SEO 채점)은 빠른 모델로(2026-08-28 속도 개선).
//   본문 작성 품질과 무관한 판정 작업까지 opus로 돌아 생성이 오래 걸리던 것을 줄인다.
//   writer_config.json에 "judgeModel"을 넣으면 바꿀 수 있다(기본 sonnet).
const judgeCfg = cfg => ({ ...cfg, model: cfg.judgeModel || 'sonnet' });

// ── SEO/AEO/GEO 독립 채점(20점) — writer 자가채점과 별개로 '심사관' 역할의 claude가 근거를 대고 항목별 채점 ──
//   후하게 주지 말 것을 지시하고, 총점은 프로그램이 하위 점수를 clamp·합산해 계산(모델의 합계는 신뢰하지 않음).
const SEO_MAX = { title: 2, keywords: 2, structure: 2, meta: 1, snippet: 3, faq: 3, direct: 1, numbers: 2, entity: 2, trust: 2 };
async function scoreArticleSEO(html, blog, cfg, log) {
  // 메타 추출(엔진마다 헬퍼가 달라 자체 처리): META 주석 JSON 우선, 없으면 필드 정규식.
  let meta = {};
  const _mm = html.match(/<!--\s*META\s*([\s\S]*?)-->/);
  if (_mm) { try { meta = parseJsonLoose(_mm[1]) || {}; } catch {} }
  const _fld = k => meta[k] || ((html.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')) || [])[1] || '').replace(/\\"/g, '"');
  const headline = _fld('headline'), description = _fld('description'), keywords = _fld('keywords'), articleSection = _fld('articleSection');
  const body = html.replace(/<!--\s*META[\s\S]*?-->/, '').replace(/자가\s*채점[^\n<]*/g, '').replace(/^\s+/, '').trim();
  const metaBlock = `[이 글의 메타 — 발행 시 검색결과·스니펫에 실제로 적용되는 값(원고 본문엔 주석으로 들어 있어 아래에 따로 제공)]
- headline(제목): ${headline || '(없음)'}
- description(요약): ${description || '(없음)'}
- keywords(키워드): ${keywords || '(없음)'}
- articleSection(분류): ${articleSection || '(없음)'}`;
  const prompt = `당신은 한국어 블로그 칼럼의 SEO·AEO·GEO 품질을 엄격하게 채점하는 '독립 심사관'이다.
아래 원고를 기준표대로 항목별 정수 점수로 매긴다. 절대 후하게 주지 말고, 원고에서 근거가 확인되는 만큼만 준다.
각 항목마다 원고에서 인용하거나 확인한 '근거'를 한 줄로 남긴다. 근거를 못 대면 그 항목은 0~1점이다.

[기준 — 괄호가 만점]
■ SEO
- title(2): 제목에 산출물 키워드가 있고 실제 검색·추천형 형태이며 자연스러운가(명백한 번역투·전체가 딱딱한 명사나열·어색만 감점 — 질문형 뒤에 짧은 설명 꼬리가 붙는 형태는 정상, 감점 말 것)
- keywords(2): 핵심 키워드가 본문·소제목·FAQ에 5~8회 자연스럽게(과다·부족 감점)
- structure(2): 결론 우선 + 2~3문단 청크 + 표/카드 활용 + ★'내용 섹션 h2 소제목'들이 자연스러운 질문형인가(어색·문어체·기계적이면 감점). ★단 FAQ 섹션 제목 '자주 묻는 질문(FAQ)'은 고정 라벨이므로 질문형이 아니어도 절대 감점하지 말 것
- meta(1): 아래 [메타] 블록의 description·keywords가 적정한가(핵심 키워드 포함·길이 적당·중복 없음)와 모든 이미지에 완성형 alt가 있는가 — description/keywords는 반드시 [메타] 블록 값으로 판단(본문에 <meta>태그가 없다고 감점하지 말 것)
■ AEO
- snippet(3): 각 h2의 첫 문장이 그 자체로 인용 가능한 '일반화된 정답'인가(하나라도 약하면 감점)
- faq(3): FAQ 5개가 업종+상황 기반·본문 연결·질문형 어미·FAQ 스키마와 100% 일치인가
- direct(1): 도입부가 핵심 질문에 직접적으로 답하는가
■ GEO
- numbers(2): 규격·기간·수량 등 인용가치 있는 구체 수치·사실이 충분한가
- entity(2): 업종·산출물 정의가 명확하고 생성형 AI가 인용할 만한 신뢰 문장이 있는가
- trust(2): 이모지·중복표현·금지 태그·날조된(출처 불명의 지어낸) 사실이 없는가. ★중요: 이 글은 자사 칼럼이라 (a)도입 인사말('안녕하세요, OOO입니다'), (b)신뢰지표 블록(자사 경력·누적 실적 수치), (c)맨 아래 CTA(브랜드명·홈페이지)에 자사 브랜드명·실적이 들어가는 것이 '정상 구성'이다 → 이 세 블록의 브랜드명·실적은 절대 감점하지 말 것. 오직 '조언 본문 문단'과 'FAQ 답변'처럼 중립적이어야 할 정보 영역에 업체명이 새어 들어갔거나, 없는 사실을 지어냈을 때만 감점한다.

[출력 — 오직 JSON 하나만. 코드펜스·설명 금지]
{"seo":{"title":N,"keywords":N,"structure":N,"meta":N},"aeo":{"snippet":N,"faq":N,"direct":N},"geo":{"numbers":N,"entity":N,"trust":N},"evidence":{"title":"근거","keywords":"근거","structure":"근거","meta":"근거","snippet":"근거","faq":"근거","direct":"근거","numbers":"근거","entity":"근거","trust":"근거"},"weakest":"가장 약한 항목명과 이유 한 줄"}

${metaBlock}

[원고]
${body}`;
  let r = null;
  for (let attempt = 1; attempt <= 2 && !(r && r.seo); attempt++) {  // ★파싱 실패 시 1회 재시도(간헐적 JSON 깨짐 방지)
    try { r = parseJsonLoose(await runClaude(prompt, judgeCfg(cfg), log)); }
    catch (e) { log && log(`  ▣ SEO 채점 오류(${attempt}차, 재시도): ` + e.message.slice(0, 50)); }
  }
  if (!r || !r.seo) { log && log('  ▣ SEO 채점 파싱 실패(무시)'); return null; }
  const c = (v, m) => Math.max(0, Math.min(m, Math.round(Number(v) || 0)));
  const bd = {
    title: c(r.seo.title, 2), keywords: c(r.seo.keywords, 2), structure: c(r.seo.structure, 2), meta: c(r.seo.meta, 1),
    snippet: c(r.aeo && r.aeo.snippet, 3), faq: c(r.aeo && r.aeo.faq, 3), direct: c(r.aeo && r.aeo.direct, 1),
    numbers: c(r.geo && r.geo.numbers, 2), entity: c(r.geo && r.geo.entity, 2), trust: c(r.geo && r.geo.trust, 2),
  };
  const seo = bd.title + bd.keywords + bd.structure + bd.meta;       // /7
  const aeo = bd.snippet + bd.faq + bd.direct;                        // /7
  const geo = bd.numbers + bd.entity + bd.trust;                      // /6
  return { total: seo + aeo + geo, seo, aeo, geo, breakdown: bd, weakest: (r.weakest || '').toString().slice(0, 120), evidence: r.evidence || {} };
}

function cleanOutput(raw) {
  let t = raw.replace(/^```(html)?\s*/im, '').replace(/```\s*$/m, '').trim();
  const i = t.indexOf('<');
  if (i > 0) t = t.slice(i);
  // 블로그스팟판은 마지막 요소가 </script> (스키마를 숨김 div로 감싸지 않음)
  const endS = t.lastIndexOf('</script>');
  if (endS !== -1) t = t.slice(0, endS + '</script>'.length);
  return t;
}

// ── 목업 눈으로 확인 ──────────────────────────────────────
// 파일명(mockup/_page-0001)만 믿으면 이름을 다르게 붙인 폴더에서 납작한 원본 스캔이 그대로 실린다.
// 그래서 claude가 Read로 사진을 '열어보고' 목업인지 판정하게 한다.
const imgName = s => s.file || s.name || path.basename(s.abs || '');
const imgInHtml = (html, s) => !!((s.url && html.includes(s.url)) || (s.file && html.includes(s.file)));
const MOCKUP_DEF = `게시 적합 사진(=true) = 완성된 결과물이 또렷하게 보이는 사진. ★아래 중 하나에 해당하면 true:
  ① 인쇄물(책자·리플렛·패키지·포스터)이 '실물처럼' 입체로 놓인 연출 컷 — 원근·각도, 그림자, 종이 두께·말림 같은 물체감이 보인다
  ② 스튜디오 촬영 결과물 — 제품·연출·모델 컷처럼 실제 카메라로 찍힌 사진(배경·조명이 있는 촬영 컷)
  ③ 상세페이지 완성본이 전체적으로 보이는 화면(디자인이 완성된 상태)
  ④ 웹사이트·홈페이지 완성 화면 — 메인/서브 페이지 시안이나 실제 사이트 캡처처럼 디자인이 완성된 상태로 화면 전체 또는 주요 영역이 또렷하게 보인다(2026-09-18 하오커뮤니케이션 웹 폴더)
  ⑤ 마케팅 운영 결과 화면·현장 사진 — SNS 피드/게시물/릴스 화면, 블로그 글·검색 노출 화면, 광고 소재, 전시회·수출상담회·박람회 부스 운영 현장 사진(2026-09-18 하오커뮤니케이션 마케팅 폴더). 캡처 화면이라는 이유만으로 탈락시키지 않는다. 계정명·댓글 등에 개인정보 보호용 블러(흐림)가 일부 있어도 피드·게시물·반응 수치 같은 결과물이 보이면 true.
게시 부적합(=false, 탈락) = PDF에서 뽑은 납작한 정면 페이지 스캔(정면 평면 지면), 작업 중 화면·도면·시안 메모, 문서/표만 있는 이미지, 결과물이 거의 안 보이는 컷, 담당자 연락처·명함이 크게 보이는 면.
★애매하면 반드시 false로 판정한다.`;

// claude가 JSON 앞뒤에 설명·코드펜스를 붙여도 건져낸다.
// (첫 { ~ 마지막 } 를 통째로 집는 방식은 설명문에 중괄호가 하나만 있어도 깨진다 → 중괄호 균형으로 찾는다)
function parseJsonLoose(raw) {
  if (!raw) return null;
  const t = String(raw).replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch {}
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(t.slice(i, j + 1)); } catch {}
        break;
      }
    }
  }
  return null;
}

// 사진 목록을 실제로 열어보고 목업 여부를 판정 → { 파일명: true/false }
// 판정 자체가 실패하면 빈 객체(= 알 수 없음)를 돌려, 검사 오류로 원고가 망가지지 않게 한다.
async function judgeMockups(items, cfg, log, topic) {
  if (!items.length) return { mock: {}, dupGroups: [] };
  const prompt = `아래 이미지 파일들을 Read 도구로 하나씩 실제로 열어서 보고, 두 가지를 판정해줘.

[1] 각 파일이 '게시에 쓸 수 있는 완성 결과물 사진(인쇄물 연출 컷 / 촬영 컷 / 상세페이지 완성본 / 웹사이트 완성 화면 / 마케팅 운영 결과 화면·현장 사진)'인지.
${MOCKUP_DEF}

[2] ★서로 '디자인은 사실상 같고 배경색·색조만 다른'(같은 시안의 다른 배경 버전) 사진들을 그룹으로 묶어라.
  - 지면/제품 디자인이 같고 배경색만 다르면 → 같은 그룹.
  - 디자인이 조금이라도 다르면(다른 지면·다른 산출물) → 묶지 마라.
  - 그런 쌍이 하나도 없으면 dupGroups는 빈 배열.

${topic ? `[3] ★이 글의 주제(질문): "${String(topic).replace(/[`$\\]/g, '')}"\n  - ★[1]의 true/false는 이 주제와 무관하게 '사진 자체'만 보고 판정한다. 주제와 업종이 달라도 결과물이 또렷하면 true다(주제 때문에 false로 바꾸지 마라).\n  - 그다음 [1]에서 true인 파일들을 '이 주제·내용과 잘 어울리는 순서'로 best 배열에 나열해라(가장 잘 맞는 파일이 맨 앞, true 파일이 있으면 best에 최소 1개는 넣는다).\n  - 순위 기준: ① 서비스 종류 일치가 가장 중요(예: 인스타·릴스·SNS 운영 질문 ↔ SNS 피드/게시물/릴스 화면, 블로그 질문 ↔ 블로그 글·검색 노출 화면, 바이어·전시회 질문 ↔ 상담회·부스 현장, 홈페이지·쇼핑몰·상세페이지 질문 ↔ 해당 웹 화면) ② 그다음 업종(카페·식당·화장품·제조 등)이 가까운 것. 업종이 달라도 서비스 종류가 같으면 잘 맞는 것으로 본다.\n` : ''}
파일 목록:
${items.map(t => `- ${imgName(t)} → ${t.abs}`).join('\n')}

다른 설명 없이 아래 JSON만 출력해:
{"results":[{"file":"파일명","isMockup":true}],"dupGroups":[["같은디자인파일A","같은디자인파일B"]],"best":["주제와 가장 잘 맞는 파일명","그다음 파일명"]}`;

  // 파싱이 깨지면 검사가 통째로 무력화되므로 1회 재시도한다.
  for (let tryNo = 1; tryNo <= 2; tryNo++) {
    let raw;
    try { raw = await runClaude(prompt, judgeCfg(cfg), null); }
    catch (e) { log && log(`  이미지 눈검사 실행 실패(${tryNo}차): ${e.message}`); continue; }
    const parsed = parseJsonLoose(raw);
    const results = parsed && Array.isArray(parsed.results) ? parsed.results : null;
    if (results && results.length) {
      const mock = {};
      for (const r of results) if (r && r.file) mock[r.file] = r.isMockup === true;
      const dupGroups = (parsed && Array.isArray(parsed.dupGroups))
        ? parsed.dupGroups.filter(g => Array.isArray(g) && g.length >= 2) : [];
      const best = (parsed && Array.isArray(parsed.best)) ? parsed.best.filter(x => typeof x === 'string') : [];
      return { mock, dupGroups, best };
    }
    log && log(`  이미지 눈검사 응답 파싱 실패(${tryNo}차): ${String(raw).replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  log && log('  ⚠ 이미지 눈검사 못 함(2회 모두 실패) — 사진 확인 없이 진행');
  return { mock: {}, dupGroups: [] };
}

// 원고에 실제로 들어간 사진만 검사 → 목업이 아닌 파일명 배열
async function verifyMockupsVisually(html, staged, cfg, log) {
  const used = staged.filter(s => imgInHtml(html, s));
  if (!used.length) return [];
  const judged = await judgeMockups(used, cfg, log);
  const mock = judged.mock || {};
  const dupGroups = judged.dupGroups || [];
  if (!Object.keys(mock).length && !dupGroups.length) return [];
  const bad = used.map(imgName).filter(n => mock[n] === false);
  // ★같은 디자인(배경색만 다른) 그룹은 하나만 남기고 나머지는 교체 대상에 추가한다.
  const dupExtra = [];
  for (const g of dupGroups) {
    const inUsed = g.filter(n => used.some(s => imgName(s) === n));
    for (let i = 1; i < inUsed.length; i++) if (!bad.includes(inUsed[i]) && !dupExtra.includes(inUsed[i])) dupExtra.push(inUsed[i]);
  }
  const all = [...new Set([...bad, ...dupExtra])];
  log && log(`  이미지 눈검사: 목업 ${used.length - bad.length}/${used.length}`
    + (bad.length ? ` | 목업아님: ${bad.join(', ')}` : '')
    + (dupExtra.length ? ` | 중복(배경색만 다름): ${dupExtra.join(', ')}` : ''));
  return all;
}

// 마커/태그 한 곳만 교체 — 티스토리는 [[IMG: 파일 | alt]], 나머지는 <img src=... alt=...>
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function swapOneImage(html, oldS, newS, newAlt) {
  if (oldS.file && html.includes(oldS.file)) {
    const re = new RegExp('\\[\\[IMG:\\s*' + esc(oldS.file) + '\\s*\\|[^\\]]*\\]\\]');
    return html.replace(re, `[[IMG: ${newS.file} | ${newAlt}]]`);
  }
  if (oldS.url && html.includes(oldS.url)) {
    const m = html.match(new RegExp('<img[^>]*' + esc(oldS.url) + '[^>]*>'));
    if (!m) return html;
    let tag = m[0].split(oldS.url).join(newS.url);
    tag = /alt\s*=\s*"/.test(tag) ? tag.replace(/alt\s*=\s*"[^"]*"/, `alt="${newAlt}"`) : tag.replace('<img', `<img alt="${newAlt}"`);
    return html.split(m[0]).join(tag);
  }
  return html;
}

// ★납작한 사진만 목업으로 갈아끼운다 — 글 전체를 다시 쓰지 않는다.
// 같은 폴더의 '아직 안 쓴 후보' 중 실제로 목업인 것을 찾아 교체하고, alt와
// 그 사진을 직접 가리키는 문장만 고친다.
// 반환: { html, fixed:[...], left:[...] }  left가 비면 완전 해결.
async function repairFlatImages(html, staged, badNames, cfg, log) {
  const usedNow = staged.filter(s => imgInHtml(html, s));
  const keptUsed = usedNow.filter(s => !badNames.includes(imgName(s)));
  const spareAll = staged.filter(s => !imgInHtml(html, s));
  if (!spareAll.length) return { html, fixed: [], left: badNames };

  // ★스페어를 판정하되, '남는 사진과 디자인이 같은(배경색만 다른)' 스페어는 교체 후보에서 뺀다.
  const judged = await judgeMockups([...keptUsed, ...spareAll], cfg, log);
  const mock = judged.mock || {};
  const dupWithKept = new Set();
  for (const g of (judged.dupGroups || [])) {
    if (g.some(n => keptUsed.some(k => imgName(k) === n))) g.forEach(n => dupWithKept.add(n));
  }
  const spare = spareAll.filter(s => mock[imgName(s)] === true && !dupWithKept.has(imgName(s)));
  if (!spare.length) { log && log('  교체용(디자인이 다른) 목업이 이 폴더에 없음'); return { html, fixed: [], left: badNames }; }

  const bad = staged.filter(s => badNames.includes(imgName(s)));
  const pairs = bad.slice(0, spare.length).map((b, i) => ({ old: b, neu: spare[i] }));

  const prompt = `아래 원고에서 지정한 사진만 목업 사진으로 교체하려고 한다. ★원고를 다시 쓰지 마라. 아래 요청한 JSON만 내라.

교체할 사진(납작하거나 다른 사진과 디자인이 겹쳐서 빼야 함) → 대신 넣을(디자인이 다른) 목업 사진:
${pairs.map(p => `- ${imgName(p.old)}  →  ${imgName(p.neu)} (${p.neu.abs})`).join('\n')}

새로 넣을 목업 사진을 Read 도구로 실제로 열어보고, 사진 내용에 맞는 alt를 써라.
alt = 업종 + 산출물/서비스 + 무엇이 보이는지, 끝에 '- 하오커뮤니케이션 디자인 작업'. ★사진 속 고객사·브랜드명은 쓰지 않는다.

그리고 원고 본문에 '교체되는 사진'을 직접 묘사하는 문장이 있으면(예: "위 사진은 ~ 표지예요") 새 사진에 맞게 그 문장만 고쳐라. 그런 문장이 없으면 textFixes는 빈 배열로 둬라.
find 는 원고에 있는 문장을 한 글자도 틀리지 않게 그대로 적어야 한다.

원고:
${html}

다른 설명 없이 아래 JSON만 출력해:
{"swaps":[{"old":"교체할 파일명","alt":"새 alt"}],"textFixes":[{"find":"원문 그대로","replace":"고친 문장"}]}`;

  let plan = null;
  for (let tryNo = 1; tryNo <= 2 && !plan; tryNo++) {
    let raw;
    try { raw = await runClaude(prompt, judgeCfg(cfg), null); }
    catch (e) { log && log(`  이미지 교체 실행 실패(${tryNo}차): ${e.message}`); continue; }
    const p = parseJsonLoose(raw);
    if (p && Array.isArray(p.swaps)) plan = p;
    else log && log(`  이미지 교체 응답 파싱 실패(${tryNo}차): ${String(raw).replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  if (!plan) return { html, fixed: [], left: badNames };

  let out = html; const fixed = [];
  for (const sw of (plan.swaps || [])) {
    const p = pairs.find(x => imgName(x.old) === sw.old);
    if (!p) continue;
    const before = out;
    out = swapOneImage(out, p.old, p.neu, (sw.alt || '').trim() || imgName(p.neu));
    if (out !== before) fixed.push(`${imgName(p.old)} → ${imgName(p.neu)}`);
  }
  for (const t of (plan.textFixes || [])) {
    if (t && t.find && out.includes(t.find)) out = out.split(t.find).join(t.replace || '');
  }
  const left = badNames.filter(n => out.includes(n));
  if (fixed.length) log && log(`  사진만 교체: ${fixed.join(' / ')}`);
  return { html: out, fixed, left };
}

// ── 검증 ─────────────────────────────────────────────────
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
function extractTags(html) {
  const m = html.match(/"keywords"\s*:\s*"([^"]+)"/);
  return m ? m[1].split(',').map(t => t.trim()).filter(Boolean) : [];
}
function extractTitle(html) {
  const m = html.match(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"') : '';
}
function extractFaqs(html) {
  const out = [];
  const re = /"@type"\s*:\s*"Question"\s*,\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m; while ((m = re.exec(html))) out.push(m[1].replace(/\\"/g, '"'));
  return out;
}
function extractSlug(html) {
  const m = html.match(/"identifier"\s*:\s*"([a-z0-9-]+)"/);
  return m ? m[1] : '';
}
// ★메타 description(스키마 BlogPosting) — 검색 스니펫 요약. 채점기(scoreArticleSEO)와 동일 소스(스키마)를 읽는다.
function extractDescription(html) {
  const m = html.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"') : '';
}
// ★FAQPage 답변 텍스트 — FAQ는 중립 정보영역이라 브랜드명이 새어들면 GEO trust 감점.
function extractFaqAnswers(html) {
  const out = [];
  const re = /"@type"\s*:\s*"Answer"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m; while ((m = re.exec(html))) out.push(m[1].replace(/\\"/g, '"'));
  return out;
}
const BRAND_KO = '하오커뮤니케이션';  // FAQ 질문/답변 등 중립 영역에 새어들면 안 되는 자사 브랜드명
function validate(html, staged, topic) {
  const errs = [];
  const score = (html.match(/자가 채점:\s*(\d+)\s*\/\s*20/) || [])[1];
  if (score && parseInt(score, 10) < 18) errs.push(`자가 채점 ${score}/20 < 18`);
  if (!/"headline"\s*:\s*"[^"]{5,}/.test(html)) errs.push('스키마 headline 없음');
  // ★후보 중 2~3장 선택 방식 — 후보 URL 안에서 골랐는지 검증
  const usedImgs = staged.filter(s => html.includes(s.url));
  // ★하오커뮤니케이션: 포트폴리오형=정확히 1장, 정보글형(staged 없음)=0장
  const need = staged.length ? 1 : 0;
  if (usedImgs.length < need) errs.push(`본문 이미지 ${usedImgs.length}장 (정확히 ${need}장 필요)`);
  if (usedImgs.length > need) errs.push(need ? `본문 이미지 ${usedImgs.length}장 (정확히 ${need}장만)` : `정보글에는 이미지를 넣지 않는다(${usedImgs.length}장 발견)`);
  const imgSrcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(m => m[1]);
  const validUrls = new Set(staged.map(s => s.url));
  const badImg = imgSrcs.filter(u => !validUrls.has(u));
  if (badImg.length) errs.push('후보에 없는 이미지 URL: ' + badImg[0].slice(-30));
  if (EMOJI_RE.test(html)) errs.push('이모지 발견');
  const textLen = html.replace(/<[^>]+>/g, '').replace(/\s/g, '').length;
  if (textLen < 1500) errs.push(`본문 분량 부족(공백 제외 약 ${textLen}자)`);
  if (/<h1[\s>]/i.test(html)) errs.push('본문에 h1 존재');
  if (html.includes('`')) errs.push('백틱(`) 잔존 — 잡담/코드펜스 섞임');
  if ((html.match(/함께 보면 좋은 글/g) || []).length > 1) errs.push("'함께 보면 좋은 글' 문단 2개 이상");
  const faqs = extractFaqs(html);
  if (faqs.length !== 5) errs.push(`스키마 FAQ ${faqs.length}개(5개여야 함)`);
  const faqBanmal = faqs.filter(q => !/요\s*\?\s*$/.test(q.trim()));
  if (faqBanmal.length) errs.push(`FAQ ${faqBanmal.length}개가 존댓말 의문형(~요?)으로 안 끝남(반말 금지)`);
  // ★메타 description 필수 — 누락 시 검색결과 스니펫 요약이 통째로 비어 meta(SEO) 점수 상실(과거 blogspot 일괄 감점 지점).
  const desc = extractDescription(html);
  if (!desc) errs.push('스키마 description(검색 설명) 없음 — 120~150자로 반드시 넣을 것');
  else if (desc.length < 60) errs.push(`description 너무 짧음(${desc.length}자) — 120~150자로`);
  else if (desc.length > 175) errs.push(`description 너무 김(${desc.length}자) — 120~150자 한 줄로`);
  if (/[■①②③·\n]/.test(desc)) errs.push('description에 기호(■·①)·줄바꿈 금지 — 쉼표·마침표만');
  if (!/exportvoucher\.com|mssmiv\.com|bizinfo\.go\.kr|mss\.go\.kr|kosmes\.or\.kr/.test(html)) errs.push('공식 출처 링크(기업마당/수출바우처/혁신바우처 등) 1개 이상 필요');
  // ★브랜드명 누수 방지 — FAQ 질문·답변은 중립 정보영역이어야 함(GEO trust 감점의 최다 원인). 인사·신뢰박스·CTA에서만 브랜드명 허용.
  const leakAns = extractFaqAnswers(html).filter(a => a.includes(BRAND_KO));
  if (leakAns.length) errs.push(`FAQ 답변 ${leakAns.length}개에 브랜드명(${BRAND_KO}) 노출 — FAQ 답은 중립적으로(업체명 빼고)`);
  const leakQ = faqs.filter(q => q.includes(BRAND_KO));
  if (leakQ.length) errs.push(`FAQ 질문 ${leakQ.length}개에 브랜드명(${BRAND_KO}) 노출 — 질문은 중립적으로`);
  const junkTag = html.match(/<\/?(?!\/?(table|tr|td|th|thead|tbody|p|span|strong|br|a|h2|div|script|img|em|b|i|ul|ol|li)\b)[a-z][a-z0-9]*[^>]*>/i);
  if (junkTag) errs.push('허용 외 태그: ' + junkTag[0].slice(0, 30));
  const tags = extractTags(html);
  if (tags.length < 3) errs.push(`라벨 부족(${tags.length}개) — 3~5개`);
  if (tags.length > 5) errs.push(`라벨 과다(${tags.length}개) — 5개 이하`);
  else if (topic && !tags.includes(topic)) errs.push(`고정 주제 라벨 "${topic}" 누락`);
  const slug = extractSlug(html);
  if (!slug) errs.push('영문 슬러그(identifier) 없음');
  else if (!/^[a-z0-9]+(-[a-z0-9]+){1,7}$/.test(slug)) errs.push('슬러그 형식 오류: ' + slug.slice(0, 40));
  return errs;
}
function safeName(s) { return s.replace(/[\\/:*?"<>|]/g, '').replace(/\?+\s*$/, '').trim(); }

// ── 사용내역 기록 ────────────────────────────────────────
// ── Drive 경로 표기(사용자가 used 폴더로 옮길 때 찾아가기 쉽게) ──
const CAT_PATH = {
  catalogue: '하오디자인 > 카달로그/브로슈어 > catalogue',
  brochure: '하오디자인 > 카달로그/브로슈어 > brochure',
  '리플렛': '하오디자인 > 리플렛/팜플렛 > 리플렛',
  '팜플렛': '하오디자인 > 리플렛/팜플렛 > 팜플렛',
  '패키지': '하오디자인 > 패키지',
  '포스터': '하오디자인 > 포스터/전단지',
  '제품촬영': '하오스튜디오 > 제품',
  '화장품촬영': '하오스튜디오 > 화장품',
  '건강식품촬영': '하오스튜디오 > 건강식품',
  '식품촬영': '하오스튜디오 > 식품',
  '상세페이지': '하오스튜디오 > 상세페이지',
};
const driveFolderUrl = (id) => id ? `https://drive.google.com/drive/folders/${id}` : '?';

function appendUsageReport(dateDir, e) {
  const lines = [
    `■ [블로그스팟] 블로그${e.blogNo} ${e.topic} (${e.account}) — ${e.time}`,
    `  제목: ${e.title}`,
    `  질문: [${e.sheetKey}열 ${e.row}번째 질문 = 시트 ${e.row + 3}행] ${e.question}`,
    ...(e.imageNames.length ? [
      `  ── used 폴더로 옮길 이미지 ──`,
      `  위치: ${CAT_PATH[e.cat] || e.cat || '?'} > ${e.folderName}`,
      `  폴더 링크: ${driveFolderUrl(e.folderId)}`,
      `  ★실제 사용한 파일(${e.imageNames.length}장): ${e.imageNames.join(', ')}`,
      `  (used로 옮겨도 본문 이미지 링크는 유지됨 — 삭제·공유해제만 금지)`,
    ] : [`  글 유형: 정보글(사진 없음)`]),
    `  라벨: ${(e.tags || []).join(', ')}`,
    `  FAQ(5개): ${e.faqs.map((q, i) => `\n    ${i + 1}. ${q}`).join('')}`,
    ...(e.score ? [
      `  ▣ SEO/AEO/GEO 채점: ${e.score.total}/20  (SEO ${e.score.seo}/7 · AEO ${e.score.aeo}/7 · GEO ${e.score.geo}/6)${e.score.total >= 18 ? '  ✅ 기준 충족' : '  ⚠ 18점 미만 — 검토 필요'}`,
      `     세부: 제목 ${e.score.breakdown.title}/2·키워드 ${e.score.breakdown.keywords}/2·구조 ${e.score.breakdown.structure}/2·메타 ${e.score.breakdown.meta}/1 | 정답문 ${e.score.breakdown.snippet}/3·FAQ ${e.score.breakdown.faq}/3·직답 ${e.score.breakdown.direct}/1 | 수치 ${e.score.breakdown.numbers}/2·전문성 ${e.score.breakdown.entity}/2·신뢰 ${e.score.breakdown.trust}/2`,
      `     약점: ${e.score.weakest || '-'}`,
    ] : []),
    '',
  ];
  fs.appendFileSync(path.join(dateDir, '사용내역.txt'), lines.join('\n') + '\n', 'utf8');
}
// ── SEO/AEO/GEO 채점 누계 CSV(엑셀에서 열어 열별로 검토) ──
function appendScoreCsv(e) {
  const f = path.join(ALL_DRAFT_DIRS[0], '_seo_scores.csv');  // 3개 플랫폼 공용(티스토리 원고 폴더에 1개)
  const b = e.score.breakdown, ev = e.score.evidence || {};
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, '﻿' + ['날짜', '플랫폼', '계정', '제목', '총점/20', '기준충족', 'SEO/7', 'AEO/7', 'GEO/6',
      '제목/2', '키워드/2', '구조/2', '메타/1', '정답문/3', 'FAQ/3', '직답/1', '수치/2', '전문성/2', '신뢰/2', '약점',
      '근거_제목', '근거_정답문', '근거_FAQ', '근거_수치'].join(',') + '\n', 'utf8');
  }
  fs.appendFileSync(f, [q(e.date), q(e.platform), q(e.account), q(e.title), e.score.total, (e.score.total >= 18 ? 'O' : 'X'),
    e.score.seo, e.score.aeo, e.score.geo,
    b.title, b.keywords, b.structure, b.meta, b.snippet, b.faq, b.direct, b.numbers, b.entity, b.trust, q(e.score.weakest),
    q(ev.title), q(ev.snippet), q(ev.faq), q(ev.numbers)].join(',') + '\n', 'utf8');
}


// ── 블로그 1개 생성 ─────────────────────────────────────
async function generateOne(blogNo, ctx, overrides = {}) {
  const cfg = loadCfg();
  const blog = cfg.blogs.find(b => b.no === blogNo);
  const log = ctx.log || (() => {});
  const dateDir = path.join(cfg.draftsDir, today());
  fs.mkdirSync(dateDir, { recursive: true });
  const recentImgSet = recentImageMd5Set(cfg.dupCheckDays || 10);  // 내용 중복 안전망 스냅샷

  const target = overrides.question
    ? { row: overrides.row || 0, question: overrides.question, block: (blog.blocks || []).find(b => overrides.block != null && b.usedNo === overrides.block) || null }
    : pickQuestion(blog, ctx.data, ctx.usedLog);
  if (!target) return { ok: false, blog: blogNo, reason: '질문 소진(티스토리·홈페이지 사용분 포함 제외 후)' };
  // ★블록 다중 지원 — 선택된 블록의 주제 태그·열·슬러그·이미지 카테고리·글 유형을 적용한 유효 blog
  const bl = target.block || (blog.blocks && blog.blocks[0]) || null;
  const eff = bl
    ? { ...blog, topic: bl.topicTag || blog.topic, sheetBlock: bl.sheetBlock || blog.sheetBlock, qCol: bl.qCol || blog.qCol, checkCol: bl.checkCol || blog.checkCol,
        slugTopic: bl.slugTopic || blog.slugTopic, categories: (bl.categories && bl.categories.length) ? bl.categories : blog.categories, imageMode: bl.imageMode || blog.imageMode || 'portfolio' }
    : { ...blog, imageMode: blog.imageMode || 'portfolio' };
  const usedKey = (bl && bl.usedNo != null) ? bl.usedNo : blogNo;
  log(`[블로그${blogNo} ${blog.account}] 질문(${eff.sheetBlock || ''} 행${target.row}): ${target.question.slice(0, 40)}...`);
  if (!overrides.question) claimRow(cfg, ctx.usedLog, usedKey, target.row);  // ★즉시 선점

  const faq = faqCandidates(eff, ctx.data, ctx.usedLog, target.question, ctx.todaysFaqs);

  // ★글 유형(info/portfolio) + 질문 속 산출물 형태에 맞춰 이미지 카테고리를 좁힌다.
  const prodCats = productCategoriesFor(target.question);
  const drv = cfg.imageCategoriesDrive || {};
  const autoImg = eff.imageMode === 'portfolio-auto';  // ★사진 있으면 포트폴리오, 없으면 정보글(2026-09-16 운영자 지시)
  let mode = overrides.mode || (eff.imageMode === 'info' ? 'info' : eff.imageMode === 'auto' ? (prodCats ? 'portfolio' : 'info') : 'portfolio');
  let imgBlog = { ...eff, ...(prodCats && !autoImg ? { categories: prodCats.filter(c => drv[c]) } : {}), _q: target.question };
  if (!imgBlog.categories.length) imgBlog.categories = eff.categories && eff.categories.length ? eff.categories : Object.keys(drv);
  if (autoImg && !overrides.mode) {
    //   웹·마케팅 블록: 전용 Drive 폴더(writer_config imageCategoriesDrive.웹/마케팅)에 쓸 사진이 생기는 순간부터 자동으로 사진 1장 글이 된다. 비어 있으면 정보글.
    let probe = null; try { probe = await pickImages(imgBlog, cfg, ctx.usedLog, []); } catch {}
    mode = probe ? 'portfolio' : 'info';
    log(probe ? `  전용 사진 폴더에 사진 있음(${probe.folder.name}) → 포트폴리오로 작성` : '  전용 사진 폴더 비어 있음(또는 미사용 폴더 없음) → 정보글로 작성');
  }
  log(`  글 유형: ${mode === 'info' ? '정보글(사진 없음)' : '포트폴리오(사진 1장)'}${prodCats ? ' | 산출물 매칭: ' + prodCats.join(', ') : ''}`);
  const blog0 = blog; const blogEff = eff;  // 아래 로직은 eff 기준
  const homeCols = await homeColumnLinks();

  // 이미지 폴더 → 작성 → 적합 확인. 적합 사진이 없는 폴더면 폴더를 바꿔 다시(최대 FOLDER_TRIES곳).
  const FOLDER_TRIES = 3;
  const skipFolders = [];
  let pick = null, staged = [], html = '', errs = [], mockupWarn = '';
  let formFallback = null;  // 형태 불일치로 다시 쓰기 전의 원고(대체 폴더가 없으면 이걸로 되돌린다)

  if (mode === 'info') {
    pick = { folder: { name: '(정보글 — 사진 없음)', cat: '', id: '' }, images: [] };
    const links = await feedLinks(blog.account);
    for (let attempt = 1; attempt <= 2; attempt++) {
      let prompt = buildPrompt(cfg, eff, target, faq, [], links, homeCols);
      if (attempt === 2 && errs.length) prompt += `\n\n[이전 시도 문제점 — 반드시 고쳐서 다시 작성]\n- ${errs.join('\n- ')}`;
      html = cleanOutput(await runClaude(prompt, cfg, log));
      errs = validate(html, [], eff.topic);
      if (!errs.length) break;
      log(`  검증 실패(${attempt}차): ${errs.join(' / ')}`);
    }
    if (errs.length) return { ok: false, blog: blogNo, reason: '검증 실패: ' + errs.join(' / ') };
  } else
  for (let folderTry = 1; folderTry <= FOLDER_TRIES; folderTry++) {
    pick = await pickImages(imgBlog, cfg, ctx.usedLog, skipFolders);
    if (!pick) {
      if (formFallback) {  // ★형태 맞는 폴더가 없어도 이미 쓴 원고는 버리지 않는다
        log('  ⚠ 제목 형태에 맞는 대체 폴더가 없음 — 처음 쓴 원고를 그대로 저장');
        ({ html, staged, pick } = formFallback);
        break;
      }
      if (skipFolders.length) return { ok: false, blog: blogNo, reason: `목업이 있는 이미지 폴더를 찾지 못함(제외: ${skipFolders.join(', ')})` };
      return { ok: false, blog: blogNo, reason: prodCats ? `산출물(${prodCats.join('/')})에 맞는 미사용 이미지 폴더 없음 — 해당 카테고리에 목업 이미지를 보충해 주세요` : '사용 가능한 미사용 이미지 폴더 없음(업종 필터/공용 로그 확인)' };
    }
    log(`  이미지 폴더: ${pick.folder.name} (${pick.images.length}장)${folderTry > 1 ? ` — ${folderTry}번째 폴더` : ''}`);
    // ★race-guard: 고른 즉시 기록 → 동시 실행하는 다른 플랫폼이 같은 폴더를 못 고른다(크로스플랫폼 중복 방지).
    recordFolderUse(cfg, ctx.usedLog, pick.folder);
    staged = await stageImages(pick.images, dateDir, blog.account);
    // ★안전망: 이 폴더 이미지가 최근 원고(3플랫폼)와 내용상 겹치면(md5) 글 쓰기 전에 폴더 교체.
    if (!overrides.imageDir && recentImgSet && recentImgSet.size) {
      const dupN = staged.reduce((n, s) => n + (recentImgSet.has(fileMd5(s.abs)) ? 1 : 0), 0);
      const need = Math.max(2, Math.ceil(staged.length / 2));
      if (dupN >= need) {
        log(`  ⚠ 내용 중복: 이 폴더 이미지가 최근 원고와 ${dupN}/${staged.length}장 겹침 → 폴더 교체`);
        skipFolders.push(pick.folder.name);
        if (folderTry < FOLDER_TRIES) continue;
        log(`  ⚠ 대체 폴더를 못 찾음 — 겹치지만 마지막 시도로 진행`);
      }
    }
    // ★사전 눈검사(2026-08-28 속도 개선): 예전엔 비싼 본문을 먼저 쓰고 나서 사진을 판정해,
    //   목업 없는 폴더에 걸리면 본문 작성(opus 수 분)을 통째로 버리고 다시 썼다. 이제 글 쓰기 전에
    //   후보 사진을 먼저 판정해 목업 아닌 것·중복(배경색만 다른 것)을 후보에서 빼고,
    //   쓸 사진이 없으면 본문 없이 폴더만 교체한다. 판정 실패 시엔 기존 사후 검사로 폴백.
    let preJudged = false;
    if (!overrides.imageDir) {
      const judged = await judgeMockups(staged, cfg, log, target.question);
      const mock = judged.mock || {};
      if (Object.keys(mock).length) {
        const dupDrop = new Set();
        for (const g of (judged.dupGroups || [])) g.slice(1).forEach(n => dupDrop.add(n));
        const good = staged.filter(s => mock[imgName(s)] === true && !dupDrop.has(imgName(s)));
        log(`  사전 눈검사: 게시 적합 ${good.length}/${staged.length}`
          + (good.length < staged.length ? ` | 제외: ${staged.filter(s => !good.includes(s)).map(imgName).join(', ')}` : ''));
        if (good.length) { staged = orderByBest(good, judged.best).slice(0, 3); preJudged = true; if (judged.best && judged.best.length) log(`  주제 맞춤 순위: ${judged.best.slice(0, 3).join(' > ')}`); }
        else {
          skipFolders.push(pick.folder.name);
          if (folderTry < FOLDER_TRIES) { log('  이 폴더엔 목업이 없음 → 본문 쓰기 전에 폴더 교체'); continue; }
          if (mockupOnlyCat(cfg, pick.folder.cat)) return { ok: false, blog: blogNo, reason: `목업 사진 없음: 폴더 ${FOLDER_TRIES}곳 모두 눈검사 탈락(${skipFolders.join(', ')}) — 목업 강제 규칙으로 저장하지 않음` };
          log(`  ⚠ 폴더 ${FOLDER_TRIES}곳 모두 목업 없음 — 마지막 폴더 사진으로 진행(사후 검사에 맡김)`);
        }
      }
    }

    const links = await feedLinks(blog.account);

    errs = []; mockupWarn = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      let prompt = buildPrompt(cfg, eff, target, faq, staged, links, homeCols);
      if (attempt === 2 && errs.length) prompt += `\n\n[이전 시도 문제점 — 반드시 고쳐서 다시 작성]\n- ${errs.join('\n- ')}`;
      html = cleanOutput(await runClaude(prompt, cfg, log));
      errs = validate(html, staged, eff.topic);
      if (!errs.length) break;
      log(`  검증 실패(${attempt}차): ${errs.join(' / ')}`);
    }
    if (errs.length) return { ok: false, blog: blogNo, reason: '검증 실패: ' + errs.join(' / ') };

    // ★사진을 열어보고 납작한 것만 목업으로 교체(글은 그대로 둔다).
    //   사전 눈검사를 통과한 사진만 후보로 줬으면 이 사후 검사는 건너뛴다(중복 판정 제거).
    let notMockup = preJudged ? [] : await verifyMockupsVisually(html, staged, cfg, log);
    if (notMockup.length) {
      const r = await repairFlatImages(html, staged, notMockup, cfg, log);
      html = r.html; notMockup = r.left;
    }
    // ★산출물 형태 사후 대조(2026-08-15): 이미지는 '질문'만 보고 미리 고르는데, 형태 단어(카탈로그/리플렛…)는
    //   Claude가 나중에 '제목'에서 정한다. 질문에 형태 단어가 없으면 필터가 꺼진 채로 폴더가 정해져
    //   '사례 카탈로그' 글에 팜플렛 사진이 붙는 사고가 난다. 그래서 글이 나온 뒤 제목 기준으로 다시 대조해
    //   어긋나면 제목의 형태로 카테고리를 좁혀 폴더를 바꾸고 다시 쓴다.
    const titleCats = productCategoriesFor(extractTitle(html));
    const formBad = !autoImg && titleCats && pick.folder.cat && !titleCats.includes(pick.folder.cat);
    if (formBad) {
      if (folderTry < FOLDER_TRIES) {
        log(`  ⚠ 산출물 형태 불일치: 제목=${titleCats.join('/')} ↔ 폴더=${pick.folder.cat}(${pick.folder.name}) → 폴더 교체 후 다시 작성`);
        formFallback = formFallback || { html, staged, pick };
        imgBlog = { ...imgBlog, categories: titleCats.filter(c => drv[c]) };
        if (!imgBlog.categories.length) imgBlog.categories = titleCats;
        skipFolders.push(pick.folder.name);
        continue;
      }
      log(`  ⚠ 산출물 형태 불일치(제목=${titleCats.join('/')} ↔ 폴더=${pick.folder.cat}) — 대체 폴더를 못 찾아 그대로 저장`);
    }

    if (!notMockup.length) break;

    skipFolders.push(pick.folder.name);
    if (folderTry < FOLDER_TRIES) log(`  이 폴더엔 목업이 없음 → 다른 폴더로 다시 시도 (제외: ${pick.folder.name})`);
    else {
      if (mockupOnlyCat(cfg, pick.folder.cat)) return { ok: false, blog: blogNo, reason: `목업 사진 없음: 폴더 ${FOLDER_TRIES}곳 모두 사후 눈검사 탈락(${skipFolders.join(', ')}) — 목업 강제 규칙으로 저장하지 않음` };
      mockupWarn = notMockup.join(', '); log(`  ⚠ 폴더 ${FOLDER_TRIES}곳을 봤지만 목업을 못 찾음 — 납작한 사진으로 저장함`);
    }
  }

  const fname = `${eff.topic}_${blog.account}_${safeName(target.question)}.html`;
  const fpath = path.join(dateDir, fname);
  fs.writeFileSync(fpath, html, 'utf8');
  const title = extractTitle(html);
  log(`  저장: ${fname} | 제목: ${title.slice(0, 40)}`);

  // SEO/AEO/GEO 독립 채점(20점)
  const seoScore = await scoreArticleSEO(html, blog, cfg, log);
  if (seoScore) {
    log(`  ▣ SEO/AEO/GEO 채점: ${seoScore.total}/20 (SEO ${seoScore.seo}/7·AEO ${seoScore.aeo}/7·GEO ${seoScore.geo}/6)${seoScore.total < 18 ? '  ⚠ 18점 미만 — 검토 필요' : '  ✅'} | 약점: ${seoScore.weakest || '-'}`);
    appendScoreCsv({ date: today(), platform: 'blogspot', account: blog.account, title, score: seoScore });
  }

  const ul = ctx.usedLog;
  markWritten(ul, usedKey, target.row); // ★원고만 씀(임시, 블록 키) — 발행되면 sync-posted.js가 postedRows로 승격
  // globalUsedFolders는 pick 직후 recordFolderUse가 이미 기록함(race-guard). 재기록 안 함.
  ul.faqLog = ul.faqLog || {};
  const usedFaqs = extractFaqs(html);
  ul.faqLog[faq.key] = (ul.faqLog[faq.key] || []).concat(usedFaqs.map(q => ({ q, date: today() })));
  usedFaqs.forEach(q => ctx.todaysFaqs.add(q));
  saveUsedLog(ul);

  // ★후보 6장 중 '본문에 실제로 쓴' 이미지만 Drive 원본 파일명으로 기록
  const usedImageNames = staged.filter(s => html.includes(s.url)).map(s => s.name);
  recordUsedImages(cfg, staged.filter(s => html.includes(s.url)));  // ★파일 단위 사용기록
  appendUsageReport(dateDir, {
    blogNo, topic: eff.topic, account: blog.account, time: new Date().toTimeString().slice(0, 5),
    title, row: target.row, question: target.question, sheetKey: faq.key,
    cat: pick.folder.cat, folderName: pick.folder.name, folderId: pick.folder.id,
    imageNames: usedImageNames, faqs: usedFaqs, tags: extractTags(html), score: seoScore,
  });

  return { ok: true, blog: blogNo, account: blog.account, file: fpath, title, row: target.row, question: target.question, folder: pick.folder.name, imgs: usedImageNames.length, images: usedImageNames, tags: extractTags(html), score: seoScore, mode };
}

function makeCtx(log) {
  return { data: loadQuestions(), usedLog: loadUsedLog(), todaysFaqs: new Set(), log };
}

async function pickPreview(blog, cfg, usedLog, data) {
  const q = pickQuestion(blog, data, usedLog);
  let img = null;
  try { img = await pickImages(blog, cfg, usedLog); } catch {}
  return { q, img };
}

module.exports = {
  pickQuestion, draftAlive, questionExcluded, rowUsedQ, normQ,
  verifyMockupsVisually, CLAUDE, runClaude, loadCfg, loadQuestions, loadUsedLog, saveUsedLog, pickQuestion, pickImages, pickPreview, generateOne, makeCtx, today, extractTitle, extractTags, extractSlug, usedRowSet, markWritten, markPosted, scoreArticleSEO, recentImageMd5Set, fileMd5, productCategoriesFor,
  stageImages, claimFolderToday, claimedFoldersToday, judgeMockups, homeColumnLinks, homePosts, extractFaqs, extractDescription,
};
