'use strict';
// post-footer.js — 게시 직전에 본문에 ① 홈페이지 CTA 링크 UTM 부착 ② 글 맨 아래 '공식 홈페이지 바로가기' 배너 추가.
// (2026-09-16 운영자 지시: 티스토리·블로그스팟 공통. 원고 파일은 건드리지 않고 발행 시점에만 적용 → 원고 검증(사진 1장 규칙)에 영향 없음)
// 설정: 같은 폴더의 post-footer.config.json
//   utm.enabled       true면 href="https://haoc.co.kr/"(루트 링크만, 하위 페이지·센터 도메인 제외)에 utm_* 부착
//   utm.source        비우면 platform 값(tistory/blogspot). campaign 은 계정명(haocommunication02 등), content 는 cta_text / cta_banner
//   banner.enabled    true면 맨 아래 배너(이미지 링크) 추가. 이미지 출처 우선순위:
//                     ① 게시 스크립트가 넘겨준 URL(티스토리는 로컬 파일을 에디터에 업로드한 kakaocdn URL)
//                     ② Drive '하단배너' 폴더(banner.driveFolderId)의 첫 이미지 → lh3 공개 URL
//                     ③ assets/banner_hosted.json(티스토리가 업로드 후 저장해 둔 URL) — 블로그스팟 폴백
//                     셋 다 없으면 배너 생략(로그만 남김). 배너 링크에도 UTM(cta_banner)이 붙고, CRM ctaTrack 이 켜지면 둘 다 /go/ 추적링크로 바뀐다.
const fs = require('fs');
const path = require('path');

let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'post-footer.config.json'), 'utf8').replace(/^﻿/, '')); } catch (e) {}
const UTM = Object.assign({ enabled: true, source: '', medium: 'blog', campaign: '', contentText: 'cta_text', contentBanner: 'cta_banner', hosts: ['haoc.co.kr'] }, CFG.utm || {});
const BANNER = Object.assign({ enabled: true, link: 'https://haoc.co.kr/', alt: '하오커뮤니케이션 공식 홈페이지 바로가기', localFile: 'assets/banner_homepage.png', driveFolderId: '', hostedUrlFile: 'assets/banner_hosted.json', maxWidth: 886 }, CFG.banner || {});

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'blog'; }
let _trackKey = null;
try { _trackKey = require('./crm-notify').trackKey; } catch (e) {}

// UTM 쿼리 문자열(앞에 ? 없이)
function utmQuery(ctx, content) {
  const p = new URLSearchParams();
  p.set('utm_source', UTM.source || ctx.platform || 'blog');
  p.set('utm_medium', UTM.medium || 'blog');
  p.set('utm_campaign', UTM.campaign || slugify(ctx.account || 'haoc'));
  p.set('utm_content', content);
  if (ctx.title && _trackKey) { try { p.set('utm_term', _trackKey(ctx.title)); } catch (e) {} }
  return p.toString();
}

// ① 본문의 홈페이지 루트 링크(쿼리 없는 것만)에 UTM 부착 — CTA 박스의 'haoc.co.kr' 링크가 대상
function utmize(html, ctx) {
  if (!html || !UTM.enabled) return html;
  const hosts = (UTM.hosts || ['haoc.co.kr']).map(esc).join('|');
  const re = new RegExp('href=(["\'])(https?:\\/\\/(?:www\\.)?(?:' + hosts + ')\\/?)\\1', 'gi');
  return html.replace(re, (m, q, url) => 'href=' + q + (url.endsWith('/') ? url : url + '/') + '?' + utmQuery(ctx, UTM.contentText) + q);
}

// ② 배너 HTML
function bannerHtml(imgUrl, ctx) {
  if (!imgUrl) return '';
  const link = BANNER.link.replace(/\/?$/, '/') + '?' + utmQuery(ctx, UTM.contentBanner);
  const alt = String(BANNER.alt || '').replace(/["<>]/g, '');
  return `\n<p style="margin:28px 0 0;text-align:center;"><a href="${link}" target="_blank" rel="noopener"><img src="${imgUrl}" alt="${alt}" style="max-width:100%;width:${BANNER.maxWidth}px;height:auto;border:0;"></a></p>\n`;
}

// 로컬 배너 파일(티스토리 업로드용) — 없으면 null
function localBannerFile() {
  if (!BANNER.enabled) return null;
  const p = path.isAbsolute(BANNER.localFile) ? BANNER.localFile : path.join(__dirname, BANNER.localFile);
  return fs.existsSync(p) ? p : null;
}
function hostedFile() { return path.isAbsolute(BANNER.hostedUrlFile) ? BANNER.hostedUrlFile : path.join(__dirname, BANNER.hostedUrlFile); }
// 티스토리가 업로드한 배너 URL을 저장(블로그스팟 폴백용) — 두 폴더 assets 에 모두 기록
function saveHostedUrl(url) {
  if (!url) return;
  const rec = { url, at: new Date().toISOString() };
  for (const f of [hostedFile(), ...(BANNER.hostedUrlMirrors || []).map(x => path.isAbsolute(x) ? x : path.join(__dirname, x))]) {
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(rec, null, 2)); } catch (e) {}
  }
}
// Drive '하단배너' 폴더 첫 이미지 → lh3 URL (공개 폴더 전제)
async function driveBannerUrl() {
  if (!BANNER.driveFolderId) return null;
  try {
    const r = await fetch(`https://drive.google.com/embeddedfolderview?id=${BANNER.driveFolderId}#list`, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const h = await r.text();
    const re = /<div class="flip-entry" id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?flip-entry-title">([^<]*)</g;
    let m; const files = [];
    while ((m = re.exec(h))) if (!m[2].includes('/folders/') && /\.(png|jpe?g|webp|gif)$/i.test(m[3].trim())) files.push({ id: m[1], name: m[3].trim() });
    files.sort((a, b) => a.name.localeCompare(b.name));
    return files.length ? `https://lh3.googleusercontent.com/d/${files[0].id}=s1200` : null;
  } catch (e) { return null; }
}
// 블로그스팟 등 '호스팅된 URL'이 필요한 플랫폼용: Drive → hosted.json 순
async function hostedBannerUrl() {
  if (!BANNER.enabled) return null;
  const d = await driveBannerUrl(); if (d) return d;
  try { const j = JSON.parse(fs.readFileSync(hostedFile(), 'utf8')); if (j && /^https?:/.test(j.url || '')) return j.url; } catch (e) {}
  return null;
}

// 본문 최종 가공: UTM 부착 + 배너 추가. ctx = { platform, account, title, bannerUrl }
function apply(html, ctx) {
  ctx = ctx || {};
  let out = utmize(html, ctx);
  if (BANNER.enabled && ctx.bannerUrl) out = out.replace(/\s*$/, '') + bannerHtml(ctx.bannerUrl, ctx);
  return out;
}

module.exports = { apply, utmize, bannerHtml, localBannerFile, hostedBannerUrl, driveBannerUrl, saveHostedUrl, utmQuery, CFG: { UTM, BANNER } };
