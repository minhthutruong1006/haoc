// 하커 디자인 글 제목 필수 키워드 (2026-09-28 운영자 지시)
//   디자인 주제 글은 제목에 아래 목록 중 질문에 맞는 키워드 1개를 반드시 넣고, 같은 산출물 안에서 표기·조합을 번갈아 쓴다.
//   사진도 이 키워드의 산출물 폴더(카탈로그→catalogue, 리플렛→리플렛 …)에서만 고른다 → 제목과 사진이 어긋나지 않는다.
//   사용 기록 = E:\하커_tistory_원고\_title_kw_log.json (3플랫폼 공유, sync.config.json에 등록돼 두 PC도 공유)
const fs = require('fs');
const path = require('path');

const FAMILIES = [
  { key: '카탈로그', cats: ['catalogue'], alt: ['brochure'],
    re: /카탈로그|카다로그|카달로그|룩북/,
    kws: ['카탈로그제작', '카탈로그디자인', '카탈로그인쇄', '제품카탈로그', '카다로그제작', '카다로그디자인', '카다로그인쇄', '카달로그제작', '카달로그디자인', '카달로그인쇄'] },
  { key: '리플렛', cats: ['리플렛'], alt: ['팜플렛'],
    re: /리플렛|리플릿|[234]\s*단\s*(접지|리플)/,
    kws: ['리플렛제작', '리플렛인쇄', '리플렛디자인', '3단리플렛', '2단리플렛', '4단 리플렛', '리플릿제작', '리플릿인쇄', '리플릿디자인'] },
  { key: '팜플렛', cats: ['팜플렛'], alt: ['리플렛'],
    re: /팜플렛|팸플릿|팜플릿/,
    kws: ['팜플렛제작', '팜플렛인쇄', '팜플렛디자인'] },
  { key: '브로슈어', cats: ['brochure'], alt: ['catalogue'],
    re: /브로슈어|브로셔|회사\s*소개서|안내\s*책자/,
    kws: ['브로슈어제작', '브로슈어디자인', '브로슈어인쇄', '브로셔제작', '브로셔디자인', '브로셔인쇄'] },
  { key: '포스터', cats: ['포스터'], alt: [],
    re: /포스터/,
    kws: ['포스터제작', '홍보포스터제작', '홍보포스터디자인', '포스터인쇄', '포스터주문제작', '포스터제작업체', '포스터디자인', '홍보포스터', '광고포스터'] },
];
// ── 스튜디오(촬영) 글 (2026-09-28 운영자 지시) ──
//   키워드 계열은 촬영 대상으로 정한다(영상·인터뷰 → 촬영대행 / 화장품 / 식품 / 공간·인물 / 그 외 제품).
//   사진은 업종 촬영 폴더에서 고르고, 질문이 '상세페이지'까지 말하면 상세페이지 폴더를 먼저 쓴다(촬영→상세페이지 디자인 글).
const STUDIO_FAMILIES = [
  { key: 'S_영상', re: /영상|인터뷰|필름|드론|움짤|라이브\s*방송|티저/, kws: ['촬영대행'] },
  { key: 'S_화장품', re: /화장품|코스메틱|뷰티|스킨케어|텍스처/, kws: ['화장품촬영', '화장품사진촬영', '화장품촬영스튜디오'] },
  { key: 'S_식품', re: /식품|건기식|음식|메뉴|반찬|김치|떡|음료|베이커리|로스팅|커피|시즐|특산물|주류|양조|농산물|과자|디저트|카페|간식|밀키트|원료/, kws: ['음식촬영', '음식사진촬영', '식품사진촬영'] },
  { key: 'S_공간', re: /프로필|전경|공장|설비|매장|공간|시설|헬스장|스케치|아카이브|양조장/, kws: ['촬영대행', '사진촬영스튜디오'] },
  { key: 'S_제품', re: /./, kws: ['촬영대행', '사진촬영스튜디오', '제품촬영스튜디오', '제품촬영', '상품촬영', '제품촬영대행', '제품사진촬영'] },
];
function studioCats(q) {
  const t = String(q || '');
  const ind = /건강\s*기능\s*식품|건강식품|건기식|영양제/.test(t) ? ['건강식품촬영', '식품촬영']
    : STUDIO_FAMILIES[2].re.test(t) ? ['식품촬영', '건강식품촬영']
    : STUDIO_FAMILIES[1].re.test(t) ? ['화장품촬영']
    : ['제품촬영'];
  return /상세\s*(페이지|이미지)/.test(t) ? { cats: ['상세페이지'], alt: ind } : { cats: ind, alt: ind[0] === '제품촬영' ? ['상세페이지'] : ['제품촬영'] };
}
function studioPlan(q) {
  const fam = STUDIO_FAMILIES.find(f => f.re.test(q || ''));
  const c = studioCats(q);
  let kws = fam.kws.slice();
  if (fam.key === 'S_식품' && /건강\s*기능\s*식품|건강식품|건기식|영양제|원료|제조사|제조업체/.test(q)) kws = ['식품사진촬영'];  // 제조사 식품은 '음식촬영'보다 식품사진촬영
  if (/스튜디오/.test(q)) { const s = kws.filter(k => k.includes('스튜디오')); if (s.length) kws = s; }
  if (/상품|쇼핑몰|오픈마켓|썸네일|스마트스토어/.test(q) && fam.key === 'S_제품') kws = kws.filter(k => k !== '사진촬영스튜디오');
  return { fixed: true, families: [{ key: fam.key, kws, cats: c.cats, alt: c.alt, _noIntent: true }] };
}

// 목록에 없는 다른 산출물을 묻는 질문(상세페이지·패키지·명함·로고·현수막 등)은 키워드를 억지로 넣지 않는다.
const OTHER_PRODUCT = /상세\s*페이지|패키지|단상자|라벨|포장|명함|로고|CI|BI|캐릭터|현수막|배너|전단|홈페이지|쇼핑몰|촬영|간판|스티커|봉투|굿즈/;
const INTENT = [
  { suf: '인쇄', re: /인쇄|출력|용지|종이|후가공|코팅|제본|박\s*가공|인쇄소|부수/ },
  { suf: '디자인', re: /디자인|시안|레이아웃|컨셉|구성안/ },
  { suf: '제작', re: /제작|업체|비용|견적|기간|주문|가격/ },
];

const LOG_FILE = 'E:/하커_tistory_원고/_title_kw_log.json';
function loadLog() { try { const j = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function saveLog(j) { try { fs.writeFileSync(LOG_FILE, JSON.stringify(j, null, 2), 'utf8'); } catch {} }

// 질문이 말하는 산출물 순서대로(먼저 나온 것 우선). 없으면 [].
function familiesInQuestion(q) {
  const hits = [];
  for (const f of FAMILIES) { const m = f.re.exec(q || ''); if (m) hits.push({ f, pos: m.index }); }
  return hits.sort((a, b) => a.pos - b.pos).map(h => h.f);
}

// 후보 산출물(가족) 목록 — 질문에 있으면 그것만, 없고 다른 산출물 얘기도 없으면 5개를 오래 안 쓴 순으로(번갈아).
function familyPlan(question, topic) {
  if (topic === '스튜디오') return studioPlan(question);
  const inQ = familiesInQuestion(question);
  if (inQ.length) return { fixed: true, families: [inQ[0]] };
  if (OTHER_PRODUCT.test(question || '')) return { fixed: true, families: [] };
  const log = loadLog();
  const fam = log.families || {};
  const order = FAMILIES.slice().sort((a, b) => (fam[a.key] || 0) - (fam[b.key] || 0));
  return { fixed: false, families: order };
}

// 가족 안에서 키워드 고르기 — 질문 의도(인쇄/디자인/제작)에 맞는 것 중 가장 오래 안 쓴 것.
function pickKeyword(fam, question) {
  const q = question || '';
  let cands = fam.kws.slice();
  const dan = /([234])\s*단/.exec(q);
  if (dan) { const same = cands.filter(k => k.includes(dan[1] + '단')); cands = same.length ? same : cands.filter(k => !/[234]단/.test(k)); }
  const intents = fam._noIntent ? [] : INTENT.filter(i => i.re.test(q)).map(i => i.suf);
  if (intents.length) {
    const neutral = k => !/(제작|디자인|인쇄)$/.test(k.replace(/업체$/, '제작'));
    const fit = cands.filter(k => intents.some(s => k.includes(s)) || neutral(k));
    if (fit.length) cands = fit;
  }
  const used = loadLog().kws || {};
  return cands.map((k, i) => ({ k, i, t: used[k] || 0 })).sort((a, b) => a.t - b.t || a.i - b.i)[0].k;
}

// 선택 확정 → 사용 기록(시각). 다음 글은 다른 표기가 먼저 나온다.
function commit(kw, famKey) {
  const log = loadLog();
  const now = Date.now();
  log.kws = log.kws || {}; log.families = log.families || {}; log.history = log.history || [];
  log.kws[kw] = now; log.families[famKey] = now;
  log.history.push({ kw, family: famKey, at: new Date(now).toISOString() });
  if (log.history.length > 300) log.history = log.history.slice(-300);
  saveLog(log);
}

function familyOf(key) { return FAMILIES.concat(STUDIO_FAMILIES).find(f => f.key === key) || null; }
function titleHas(title, kw) {
  const n = s => String(s || '').replace(/\s+/g, '');
  return n(title).includes(n(kw));
}

// 프롬프트 주입 블록
function promptBlock(kw) {
  if (!kw) return '';
  return `[★제목 필수 키워드 — 2026-09-28 운영자 지시]
- 제목(headline)에 "${kw}" 를 글자 그대로 반드시 넣는다(가능하면 제목 앞쪽, 띄어쓰기도 이 표기 그대로).
- 이 키워드는 질문에 맞춰 골라 준 것이다. 제목은 질문 핵심을 간추려 짧고 자연스럽게(SEO 노출 최우선) — 키워드를 억지로 나열하거나 다른 산출물 키워드와 섞지 않는다.
- 첨부 사진도 이 키워드에 맞는 폴더에서 골랐다 → 제목·본문·alt가 모두 이 키워드(${kw.replace(/\s+/g, '')})의 주제를 말하도록 쓴다. 본문 첫 정답 문장과 태그/키워드에도 한 번 넣는다.`;
}

module.exports = { FAMILIES, STUDIO_FAMILIES, studioPlan, familyPlan, pickKeyword, commit, familyOf, titleHas, promptBlock, LOG_FILE };
