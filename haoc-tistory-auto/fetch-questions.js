// fetch-questions.js — 하오커뮤니케이션 질문 목록을 '블록 구조 CSV'(E:\하커_tistory_원고\질문목록.csv)로 만든다.
//   3개 프로그램(티스토리/블로그스팟/홈페이지)이 이 CSV 하나를 읽는다.
//   출력 열 구조(하오팩토리 통합시트와 동일): 5블록 × 24열 —
//     정부지원사업=B열(2) · 디자인=Z열(26) · 웹=AX열(50) · 스튜디오=BV열(74) · 마케팅=CT열(98), 각 블록 [질문 | 포스팅 체크 | ...]
//     1행=블록명 헤더, 2행=열 헤더, 3행=서브헤더, 4행부터 데이터(데이터행 N = CSV N+3행).
//   입력(writer_config.json questionSource):
//     · sheetCsvUrl 이 있으면 구글시트 CSV(이미 블록 구조)를 그대로 내려받는다.
//     · 없으면 localCsv(6열: NO.,정부지원사업,디자인,웹,스튜디오,마케팅 — 하커_질문_500_v5.csv 형식)를 블록 구조로 변환한다.
//       localCsv에 '체크' 열은 없으므로 포스팅 체크는 비워 두고, 중복 방지는 _used_log.json(3플랫폼 공유)이 담당한다.
const fs = require('fs');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'writer_config.json'), 'utf8').replace(/^\uFEFF/, ''));
const OUT = cfg.csvFile;
const BLOCKS = ['정부지원사업', '디자인', '웹', '스튜디오', '마케팅'];
const BLOCK_W = 24;

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
const q = s => { s = String(s == null ? '' : s); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function buildBlockCsv(local) {
  // local: [[NO., 정부, 디자인, 웹, 스튜디오, 마케팅], ...] (1행 헤더)
  const header = local[0].map(h => String(h || '').replace(/^\uFEFF/, '').trim());
  const colOf = {};
  for (const b of BLOCKS) { const i = header.findIndex(h => h === b); if (i < 0) throw new Error(`localCsv 헤더에 '${b}' 열이 없습니다: ${header.join(',')}`); colOf[b] = i; }
  const data = local.slice(1).filter(r => r.some(c => String(c || '').trim()));
  const width = 1 + BLOCK_W * BLOCKS.length;
  const blank = () => new Array(width).fill('');
  const r1 = blank(); r1[0] = 'NO.'; BLOCKS.forEach((b, i) => { r1[1 + BLOCK_W * i] = b; });
  const r2 = blank(); BLOCKS.forEach((b, i) => { r2[1 + BLOCK_W * i] = '질문'; r2[2 + BLOCK_W * i] = '포스팅 체크'; r2[3 + BLOCK_W * i] = 'Google AI'; });
  const r3 = blank();
  const out = [r1, r2, r3];
  data.forEach((r, n) => {
    const row = blank(); row[0] = String(n + 1);
    BLOCKS.forEach((b, i) => { row[1 + BLOCK_W * i] = String(r[colOf[b]] || '').trim(); });
    out.push(row);
  });
  return out.map(r => r.map(q).join(',')).join('\n') + '\n';
}

(async () => {
  const src = cfg.questionSource || {};
  let txt;
  if (src.sheetCsvUrl) {
    const r = await fetch(src.sheetCsvUrl, { redirect: 'follow' });
    txt = await r.text();
    if (txt.trim().startsWith('<')) { console.log('FAIL: HTML 반환(시트 권한/차단) — 시트를 "링크가 있는 모든 사용자 보기"로 공유하세요'); process.exit(2); }
    console.log('시트 다운로드 OK status', r.status, '| bytes', txt.length);
  } else {
    if (!src.localCsv || !fs.existsSync(src.localCsv)) { console.log('FAIL: questionSource.localCsv 파일이 없습니다:', src.localCsv); process.exit(2); }
    const local = parseCSV(fs.readFileSync(src.localCsv, 'utf8').replace(/^\uFEFF/, ''));
    txt = buildBlockCsv(local);
    console.log('로컬 질문 파일 변환:', src.localCsv);
  }
  { const _rows = parseCSV(txt).slice(3); const _n = _rows.reduce((k, r) => k + BLOCKS.filter((b, i) => (r[1 + BLOCK_W * i] || '').trim()).length, 0);
    if (_n < 20 && fs.existsSync(OUT)) { console.log('FAIL: 내려받은 시트에 질문이 ' + _n + '개뿐 — 기존 질문목록을 유지합니다'); process.exit(2); } }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, txt, 'utf8');
  const rows = parseCSV(txt).slice(3);
  const summary = BLOCKS.map((b, i) => `${b}=${rows.filter(r => (r[1 + BLOCK_W * i] || '').trim()).length}`).join(' · ');
  console.log('저장:', OUT);
  console.log('블록별 질문 수:', summary);
  if (!rows.some(r => BLOCKS.some((b, i) => (r[1 + BLOCK_W * i] || '').trim()))) console.log('⚠ 질문이 0개입니다 — 질문 파일/시트를 채운 뒤 다시 새로고침하세요.');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
