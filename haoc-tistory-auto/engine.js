// engine.js — 글 생성 엔진: 질문/FAQ/이미지 자동 선택 → claude -p 로 작성 → 검증 → 저장
// TistoryWriter(writer.js)와 배치 모드가 공용으로 사용.
// ★하오커뮤니케이션(haoc.co.kr)판(2026-09-14): 하오디자인 엔진(C:\tistory-auto)을 복제해 브랜드·질문 블록·이미지 규칙만 바꿨다.
//   - 질문: blocks[] 다중 블록(정부지원사업/디자인/웹/스튜디오/마케팅), usedNo(1~5) 고정 키로 3플랫폼 중복 차단
//   - 글 유형: portfolio(사진 1장) / info(사진 없음) / auto(질문에 산출물 단어가 있으면 portfolio)
//   - 사진: 하오디자인(인쇄물)·하오스튜디오(촬영) Drive 폴더 공유, 평면 폴더(루트에 사진만) 지원
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const ACC = require('./accounts');  // Claude 다계정 전환/페일오버(3개 프로그램 공용 저장소)
const TKW = require('../shared/title-kw');  // ★디자인 제목 필수 키워드(2026-09-28)
const { DRAFTS_DIR } = require('./config');

const CFG_FILE = path.join(__dirname, 'writer_config.json');
function loadCfg() { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^﻿/, '')); }

// ── claude.exe 자동 탐지 (BlogWriter 방식) ──────────────────
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
        for (const v of vers) { push(path.join(cc, v, 'claude.exe')); try { for (const h of fs.readdirSync(path.join(cc, v))) push(path.join(cc, v, h, 'claude.exe')); } catch {} }
      } catch {}
    }
  } catch {}
  return cands[0] || null;
}
const CLAUDE = findClaude();

// ── CSV 파서 (따옴표·셀 내 줄바꿈 지원) ─────────────────────
function parseCSV(text) {
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// 데이터 행: CSV 4행부터(1행=업종 헤더, 2행=열 헤더, 3행=차수 서브헤더). 행번호 N = 데이터 N번째(1-base).
function loadQuestions() {
  const cfg = loadCfg();
  const rows = parseCSV(fs.readFileSync(cfg.csvFile, 'utf8'));
  return rows.slice(3); // 데이터부
}

// ── 사용 로그 ────────────────────────────────────────────
function loadUsedLog() {
  const cfg = loadCfg();
  try { return JSON.parse(fs.readFileSync(cfg.usedLog, 'utf8')); } catch { return {}; }
}
function saveUsedLog(log) {
  const cfg = loadCfg();
  fs.writeFileSync(cfg.usedLog, JSON.stringify(log, null, 2), 'utf8');
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 플랫폼 간 폴더 중복 방지 ───────────────────────────────
// 3개 프로그램이 같은 _used_log.json을 공유한다. 폴더를 고르는 즉시 '오늘 찜' 목록에 디스크로 기록해
// 다른 플랫폼(동시 실행 포함)이 같은 폴더·같은 이미지를 고르지 못하게 한다.
// '오늘 이미 쓴 폴더'만 하드 제외 — 같은 날 3개 플랫폼이 같은 폴더를 고르는 것을 막는다.
// (예전엔 globalUsedFolders 전체를 하드 제외 → sync-posted가 그걸 wipe하면 옛 폴더가 풀려 날짜 넘어 중복됐음.)
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
// 폴더별 '마지막 사용일' 맵(구버전 문자열 항목은 최하위로).
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
// 후보 폴더를 '가장 오래 안 쓴 순'으로 정렬(미사용=제일 먼저). 날짜가 같으면 원래 순서 유지.
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


// ── 사용 행 판정(3개 프로그램 공용 규칙) ──────────────────
//  postedRows = 실제 발행 확인된 행(영구 제외) · writtenRows = 원고만 쓴 행(임시 제외, 기본 3일)
//  → 테스트로 쓰고 발행 안 한 질문은 3일 뒤 자동으로 다시 쓸 수 있게 된다.
//  (sync-posted.js가 3개 플랫폼의 실제 발행 글을 확인해 postedRows를 갱신)
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
  usedLog[key].usedRows = [...new Set([...(usedLog[key].usedRows || []), row])]; // 호환 유지
}
// 게시 성공 시 호출 → 영구 사용 처리
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

// ── 오늘의 타겟 질문 선택 ────────────────────────────────
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

// ── FAQ 후보 (같은 열, 타겟 제외) ─────────
// ★FAQ 다양화(2026-07-28): ① 최근 14일 사용분 제외(예전 3일 → 며칠 만에 같은 질문이 돌아와 중복 원인)
//   ② 남은 후보를 '오래 안 쓴 순(LRU)'으로 제공 — 항상 시트 앞쪽 40개만 주던 방식이 글마다 비슷한 FAQ를 만들었다.
//   ③ 풀이 15개 미만으로 마르면 기간 제한을 풀되 LRU 순서는 유지(같은 날 중복은 todaysFaqs가 계속 차단).
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

// ── 이미지 폴더·이미지 선택 ──────────────────────────────
const IMG_EXT = /\.(jpe?g|png|webp)$/i;
function listProjectFolders(blog, cfg) {
  const out = [];
  for (const cat of blog.categories) {
    const root = cfg.imageCategories[cat];
    if (!root || !fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const nm = d.name;
      if (cfg.excludeFolderPatterns.some(p => nm.toLowerCase().includes(p.toLowerCase()))) continue;
      out.push({ cat, name: nm, dir: path.join(root, nm) });
    }
  }
  return out;
}
function pickImages(blog, cfg, usedLog, skip) {
  const usedFolders = claimedFoldersToday(cfg);  // ★공유 로그 + 오늘 찜(디스크에서 새로 읽음)
  const skipSet2 = new Set(skip || []);
  const allFolders = listProjectFolders(blog, cfg).filter(f => !skipSet2.has(f.name));
  let folders = allFolders.filter(f => !usedFolders.has(f.dir) && !usedFolders.has(f.name));
  if (!folders.length) folders = allFolders;  // ★오늘까지 전부 소진 → 오늘 쓴 폴더도 재사용(최후 폴백)
  if (blog.industryKeywords.length) {
    const match = folders.filter(f => blog.industryKeywords.some(k => f.name.toLowerCase().includes(k.toLowerCase())));
    if (match.length) folders = match;
    else return null; // 업종 필터 매칭 없음 → 보류
  }
  folders = sortByLastUse(folders, cfg);  // 오래 안 쓴 폴더 먼저 → 날짜 넘는 중복 최소화
  folders = preferContentMatch(folders, blog._q);  // ★질문 업종과 폴더명이 맞으면 그 폴더 우선
  for (const f of folders) {
    const imgs = fs.readdirSync(f.dir).filter(n => IMG_EXT.test(n)).sort();
    if (imgs.length >= cfg.imagesPerPost) {
      // 찜은 하지 않는다 — 폴더 중복 방지는 generateOne이 글 저장 후 globalUsedFolders에 기록하는 것으로 충분.
      return { folder: f, images: imgs.slice(0, Math.min(3, Math.max(cfg.imagesPerPost, 2))).map(n => path.join(f.dir, n)) };
    }
  }
  return null;
}

// ── Google Drive 공개 폴더에서 이미지 자동 선택 (다운로드 불필요) ──
// 전제: 이미지 폴더가 '링크가 있는 모든 사용자 보기 가능'으로 공유됨(embeddedfolderview로 목록 조회).
const DRIVE_CACHE = new Map(); // folderId → { t, entries } (10분 캐시)
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
const YEARISH = /^(19|20)\d{2}([\s~\-–—]+\d{2,4})?$/; // '2024', '2024-2025' 같은 연도 폴더 → 한 단계 더 펼침
// ★컨테이너 폴더(2026-09-04): 연도(2023/2024-2025/2026)·poster·'New folder'처럼 프로젝트가 아니라
//   프로젝트들을 '담는' 폴더는 재귀로 펼쳐 그 안의 프로젝트 폴더를 후보에 넣는다(최대 3단계).
//   예: 리플렛/2025/New folder 안의 47개 프로젝트가 통째로 후보에서 빠져 있었다.
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
    // ★평면 폴더(2026-09-14 하오커뮤니케이션): 루트에 프로젝트 하위 폴더가 없고 사진이 직접 들어 있으면(예: 하오스튜디오 '상세페이지')
    //   루트 자체를 프로젝트 폴더 하나로 쓴다.
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
  // ★2026-09-23: 촬영 폴더는 업종으로 한 번 더 좁힌다(식품 질문에 화장품·생활용품 촬영컷이 붙던 문제).
  const SHOOT = ['제품촬영', '화장품촬영', '건강식품촬영', '식품촬영'];
  if (SHOOT.some(c => hit.has(c))) {
    const t = String(text || '');
    const ind = /건강s*식품|영양제|건기식/.test(t) ? ['건강식품촬영']
      : /식품|음식|요리|시즐|떡|소스|음료|간식|과자|밀키트|디저트|카페|베이커리|빵|농산물|수산물|축산|반찬|김치|주류|술/.test(t) ? ['식품촬영']
      : /화장품|코스메틱|뷰티|스킨케어|앰플|세럼/.test(t) ? ['화장품촬영'] : null;
    if (ind) SHOOT.filter(c => !ind.includes(c)).forEach(c => hit.delete(c));
  }
  return hit.size ? [...hit] : null;
}

async function pickImagesDrive(blog, cfg, usedLog, skip) {
  const used = claimedFoldersToday(cfg);  // ★globalUsedFolders + 오늘 다른 플랫폼이 찜한 폴더(디스크에서 매번 새로 읽음)
  const skipSet = new Set(skip || []);
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
  // ★목업이 2장 이상 있는 폴더를 먼저 찾는다. 폴더 안에서만 목업을 앞세워도,
  //   목업이 아예 없는 폴더에 걸리면 결국 납작한 원본 스캔만 나오기 때문.
  //   MOCKUP_SCAN_LIMIT개까지 뒤져보고 없으면 조건 없이 첫 폴더로 폴백(이미지 고갈 방지).
  const take = (f, files) => {
    // 찜 안 함(pollution 방지) — 중복 방지는 globalUsedFolders(글 저장 시 기록)로 처리.
    const picked = files.slice(0, Math.min(files.length > 12 ? 8 : 6, files.length));
    // ★이번에 이미지를 꺼낸 하위 폴더 목록 — recordFolderUse가 같이 기록해 하위 폴더 단위로 재사용을 막는다
    const subFolders = [...new Map(picked.filter(x => x.src).map(x => [x.src.id, x.src])).values()];
    return { folder: { ...f, dir: f.id, drive: true, subFolders }, images: picked };
  };
  let fallback = null;
  let scanned = 0, strictScanned = 0;
  const usedSub = folderLastUse(cfg);  // 하위 폴더 사용기록(상시) — 한 번 쓴 하위 폴더는 다시 쓰지 않는다
  for (const f of folders) {
    let files = await driveListImagesDeep(f.id, cfg, 2);  // ★하위 폴더에만 이미지가 있는 프로젝트도 잡는다
    // ★하위 폴더 재사용 금지(2026-09-04): 상위 폴더는 다시 골라도, 이미 쓴 하위 폴더의 이미지는 제외
    files = files.filter(x => !x.src || (!usedSub.has(x.src.id) && !usedSub.has(x.src.name) && !used.has(x.src.id) && !used.has(x.src.name)));
    { const _ui = new Set(loadUsedImages(cfg).map(x => x.id).filter(Boolean)); const _fresh = files.filter(x => !_ui.has(x.id)); files = _fresh.length >= 2 ? _fresh : _fresh.concat(files.filter(x => _ui.has(x.id))); }  // ★10/5: 미사용 1장뿐이면 버리지 말고 앞세워 채움(2장 미만 폴더 건너뜀 방지)  // ★이미 글에 쓴 사진은 후보에서 제외(전부 썼으면 재사용) — 평면 폴더도 매번 다른 사진
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
// ★10/9: Drive가 가끔 HTML(일시 차단/쿼터 페이지)을 돌려줌 → 공유 문제로 단정하지 말고 재시도 + lh3 대체 주소로 받기
async function driveFetchImageBuf(id) {
  const urls = [`https://drive.google.com/uc?export=download&id=${id}`, `https://lh3.googleusercontent.com/d/${id}=w2000`];
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const u of urls) {
      try {
        const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(90000) });
        const buf = Buffer.from(await r.arrayBuffer());
        if (r.ok && buf.length > 1000 && buf[0] !== 0x3c) return buf;
        lastErr = new Error(`drive 파일 접근 불가 ${id} (HTTP ${r.status})`);
      } catch (e) { lastErr = e; }
    }
    if (attempt < 3) await new Promise(res => setTimeout(res, 2500 * attempt));
  }
  throw lastErr;
}
async function driveDownload(fileId, dest) { fs.writeFileSync(dest, await driveFetchImageBuf(fileId)); }
async function stageDriveImages(images, outDir, prefix) {
  const staged = [];
  for (let i = 0; i < images.length; i++) {
    const raw = path.join(outDir, `_dl_${prefix}_${i + 1}.bin`);
    try { await driveDownload(images[i].id, raw); }
    catch (e) { if (images.length > 1) { console.log('  ⚠ 사진 1장 다운로드 실패 → 건너뜀: ' + (images[i].name || images[i].id) + ' | ' + e.message); continue; } throw e; }
    const out = path.join(outDir, `${prefix}_${i + 1}.webp`);
    try {
      execSync(`ffmpeg -y -i "${raw}" -vf "scale='min(1200,iw)':-2" "${out}"`, { stdio: 'ignore' });
      if (fs.existsSync(out) && fs.statSync(out).size > 1000) { fs.unlinkSync(raw); staged.push({ file: path.basename(out), abs: out, src: 'drive:' + images[i].id }); continue; }
    } catch {}
    const cp = path.join(outDir, `${prefix}_${i + 1}${path.extname(images[i].name) || '.jpg'}`);
    fs.renameSync(raw, cp);
    staged.push({ file: path.basename(cp), abs: cp, src: 'drive:' + images[i].id });
  }
  return staged;
}
// 통합 선택: Drive 우선 → 실패 시 로컬 폴더
async function pickImagesAny(blog, cfg, usedLog, log, skip) {
  if ((cfg.imageSource || 'drive') === 'drive') {
    try {
      const p = await pickImagesDrive(blog, cfg, usedLog, skip);
      if (p) return p;
      log && log('  Drive에서 조건 맞는 폴더 없음 → 로컬 폴더 시도');
    } catch (e) { log && log('  Drive 이미지 조회 실패(' + e.message.slice(0, 50) + ') → 로컬 폴더 시도'); }
  }
  return pickImages(blog, cfg, usedLog, skip);
}

// 이미지를 날짜 폴더로 webp 변환 복사 → [{file(마커용 파일명), abs(뷰용 절대경로)}]
function stageImages(images, outDir, prefix) {
  const staged = [];
  for (let i = 0; i < images.length; i++) {
    const out = path.join(outDir, `${prefix}_${i + 1}.webp`);
    try {
      execSync(`ffmpeg -y -i "${images[i]}" -vf "scale='min(1200,iw)':-2" "${out}"`, { stdio: 'ignore' });
      if (fs.existsSync(out) && fs.statSync(out).size > 1000) { staged.push({ file: path.basename(out), abs: out, src: images[i] }); continue; }
    } catch {}
    // ffmpeg 실패 시 원본 복사
    const cp = path.join(outDir, `${prefix}_${i + 1}${path.extname(images[i])}`);
    fs.copyFileSync(images[i], cp);
    staged.push({ file: path.basename(cp), abs: cp, src: images[i] });
  }
  return staged;
}

// ── 본사(haoc.co.kr) 칼럼 목록 ────────────────────────────
// 하오커뮤니케이션 홈페이지 칼럼은 Supabase overrides.hv_posts(사이트 js/data.js에 공개된 anon 키)에 저장된다 — 읽기 전용으로 제목·id를 가져와
// 개별 글 https://haoc.co.kr/column-{id}.html 링크 후보를 만든다(앵커 키워드 전달·딥링크 효과).
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

// ── 블로그 자신의 RSS에서 실제 개별 글 링크 ───────────────
async function rssLinks(account) {
  try {
    const r = await fetch(`https://${account}.tistory.com/rss`, { signal: AbortSignal.timeout(10000) });
    const xml = await r.text();
    const items = [];
    const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && items.length < 4) {
      const t = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const l = m[2].trim();
      if (/tistory\.com\/(entry\/|\d+)/.test(l)) items.push({ title: t, url: l });
    }
    return items;
  } catch { return []; }
}

// ── 프롬프트 조립 ────────────────────────────────────────
function loadCategories() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'categories.json'), 'utf8')); } catch { return {}; } }

// [주제] 라벨(시트 블록 → 프롬프트의 4개 분야 표기)
const SUBJECT_OF = { '정부지원사업': '정부지원사업(질문이 말하는 산출물/서비스 분야 중심)', '디자인': '홍보물 디자인', '웹': '홈페이지 제작', '스튜디오': '스튜디오 촬영', '마케팅': '마케팅' };
function buildPrompt(cfg, blog, target, faq, staged, links, homeCols) {
  const engine = fs.readFileSync(cfg.enginePrompt, 'utf8');
  const cats = (loadCategories()[blog.account] || []).map(c => c.name);
  const mode = staged.length ? 'portfolio' : 'info';
  const imgList = staged.map((s, i) => `${i + 1}. 마커 파일명: ${s.file}  |  실제 파일 경로(Read로 열어볼 것): ${s.abs}`).join('\n');
  const linkList = links.length
    ? links.map(l => `- ${l.title} : ${l.url}`).join('\n')
    : '(가져온 글 없음 — 관련 글 링크 섹션은 생략한다)';
  const homeList = (homeCols || []).length ? homeCols.map(l => `- ${l.title} : ${l.url}`).join('\n') : '(없음)';
  const faqList = faq.candidates.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const subject = SUBJECT_OF[blog.sheetBlock] || blog.sheetBlock || blog.topic;
  const imageBlock = mode === 'portfolio'
    ? `[글 유형] 포트폴리오 — 아래 이미지 후보 ★${staged.length}장 전부 Read 도구로 실제로 열어보고, 이 중 ★정확히 1장만 골라 마커로 넣는다(더 넣지 말 것)]
${imgList}
■ 이미지 고르는 기준(순서대로):
 ① ★개인정보가 보이는 이미지는 쓰지 않는다 — 담당자 이름·이메일·휴대폰/직통번호·QR코드·명함·주소가 찍힌 면(주로 뒤표지·연락처 페이지)은 제외.
 ② 산출물(카탈로그·브로슈어·리플렛·패키지 등)이 잘 보이는 연출 컷, 또는 촬영 결과물(제품·연출 컷)이 또렷한 사진을 우선한다. 납작한 PDF 페이지 스캔·작업 중 컷은 피한다.
 ③ ★업종이 글 주제와 달라도 괜찮다(예: 화장품 글에 식품 카탈로그 사진). 산출물/서비스 '종류'만 맞으면 된다.
■ alt 작성(★가장 중요 — 검색엔진·AI는 사진을 못 읽고 alt로 판단한다):
 - alt는 '이 글의 주제(제목)'에 맞춰 완성형 문장으로 쓴다. 사진에 실제로 보이는 형태를 근거로 하되, 업종·산출물 명칭은 글 제목을 따른다. 사진 속 고객사·브랜드명·제품명은 쓰지 않는다.
 - ★맨 끝에 반드시 "- 하오커뮤니케이션 디자인 작업" / "- 하오커뮤니케이션 제작" / "- 하오커뮤니케이션 작업물" 중 하나를 붙인다.
- 본문 삽입은 마커로만: [[IMG: 마커파일명 | alt]] — ★고른 이미지의 '마커 파일명'을 정확히 쓴다. 배치는 첫 번째 H2 섹션부터 그 이후에만.`
    : `[글 유형] 정보글 — 사진이 없다. ★이미지 마커([[IMG: ...]])를 하나도 넣지 않는다. 본문 흐름이 이미지 없이도 완결되게 쓰고, 없는 프로젝트·고객사를 사례처럼 지어내지 않는다(예시는 "예를 들어 ○○ 기업이라면" 가정형).`;
  return `${engine}

---
[자동 주입 블록]

[오늘의 타겟 질문 — 이 질문이 글의 근거다. 이 질문을 한 사람이 만족할 '답'이 되는 글을 쓴다]
${target.question}

[주제] ${subject}
[발행 계정] ${blog.account}.tistory.com  (스키마·관련 글 링크·내부 링크 기준)

[제목] 사람이 제목을 주지 않는다. 위 타겟 질문을 근거로 SEO·AEO·GEO 제목을 스스로 짓는다(산출물/서비스 키워드 + 정부사업명(질문에 있으면) + 실제 검색 질문형/추천형, 26~32자).
★제목은 본문에 넣지 않는다 — json 블록의 headline 에만 넣는다(게시 도구가 이걸 티스토리 제목칸에 넣는다).

[★출력은 코드블록 2개 — json 블록 먼저, 그 다음 html 블록. 이 순서를 반드시 지킨다]
 1) \`\`\`json 블록: 아래 5개 필드만.
    {"headline":"[글 제목]","keywords":"[태그5~8개 쉼표구분]","articleSection":"[카테고리]","description":"[검색결과 설명문 150~160자]","slug":"[영문-슬러그]"}
 2) \`\`\`html 블록: 본문 HTML (핵심 요약 박스부터 스키마까지 — 박스 위에 문단 금지)
- description = 구글 검색결과에 뜨는 설명문. 이 글이 무슨 질문에 답하는지 + 핵심 답을 자연스러운 한 문장~두 문장으로. ★150~160자. ★■ ① ② 같은 기호로 시작 금지. '핵심 요약' 같은 라벨 말고 바로 내용으로.
- slug = 영문 소문자·하이픈 3~6단어, 주제 영문 힌트: ${blog.slugTopic || 'haoc'} (예: export-voucher-catalog-print). 한글·공백 금지.

[FAQ 후보 — 같은 주제의 질문 목록. 이 목록을 재료로 5개를 고르거나 발전시킨다(타겟 질문과 관련 높은 순). 어미는 존댓말 의문형(~요?)으로 다듬고 스키마도 동일 문장으로.]
${faqList}

${TKW.promptBlock(target._titleKw)}

${imageBlock}

[관련 글 링크 — 실제 URL만. 아래 발행 계정의 실제 글 목록에서 이번 글과 관련 있는 것 1~2개를 '함께 보면 좋은 글'에 사용(없으면 섹션 생략).
 ★2개를 써도 '함께 보면 좋은 글' 문단은 하나만 — 라벨 반복 금지, 링크들을 쉼표(, )로 이어 한 줄에.]
${linkList}
[본사 칼럼(haoc.co.kr) 실제 글 — 주제가 정말 이어질 때만 '함께 보면 좋은 글'에 1개까지 추가 가능(내부 링크가 우선). 없으면 생략]
${homeList}

[★본사 링크 — CTA 박스 안의 연락처]
- ★홈페이지 앵커는 'haoc.co.kr' 그대로, 링크는 https://haoc.co.kr/ 홈으로. 전화 1666-2027(tel: 링크). 서술형 앵커·딥링크로 바꾸지 말 것.

[해시태그 — 필수]
- json 블록의 "keywords" 필드에 넣는다: 쉼표로 구분한 태그 5~8개.
- ★첫 번째 태그는 반드시 "${blog.topic}" (이 블로그의 고정 주제 태그).
- 나머지는 이 글의 핵심 키워드(산출물/서비스명, 지원사업명, 업종+산출물). '#' 기호 금지, 태그 안에 공백 금지(붙여쓰기, 예: 영문카탈로그, 수출바우처).
- 예: "keywords": "${blog.topic},산출물태그1,지원사업명,업종산출물태그2,..."

[카테고리 — 필수]
- json 블록의 "articleSection" 필드에 이 글의 티스토리 카테고리를 넣는다(게시 도구가 이 카테고리를 선택).
- 반드시 아래 목록 중 글 내용(주로 다루는 산출물/서비스)에 가장 맞는 하나를 그대로(문장부호 포함) 쓴다:
${cats.length ? cats.map(c => '  · ' + c).join('\n') : '  · ' + blog.topic + '   (이 블로그에 아직 카테고리 목록이 없음 — 고정 주제명 "' + blog.topic + '"을 그대로 articleSection에 쓴다)'}
- 판단 기준: 글이 주로 다루는 분야(정부지원사업/홍보물 디자인/홈페이지/촬영/마케팅). 애매하면 이 블로그의 고정 주제 카테고리.

[출력 형식 — 절대 준수]
- "자가 채점: NN/20" 한 줄 → json 코드블록 → html 코드블록. 그 외 설명·머리말 없음.
지금 작성하라.`;
}

// ── claude -p 실행 (비동기) — 계정별 env로 1회 호출 ──
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
      // ★한도/제한(예: "You've hit your weekly limit")은 짧게 종료 → 페일오버로 넘긴다.
      if (ACC.isSwitchable(c) && (code !== 0 || out.trim().length < 300))
        return reject(new Error('usage limit: ' + c.replace(/\s+/g, ' ').trim().slice(0, 140)));
      if (!out.trim()) return reject(new Error('claude 빈 응답 ' + err.slice(0, 150)));
      resolve(out.trim());
    });
    p.stdin.write(prompt); p.stdin.end();
  });
}
// ★다계정 자동 페일오버: active 계정 → 로그인/한도 오류면 쉬게 하고 다음 건강한 계정으로 재시도.
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
      if (!ACC.isSwitchable(e.message)) throw e;
      ACC.markCooldown(name, /weekly/i.test(e.message) ? 12 * 3600 * 1000 : undefined);
      const next = ACC.nextHealthy(name);
      log && log(`  ⚠ 계정 [${name}] 사용 불가(${e.message.slice(0, 45)}) → ${next ? `계정 [${next}]로 전환` : '전환할 계정 없음'}`);
      if (!next || tried.has(next)) throw new Error(`모든 계정 소진/미로그인: ${e.message.slice(0, 80)}`);
      ACC.setActive(next);
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

// ★티스토리 줄간격 보정: 티스토리는 <p>의 margin을 저장 시 지워서 문단이 붙어버린다.
//  → 문단 뒤 <br>, h2 앞 <br>를 넣어 '한 줄 띄움'을 강제(연속 <br>는 1개로 정리).
function normalizeSpacing(html) {
  // 본문 문단(18px) 뒤 한 줄
  let t = html.replace(/(<p style="margin:0 0 18px 0;">[\s\S]*?<\/p>)\s*\n/g, '$1\n<br>\n');
  // ★FAQ 답변(20px) 뒤 한 줄 → Q&A 묶음 사이가 벌어진다(Q와 답변 사이는 붙여 둔다)
  t = t.replace(/(<p style="margin:0 0 20px 0;">[\s\S]*?<\/p>)\s*\n/g, '$1\n<br>\n');
  // h2 앞 한 줄
  t = t.replace(/(?<!<br>\s*\n)(<h2>)/g, '<br>\n$1');
  t = t.replace(/(<br>\s*\n){2,}/g, '<br>\n');
  return t;
}

// 출력 정리: 코드펜스 제거, 첫 '<' 부터, ★마지막 </div>(스키마 숨김 div) 뒤 잡담 제거
function cleanOutput(raw) {
  let t = raw.replace(/^```(html)?\s*/im, '').replace(/```\s*$/m, '').trim();
  const i = t.indexOf('<');
  if (i > 0) t = t.slice(i);
  const end = t.lastIndexOf('</div>');
  if (end !== -1) t = t.slice(0, end + '</div>'.length);
  return normalizeSpacing(t);
}

// ★출력에서 메타(json 블록)와 본문(html 블록)을 분리해, META 주석은 '프로그램이' 붙인다.
// AI에게 "주석을 첫 줄에 정확히 놓아라"라고 시키면 1차 시도에서 계속 빠뜨렸다(2차에 오류를 알려줘야 넣음).
// json 블록을 내는 건 잘 하므로, 형식 준수 부담을 AI에서 코드로 옮긴다.
function assembleOutput(raw) {
  const jm = raw.match(/```json\s*([\s\S]*?)```/i);
  const hm = raw.match(/```html\s*([\s\S]*?)```/i);
  const body = cleanOutput(hm ? hm[1] : raw);
  let meta = jm ? parseJsonLoose(jm[1]) : null;
  if (!meta) meta = extractMeta(raw);           // AI가 직접 META 주석을 낸 경우도 허용
  if (!meta) return body;                        // 메타 없음 → validate가 잡아서 재시도시킨다
  const clean = stripMeta(body);
  return `<!-- META\n${JSON.stringify(meta)}\n-->\n${clean}`;
}

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
function driveFolderUrl(id) { return id && !id.includes('\\') ? `https://drive.google.com/drive/folders/${id}` : '(로컬 폴더)'; }

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
alt = 업종 + 산출물/서비스 + 무엇이 보이는지, 끝에 '- 하오커뮤니케이션 디자인 작업'(예: 식품 수출기업 영문 카탈로그 디자인 내지 펼침 - 하오커뮤니케이션 디자인 작업). ★사진 속 고객사·브랜드명은 쓰지 않는다.

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

// ── 메타 운반 ────────────────────────────────────────────
// 예전엔 본문에 BlogPosting 스키마를 넣고 거기서 제목·태그·카테고리를 읽었다. 그런데 티스토리가
// BlogPosting을 이미 자동 생성하기 때문에 한 페이지에 BlogPosting이 2개가 되고(구글이 어느 쪽을
// 채택할지 불확실), 우리 쪽은 datePublished·url·image가 없어 더 부실했다. author 이름도 블로그마다
// 제각각으로 나가 같은 회사가 5개 엔티티로 쪼개졌다.
// → BlogPosting은 티스토리 자동 생성분에 맡기고, 우리 데이터는 HTML 주석으로 나른다(게시 전 제거).
//   본문에 남기는 스키마는 FAQPage 하나뿐(티스토리가 자동 생성하지 않는 것).
const META_RE = /<!--\s*META\s*([\s\S]*?)-->/;
function extractMeta(html) {
  const m = html.match(META_RE);
  if (m) { const j = parseJsonLoose(m[1]); if (j) return j; }
  return null;
}
function stripMeta(html) { return html.replace(META_RE, '').replace(/^\s+/, ''); }

// ★AI가 카테고리를 목록에 없는 값으로 지어낼 때(예: "화장품 리플렛·팜플렛") 통째로 버리지 말고
//   목록 중 가장 가까운 것으로 자동 교정한다. 토큰(공백···/) 겹침이 가장 많은 후보를 고른다.
function nearestCategory(sec, catNames) {
  if (!sec || !catNames.length) return null;
  if (catNames.includes(sec)) return sec;
  const toks = s => s.split(/[\s·/,]+/).filter(t => t.length >= 2);
  const want = toks(sec);
  let best = null, bestScore = 0;
  for (const c of catNames) {
    const ct = toks(c);
    const overlap = want.filter(w => ct.some(t => t.includes(w) || w.includes(t))).length;
    if (overlap > bestScore) { bestScore = overlap; best = c; }
  }
  return bestScore >= 1 ? best : null;  // 겹치는 토큰이 하나도 없으면 교정 불가
}
// META 주석의 articleSection을 교정 값으로 바꾼다
function rewriteCategory(html, newSec) {
  const meta = extractMeta(html);
  if (!meta) return html;
  meta.articleSection = newSec;
  return html.replace(META_RE, `<!-- META\n${JSON.stringify(meta)}\n-->`);
}

// ── 검증 ─────────────────────────────────────────────────
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
function extractTags(html) {
  const meta = extractMeta(html);
  const raw = meta && meta.keywords ? meta.keywords : (html.match(/"keywords"\s*:\s*"([^"]+)"/) || [])[1];  // 구버전 원고 호환
  return raw ? String(raw).split(',').map(t => t.trim()).filter(Boolean) : [];
}
function extractSection(html) {
  const meta = extractMeta(html);
  if (meta && meta.articleSection) return String(meta.articleSection).trim();
  const m = html.match(/"articleSection"\s*:\s*"([^"]+)"/);  // 구버전 원고 호환
  return m ? m[1].trim() : '';
}
function extractDesc(html) {
  const meta = extractMeta(html);
  return meta && meta.description ? String(meta.description).trim() : '';
}
function validate(html, staged, topic, account) {
  const errs = [];
  const score = (html.match(/자가 채점:\s*(\d+)\s*\/\s*20/) || [])[1];
  if (score && parseInt(score, 10) < 18) errs.push(`자가 채점 ${score}/20 < 18`);
  // ★메타는 맨 위 <!-- META {...} --> 주석에서 온다(BlogPosting 스키마 아님 — 티스토리가 자동 생성해 중복되므로)
  const meta = extractMeta(html);
  if (!meta) errs.push('맨 위 <!-- META {...} --> 주석 없음(제목·태그·카테고리·설명이 여기 있어야 함)');
  else {
    if (!meta.headline || String(meta.headline).length < 5) errs.push('META headline 없음(제목)');
    const d = String(meta.description || '');
    // 설명문 길이는 SEO 영향이 작다 → 목표(150~160)는 프롬프트로만 유도하고, 검증은 '쓸 수 있는 범위'만 막는다.
    if (!d) errs.push('META description 없음');
    else if (d.length < 60) errs.push(`META description 너무 짧음(${d.length}자)`);
    else if (d.length > 185) errs.push(`META description 너무 김(${d.length}자) — 검색결과에서 잘림`);
    if (/■|①|②|③/.test(d)) errs.push('META description에 ■·① 같은 기호 금지(스니펫 첫 글자가 됨)');
  }
  // 본문에 BlogPosting을 넣으면 티스토리 자동 생성분과 2개가 되어 구글이 어느 쪽을 쓸지 불확실해진다
  if (/"@type"\s*:\s*"BlogPosting"/.test(html)) errs.push('본문에 BlogPosting 스키마 금지(티스토리가 자동 생성함 — FAQPage만 남길 것)');
  if (!/"@type"\s*:\s*"FAQPage"/.test(html)) errs.push('FAQPage 스키마 없음');
  if (!/자주 묻는 질문\(FAQ\)/.test(html)) errs.push('FAQ h2 소제목 없음');
  // ★후보 중 2~3장만 고르는 방식 → '전부 사용' 강제 대신 '후보 안에서 골랐는지'를 검증
  const markerFiles = [...html.matchAll(/\[\[IMG:\s*([^|\]]+?)\s*[|\]]/g)].map(m => m[1].trim());
  const markers = markerFiles.length;
  // ★하오커뮤니케이션: 포트폴리오형=정확히 imagesPerPost(1)장, 정보글형(staged 없음)=0장
  const need = staged.length ? Math.max(1, Math.min((loadCfg().imagesPerPost || 1), staged.length)) : 0;
  if (markers < need) errs.push(`이미지 마커 ${markers}개 (정확히 ${need}개 필요)`);
  if (markers > need) errs.push(need ? `이미지 마커 ${markers}개 (정확히 ${need}개만)` : `정보글에는 이미지 마커를 넣지 않는다(${markers}개 발견)`);
  const validFiles = new Set(staged.map(s => s.file));
  const bad = markerFiles.filter(f => !validFiles.has(f));
  if (bad.length) errs.push(`후보에 없는 이미지 파일명: ${bad[0]}`);
  if (new Set(markerFiles).size !== markerFiles.length) errs.push('같은 이미지를 두 번 사용');
  if (EMOJI_RE.test(html)) errs.push('이모지 발견');
  const textLen = html.replace(/<[^>]+>/g, '').replace(/\s/g, '').length;
  if (textLen < 1500) errs.push(`본문 분량 부족(공백 제외 약 ${textLen}자)`);
  if (/<h1[\s>]/i.test(html)) errs.push('본문에 h1 존재');
  if (html.includes('`')) errs.push('백틱(`) 잔존 — 코드펜스/설명 잡담이 본문에 섞임');
  if ((html.match(/함께 보면 좋은 글/g) || []).length > 1) errs.push("'함께 보면 좋은 글' 문단이 2개 이상 — 링크들을 쉼표로 이어 문단 1개로");
  const faqsAll = extractFaqs(html);
  if (faqsAll.length !== 5) errs.push(`스키마 FAQ ${faqsAll.length}개(5개여야 함)`);
  const faqNoQ = faqsAll.filter(q => !/요\s*\?\s*$/.test(q.trim()));
  if (faqNoQ.length) errs.push(`FAQ 질문 ${faqNoQ.length}개가 존댓말 의문형(~요?)으로 안 끝남`);
  // ★브랜드명 누수 방지 — FAQ 질문·답변은 중립 정보영역(GEO trust). 인사·신뢰박스·CTA·alt에서만 브랜드명 허용.
  const leakQ = faqsAll.filter(q => q.includes(BRAND_KO));
  if (leakQ.length) errs.push(`FAQ 질문 ${leakQ.length}개에 브랜드명(${BRAND_KO}) 노출 — 질문은 중립적으로`);
  const leakA = extractFaqAnswers(html).filter(a => a.includes(BRAND_KO));
  if (leakA.length) errs.push(`FAQ 답변 ${leakA.length}개에 브랜드명(${BRAND_KO}) 노출 — FAQ 답은 중립적으로(업체명 빼고)`);
  if (!/exportvoucher\.com|mssmiv\.com|bizinfo\.go\.kr|mss\.go\.kr|kosmes\.or\.kr/.test(html)) errs.push('공식 출처 링크(수출바우처/혁신바우처/기업마당 등) 1개 필요');
  const junkTag = html.match(/<\/?(?!\/?(table|tr|td|th|thead|tbody|p|span|strong|br|a|h2|div|script|img|em|b|i|ul|ol|li)\b)[a-z][a-z0-9]*[^>]*>/i);
  if (junkTag) errs.push('허용 외 태그 발견: ' + junkTag[0].slice(0, 30));
  const tags = extractTags(html);
  if (tags.length < 5) errs.push(`해시태그 부족(${tags.length}개) — 스키마 keywords에 5~8개`);
  else if (topic && !tags.includes(topic)) errs.push(`고정 주제 태그 "${topic}" 누락`);
  const sec = extractSection(html);
  const catNames = (loadCategories()[account] || []).map(c => c.name);
  if (!sec) errs.push('카테고리(articleSection) 없음');
  else if (catNames.length && !catNames.includes(sec)) errs.push(`카테고리 값 오류: "${sec}" (목록에 없음)`);
  return errs;
}

function extractTitle(html) {
  const meta = extractMeta(html);
  if (meta && meta.headline) return String(meta.headline).trim();
  const m = html.match(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/);  // 구버전 원고 호환
  return m ? m[1].replace(/\\"/g, '"') : '';
}
function extractFaqs(html) {
  const out = [];
  const re = /"@type"\s*:\s*"Question"\s*,\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m; while ((m = re.exec(html))) out.push(m[1].replace(/\\"/g, '"'));
  return out;
}
function extractFaqAnswers(html) {
  const out = [];
  const re = /"@type"\s*:\s*"Answer"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m; while ((m = re.exec(html))) out.push(m[1].replace(/\\"/g, '"'));
  return out;
}
const BRAND_KO = '하오커뮤니케이션';  // FAQ 등 중립 영역에 새어들면 안 되는 자사 브랜드명
function safeName(s) { return s.replace(/[\\/:*?"<>|]/g, '').replace(/\?+\s*$/, '').trim(); }

// ── 사용내역 기록 (사람용 — 시트 체크·이미지 used 이동을 수동으로 하기 위한 명세) ──
function appendUsageReport(dateDir, e) {
  const f = path.join(dateDir, '사용내역.txt');
  const lines = [
    `■ 블로그${e.blogNo} ${e.topic} (${e.account}) — ${e.time}`,
    `  제목: ${e.title}`,
    `  질문: [${e.sheetKey}열 ${e.row}번째 질문 = 시트 ${e.row + 3}행] ${e.question}`,
    `  카테고리: ${e.section || ''}`,
    ...(e.imageNames.length ? [
      `  ── used 폴더로 옮길 이미지 ──`,
      `  위치: ${CAT_PATH[e.cat] || e.cat || '?'} > ${e.folderName}`,
      `  폴더 링크: ${driveFolderUrl(e.folderId)}`,
      `  ★실제 사용한 파일(${e.imageNames.length}장): ${e.imageNames.join(', ')}`,
    ] : [`  글 유형: 정보글(사진 없음)`]),
    ...(e.mockupWarn ? [`  ⚠ 목업 아님(눈으로 확인함): ${e.mockupWarn} — 이 폴더엔 목업 컷이 없을 수 있음`] : []),
    `  해시태그: ${(e.tags || []).join(', ')}`,
    `  FAQ(5개): ${e.faqs.map((q, i) => `\n    ${i + 1}. ${q}`).join('')}`,
    ...(e.score ? [
      `  ▣ SEO/AEO/GEO 채점: ${e.score.total}/20  (SEO ${e.score.seo}/7 · AEO ${e.score.aeo}/7 · GEO ${e.score.geo}/6)${e.score.total >= 18 ? '  ✅ 기준 충족' : '  ⚠ 18점 미만 — 검토 필요'}`,
      `     세부: 제목 ${e.score.breakdown.title}/2·키워드 ${e.score.breakdown.keywords}/2·구조 ${e.score.breakdown.structure}/2·메타 ${e.score.breakdown.meta}/1 | 정답문 ${e.score.breakdown.snippet}/3·FAQ ${e.score.breakdown.faq}/3·직답 ${e.score.breakdown.direct}/1 | 수치 ${e.score.breakdown.numbers}/2·전문성 ${e.score.breakdown.entity}/2·신뢰 ${e.score.breakdown.trust}/2`,
      `     약점: ${e.score.weakest || '-'}`,
    ] : []),
    '',
  ];
  fs.appendFileSync(f, lines.join('\n') + '\n', 'utf8');
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

// ── 블로그 1개 생성 (메인 엔트리) ────────────────────────
// ctx: { data, usedLog, todaysFaqs:Set, log:fn }
// overrides: { question, row, imageDir, mode('info'|'portfolio') }
async function generateOne(blogNo, ctx, overrides = {}) {
  const cfg = loadCfg();
  const blog = cfg.blogs.find(b => b.no === blogNo);
  const log = ctx.log || (() => {});
  const dateDir = path.join(DRAFTS_DIR, today());
  fs.mkdirSync(dateDir, { recursive: true });
  // 최근 원고 이미지 md5 집합(내용 중복 안전망) — 생성 시작 시 1회 스냅샷(오늘 먼저 만든 다른 글 포함).
  const recentImgSet = recentImageMd5Set(cfg.dupCheckDays || 10);

  // 1) 질문 (★블록 다중 지원 — 선택된 블록의 주제 태그·열·슬러그·이미지 카테고리·글 유형을 적용한 유효 blog)
  const target = overrides.question
    ? { row: overrides.row || 0, question: overrides.question, block: (blog.blocks || []).find(b => overrides.block != null && b.usedNo === overrides.block) || null }
    : pickQuestion(blog, ctx.data, ctx.usedLog);
  if (!target) return { ok: false, blog: blogNo, reason: '질문 소진 — 이 블로그 범위의 미게시 질문이 없습니다.' };
  const bl = target.block || (blog.blocks && blog.blocks[0]) || null;
  const eff = bl
    ? { ...blog, topic: bl.topicTag || blog.topic, sheetBlock: bl.sheetBlock || blog.sheetBlock, qCol: bl.qCol || blog.qCol, checkCol: bl.checkCol || blog.checkCol,
        slugTopic: bl.slugTopic || blog.slugTopic, categories: (bl.categories && bl.categories.length) ? bl.categories : blog.categories, imageMode: bl.imageMode || blog.imageMode || 'portfolio' }
    : { ...blog, imageMode: blog.imageMode || 'portfolio' };
  const usedKey = (bl && bl.usedNo != null) ? bl.usedNo : blogNo;
  log(`[블로그${blogNo} ${blog.account}] 질문(${eff.sheetBlock || ''} 행${target.row}): ${target.question.slice(0, 40)}...`);
  if (!overrides.question) claimRow(cfg, ctx.usedLog, usedKey, target.row);  // ★즉시 선점

  // 2) FAQ 후보
  const faq = faqCandidates(eff, ctx.data, ctx.usedLog, target.question, ctx.todaysFaqs);

  // 2.5) 글 유형(info/portfolio) — ★질문 속 산출물 형태에 맞춰 이미지 카테고리를 좁힌다(형태 불일치 방지).
  const prodCats = productCategoriesFor(target.question);
  const drv = cfg.imageCategoriesDrive || {};
  const autoImg = eff.imageMode === 'portfolio-auto';  // ★사진 있으면 포트폴리오, 없으면 정보글(2026-09-16 운영자 지시)
  let mode = overrides.mode || (overrides.imageDir ? 'portfolio' : eff.imageMode === 'info' ? 'info' : eff.imageMode === 'auto' ? (prodCats ? 'portfolio' : 'info') : 'portfolio');
  let imgBlog = { ...eff, ...(prodCats && !autoImg ? { categories: prodCats.filter(c => drv[c]) } : {}), _q: target.question };
  if (!imgBlog.categories.length) imgBlog.categories = eff.categories && eff.categories.length ? eff.categories : Object.keys(drv);
  if (autoImg && !overrides.mode && !overrides.imageDir) {
    //   웹·마케팅 블록: 전용 Drive 폴더(writer_config imageCategoriesDrive.웹/마케팅)에 쓸 사진이 생기는 순간부터 자동으로 사진 1장 글이 된다. 비어 있으면 정보글.
    let probe = null; try { probe = await pickImagesAny(imgBlog, cfg, ctx.usedLog, null, []); } catch {}
    mode = probe ? 'portfolio' : 'info';
    log(probe ? `  전용 사진 폴더에 사진 있음(${probe.folder.name}) → 포트폴리오로 작성` : '  전용 사진 폴더 비어 있음(또는 미사용 폴더 없음) → 정보글로 작성');
  }
  // ★디자인 제목 필수 키워드(2026-09-28 운영자 지시): 질문에 맞는 키워드 1개를 번갈아 골라 제목에 넣고, 사진도 그 산출물 폴더에서만 고른다.
  if (eff.sheetBlock === '디자인' && !overrides.imageDir && overrides.mode !== 'info') {
    const plan = TKW.familyPlan(target.question);
    let chosen = null;
    for (const fam of plan.families) {
      for (const cats0 of [fam.cats, ...(plan.fixed && fam.alt.length ? [fam.alt] : [])]) {
        const cats = cats0.filter(c => drv[c]);
        if (!cats.length) continue;
        let probe = null; try { probe = await pickImagesAny({ ...imgBlog, categories: cats }, cfg, ctx.usedLog, null, []); } catch {}
        if (probe) { chosen = { fam, cats }; break; }
      }
      if (chosen) break;
    }
    if (!chosen && plan.fixed && plan.families.length) chosen = { fam: plan.families[0], cats: null };  // 질문이 정한 산출물은 사진이 없어도 키워드는 넣는다
    if (chosen) {
      const kw = TKW.pickKeyword(chosen.fam, target.question);
      TKW.commit(kw, chosen.fam.key);
      target._titleKw = kw;
      if (chosen.cats) { imgBlog = { ...imgBlog, categories: chosen.cats }; if (mode === 'info') mode = 'portfolio'; }
      log(`  제목 필수 키워드: ${kw} | 사진 폴더: ${chosen.cats ? chosen.cats.join(', ') : '(해당 산출물 사진 없음 — 기존 매칭)'}`);
    }
  }
  log(`  글 유형: ${mode === 'info' ? '정보글(사진 없음)' : '포트폴리오(사진 1장)'}${prodCats ? ' | 산출물 매칭: ' + prodCats.join(', ') : ''}`);

  const FOLDER_TRIES = 3;
  const skipFolders = [];
  let pick = null, staged = [], html = '', errs = [], mockupWarn = '';
  let formFallback = null;  // 형태 불일치로 다시 쓰기 전의 원고(대체 폴더가 없으면 이걸로 되돌린다)
  const homeCols = await homeColumnLinks();
  const links = await rssLinks(blog.account);

  // 정보글: 사진 없이 바로 작성
  if (mode === 'info') {
    pick = { folder: { name: '(정보글 — 사진 없음)', cat: '', dir: '', id: '' }, images: [] };
    for (let attempt = 1; attempt <= 2; attempt++) {
      let prompt = buildPrompt(cfg, eff, target, faq, [], links, homeCols);
      if (attempt === 2 && errs.length) prompt += `\n\n[이전 시도 문제점 — 반드시 고쳐서 다시 작성]\n- ${errs.join('\n- ')}`;
      html = assembleOutput(await runClaude(prompt, cfg, log));
      const secNow = extractSection(html);
      const catNames = (loadCategories()[blog.account] || []).map(c => c.name);
      if (secNow && catNames.length && !catNames.includes(secNow)) {
        const fixed = nearestCategory(secNow, catNames);
        if (fixed) { html = rewriteCategory(html, fixed); log(`  카테고리 자동 교정: "${secNow}" → "${fixed}"`); }
      }
      errs = validate(html, [], eff.topic, eff.account);
      if (target._titleKw && !TKW.titleHas(extractTitle(html), target._titleKw)) { if (attempt === 1) errs.push(`제목에 필수 키워드 "${target._titleKw}"가 없음 — headline에 글자 그대로 넣을 것`); else log(`  ⚠ 제목에 필수 키워드 "${target._titleKw}" 없음(2차) — 그대로 저장`); }
      if (!errs.length) break;
      log(`  검증 실패(${attempt}차): ${errs.join(' / ')}`);
    }
    if (errs.length) return { ok: false, blog: blogNo, reason: '검증 실패: ' + errs.join(' / '), file: null };
  } else
  // 포트폴리오: 이미지 폴더 → (사전 눈검사) → 작성 → 검증. 쓸 사진이 없는 폴더에 걸리면 폴더를 바꿔 다시(최대 FOLDER_TRIES개 폴더).
  for (let folderTry = 1; folderTry <= FOLDER_TRIES; folderTry++) {
    pick = overrides.imageDir
      ? { folder: { dir: overrides.imageDir, name: path.basename(overrides.imageDir), cat: '' },
          images: fs.readdirSync(overrides.imageDir).filter(n => IMG_EXT.test(n)).sort().slice(0, 3).map(n => path.join(overrides.imageDir, n)) }
      : await pickImagesAny(imgBlog, cfg, ctx.usedLog, log, skipFolders);
    if (!pick || !pick.images.length) {
      if (formFallback) {  // ★형태 맞는 폴더가 없어도 이미 쓴 원고는 버리지 않는다
        log('  ⚠ 제목 형태에 맞는 대체 폴더가 없음 — 처음 쓴 원고를 그대로 저장');
        ({ html, staged, pick } = formFallback);
        break;
      }
      if (skipFolders.length) return { ok: false, blog: blogNo, reason: `게시 적합 사진이 있는 이미지 폴더를 찾지 못했습니다(제외: ${skipFolders.join(', ')})` };
      return { ok: false, blog: blogNo, reason: prodCats ? `산출물(${prodCats.join('/')})에 맞는 미사용 이미지 폴더가 없습니다 — 해당 Drive 카테고리에 사진을 보충해 주세요.` : '사용 가능한 미사용 이미지 폴더가 없습니다(업종 필터/사용 로그/Drive 공유 확인).' };
    }
    log(`  이미지 폴더: ${pick.folder.name}${pick.folder.drive ? ' (Drive)' : ''} (${pick.images.length}장)${folderTry > 1 ? ` — ${folderTry}번째 폴더` : ''}`);
    // ★race-guard: 고른 즉시 globalUsedFolders에 오늘자로 기록(디스크+메모리) — 다른 플랫폼이 같은 폴더를 못 고른다.
    recordFolderUse(cfg, ctx.usedLog, pick.folder);
    staged = pick.folder.drive
      ? await stageDriveImages(pick.images, dateDir, `${blog.account}`)
      : stageImages(pick.images, dateDir, `${blog.account}`);

    // ★안전망: 이 폴더 이미지가 최근 원고(3플랫폼)와 '내용상' 겹치는지 md5로 확인 → 겹치면 글 쓰기 전에 폴더 교체.
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

    // ★사전 눈검사(2026-08-28 속도 개선): 글 쓰기 전에 후보 사진을 먼저 판정해 부적합·중복을 후보에서 빼고,
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
          if (folderTry < FOLDER_TRIES) { log('  이 폴더엔 쓸 사진이 없음 → 본문 쓰기 전에 폴더 교체'); continue; }
          if (mockupOnlyCat(cfg, pick.folder.cat)) return { ok: false, blog: blogNo, reason: `목업 사진 없음: 폴더 ${FOLDER_TRIES}곳 모두 눈검사 탈락(${skipFolders.join(', ')}) — 목업 강제 규칙으로 저장하지 않음`, file: null };
          log(`  ⚠ 폴더 ${FOLDER_TRIES}곳 모두 적합 사진 없음 — 마지막 폴더 사진으로 진행(사후 검사에 맡김)`);
        }
      }
    }

    // 작성 (+ 1회 재시도) — 글자 검증용
    errs = []; mockupWarn = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      let prompt = buildPrompt(cfg, eff, target, faq, staged, links, homeCols);
      if (attempt === 2 && errs.length) prompt += `\n\n[이전 시도 문제점 — 반드시 고쳐서 다시 작성]\n- ${errs.join('\n- ')}`;
      html = assembleOutput(await runClaude(prompt, cfg, log));
      // ★검증 전에 카테고리를 목록 값으로 자동 교정(지어낸 값이면 가장 가까운 것으로) → 사소한 값 오류로 원고를 버리지 않는다.
      const secNow = extractSection(html);
      const catNames = (loadCategories()[blog.account] || []).map(c => c.name);
      if (secNow && catNames.length && !catNames.includes(secNow)) {
        const fixed = nearestCategory(secNow, catNames);
        if (fixed) { html = rewriteCategory(html, fixed); log(`  카테고리 자동 교정: "${secNow}" → "${fixed}"`); }
      }
      errs = validate(html, staged, eff.topic, eff.account);
      if (target._titleKw && !TKW.titleHas(extractTitle(html), target._titleKw)) { if (attempt === 1) errs.push(`제목에 필수 키워드 "${target._titleKw}"가 없음 — headline에 글자 그대로 넣을 것`); else log(`  ⚠ 제목에 필수 키워드 "${target._titleKw}" 없음(2차) — 그대로 저장`); }
      if (!errs.length) break;
      log(`  검증 실패(${attempt}차): ${errs.join(' / ')}`);
    }
    if (errs.length) return { ok: false, blog: blogNo, reason: '검증 실패: ' + errs.join(' / '), file: null };

    // ★사진을 실제로 열어 적합한지 확인 → 부적합만 '사진 교체'(글은 그대로). 사전 눈검사를 통과한 사진만 후보로 줬으면 건너뛴다.
    let notMockup = preJudged ? [] : await verifyMockupsVisually(html, staged, cfg, log);
    if (notMockup.length) {
      const r = await repairFlatImages(html, staged, notMockup, cfg, log);
      html = r.html; notMockup = r.left;
    }
    // ★산출물 형태 사후 대조: 제목 기준으로 다시 대조해 어긋나면 폴더를 바꾸고 다시 쓴다.
    const titleCats = productCategoriesFor(extractTitle(html));
    const formBad = !autoImg && titleCats && pick.folder.cat && !titleCats.includes(pick.folder.cat);
    if (formBad && !overrides.imageDir) {
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

    if (!notMockup.length) break;  // 해결됨

    if (overrides.imageDir) { mockupWarn = notMockup.join(', '); break; }  // 폴더 지정 실행이면 바꿀 수 없음
    skipFolders.push(pick.folder.name);
    if (folderTry < FOLDER_TRIES) {
      log(`  이 폴더엔 쓸 사진이 없음 → 다른 폴더로 다시 시도 (제외: ${pick.folder.name})`);
    } else {
      if (mockupOnlyCat(cfg, pick.folder.cat)) return { ok: false, blog: blogNo, reason: `목업 사진 없음: 폴더 ${FOLDER_TRIES}곳 모두 사후 눈검사 탈락(${skipFolders.join(', ')}) — 목업 강제 규칙으로 저장하지 않음`, file: null };
      mockupWarn = notMockup.join(', ');
      log(`  ⚠ 폴더 ${FOLDER_TRIES}곳을 봤지만 적합 사진을 못 찾음 — 그대로 저장함`);
    }
  }

  // 6) 저장
  const fname = `${eff.topic}_${eff.account}_${safeName(target.question)}.html`;
  const fpath = path.join(dateDir, fname);
  fs.writeFileSync(fpath, html, 'utf8');
  const title = extractTitle(html);
  log(`  저장: ${fname} | 제목: ${title.slice(0, 40)}`);

  // 6.5) SEO/AEO/GEO 독립 채점(20점)
  const seoScore = await scoreArticleSEO(html, blog, cfg, log);
  if (seoScore) {
    log(`  ▣ SEO/AEO/GEO 채점: ${seoScore.total}/20 (SEO ${seoScore.seo}/7·AEO ${seoScore.aeo}/7·GEO ${seoScore.geo}/6)${seoScore.total < 18 ? '  ⚠ 18점 미만 — 검토 필요' : '  ✅'} | 약점: ${seoScore.weakest || '-'}`);
    appendScoreCsv({ date: today(), platform: 'tistory', account: blog.account, title, score: seoScore });
  }

  // 7) 로그 갱신 — ★'원고만 씀'으로 기록(임시, 블록 키). 실제 발행되면 sync-posted.js가 postedRows로 승격.
  const ul = ctx.usedLog;
  markWritten(ul, usedKey, target.row);
  ul.faqLog = ul.faqLog || {};
  const usedFaqs = extractFaqs(html);
  ul.faqLog[faq.key] = (ul.faqLog[faq.key] || []).concat(usedFaqs.map(q => ({ q, date: today() })));
  usedFaqs.forEach(q => ctx.todaysFaqs.add(q));
  saveUsedLog(ul);

  // 8) 사용내역.txt — 본문에 실제로 쓴 이미지만 Drive 원본 파일명으로 기록
  const usedStaged = staged.filter(s => html.includes(s.file));
  const imageNames = usedStaged.map((s) => {
    const orig = pick.folder.drive ? (pick.images[staged.indexOf(s)] || {}).name : path.basename(s.src || s.abs);
    return orig || s.file;
  });
  recordUsedImages(cfg, usedStaged.map((s, i) => ({ id: String(s.src || '').replace(/^drive:/, ''), name: imageNames[i], abs: s.abs })));  // ★파일 단위 사용기록
  appendUsageReport(dateDir, {
    blogNo, topic: eff.topic, account: eff.account,
    time: new Date().toTimeString().slice(0, 5),
    title, row: target.row, question: target.question, sheetKey: faq.key,
    cat: pick.folder.cat, folderName: pick.folder.name, folderId: pick.folder.dir,
    imageNames, faqs: usedFaqs, tags: extractTags(html), section: extractSection(html),
    mockupWarn, score: seoScore,
  });

  return { ok: true, blog: blogNo, account: blog.account, file: fpath, title, row: target.row, question: target.question, folder: pick.folder.name, imgs: usedStaged.length, images: imageNames, section: extractSection(html), score: seoScore, mode };
}

function makeCtx(log) {
  return { data: loadQuestions(), usedLog: loadUsedLog(), todaysFaqs: new Set(), log };
}

module.exports = {
  pickQuestion, draftAlive, questionExcluded, rowUsedQ, normQ,
  CLAUDE, runClaude, loadCfg, loadQuestions, loadUsedLog, pickQuestion, pickImages, pickImagesAny,
  listProjectFolders, generateOne, makeCtx, today, rssLinks, extractSection, extractTitle, loadCategories,
  usedRowSet, markWritten, markPosted, saveUsedLog, verifyMockupsVisually, repairFlatImages, judgeMockups, assembleOutput,
  extractTags, extractDesc, extractMeta, stripMeta, homeColumnLinks, homePosts, extractFaqs,
  stageImages, stageDriveImages, claimFolderToday, claimedFoldersToday, folderLastUse, sortByLastUse, recordFolderUse, scoreArticleSEO, recentImageMd5Set, fileMd5, appendScoreCsv, productCategoriesFor,
};
