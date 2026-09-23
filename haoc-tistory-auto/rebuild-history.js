// 최근 N일 3개 플랫폼 사용내역.txt에서 (folderId, folderName)을 그 날짜로 globalUsedFolders에 복원.
// sync-posted가 과거에 wipe해 사라진 폴더 이력을 되살려 LRU가 최근 폴더를 피하게 한다.
const fs = require('fs'), path = require('path');
try { require('../shared/haoc-sync'); } catch (e) { console.error('[공유] haoc-sync 없음 → 로컬 기록만: ' + e.message); } // ★두 PC 공유(2026-09-23)
const LOG = 'E:/하커_tistory_원고/_used_log.json';
const BASES = {
  tistory: 'E:/하커_tistory_원고',
  blogspot: 'E:/하커_blogspot_원고',
  homepage: 'E:/하커_homepage_원고',
};
const APPLY = process.argv.includes('--apply');

// 대상 날짜: 최근 10일
const dates = [];
{
  // Date 산술은 UTC 기준이지만 폴더명이 KST 날짜라 그대로 문자열로 비교/사용
  const list = new Set();
  for (const base of Object.values(BASES)) {
    let ds = []; try { ds = fs.readdirSync(base); } catch {}
    ds.filter(d => /^2026-\d\d-\d\d$/.test(d)).forEach(d => list.add(d));
  }
  dates.push(...[...list].sort());
}

const log = JSON.parse(fs.readFileSync(LOG, 'utf8'));
const existing = log.globalUsedFolders || [];
// 이미 있는 (v)들을 최신 날짜로 유지하기 위한 맵
const bestDate = new Map();
const add = (v, date) => { if (!v) return; const p = bestDate.get(v); if (p === undefined || date > p) bestDate.set(v, date); };
for (const e of existing) {
  const v = typeof e === 'string' ? e : e && e.v;
  const d = typeof e === 'string' ? '0000-00-00' : (e && e.date) || '0000-00-00';
  add(v, d);
}

let found = 0;
for (const [plat, base] of Object.entries(BASES)) {
  for (const date of dates) {
    const fp = path.join(base, date, '사용내역.txt');
    let txt = ''; try { txt = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    // 폴더명: "위치: ... > <name>" (마지막 > 뒤)
    for (const m of txt.matchAll(/위치:[^\n]*>\s*([^\n>]+?)\s*$/gm)) { add(m[1].trim(), date); found++; }
    // 폴더ID: "폴더 링크: .../folders/<id>"
    for (const m of txt.matchAll(/folders\/([A-Za-z0-9_-]{20,})/g)) { add(m[1], date); }
  }
}


const rebuilt = [...bestDate.entries()].map(([v, date]) => ({ v, date }));
console.log('복원 대상 날짜:', dates.join(', '));
console.log('사용내역 위치줄 매칭:', found, '건');
console.log('globalUsedFolders:', existing.length, '→', rebuilt.length, '개');
// 날짜별 분포
const byDate = {};
rebuilt.forEach(e => { byDate[e.date] = (byDate[e.date] || 0) + 1; });
console.log('날짜 분포:', JSON.stringify(byDate));

if (APPLY) {
  const bak = LOG.replace('.json', '.bak-rebuild-' + dates.length + '.json');
  fs.writeFileSync(bak, JSON.stringify(log, null, 2));
  log.globalUsedFolders = rebuilt;
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2), 'utf8');
  console.log('✅ 적용 완료. 백업:', path.basename(bak));
} else {
  console.log('(미리보기 — 적용하려면 --apply)');
}
