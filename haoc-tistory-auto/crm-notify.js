'use strict';
// crm-notify.js — 게시 결과를 CRM '게시 현황'으로 전송 (mail-crm-mvp.vigo.co.kr)
// 설정: 같은 폴더의 crm-notify.config.json { url, token, brand, platform, prefix, account, ctaTrack }
//       또는 환경변수 CRM_URL / CRM_TOKEN / CRM_CTA_TRACK
// token 이 비어 있으면 아무것도 보내지 않는다(no-op). 실패해도 절대 게시 흐름을 막지 않는다.
// ★2026-09-16 하오커뮤니케이션: crm-addon(Pictures\CRM\CRM분리)의 'CTA 추적링크 치환'을 ctaTrackHtml()로 합침.
//   token 이 있고 ctaTrack=true 일 때만 본문의 홈페이지 CTA 링크(https://haoc.co.kr/)를 CRM /go/<추적키> 로 바꾼다.
//   둘 중 하나라도 없으면 본문을 그대로 돌려준다(브랜드가 CRM에 등록되기 전 링크 깨짐 방지).
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'crm-notify.config.json'), 'utf8')); } catch (e) {}
const CRM_URL = process.env.CRM_URL || CFG.url || '';
const CRM_TOKEN = process.env.CRM_TOKEN || CFG.token || '';
const CTA_TRACK = process.env.CRM_CTA_TRACK ? /^(1|true|yes)$/i.test(process.env.CRM_CTA_TRACK) : CFG.ctaTrack === true;
// 치환 대상 = 브랜드 홈페이지 루트 링크만(하위 페이지·센터 도메인은 그대로). 설정 ctaHosts 로 바꿀 수 있다.
const CTA_HOSTS = Array.isArray(CFG.ctaHosts) && CFG.ctaHosts.length ? CFG.ctaHosts : ['haoc.co.kr'];

// 추적키 — CRM 피드/게시현황과 동일 공식: HTML 엔티티 6종 복원 + 공백 정리 + md5 앞 16자.
// prefix 는 브랜드별로 CRM 설정과 같아야 매칭된다(firstd='fd', 하오커뮤니케이션='hc').
function trackKey(title) {
  const s = String(title || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return (CFG.prefix || 'xx') + crypto.createHash('md5').update(s, 'utf8').digest('hex').slice(0, 16);
}

// CRM /go/ 추적 URL 기본 주소 — 전송 URL(…/api/ingest/content-post)의 origin
function goBase() {
  try { const u = new URL(CRM_URL); return u.origin + '/go/'; } catch (e) { return ''; }
}

// CTA 홈페이지 링크 → 콘텐츠별 추적링크. 조건 미충족이면 원문 그대로.
// 앵커 텍스트(haoc.co.kr)는 바꾸지 않으므로 원고 검증·독자 표시는 그대로다.
function ctaTrackHtml(html, title) {
  if (!html || !CRM_URL || !CRM_TOKEN || !CTA_TRACK) return html;
  const base = goBase(); if (!base) return html;
  const key = trackKey(title);
  const hosts = CTA_HOSTS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // 루트 링크(쿼리 없음) + UTM 등 쿼리가 붙은 루트 링크(post-footer가 붙인 것) 둘 다 치환. 하위 페이지는 제외.
  const re = new RegExp('href=(["\'])https?:\\/\\/(?:www\\.)?(?:' + hosts + ')\\/?(?:\\?[^"\']*)?\\1', 'gi');
  return html.replace(re, (m, q) => 'href=' + q + base + key + q);
}

function notifyCrm(post) {
  return new Promise((resolve) => {
    if (!CRM_URL || !CRM_TOKEN) return resolve({ ok: false, skipped: 'not configured' });
    let u;
    try { u = new URL(CRM_URL); } catch (e) { return resolve({ ok: false, error: 'bad url' }); }
    const payload = Object.assign({
      brand: CFG.brand || '',
      platform: CFG.platform || '',
      account: CFG.account || '',
      track_key: trackKey(post && post.title),
    }, post || {});
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'X-CRM-Token': CRM_TOKEN,
      },
      timeout: 8000,
    }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: t }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

module.exports = { notifyCrm, trackKey, ctaTrackHtml };
