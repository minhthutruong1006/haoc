// ★Blogger 관리자 글 목록 썸네일 안전장치 (2026-09-21 실험으로 확인)
//  Blogger는 글 HTML의 '앞부분'에서만 썸네일용 이미지를 찾는다.
//  같은 본문·같은 사진으로 실험: 첫 <img>가 3,590자 이내 → 썸네일 표시 / 10,185자 → 글자 아이콘.
//  그래서 발행 직전에 첫 이미지가 LIMIT보다 뒤에 있으면 앞으로 옮긴다(핵심 요약 박스 위로는 절대 올리지 않는다).
const LIMIT = 3000;

function ensureEarlyImage(html, log) {
  const say = log || (() => {});
  const at = html.indexOf('<img');
  if (at < 0 || at <= LIMIT) return html;
  const m = html.match(/<p[^>]*>\s*<img[^>]*>\s*<\/p>/) || html.match(/<img[^>]*>/);
  if (!m) return html;
  const block = m[0];
  const without = html.replace(block, '');
  // 후보 ① 첫 h2 바로 앞(도입부 끝)  ② 인사 문단 바로 뒤  ③ 핵심 요약 박스 바로 뒤
  const cands = [];
  const h2 = without.indexOf('<h2');
  if (h2 > 0) cands.push(['첫 h2 앞', h2]);
  const greet = without.indexOf('안녕하세요');
  if (greet > 0) { const e = without.indexOf('</p>', greet); if (e > 0) cands.push(['인사 문단 뒤', e + 4]); }
  const sum = without.indexOf('핵심 요약');
  if (sum > 0) { const e = without.indexOf('</table>', sum); if (e > 0) cands.push(['핵심 요약 박스 뒤', e + 8]); }
  const pick = cands.find(c => c[1] <= LIMIT) || cands.sort((a, b) => a[1] - b[1])[0];
  if (!pick) return html;
  const out = without.slice(0, pick[1]) + '\n' + block + '\n' + without.slice(pick[1]);
  say(`썸네일 안전장치: 첫 이미지 ${at}자 → ${out.indexOf('<img')}자 (${pick[0]})로 이동`);
  return out;
}

module.exports = { ensureEarlyImage, LIMIT };
