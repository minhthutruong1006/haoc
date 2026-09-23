// sync-posted.js — ★3개 플랫폼(티스토리·블로그스팟·홈페이지)에서 '실제로 공개 발행된 글'을 확인해
//   공유 로그(_used_log.json)의 postedRows(영구 사용 처리)를 갱신한다. (하오커뮤니케이션판 2026-09-14)
//   - writtenRows: 원고를 쓴 행(임시, 3일). 게시 안 되면 며칠 뒤 질문이 자동으로 풀린다.
//   - postedRows : 실제 발행 확인된 행(영구 제외). 키 = usedNo(1=정부지원사업·2=디자인·3=웹·4=스튜디오·5=마케팅).
//   ★사용내역.txt 블록을 '■' 단위로 나눠 제목/질문(블록명·행)을 읽는다(하오디자인판의 정규식은 '이미지 폴더:' 줄이 없어 매칭이 안 됐음).
// 실행: node sync-posted.js            → 확인만(변경 미리보기)
//       node sync-posted.js --apply    → _used_log.json 갱신
const fs = require('fs');
try { require('../shared/haoc-sync'); } catch (e) { console.error('[공유] haoc-sync 없음 → 로컬 기록만: ' + e.message); } // ★두 PC 공유(2026-09-23)
const path = require('path');

const LOG = 'E:\\하커_tistory_원고\\_used_log.json';
const DIRS = {
  tistory: 'E:\\하커_tistory_원고',
  blogspot: 'E:\\하커_blogspot_원고',
  homepage: 'E:\\하커_homepage_원고',
};
const TISTORY = ['haocommunication', 'haocommunication02', 'haocommunication03'];
const BLOGSPOT = ['haocommunication', 'haocommunication02', 'haocommunication03'];
const SB_URL = 'https://oaqrjrrgntlqmyxxovfn.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9hcXJqcnJnbnRscW15eHhvdmZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NjQzMTUsImV4cCI6MjA5NzE0MDMxNX0.3bOfZOXVKSoI9ELfE7ZjWETuxvjpNYHdCBSIMrbAGtU';
const APPLY = process.argv.includes('--apply');

const norm = (s) => (s || '').replace(/&[a-z]+;|&#\d+;/g, '').replace(/\s+/g, '').replace(/[^가-힣a-z0-9]/gi, '').toLowerCase();

// ── 1) 각 플랫폼의 '공개된 글 제목' 수집 ──
async function tistoryTitles() {
  const out = [];
  for (const a of TISTORY) {
    try {
      const r = await fetch(`https://${a}.tistory.com/rss`, { signal: AbortSignal.timeout(12000) });
      const xml = await r.text();
      const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g; let m;
      while ((m = re.exec(xml))) out.push(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
    } catch (e) { console.log(`  (티스토리 ${a} RSS 실패: ${e.message.slice(0, 40)})`); }
  }
  return out;
}
async function blogspotTitles() {
  const out = [];
  for (const a of BLOGSPOT) {
    try {
      const r = await fetch(`https://${a}.blogspot.com/feeds/posts/default?alt=json&max-results=150`, { signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      for (const e of (j.feed && j.feed.entry) || []) out.push((e.title && e.title.$t || '').trim());
    } catch (e) { console.log(`  (블로그스팟 ${a} 피드 실패: ${e.message.slice(0, 40)})`); }
  }
  return out;
}
async function homepageTitles() {
  // 하오커뮤니케이션 홈페이지 칼럼 = Supabase overrides.hv_posts (공개 anon 키, 읽기 전용)
  // ★2026-09-18: 센터 4곳(design/studio/web/mkt)도 같이 본다 — 안 보면 센터에 발행된 질문이 '발행됨'으로 남지 않아 나중에 다시 뽑힌다. 마케팅센터는 제목 필드가 t.
  try {
    const out = [];
    for (const key of ['hv_posts', 'hao_posts', 'hs_posts', 'hw_posts', 'hm_posts']) {
      const r = await fetch(`${SB_URL}/rest/v1/overrides?select=v&k=eq.${key}`, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }, signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      let v = j && j[0] && j[0].v; if (typeof v === 'string') v = JSON.parse(v);
      for (const p of (Array.isArray(v) ? v : [])) { const t = String((p && (p.title || p.t)) || '').trim(); if (t) out.push(t); }
    }
    return out;
  } catch (e) { console.log(`  (홈페이지 칼럼 목록 실패: ${e.message.slice(0, 40)})`); return []; }
}

// ── 2) 원고 폴더의 사용내역.txt → {platform, day, title, sheetKey, row, folder} ──
function scanDrafts() {
  const items = [];
  for (const [platform, base] of Object.entries(DIRS)) {
    if (!fs.existsSync(base)) continue;
    for (const day of fs.readdirSync(base).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
      const report = path.join(base, day, '사용내역.txt');
      if (!fs.existsSync(report)) continue;
      const txt = fs.readFileSync(report, 'utf8');
      for (const blk of txt.split(/^■/m).slice(1)) {
        const t = blk.match(/제목:\s*([^\n]+)/);
        const q = blk.match(/질문:\s*\[([^\]]+?)열\s*(\d+)번째[^\]]*\]\s*([^\n]*)/);
        if (!t || !q) continue;
        const f = blk.match(/위치:[^\n]*>\s*([^\n]+)/);
        items.push({ platform, day, title: t[1].trim(), sheetKey: q[1].trim(), row: parseInt(q[2], 10), question: q[3].trim(), folder: f ? f[1].trim() : '' });
      }
    }
  }
  return items;
}

// 시트 블록명 → usedNo (3개 프로그램 공통 매핑)
function blogNoOf(sheetKey) {
  const k = String(sheetKey || '');
  if (/정부|지원사업|바우처/.test(k)) return 1;
  if (/디자인|홍보물/.test(k)) return 2;
  if (/^웹|홈페이지/.test(k)) return 3;
  if (/스튜디오|촬영/.test(k)) return 4;
  if (/마케팅/.test(k)) return 5;
  return null;
}

(async () => {
  console.log('■ 3개 플랫폼에서 공개된 글 수집 중...');
  const [tT, bT, hT] = [await tistoryTitles(), await blogspotTitles(), await homepageTitles()];
  console.log(`  티스토리 공개: ${tT.length}건 | 블로그스팟 공개: ${bT.length}건 | 홈페이지 공개: ${hT.length}건`);
  const live = new Set([...tT, ...bT, ...hT].map(norm));

  const drafts = scanDrafts();
  console.log(`■ 원고(사용내역) 스캔: ${drafts.length}건`);

  const posted = {};
  const postedQ = {};  // ★행 → 발행된 질문 내용(시트에서 질문이 바뀌어도 기록이 어긋나지 않게, 2026-09-19)
  const unposted = [];
  for (const d of drafts) {
    const no = blogNoOf(d.sheetKey);
    if (!no) continue;
    if (live.has(norm(d.title))) { (posted[no] = posted[no] || new Set()).add(d.row); if (d.question) (postedQ[no] = postedQ[no] || {})[d.row] = d.question; }
    else unposted.push(d);
  }

  console.log('\n■ 실제 발행 확인된 행(영구 제외 대상):');
  for (const no of Object.keys(posted).sort()) console.log(`  blog${no}: ${[...posted[no]].sort((a, b) => a - b).join(', ')}`);
  console.log('\n■ 원고는 있으나 발행 안 됨(3일 뒤 질문 재사용 가능):');
  unposted.forEach(d => console.log(`  [${d.platform}] blog${blogNoOf(d.sheetKey)} 행${d.row} | ${d.title.slice(0, 40)}`));

  // ── 3) 로그 갱신 — postedRows만 갱신(writtenRows는 markWritten이 관리, 3일 뒤 자동 만료) ──
  let log = {};
  try { log = JSON.parse(fs.readFileSync(LOG, 'utf8')); } catch {}
  const changes = [];
  for (let no = 1; no <= 5; no++) {
    const key = 'blog' + no;
    const prev = new Set((log[key] && log[key].postedRows) || []);
    const postedRows = new Set([...prev, ...(posted[no] || [])]);  // 한번 발행 확인된 행은 계속 유지(피드에서 밀려나도)
    const added = [...postedRows].filter(r => !prev.has(r));
    if (added.length) changes.push(`  blog${no}: +${added.sort((a, b) => a - b).join(',')} → postedRows ${postedRows.size}개`);
    if (APPLY) {
      log[key] = log[key] || {};
      log[key].postedRows = [...postedRows].sort((a, b) => a - b);
      log[key].postedMap = Object.assign({}, log[key].postedMap || {}, postedQ[no] || {});
      const written = ((log[key].writtenRows) || []).map(x => (typeof x === 'number' ? x : x.row)).filter(r => r != null);
      log[key].usedRows = [...new Set([...postedRows, ...written])].sort((a, b) => a - b);
    }
  }
  console.log('\n■ 로그 변경:');
  console.log(changes.length ? changes.join('\n') : '  (변경 없음)');
  console.log(`\n■ 이미지 폴더: sync가 건드리지 않음(globalUsedFolders ${(log.globalUsedFolders || []).length}개 유지) — LRU는 engine이 관리`);
  if (APPLY) {
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2), 'utf8');
    console.log('\n★ _used_log.json 갱신 완료(postedRows만; globalUsedFolders는 그대로)');
  } else console.log('\n(미리보기입니다. 실제 적용하려면: node sync-posted.js --apply)');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
