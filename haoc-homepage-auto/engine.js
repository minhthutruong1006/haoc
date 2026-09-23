// engine.js (homepage) — 요일별 스케줄로 하루 2건. 질문/FAQ/이미지 선택은 티스토리·블로그스팟과
// 공유 로그로 중복 차단. 게시는 poster_hp.js(haoc.co.kr/admin.html 칼럼 폼 브라우저 자동화).
// ★하오커뮤니케이션(haoc.co.kr)판(2026-09-14): 하오디자인 홈페이지 엔진(C:\homepage-auto) 복제.
//   홈페이지 칼럼은 HTML이 아니라 '순수 텍스트'(제목/날짜/요약/본문 + 대표이미지 1장) — 원고는 .txt(첫 줄 #META JSON).
//   글 유형 info(사진 없음)/portfolio(참고 사진 + 대표이미지)/auto. 사진은 하오디자인·하오스튜디오 Drive 폴더 공유.
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const ACC = require('./accounts');  // Claude 다계정 전환/페일오버(3개 프로그램 공용 저장소)

const CFG_FILE = path.join(__dirname, 'writer_config.json');
function loadCfg() { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^﻿/, '')); }

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
      try { const vers = fs.readdirSync(cc).filter(v => /^\d/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); for (const v of vers) push(path.join(cc, v, 'claude.exe')); } catch {}
    }
  } catch {}
  return cands[0] || null;
}
const CLAUDE = findClaude();

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
function loadQuestions() { return parseCSV(fs.readFileSync(loadCfg().csvFile, 'utf8')).slice(3); }
function loadUsedLog() { try { return JSON.parse(fs.readFileSync(loadCfg().usedLog, 'utf8')); } catch { return {}; } }
function saveUsedLog(log) { fs.writeFileSync(loadCfg().usedLog, JSON.stringify(log, null, 2), 'utf8'); }
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function weekday() { const w = new Date().getDay(); return w === 0 ? 7 : w; } // 1=월..7=일

// ── 오늘의 슬롯(주제 2개) 결정: 스케줄 + 순환 쌍 토글 ──
function loadCycle() { try { return JSON.parse(fs.readFileSync(loadCfg().cycleState, 'utf8')); } catch { return {}; } }
function saveCycle(c) { fs.writeFileSync(loadCfg().cycleState, JSON.stringify(c, null, 2), 'utf8'); }
// 미리보기(상태 반영 안 함): 순환쌍은 현재 인덱스 기준으로만 보여줌
// ★사이트 5개 = 슬롯 5개(2026-09-15): 정부지원사업(haoc.co.kr)은 topicCycle(디자인→웹→마케팅)을 날마다 회전, 센터 4개는 각자 주제.
//   slot = { site, label(=site), topic(질문 열), subTopic(정부지원사업 회전 주제 또는 null), cycleKey, cyclePair, cycleIdx }
function todaysSlots(cfg, cycle, advance) {
  const out = [];
  for (const [site, sc] of Object.entries(cfg.sites || {})) {
    if (sc.topicCycle && sc.topicCycle.length) {
      const idx = (cycle[site] || 0) % sc.topicCycle.length;
      out.push({ site, label: site, topic: sc.questionBlock, subTopic: sc.topicCycle[idx], cycleKey: site, cyclePair: sc.topicCycle, cycleIdx: idx });
    } else out.push({ site, label: site, topic: sc.questionBlock, subTopic: null, cycleKey: null });
  }
  return out;
}
// 정부지원사업 질문을 디자인/웹/마케팅 성격으로 분류(가장 먼저 나오는 키워드 기준). 어느 쪽도 아니면 '기타'.
const SUB_KW = {
  '디자인': /카탈로그|카달로그|카다로그|브로슈어|브로셔|리플렛|리플릿|팜플렛|전단|포스터|패키지|라벨|회사소개서|제품소개서|명함|인쇄|디자인|현수막|배너|캐릭터|로고|CI|BI/i,
  '웹': /홈페이지|쇼핑몰|자사몰|웹사이트|사이트|랜딩|리뉴얼|온라인몰|스마트스토어|입점|상세페이지|반응형|워드프레스|카페24/i,
  '마케팅': /SNS|인스타|릴스|숏폼|유튜브|블로그|체험단|인플루언서|라이브커머스|라이브|광고|마케팅|바이어|상담회|전시회|박람회|통역|번역|콘텐츠|키워드|검색|매칭/i,
};
function classifySub(q) {
  if (/상세\s*페이지/.test(q || '')) return '디자인';  // ★2026-09-18: 상세페이지는 홈페이지(웹) 주제가 아니다 → 디자인 차례에서 다룬다
  let best = null, pos = Infinity;
  for (const [k, re] of Object.entries(SUB_KW)) { const m = re.exec(q || ''); if (m && m.index < pos) { pos = m.index; best = k; } }
  return best || '기타';
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


// ── 사용 행 판정(3개 프로그램 공용: postedRows=영구, writtenRows=3일 임시) ──
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

// ── 질문/FAQ (블로그스팟판과 동일 로직) ──
function pickQuestion(topicCfg, data, usedLog, blogNo, subTopic) {
  const used = usedRowSet(usedLog, blogNo);
  let fallback = null;
  for (let n = topicCfg.rowFrom; n <= topicCfg.rowTo; n++) {
    const r = data[n - 1]; if (!r) continue;
    const q = (r[topicCfg.qCol - 1] || '').trim();
    const chk = (r[topicCfg.checkCol - 1] || '').trim().toUpperCase();
    if (!q || chk === 'TRUE' || rowUsedQ(usedLog, blogNo, n, q, used) || draftAlive(q) || questionExcluded(subTopic ? ((loadCfg().topics || {})[subTopic] || {}) : topicCfg, q)) continue;  // ★미발행 원고가 살아 있는 질문·제외 패턴 질문은 건너뜀
    if (!subTopic) return { row: n, question: q };
    const c = classifySub(q);
    if (c === subTopic) return { row: n, question: q, sub: c };
    if (!fallback && c === '기타') fallback = { row: n, question: q, sub: c };
  }
  return fallback;  // 해당 성격 질문이 바닥나면 '기타'(분류 안 되는 질문)로, 그것도 없으면 null
}
// ★FAQ 다양화(2026-07-28): 최근 14일 제외 + LRU 순 제공 + 풀 고갈 시 완화(티스토리판과 동일).
function faqCandidates(topicCfg, data, usedLog, targetQ, todaysFaqs) {
  const key = topicCfg.sheetBlock || ('col' + topicCfg.qCol);
  const log = (usedLog.faqLog || {})[key] || [];
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const lastUse = new Map();
  for (const e of log) { const p = lastUse.get(e.q); if (!p || e.date > p) lastUse.set(e.q, e.date); }
  const all = [];
  for (let n = 1; n <= 300; n++) {
    const r = data[n - 1]; if (!r) break;
    const q = (r[topicCfg.qCol - 1] || '').trim();
    if (!q || q === targetQ || todaysFaqs.has(q)) continue;
    all.push({ q, last: lastUse.get(q) || '' });
  }
  let pool = all.filter(x => !x.last || x.last < cutoff);
  if (pool.length < 15) pool = all;
  pool.sort((a, b) => (a.last < b.last ? -1 : a.last > b.last ? 1 : 0));
  return { key, candidates: pool.slice(0, 40).map(x => x.q) };
}

// ── Drive 이미지 (블로그스팟판과 동일) ──
const IMG_EXT = /\.(jpe?g|png|webp)$/i;
const DRIVE_CACHE = new Map();
async function driveList(folderId) {
  const c = DRIVE_CACHE.get(folderId);
  if (c && Date.now() - c.t < 10 * 60000) return c.entries;
  const r = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}#list`, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`drive 폴더 조회 HTTP ${r.status}`);
  const html = await r.text();
  const entries = []; const re = /<div class="flip-entry" id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?flip-entry-title">([^<]*)</g;
  let m; while ((m = re.exec(html))) entries.push({ id: m[1], name: m[3].trim(), isFolder: m[2].includes('/folders/') });
  DRIVE_CACHE.set(folderId, { t: Date.now(), entries });
  return entries;
}
const YEARISH = /^(19|20)\d{2}([\s~\-–—]+\d{2,4})?$/;
// ★컨테이너 폴더(2026-09-04): 연도(2023/2024-2025/2026)·poster·'New folder'처럼 프로젝트가 아니라
//   프로젝트들을 '담는' 폴더는 재귀로 펼쳐 그 안의 프로젝트 폴더를 후보에 넣는다(최대 3단계).
const isContainerFolder = n => YEARISH.test(n) || /^poster$/i.test(n) || /^new\s*folder/i.test(n);
async function driveProjectFolders(topicCfg, cfg) {
  const out = [];
  const excluded = n => cfg.excludeFolderPatterns.some(p => n.toLowerCase().includes(p.toLowerCase()));
  async function expand(cat, folderId, depth) {
    let entries = []; try { entries = await driveList(folderId); } catch { return; }
    for (const e of entries.filter(x => x.isFolder)) {
      if (excluded(e.name)) continue;
      if (depth < 3 && isContainerFolder(e.name)) await expand(cat, e.id, depth + 1);
      else out.push({ cat, name: e.name, id: e.id });
    }
  }
  for (const cat of topicCfg.categories) {
    const rootId = (cfg.imageCategoriesDrive || {})[cat]; if (!rootId) continue;
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
  let entries = []; try { entries = await driveList(folderId); } catch { return []; }
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
//   질문에 형태 단어가 없으면 null → 기존 topic 기본 카테고리 사용.
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


async function pickImages(topicCfg, cfg, usedLog, skip) {
  const used = claimedFoldersToday(cfg);  // ★공유 로그 + 오늘 다른 플랫폼이 찜한 폴더(디스크에서 새로 읽음)
  const skipSet = new Set(skip || []);   // 목업이 없어 탈락시킨 폴더
  const allFolders = (await driveProjectFolders(topicCfg, cfg)).filter(f => !skipSet.has(f.name));
  // ★웹·마케팅(writer_config.fileLevelReuseCategories)은 폴더 단위가 아니라 사진 단위로 재사용을 막는다(2026-09-18) — 사진 20~37장짜리 폴더가 하루 한 번 쓰였다고 통째로 잠기면 주제에 맞는 폴더를 못 고른다.
  const _fileLevel = f => (cfg.fileLevelReuseCategories || []).includes(f.cat);
  let folders = allFolders.filter(f => _fileLevel(f) || (!used.has(f.id) && !used.has(f.name)));
  if (!folders.length) folders = allFolders;  // ★오늘까지 전부 소진 → 오늘 쓴 폴더도 재사용(최후 폴백)
  if (topicCfg.industryKeywords.length) {
    folders = folders.filter(f => topicCfg.industryKeywords.some(k => f.name.toLowerCase().includes(k.toLowerCase())));
    if (!folders.length) return null;
  }
  folders = sortByLastUse(folders, cfg);  // 오래 안 쓴 폴더 먼저 → 날짜 넘는 중복 최소화
  folders = preferContentMatch(folders, topicCfg._q);  // ★질문 업종과 폴더명이 맞으면 그 폴더 우선
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
    files = rankByQuestion(files, topicCfg._q);  // ★질문과 파일명이 맞는 사진을 앞세움
    if (files.filter(x => imageRank(x.name) === 0).length >= 2) return take(f, files);  // 목업 폴더 — 바로 채택
    if (!fallback) fallback = { f, files };
    if (++scanned >= MOCKUP_SCAN_LIMIT) break;
  }
  return fallback ? take(fallback.f, fallback.files) : null;
}
function imgUrl(id) { return `https://lh3.googleusercontent.com/d/${id}=w1200`; }
async function stageImages(images, outDir, prefix) {
  const staged = [];
  for (let i = 0; i < images.length; i++) {
    const raw = path.join(outDir, `_dl_${prefix}_${i + 1}.bin`);
    let buf;
    for (let attempt = 1; attempt <= 3; attempt++) {  // ★일시적 네트워크(terminated 등) 재시도 — 한 장 실패로 글 전체가 죽지 않게
      try {
        const r = await fetch(`https://drive.google.com/uc?export=download&id=${images[i].id}`, { redirect: 'follow', signal: AbortSignal.timeout(90000) });
        buf = Buffer.from(await r.arrayBuffer());
        if (buf[0] === 0x3c) throw new Error('drive 파일 접근 불가 ' + images[i].id);
        break;
      } catch (e) {
        if (/접근 불가/.test(e.message) || attempt === 3) throw e;
        await new Promise(res => setTimeout(res, 800 * attempt));
      }
    }
    fs.writeFileSync(raw, buf);
    const out = path.join(outDir, `${prefix}_${i + 1}.webp`);
    // 첫 이미지는 대표이미지(썸네일)용 JPG도 생성 — 홈페이지 크롭 서버가 webp를 거부하기 때문.
    let thumbJpg = '';
    if (i === 0) {
      const tj = path.join(outDir, `${prefix}_thumb.jpg`);
      try { execSync(`ffmpeg -y -i "${raw}" -vf "scale='min(1200,iw)':-2" -q:v 3 "${tj}"`, { stdio: 'ignore' }); if (fs.existsSync(tj) && fs.statSync(tj).size > 1000) thumbJpg = tj; } catch {}
    }
    let abs = raw;
    try { execSync(`ffmpeg -y -i "${raw}" -vf "scale='min(1200,iw)':-2" "${out}"`, { stdio: 'ignore' }); if (fs.existsSync(out) && fs.statSync(out).size > 1000) { fs.unlinkSync(raw); abs = out; } } catch {}
    if (abs === raw) { const cp = path.join(outDir, `${prefix}_${i + 1}${path.extname(images[i].name) || '.jpg'}`); fs.renameSync(raw, cp); abs = cp; }
    staged.push({ id: images[i].id, name: images[i].name, url: imgUrl(images[i].id), abs, thumbJpg });
  }
  return staged;
}

const SB_URL_DEFAULT = 'https://oaqrjrrgntlqmyxxovfn.supabase.co';
const SB_ANON_DEFAULT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9hcXJqcnJnbnRscW15eHhvdmZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NjQzMTUsImV4cCI6MjA5NzE0MDMxNX0.3bOfZOXVKSoI9ELfE7ZjWETuxvjpNYHdCBSIMrbAGtU';
// Supabase overrides.{key} (hv_posts=haoc.co.kr · hao_posts=design · hs_posts=studio · hw_posts=web · hm_posts=mkt) — 읽기 전용
async function homePosts(key) {
  const cfg = loadCfg();
  const k = cfg.supabaseAnonKey || SB_ANON_DEFAULT;
  const r = await fetch((cfg.supabaseUrl || SB_URL_DEFAULT) + '/rest/v1/overrides?select=v&k=eq.' + encodeURIComponent(key || 'hv_posts'),
    { headers: { apikey: k, Authorization: 'Bearer ' + k }, signal: AbortSignal.timeout(12000) });
  const j = await r.json();
  let v = j && j[0] && j[0].v; if (typeof v === 'string') v = JSON.parse(v);
  return (Array.isArray(v) ? v : []).map(p => (p && p.title == null && p.t != null) ? { ...p, title: p.t, summary: p.summary || p.d } : p);  // ★마케팅센터는 제목=t·요약=d
}
function siteCfg(site) { const cfg = loadCfg(); return (cfg.sites || {})[site] || (cfg.sites || {})['정부지원사업'] || { postsKey: 'hv_posts', siteBase: 'https://haoc.co.kr' }; }
async function columnLinks(site) {
  try {
    const sc = siteCfg(site);
    return (await homePosts(sc.postsKey)).slice(0, 15)
      .map(p => ({ title: String(p.title || '').replace(/\s+/g, ' ').trim(), url: `${sc.siteBase}/column-${p.id}.html` }))
      .filter(x => x.title.length > 6);
  } catch { return []; }
}

// ── 프롬프트 ──
function buildPrompt(cfg, topic, target, faq, staged, links, subjectOverride) {
  const engine = fs.readFileSync(cfg.enginePrompt, 'utf8');
  const tc = (cfg.topics || {})[topic] || {};
  const subject = subjectOverride || tc.subject || topic;
  const mode = staged.length ? 'portfolio' : 'info';
  const imgList = staged.map((s, i) => `${i + 1}. ${s.abs}`).join('\n');
  const faqList = faq.candidates.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const linkList = links.length ? links.map(l => `- ${l.title}`).join('\n') : '(없음)';
  const td = today();
  const imageBlock = mode === 'portfolio'
    ? `[글 유형] 포트폴리오 — 아래 참고 사진 ${staged.length}장을 Read 도구로 실제로 열어보고, 그 프로젝트(산출물·업종·구성·색·언어·분위기)를 글로 묘사해 사례(증거)로 쓴다.
★본문에 이미지·마커·링크는 넣지 않는다(프로그램이 1번 사진을 대표이미지로 따로 올린다). 사진 속 고객사·브랜드명·제품명은 쓰지 않고 업종·산출물로만 말한다. 사진과 명백히 모순되는 물리 표현만 피한다.
${imgList}`
    : `[글 유형] 정보글 — 참고 사진 없음. 없는 프로젝트·고객사를 실제 사례처럼 지어내지 않는다(예시는 "예를 들어 ○○ 기업이라면" 가정형).`;
  return `${engine}

---
[자동 주입 블록]

[오늘의 타겟 질문 — 이 질문이 글의 근거다. 이 질문을 한 사람이 만족할 '답'이 되는 글을 쓴다]
${target.question}

[주제] ${subject}
[게시일] ${td.replace(/-/g, '.')} — 프로그램이 날짜 칸에 넣는다. 본문에 날짜를 쓰지 않는다.

${imageBlock}

[FAQ 후보 — 같은 주제의 질문 목록. 이 목록을 재료로 5개를 고르거나 다듬는다(어미는 존댓말 의문형 ~요?)]
${faqList}

[이미 홈페이지 칼럼에 올라간 최근 글 제목 — 같은 각도·비슷한 제목을 피한다(링크는 넣지 않는다)]
${linkList}

[출력 형식 — 절대 준수]
- "자가 채점: NN/20" 한 줄 → \`\`\`json 블록({"headline":"...","summary":"...","keywords":"..."}) → \`\`\`text 블록(본문 전체, 문단은 빈 줄로 구분). 그 외 설명·머리말 없음.
- 본문 첫 문단은 "■ 핵심 요약"으로, 두 번째 문단은 "안녕하세요, 하오커뮤니케이션입니다."로 시작한다. HTML 태그·URL·이모지·마크다운 기호 금지.
지금 작성하라.`;
}
// ── claude -p 실행 (비동기) — 계정별 env로 1회 호출 ──
function spawnClaudeOnce(prompt, cfg, env) {
  const args = ['-p', '--model', cfg.model || 'opus', '--allowedTools', 'Read'];
  return new Promise((resolve, reject) => {
    const p = spawn(CLAUDE, args, { windowsHide: true, env });
    let out = '', err = '';
    const to = setTimeout(() => { try { p.kill(); } catch {} reject(new Error(`claude 시간 초과`)); }, (cfg.claudeTimeoutSec || 600) * 1000);
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(to); reject(e); });
    p.on('close', (code) => {
      clearTimeout(to);
      const c = out + '\n' + err;
      if (/Not logged in|Please run \/login/i.test(c)) return reject(new Error('Not logged in (login 필요)'));
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
  const headline = _fld('headline'), description = _fld('description') || _fld('summary'), keywords = _fld('keywords'), articleSection = _fld('articleSection') || _fld('topic');
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
- trust(2): 이모지·중복표현·금지 태그·날조된(출처 불명의 지어낸) 사실이 없는가. ★중요: 이 글은 자사 칼럼이라 (a)도입 인사말('안녕하세요, OOO입니다'), (b)작성자 바이라인('하오디자인 디자인팀 · 날짜 발행' 줄), (c)신뢰지표 블록(자사 경력·누적 실적 수치), (d)맨 아래 CTA(브랜드명·홈페이지), (e)자사 서비스·견적 페이지로 가는 내부 링크(haodesign.co.kr/sub…)에 자사 브랜드명·실적이 들어가는 것이 '정상 구성'이다 → 이 블록들의 브랜드명·실적·내부링크는 절대 감점하지 말 것. 오직 '조언 본문 문단'과 'FAQ 답변'처럼 중립적이어야 할 정보 영역에 업체명이 새어 들어갔거나, 없는 사실을 지어냈을 때만 감점한다.

★이 원고는 홈페이지 관리자 폼에 들어가는 '순수 텍스트 칼럼'이다 — HTML 표/카드·이미지 alt·메타 태그·스키마가 없는 것은 절대 감점하지 말고, 텍스트 구조(■ 소제목 · ①②③ 나열 · "Q./A." FAQ 문단 · 빈 줄 청크)로 structure/faq/meta를 판단한다. meta는 [메타] 블록의 description(요약 한 줄)·keywords로 판단한다. FAQ 스키마 일치 항목은 본문 Q./A. 5쌍이 정돈돼 있으면 만점으로 본다.

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

// ★출력(json 블록 + text 블록)을 '#META {…}' 한 줄 + 본문 텍스트로 조립한다. 게시 도구가 #META에서 제목·요약·날짜·대표이미지를 읽는다.
function assembleText(raw, extra) {
  const fences = [...String(raw || '').matchAll(/```([a-zA-Z]*)[ \t]*\r?\n([\s\S]*?)```/g)].map(m => ({ lang: (m[1] || '').toLowerCase(), body: m[2] }));
  let meta = null, body = '';
  const jb = fences.find(f => f.lang === 'json');
  if (jb) meta = parseJsonLoose(jb.body);
  const tb = fences.find(f => f.lang === 'text' || f.lang === 'txt') || fences.find(f => f.lang !== 'json');
  if (tb) body = tb.body;
  if (!meta) { meta = parseJsonLoose(raw); }
  if (!body) {  // 펜스가 없으면 json 뒤 전부를 본문으로
    let t = String(raw || '');
    const k = t.indexOf('}'); if (meta && k >= 0) t = t.slice(k + 1);
    body = t.replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  }
  body = body.replace(/\r/g, '').replace(/^\s*자가 채점[^\n]*\n/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  const m = { headline: '', summary: '', keywords: '', ...(meta || {}), ...(extra || {}) };
  return `#META ${JSON.stringify(m)}\n\n${body}\n`;
}
function extractMeta(text) { const m = String(text || '').match(/^#META[ \t]*(\{[\s\S]*?\})[ \t]*$/m); return m ? parseJsonLoose(m[1]) : null; }
function extractBody(text) { return String(text || '').replace(/^#META[^\n]*\n+/, '').trim(); }
function cleanOutput(raw) { return assembleText(raw); }

// ── 추출·검증 ──
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
function extractField(html, key) { const m = html.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)); return m ? m[1].replace(/\\"/g, '"') : ''; }
function extractTags(html) { const v = extractField(html, 'keywords'); return v ? v.split(',').map(t => t.trim()).filter(Boolean) : []; }
function extractTitle(html) { return extractField(html, 'headline'); }
function extractSection(html) { return extractField(html, 'topic'); }
function extractDesc(html) { return extractField(html, 'summary'); }
function extractFaqs(text) { return extractBody(text).split(/\n\s*\n/).map(p => p.trim()).filter(p => /^Q\./.test(p)).map(p => p.replace(/^Q\.\s*/, '').trim()); }
function extractFaqAnswers(text) { return extractBody(text).split(/\n\s*\n/).map(p => p.trim()).filter(p => /^A\./.test(p)).map(p => p.replace(/^A\.\s*/, '').trim()); }
const BRAND_KO = '하오커뮤니케이션';
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
alt = 업종 + 산출물 + 무엇이 보이는지 (예: 병원 브로슈어 내지 펼침 목업).

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

function validate(text, staged, topic, cfg) {
  const errs = [];
  const meta = extractMeta(text);
  if (!meta) errs.push('#META 없음 — json 블록(headline/summary/keywords)이 필요');
  else {
    const h = String(meta.headline || '').trim();
    if (h.length < 5) errs.push('headline(제목) 없음');
    else if (h.length > 40) errs.push(`제목 너무 김(${h.length}자) — 26~32자`);
    const sm = String(meta.summary || '').trim();
    if (!sm) errs.push('summary(요약 한 줄) 없음');
    else if (sm.length < 15 || sm.length > 90) errs.push(`summary 길이 ${sm.length}자 — 40자 안팎 한 문장`);
    if (/■|①|②|③/.test(sm)) errs.push('summary에 기호(■·①) 금지');
  }
  const body = extractBody(text);
  if (/<\/?[a-zA-Z][^>]*>/.test(body)) errs.push('본문에 HTML 태그 발견 — 순수 텍스트만');
  if (/https?:\/\/|www\./i.test(body)) errs.push('본문에 URL 링크 발견 — 링크 금지(기관명만)');
  if (/\[\[img:/i.test(body)) errs.push('본문 이미지 마커 금지');
  if (/```|\*\*|^#{1,3}\s/m.test(body)) errs.push('마크다운 기호(**, #, ```) 잔존');
  if (EMOJI_RE.test(text)) errs.push('이모지 발견');
  const len = body.replace(/\s/g, '').length;
  if (len < 1500) errs.push(`본문 분량 부족(공백 제외 약 ${len}자)`);
  const paras = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (!/^■\s*핵심 요약/.test(paras[0] || '')) errs.push("첫 문단이 '■ 핵심 요약'으로 시작하지 않음");
  if (!/안녕하세요, 하오커뮤니케이션입니다/.test(body)) errs.push("인사 문단('안녕하세요, 하오커뮤니케이션입니다.') 없음");
  const heads = paras.filter(p => /^■/.test(p) && !/핵심 요약|자주 묻는 질문/.test(p));
  if (heads.length < 4) errs.push(`질문형 소제목(■ 한 줄 문단) ${heads.length}개 — 4개 필요`);
  if (!paras.some(p => /^■\s*자주 묻는 질문/.test(p))) errs.push("'■ 자주 묻는 질문' 소제목 문단 없음");
  const qs = extractFaqs(text), as = extractFaqAnswers(text);
  if (qs.length !== 5 || as.length !== 5) errs.push(`FAQ Q ${qs.length}개 / A ${as.length}개 — 각 5개(Q. 문단 + A. 문단)`);
  const noQ = qs.filter(q => !/요\s*\?\s*$/.test(q.trim()));
  if (noQ.length) errs.push(`FAQ 질문 ${noQ.length}개가 존댓말 의문형(~요?)으로 안 끝남`);
  if ([...qs, ...as].some(p => p.includes(BRAND_KO))) errs.push(`FAQ 질문/답변에 브랜드명(${BRAND_KO}) 노출 — 중립적으로`);
  if (!/haoc\.co\.kr/.test(body) || !/1666-2027/.test(body)) errs.push('마무리 문단에 홈페이지 haoc.co.kr, 전화 1666-2027 안내 필요');
  if (!/412/.test(body)) errs.push('신뢰 문단(412건+ 등 실적 1회) 없음');
  const brandN = (body.match(/하오커뮤니케이션/g) || []).length;
  if (brandN > 6) errs.push(`본문에 브랜드명 ${brandN}회 — 인사·신뢰·마무리 문단에서만(과다)`);
  if (staged && staged.length && !meta) {}
  return errs;
}
function safeName(s) { return s.replace(/[\\/:*?"<>|]/g, '').replace(/\?+\s*$/, '').trim(); }

// ── Drive 경로 표기(used 폴더로 옮길 때 찾아가기 쉽게) ──
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
    `■ [홈페이지] ${e.slotLabel} ${e.topic} — ${e.time}`,
    `  제목: ${e.title}`,
    `  글 유형: ${e.mode === 'info' ? '정보글(사진 없음)' : '포트폴리오(대표이미지 1장)'}`,
    `  질문: [${e.sheetKey}열 ${e.row}번째 질문 = 시트 ${e.row + 3}행] ${e.question}`,
    ...(e.imageNames.length ? [
      `  ── used 폴더로 옮길 이미지 ──`,
      `  위치: ${CAT_PATH[e.cat] || e.cat || '?'} > ${e.folderName}`,
      `  폴더 링크: ${driveFolderUrl(e.folderId)}`,
      `  ★실제 사용한 파일(${e.imageNames.length}장): ${e.imageNames.join(', ')} (대표이미지)`,
    ] : []),
    `  키워드: ${(e.tags || []).join(', ')}`,
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


// ── 슬롯 1개 생성 ──
// overrides: { question, row } — ★원고별 다시쓰기(2026-09-21): 같은 질문으로 다시 쓸 때 질문을 고르지 않고 그대로 쓴다(선점은 이미 돼 있음)
async function generateSlot(slot, slotIdx, ctx, overrides = {}) {
  const cfg = loadCfg();
  const topic = slot.topic;                       // 질문 열(시트 블록)
  const topicCfg = cfg.topics[topic];
  const blogNo = topicCfg.no;
  const log = ctx.log || (() => {});
  const dateDir = path.join(cfg.draftsDir, today());
  fs.mkdirSync(dateDir, { recursive: true });
  const recentImgSet = recentImageMd5Set(cfg.dupCheckDays || 10);  // 내용 중복 안전망 스냅샷
  const slotLabel = slot.label || slot.site;      // 파일명 접두 = 사이트명
  const site = slot.site;
  // 정부지원사업 사이트: 회전 주제(디자인/웹/마케팅)의 성격을 가진 질문만 고르고, 사진·글유형·주제 표기는 그 회전 주제를 따른다
  const subCfg = slot.subTopic ? (cfg.topics[slot.subTopic] || {}) : null;
  const fileTopic = slot.subTopic || topic;

  const target = overrides.question
    ? { row: overrides.row || 0, question: overrides.question }
    : pickQuestion(topicCfg, ctx.data, ctx.usedLog, blogNo, slot.subTopic);
  if (!target) return { ok: false, slot: slotIdx, slotLabel, topic: fileTopic, reason: `질문 소진(${topic}${slot.subTopic ? '/' + slot.subTopic : ''})` };
  log(`[${slotLabel}${slot.subTopic ? ' · ' + slot.subTopic : ''}] 질문(${topic} 행${target.row}): ${target.question.slice(0, 40)}...`);
  if (target.row) claimRow(cfg, ctx.usedLog, blogNo, target.row);  // ★즉시 선점
  const faq = faqCandidates(topicCfg, ctx.data, ctx.usedLog, target.question, ctx.todaysFaqs);

  // 글 유형(info/portfolio) + 질문 속 산출물 형태에 맞춰 이미지 카테고리를 좁힌다.
  const prodCats = productCategoriesFor(target.question);
  const drv = cfg.imageCategoriesDrive || {};
  const modeCfg = subCfg ? (subCfg.imageMode || 'auto') : topicCfg.imageMode;
  const autoImg = modeCfg === 'portfolio-auto';  // ★사진 있으면 포트폴리오, 없으면 정보글(2026-09-16 운영자 지시) — 아래 portfolio 분기가 폴더 없으면 info로 넘긴다
  let mode = modeCfg === 'info' ? 'info' : modeCfg === 'auto' ? (prodCats ? 'portfolio' : 'info') : 'portfolio';
  const baseCats = (subCfg && subCfg.categories && subCfg.categories.length) ? subCfg.categories : (topicCfg.categories || []);
  let imgTopicCfg = { ...topicCfg, categories: baseCats, ...(prodCats && !autoImg ? { categories: prodCats.filter(c => drv[c]) } : {}), _q: target.question };
  if (!imgTopicCfg.categories.length) imgTopicCfg.categories = baseCats.length ? baseCats : Object.keys(drv);
  log(`  글 유형: ${mode === 'info' ? '정보글(사진 없음)' : '포트폴리오(참고 사진 + 대표이미지)'}${prodCats ? ' | 산출물 매칭: ' + prodCats.join(', ') : ''}`);

  // 참고 사진(포트폴리오형): 폴더 → 사전 눈검사 → 적합 사진만. 없으면 정보글로 전환.
  let pick = { folder: { name: '(정보글 — 사진 없음)', cat: '', id: '' }, images: [] }, staged = [], thumb = '';
  if (mode === 'portfolio') {
    const FOLDER_TRIES = 3; const skipFolders = [];
    for (let folderTry = 1; folderTry <= FOLDER_TRIES; folderTry++) {
      const p = await pickImages(imgTopicCfg, cfg, ctx.usedLog, skipFolders);
      if (!p) { log('  ⚠ 사용 가능한 이미지 폴더 없음 → 정보글로 전환'); mode = 'info'; staged = []; break; }
      log(`  이미지 폴더: ${p.folder.name} (${p.images.length}장)${folderTry > 1 ? ` — ${folderTry}번째 폴더` : ''}`);
      recordFolderUse(cfg, ctx.usedLog, p.folder);  // ★race-guard
      let st = await stageImages(p.images, dateDir, `${slotLabel}_${fileTopic}`);
      if (recentImgSet && recentImgSet.size) {
        const dupN = st.reduce((k, x) => k + (recentImgSet.has(fileMd5(x.abs)) ? 1 : 0), 0);
        if (dupN >= Math.max(2, Math.ceil(st.length / 2))) {
          log(`  ⚠ 내용 중복: 이 폴더 이미지가 최근 원고와 ${dupN}/${st.length}장 겹침 → 폴더 교체`);
          skipFolders.push(p.folder.name);
          if (folderTry < FOLDER_TRIES) continue;
        }
      }
      const judged = await judgeMockups(st, cfg, log, target.question);
      const mock = judged.mock || {};
      if (Object.keys(mock).length) {
        const dupDrop = new Set();
        for (const g of (judged.dupGroups || [])) g.slice(1).forEach(x => dupDrop.add(x));
        const good = st.filter(x => mock[imgName(x)] === true && !dupDrop.has(imgName(x)));
        log(`  사전 눈검사: 게시 적합 ${good.length}/${st.length}` + (good.length < st.length ? ` | 제외: ${st.filter(x => !good.includes(x)).map(imgName).join(', ')}` : ''));
        if (good.length) { st = orderByBest(good, judged.best); if (judged.best && judged.best.length) log(`  주제 맞춤 순위: ${judged.best.slice(0, 3).join(' > ')}`); }
        else { skipFolders.push(p.folder.name); if (folderTry < FOLDER_TRIES) { log('  이 폴더엔 쓸 사진이 없음 → 폴더 교체'); continue; } if (mockupOnlyCat(cfg, p.folder.cat)) return { ok: false, slot: slotIdx, slotLabel, topic: fileTopic, reason: `목업 사진 없음: 폴더 ${FOLDER_TRIES}곳 모두 눈검사 탈락(${skipFolders.join(', ')}) — 목업 강제 규칙으로 저장하지 않음` }; log('  ⚠ 적합 사진을 못 찾음 — 마지막 폴더 사진으로 진행'); }
      }
      pick = p; staged = st.slice(0, 3); break;
    }
    if (staged.length) {
      const tj = path.join(dateDir, `${slotLabel}_${fileTopic}_thumb.jpg`);
      try { execSync(`ffmpeg -y -i "${staged[0].abs}" -vf "scale='min(1280,iw)':-2" -q:v 3 "${tj}"`, { stdio: 'ignore' }); if (fs.existsSync(tj) && fs.statSync(tj).size > 1000) thumb = tj; } catch {}
      if (!thumb && staged[0].thumbJpg && fs.existsSync(staged[0].thumbJpg)) thumb = staged[0].thumbJpg;
    } else mode = 'info';
  }

  const links = await columnLinks(site);
  const subject = slot.subTopic ? `정부지원사업 — ${(cfg.topics[slot.subTopic] || {}).subject || slot.subTopic} 분야(정부지원사업 활용 관점으로)` : ((cfg.topics[topic] || {}).subject || topic);
  let text = '', errs = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    let prompt = buildPrompt(cfg, topic, target, faq, staged, links, subject);
    if (attempt === 2 && errs.length) prompt += `\n\n[이전 시도 문제점 — 반드시 고쳐서 다시 작성]\n- ${errs.join('\n- ')}`;
    text = assembleText(await runClaude(prompt, cfg, log), { site, topic: fileTopic, date: today().replace(/-/g, '.'), mode, thumb: thumb ? path.basename(thumb) : '' });
    errs = validate(text, staged, fileTopic, cfg);
    if (!errs.length) break;
    log(`  검증 실패(${attempt}차): ${errs.join(' / ')}`);
  }
  if (errs.length) return { ok: false, slot: slotIdx, slotLabel, topic: fileTopic, reason: '검증 실패: ' + errs.join(' / ') };

  const fname = `${slotLabel}_${fileTopic}_${safeName(target.question)}.txt`;
  const fpath = path.join(dateDir, fname);
  fs.writeFileSync(fpath, text, 'utf8');
  const title = extractTitle(text);
  log(`  저장: ${fname} | 제목: ${title.slice(0, 40)}`);

  const seoScore = await scoreArticleSEO(text, null, cfg, log);
  if (seoScore) {
    log(`  ▣ SEO/AEO/GEO 채점: ${seoScore.total}/20 (SEO ${seoScore.seo}/7·AEO ${seoScore.aeo}/7·GEO ${seoScore.geo}/6)${seoScore.total < 18 ? '  ⚠ 18점 미만 — 검토 필요' : '  ✅'} | 약점: ${seoScore.weakest || '-'}`);
    appendScoreCsv({ date: today(), platform: 'homepage', account: `${slotLabel}_${fileTopic}`, title, score: seoScore });
  }

  const ul = ctx.usedLog;
  markWritten(ul, blogNo, target.row);
  ul.faqLog = ul.faqLog || {};
  const usedFaqs = extractFaqs(text);
  ul.faqLog[faq.key] = (ul.faqLog[faq.key] || []).concat(usedFaqs.map(q => ({ q, date: today() })));
  usedFaqs.forEach(q => ctx.todaysFaqs.add(q));
  saveUsedLog(ul);
  if (slot.cycleKey) { ctx.cycle[slot.cycleKey] = ((ctx.cycle[slot.cycleKey] || 0) + 1) % slot.cyclePair.length; saveCycle(ctx.cycle); }  // 정부지원사업 회전 진행(성공 시)

  const usedImageNames = staged.length ? [staged[0].name] : [];
  recordUsedImages(cfg, staged.length ? [staged[0]] : []);  // ★파일 단위 사용기록(대표이미지로 쓴 사진)
  appendUsageReport(dateDir, {
    slotLabel, topic: fileTopic, time: new Date().toTimeString().slice(0, 5), mode,
    title, section: fileTopic, row: target.row, question: target.question, sheetKey: faq.key,
    cat: pick.folder.cat, folderName: pick.folder.name, folderId: pick.folder.id, imageNames: usedImageNames,
    tags: extractTags(text), faqs: usedFaqs, score: seoScore,
  });
  return { ok: true, slot: slotIdx, slotLabel, site, topic: fileTopic, file: fpath, fname, title, section: fileTopic, row: target.row, folder: pick.folder.name, imgs: usedImageNames.length, thumb, score: seoScore, mode };
}

async function generateToday(ctx) {
  const cfg = loadCfg();
  const slots = todaysSlots(cfg, ctx.cycle, true);
  if (!slots.length) { ctx.log && ctx.log('오늘(일요일)은 게시 없음'); return []; }
  const results = [];
  for (let i = 0; i < slots.length; i++) {
    try { results.push(await generateSlot(slots[i], i, ctx)); }
    catch (e) { results.push({ ok: false, slot: i, topic: slots[i].topic, reason: e.message.slice(0, 150) }); ctx.log && ctx.log(`[슬롯${i}] 오류: ${e.message.slice(0, 100)}`); }
  }
  return results;
}

function makeCtx(log) { return { data: loadQuestions(), usedLog: loadUsedLog(), cycle: loadCycle(), todaysFaqs: new Set(), log }; }

function previewToday() {
  const cfg = loadCfg();
  const slots = todaysSlots(cfg, loadCycle(), false);
  const data = loadQuestions(), usedLog = loadUsedLog();
  return slots.map((s, i) => {
    const tc = cfg.topics[s.topic];
    const q = pickQuestion(tc, data, usedLog, tc.no, s.subTopic);
    return { slot: i, slotLabel: s.label, site: s.site, topic: s.subTopic ? `${s.topic} → ${s.subTopic}` : s.topic, cyclePair: s.cyclePair || null, row: q ? q.row : null, question: q ? q.question : '(소진)' };
  });
}

module.exports = {
  pickQuestion, draftAlive, questionExcluded, rowUsedQ, normQ,
  verifyMockupsVisually, CLAUDE, runClaude, loadCfg, loadQuestions, loadUsedLog, saveUsedLog, loadCycle, weekday, generateToday, generateSlot, makeCtx, today, previewToday, todaysSlots, extractTitle, extractTags, extractSection, extractDesc, extractFaqs, usedRowSet, markWritten, markPosted,
  pickImages, stageImages, claimFolderToday, claimedFoldersToday, judgeMockups, scoreArticleSEO, recentImageMd5Set, fileMd5, productCategoriesFor,
  homePosts, columnLinks, extractMeta, extractBody, assembleText, validate, classifySub, siteCfg,
};
