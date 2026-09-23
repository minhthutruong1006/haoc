// poster.js — Blogger API v3로 게시(초안/공개). OAuth 토큰은 blogauth.js로 1회 발급.
const fs = require('fs');
const path = require('path');
const { google } = require('E:/haoc-tistory-auto/node_modules/googleapis');

const TOKEN_FILE = path.join(__dirname, 'token.json');

function findClientSecret() {
  const f = fs.readdirSync(__dirname).find(n => /^client_secret.*\.json$/i.test(n) || n === 'credentials.json');
  return f ? path.join(__dirname, f) : null;
}
function authClient() {
  const csPath = findClientSecret();
  if (!csPath) throw new Error('client_secret*.json 이 E:\\haoc-blogger-auto 에 없습니다(Google Cloud OAuth 클라이언트 JSON).');
  const cs = JSON.parse(fs.readFileSync(csPath, 'utf8'));
  const c = cs.installed || cs.web;
  const oauth2 = new google.auth.OAuth2(c.client_id, c.client_secret, 'http://127.0.0.1:5117/oauth2cb');
  if (!fs.existsSync(TOKEN_FILE)) throw new Error('token.json 없음 — 먼저 node blogauth.js 로 1회 인증하세요.');
  oauth2.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
  oauth2.on('tokens', (t) => { // 갱신 토큰 회전 반영
    try {
      const cur = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...cur, ...t }, null, 2), 'utf8');
    } catch {}
  });
  return oauth2;
}
function bloggerApi() { return google.blogger({ version: 'v3', auth: authClient() }); }

// 블로그 URL → blogId 조회(1회, config에 캐시)
async function resolveBlogIds() {
  const cfgPath = path.join(__dirname, 'writer_config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, ''));
  const api = bloggerApi();
  let changed = false;
  for (const b of cfg.blogs) {
    if (b.blogId) continue;
    const r = await api.blogs.getByUrl({ url: b.blogUrl });
    b.blogId = r.data.id;
    changed = true;
    console.log(`${b.account} → blogId ${b.blogId}`);
  }
  if (changed) fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

// 초안 등록(제목=한글 그대로 — 검토용)
async function insertDraft(blog, { title, html, labels }) {
  const api = bloggerApi();
  const res = await api.posts.insert({
    blogId: blog.blogId, isDraft: true,
    requestBody: { title, content: html, labels: (labels || []).slice(0, 20) },
  });
  return { id: res.data.id, url: res.data.url, status: res.data.status };
}

// ★제목 복원 patch는 '이미 글이 살아 있는' 상태에서 도는 마지막 단계다. 여기서 5xx가 한 번 나면
//   글은 슬러그가 제목인 채로 남고, 호출부는 실패로 보고 같은 글을 다시 insert → 같은 글이 두 번 올라간다
//   (2026-08-15 haodesign04 실제 발생). 그래서 patch만 따로 재시도하고, 끝내 실패해도 던지지 않는다.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function patchTitleWithRetry(api, blog, postId, title) {
  for (let i = 1; i <= 3; i++) {
    try { await api.posts.patch({ blogId: blog.blogId, postId, requestBody: { title } }); return true; }
    catch (e) { if (i === 3) return false; await sleep(1500 * i); }
  }
  return false;
}

// ★공개 발행 + 커스텀 퍼머링크: 발행 순간의 제목이 URL 슬러그가 되므로
//  ① 제목을 영문 슬러그로 변경 → ② 발행(URL 확정) → ③ 제목을 한글로 복원.
async function publishWithSlug(blog, postId, slug, koreanTitle) {
  const api = bloggerApi();
  if (slug) await api.posts.patch({ blogId: blog.blogId, postId, requestBody: { title: slug.replace(/-/g, ' ') } });
  const pub = await api.posts.publish({ blogId: blog.blogId, postId });
  const titleOk = await patchTitleWithRetry(api, blog, postId, koreanTitle);
  return { id: postId, url: pub.data.url, status: 'LIVE', titleFixFailed: !titleOk };
}

// 초안 없이 바로 공개(파일→즉시 발행): 슬러그 제목으로 insert 후 제목 복원
async function insertPublish(blog, { title, html, labels, slug }) {
  const api = bloggerApi();
  const res = await api.posts.insert({
    blogId: blog.blogId, isDraft: false,
    requestBody: { title: slug ? slug.replace(/-/g, ' ') : title, content: html, labels: (labels || []).slice(0, 20) },
  });
  const titleOk = slug ? await patchTitleWithRetry(api, blog, res.data.id, title) : true;
  return { id: res.data.id, url: res.data.url, status: 'LIVE', titleFixFailed: !titleOk };
}

// (하위 호환) mode 기반 단일 진입점
async function postOne(blog, payload, mode) {
  return mode === 'publish' ? insertPublish(blog, payload) : insertDraft(blog, payload);
}

module.exports = { bloggerApi, resolveBlogIds, postOne, insertDraft, insertPublish, publishWithSlug, findClientSecret, TOKEN_FILE };
