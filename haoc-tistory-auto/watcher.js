// watcher.js — 오늘 폴더의 HTML 원고를 각 블로그에 올린다(기본 draft).
// 이미지 마커: [[IMG: <로컬파일명 또는 Drive파일ID> | alt]]
// 방식: 이미지를 먼저 업로드해 티스토리 URL을 얻고 → 원본 HTML의 마커 자리에 <img>로 치환 →
//       전체를 한 번에 setContent (본문 구조/이미지 위치 보존).
// 사용법: node watcher.js [폴더|단일.html|비움] [draft|publish]
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright-core');
const { CHANNEL, AUTH_FILE, USER_DATA_DIR, DRAFTS_DIR } = require('./config');

const LOGIN_WAIT_MS = 10 * 60000; // 세션 만료 시 수동 로그인 대기 한도(홈페이지와 동일)

const ARG = process.argv[2];
const MODE = process.argv[3] || 'draft';
const TMP = 'E:\\haoc-tistory-auto\\_imgtmp';

function targetFiles() {
  if (ARG && ARG.endsWith('.html') && fs.existsSync(ARG)) return [ARG];
  let folder = (ARG && fs.existsSync(ARG)) ? ARG : null;
  if (!folder) { const dirs = fs.readdirSync(DRAFTS_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); folder = path.join(DRAFTS_DIR, dirs[dirs.length - 1]); }
  const all = fs.readdirSync(folder).filter(f => f.endsWith('.html'));
  // ★계정별 '최신 파일 1개'만 게시(블로그당 하루 1건). 폴더에 옛/테스트 원고가 섞여도 오게시 방지.
  const byAcct = {};
  for (const f of all) {
    const acct = parseAccount(f);
    const mt = fs.statSync(path.join(folder, f)).mtimeMs;
    if (!byAcct[acct] || mt > byAcct[acct].mt) byAcct[acct] = { f, mt };
  }
  const chosen = Object.values(byAcct).map(x => x.f);
  if (all.length > chosen.length) console.log(`(건너뜀 ${all.length - chosen.length}건: 계정당 최신 1건만 게시)`);
  return chosen.map(f => path.join(folder, f));
}
function parseAccount(f) { const m = f.match(/_(haocommunication\d*)_/); return m ? m[1] : 'haocommunication'; }

// ★하루 1편 보증(2026-08-15): 공개 발행 전에 각 계정의 RSS를 직접 보고 '오늘 이미 올라간 글'이 있으면 건너뛴다.
//   로컬 기록이 아니라 실제 블로그를 봐야, 발행 뒤 기록이 빠졌거나 실행을 두 번 걸어도 중복이 안 생긴다.
//   블로그마다 표준시 설정이 달라서, 절대 시각을 이 PC 기준 날짜로 환산해 비교한다.
async function accountsPostedToday(accounts) {
  const d = new Date();
  const td = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const done = new Set();
  await Promise.all([...new Set(accounts)].map(async (a) => {
    try {
      const r = await fetch(`https://${a}.tistory.com/rss`, { signal: AbortSignal.timeout(15000) });
      const xml = await r.text();
      for (const it of xml.split('<item>').slice(1)) {   // 채널 pubDate는 무시하고 글(item)만 본다
        const m = it.match(/<pubDate>([^<]+)<\/pubDate>/);
        if (!m) continue;
        const dt = new Date(m[1]);
        if (isNaN(dt)) continue;
        const loc = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        if (loc === td) { done.add(a); break; }
      }
    } catch (e) { console.log(`(하루1편 확인 실패: ${a} — ${String(e.message).slice(0, 40)})`); }
  }));
  return done;
}

// ★제목·태그·카테고리는 맨 위 <!-- META {...} --> 주석에서 읽는다.
//   (예전엔 본문 BlogPosting 스키마에서 읽었는데, 티스토리가 BlogPosting을 자동 생성해 중복되므로 스키마를 뺐다)
//   구버전 원고도 계속 게시할 수 있게 옛 스키마 방식은 폴백으로 남긴다.
const META_RE = /<!--\s*META\s*([\s\S]*?)-->/;
function extractMeta(html) {
  const m = html.match(META_RE);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}
function stripMeta(html) { return html.replace(META_RE, '').replace(/^\s+/, ''); }
function extractTitle(html, f) {
  const meta = extractMeta(html);
  if (meta && meta.headline) return String(meta.headline);
  const m = html.match(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) return m[1].replace(/\\"/g, '"');
  return f.replace(/\.html$/, '').split('_').slice(2).join('_') || '제목';
}
function extractTags(html) {
  const meta = extractMeta(html);
  const raw = meta && meta.keywords ? meta.keywords : (html.match(/"keywords"\s*:\s*"([^"]+)"/) || [])[1];
  return raw ? String(raw).split(',').map(t => t.trim()).filter(Boolean) : [];
}
function extractSection(html) {
  const meta = extractMeta(html);
  if (meta && meta.articleSection) return String(meta.articleSection).trim();
  const m = html.match(/"articleSection"\s*:\s*"([^"]+)"/);
  return m ? m[1].trim() : '';
}
// ★영문 고유주소(slug) — META의 slug 필드(블로그스팟과 동일한 영문 슬러그 정책, 2026-07-28).
//   형식이 맞을 때만 발행 레이어의 #urlPublish에 덮어쓴다(없으면 기존 제목 기반 주소 그대로).
function extractSlug(html) {
  const meta = extractMeta(html);
  const s = meta && meta.slug ? String(meta.slug).trim() : '';
  return /^[a-z0-9]+(-[a-z0-9]+){1,7}$/.test(s) ? s : '';
}
let CATEGORIES = {};
try { CATEGORIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'categories.json'), 'utf8')); } catch {}
function markerList(html) {
  const out = []; const re = /\[\[IMG:\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?))?\]\]/g; let m;
  while ((m = re.exec(html))) out.push({ file: m[1].trim(), alt: (m[2] || '').trim() });
  return out;
}
async function resolveImage(ref, dir, tag) {
  for (const c of [path.join(dir, ref), path.join('E:\\haoc-tistory-auto', ref), ref]) if (fs.existsSync(c)) return c;
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
  const bin = path.join(TMP, `${tag}.bin`); const webp = path.join(TMP, `${tag}.webp`);
  const r = await fetch(`https://drive.google.com/uc?export=download&id=${ref}`, { redirect: 'follow' });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x3c) throw new Error('drive-not-image id=' + ref);
  fs.writeFileSync(bin, buf);
  execSync(`ffmpeg -y -i "${bin}" -vf "scale='min(1200,iw)':-2" "${webp}"`, { stdio: 'ignore' });
  return webp;
}
const toEnd = () => { const ed = window.tinymce.get('editor-tistory'); ed.focus(); ed.selection.select(ed.getBody(), true); ed.selection.collapse(false); };

// 에디터(TinyMCE) 준비 대기 — 로딩 지연/재생성 시 TypeError 방지
async function waitEditor(page) {
  await page.waitForFunction(
    () => window.tinymce && window.tinymce.get('editor-tistory') && window.tinymce.get('editor-tistory').getBody(),
    null, { timeout: 20000 });
}

// 이미지 1장 업로드 → 티스토리 URL 반환
async function uploadOne(page, fp) {
  await waitEditor(page);
  const before = await page.evaluate(() => window.tinymce.get('editor-tistory').getBody().querySelectorAll('img').length);
  await page.evaluate(toEnd);
  await page.mouse.click(292, 35);
  await page.waitForTimeout(700);
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null),
    page.locator('.mce-menu-item:has-text("사진"), [role="menuitem"]:has-text("사진")').first().click().catch(() => {}),
  ]);
  if (!fc) return null;
  await fc.setFiles(fp);
  for (let t = 0; t < 20; t++) {
    await page.waitForTimeout(700);
    const info = await page.evaluate(() => { const im = window.tinymce.get('editor-tistory').getBody().querySelectorAll('img'); const l = im[im.length - 1]; return { n: im.length, src: l ? l.getAttribute('src') : null }; });
    if (info.n > before && info.src && /^https?:/.test(info.src)) return info.src;
  }
  return null;
}

async function postOne(page, file) {
  const html = fs.readFileSync(file, 'utf8');
  const fname = path.basename(file);
  const account = parseAccount(fname);
  const title = extractTitle(html, fname);
  let postUrl = '';  // 발행 후 고유주소(CRM 게시현황 전송용)
  await page.goto(`https://${account}.tistory.com/manage/newpost/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: /취소|아니오|닫기/ }).first().click({ timeout: 1500 }).catch(() => {});
  // 에디터가 뜨는지로 로그인 판정(카카오 SSO 중간 리다이렉트 오탐 방지)
  try { await waitEditor(page); }
  catch (e) {
    const isLogin = /auth\/login|accounts\.kakao|tistory\.com\/auth/.test(page.url());
    if (!isLogin) throw new Error('에디터 로딩 실패(url=' + page.url().slice(0, 80) + ')');
    // ★세션 만료 → 창을 닫지 말고 수동 로그인을 기다린다(홈페이지 방식과 동일, 최대 10분).
    console.log('  티스토리 로그인이 필요합니다. 열린 창에서 카카오로 로그인해 주세요(최대 10분 대기)...');
    const deadline = Date.now() + LOGIN_WAIT_MS;
    let recovered = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000).catch(() => {});
      if (page.isClosed && page.isClosed()) break;
      const u = page.url();
      // 로그인 화면을 벗어났으면 글쓰기 페이지로 되돌려 에디터가 뜨는지 확인
      if (!/auth\/login|accounts\.kakao|tistory\.com\/auth/.test(u)) {
        await page.goto(`https://${account}.tistory.com/manage/newpost/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(4000);
        await page.getByRole('button', { name: /취소|아니오|닫기/ }).first().click({ timeout: 1500 }).catch(() => {});
        try { await waitEditor(page); recovered = true; break; } catch {}
      }
    }
    if (!recovered) throw new Error('티스토리 로그인 대기 시간 초과(10분) — 다시 실행해 주세요');
    console.log('  로그인 확인됨. 계속 진행합니다.');
    // 로그인 성공 세션을 저장해 다음 글부터는 바로 진행되게 한다
    try { await page.context().storageState({ path: AUTH_FILE }); } catch {}
  }
  await page.getByRole('button', { name: /취소|아니오|닫기/ }).first().click({ timeout: 1500 }).catch(() => {});
  await page.fill('#post-title-inp', title).catch(() => {});

  // 1) 이미지 먼저 업로드 (임시 본문에)
  const markers = markerList(html);
  await waitEditor(page);
  await page.evaluate(() => window.tinymce.get('editor-tistory').setContent('<p></p>'));
  const urls = [];
  for (let k = 0; k < markers.length; k++) {
    let src = null;
    for (let tryN = 1; tryN <= 2 && !src; tryN++) {
      try { const fp = await resolveImage(markers[k].file, path.dirname(file), `${account}_${k + 1}`); src = await uploadOne(page, fp); }
      catch (e) { console.log(`  img_err(${tryN}차):`, e.message.split('\n')[0].slice(0, 140)); if (tryN === 1) await page.waitForTimeout(2000); }
    }
    urls.push({ src, alt: markers[k].alt });
  }

  // 1.5) ★하단 배너(2026-09-16): 로컬 배너 파일을 에디터에 업로드해 kakaocdn URL 확보(블로그스팟 폴백용으로 저장). 실패해도 글은 그대로 발행.
  const footer = require('./post-footer');
  let bannerSrc = null;
  try { const bf = footer.localBannerFile(); if (bf) { bannerSrc = await uploadOne(page, bf); if (bannerSrc) footer.saveHostedUrl(bannerSrc); } }
  catch (e) { console.log('  banner_err:', e.message.split('\n')[0].slice(0, 120)); }
  if (!bannerSrc) { try { bannerSrc = await footer.hostedBannerUrl(); } catch (e) {} }
  console.log('  banner:', bannerSrc ? bannerSrc.slice(0, 70) : '없음(생략)');

  // 2) 마커를 <img>로 치환한 최종 HTML을 한 번에 주입
  //    ★META 주석은 우리 내부용(제목·태그·카테고리 운반)이므로 본문에 들어가기 전에 제거한다.
  let idx = 0, used = 0;
  // ★CRM CTA 추적링크(crm-notify.config ctaTrack=true + token 있을 때만 치환, 아니면 원문 그대로)
  //   순서: UTM 부착+배너 추가(post-footer) → CRM 추적링크(켜져 있을 때만) → 이미지 마커 치환
  const finalHtml = require('./crm-notify').ctaTrackHtml(footer.apply(stripMeta(html), { platform: 'tistory', account, title, bannerUrl: bannerSrc }), title).replace(/\[\[IMG:[^\]]*\]\]/g, () => {
    const u = urls[idx++];
    if (u && u.src) { used++; return `<p><img src="${u.src}" alt="${(u.alt || '').replace(/["<>]/g, '')}" style="max-width:100%;height:auto;"></p>`; }
    return '';
  });
  await page.evaluate(() => window.tinymce.get('editor-tistory').setContent(''));
  await page.waitForTimeout(300);
  await page.evaluate((h) => window.tinymce.get('editor-tistory').setContent(h), finalHtml);
  await page.waitForTimeout(800);
  await page.evaluate(() => { const ed = window.tinymce.get('editor-tistory'); if (ed.save) ed.save(); });
  await page.waitForTimeout(500);
  // ★본문 주입 검증 — 비어 있으면 저장하지 않고 실패 처리(빈 글 임시저장/발행 방지)
  const bodyLen = await page.evaluate(() => window.tinymce.get('editor-tistory').getBody().innerText.trim().length);
  if (bodyLen < 500) throw new Error(`본문 주입 실패(에디터 텍스트 ${bodyLen}자) — 저장 중단`);
  // ★alt 검증 — 검색엔진·AI는 사진을 못 읽고 alt로 판단하므로 alt가 살아있는지 확인.
  //  에디터가 alt를 지웠다면 DOM에서 직접 복원한다.
  const altInfo = await page.evaluate((pairs) => {
    const imgs = Array.from(window.tinymce.get('editor-tistory').getBody().querySelectorAll('img'));
    let restored = 0;
    imgs.forEach((im) => {
      const cur = (im.getAttribute('alt') || '').trim();
      if (cur.length > 5) return;
      const src = im.getAttribute('src') || '';
      const hit = pairs.find(p => p.src && src.includes(p.src.split('/').pop().split('?')[0]));
      if (hit && hit.alt) { im.setAttribute('alt', hit.alt); restored++; }
    });
    if (restored) { const ed = window.tinymce.get('editor-tistory'); if (ed.save) ed.save(); }
    const after = Array.from(window.tinymce.get('editor-tistory').getBody().querySelectorAll('img'));
    return { n: after.length, withAlt: after.filter(i => (i.getAttribute('alt') || '').trim().length > 5).length, restored };
  }, urls.filter(u => u && u.src));
  console.log(`  alt: ${altInfo.withAlt}/${altInfo.n}${altInfo.restored ? ` (${altInfo.restored}개 복원)` : ''}`);

  // 3) 해시태그 입력 (스키마 keywords → #tagText, 최대 10개)
  const tags = extractTags(html);
  let tagOk = 0;
  if (tags.length) {
    const inp = page.locator('#tagText');
    if (await inp.count()) {
      for (const t of tags.slice(0, 10)) {
        try {
          await inp.click();
          await inp.pressSequentially(t.replace(/^#/, ''), { delay: 15 });
          await inp.press('Enter');
          await page.waitForTimeout(250);
          tagOk++;
        } catch (e) { console.log('  tag_err:', t, e.message.slice(0, 40)); }
      }
    }
  }

  // 4) 카테고리 선택 (스키마 articleSection → categories.json의 해당 id)
  const section = extractSection(html);
  let catOk = false;
  if (section) {
    const cat = (CATEGORIES[account] || []).find(c => c.name === section);
    if (cat) {
      try {
        await page.locator('#category-btn').click({ timeout: 5000 });
        // 목록(category-item)이 뜰 때까지 대기
        await page.locator(`#category-item-${cat.id}`).waitFor({ state: 'visible', timeout: 8000 });
        await page.locator(`#category-item-${cat.id}`).click();
        await page.waitForTimeout(500);
        catOk = true;
      } catch (e) { console.log('  cat_err:', section, e.message.split('\n')[0].slice(0, 60)); }
    } else console.log('  cat_warn: 목록에 없는 카테고리', section);
  }

  if (MODE === 'draft') {
    await page.locator('button:has-text("임시저장"), a:has-text("임시저장")').first().click().catch(() => {});
    await page.waitForTimeout(3500);
  } else {
    // 완료 → 공개/비공개 선택 → (영문 고유주소) → 발행/저장
    await page.locator('button:has-text("완료"), a:has-text("완료")').first().click().catch(() => {});
    await page.waitForTimeout(2200);
    const vis = (MODE === 'ptest') ? '비공개' : '공개';   // ptest = 비공개(안전 테스트), publish = 공개
    await page.getByText(vis, { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(900);
    // ★META.slug가 있으면 발행 레이어의 고유주소(#urlPublish)를 영문 슬러그로 교체(블로그 주소 설정이 '문자'일 때만 입력칸이 뜬다)
    const slug = extractSlug(html);
    if (slug) {
      try {
        const urlInp = page.locator('#urlPublish');
        await urlInp.waitFor({ state: 'visible', timeout: 4000 });
        await urlInp.fill(slug);
        await page.waitForTimeout(300);
        const applied = await urlInp.inputValue();
        postUrl = `https://${account}.tistory.com/entry/${encodeURIComponent(applied)}`;  // CRM 게시현황용
        console.log(`  url: /entry/${applied}${applied === slug ? '' : ' (⚠ 의도한 슬러그와 다름: ' + slug + ')'}`);
      } catch (e) { console.log('  url_warn: 고유주소 입력칸 없음(주소 설정이 숫자 방식이거나 레이어 변경) —', e.message.split('\n')[0].slice(0, 50)); }
    }
    await page.getByRole('button', { name: /발행|저장/ }).last().click().catch(() => {});
    await page.waitForTimeout(4000);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'E:/haoc-tistory-auto/shot_final.png' }).catch(() => {});
  const imgs = 0;
  const driveIds = markers.map(m => m.file).filter(x => !x.includes('.')); // 확장자 없으면 Drive 파일ID로 간주
  return { account, title, url: postUrl, imgN: markers.length, imgOk: used, imgs, driveIds, tagN: tags.length, tagOk, section, catOk };
}

(async () => {
  let files = targetFiles();
  console.log('FILES:', files.length);
  // ★안전장치: 공개 발행(publish) 또는 스케줄 자동 실행(인자 없음)은 '오늘 날짜 폴더'일 때만.
  //  옛 원고 재발행·재초안 방지. (UI에서 폴더/파일을 명시해 draft/ptest 하는 건 허용)
  if ((MODE === 'publish' || !ARG) && files.length) {
    const fdate = path.basename(path.dirname(files[0]));
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(fdate) && fdate !== today) { console.log(`중단: 폴더(${fdate}) != 오늘(${today}). 오늘 원고 없음.`); process.exit(0); }
  }
  // ★하루 1편: 오늘 이미 글이 올라간 계정은 발행에서 뺀다(5번째 인자 force면 무시하고 강행 — 수동 복구용).
  if (MODE === 'publish' && process.argv[5] !== 'force' && files.length) {
    const done = await accountsPostedToday(files.map(parseAccount));
    if (done.size) {
      const before = files.length;
      files = files.filter(f => !done.has(parseAccount(f)));
      console.log(`하루 1편 규칙: 오늘 이미 발행된 계정 건너뜀 — ${[...done].join(', ')} (${before}→${files.length}건)`);
    }
    if (!files.length) { console.log('발행할 글 없음(해당 계정은 오늘 이미 발행됨)'); process.exit(0); }
  }
  // ★영구 프로필 + auth.json 쿠키 주입: 프로필이 세션 쿠키를 디스크에 안 남겨도
  //  auth.json의 최신 쿠키로 로그인 상태를 복원하고, 실행 끝에 다시 auth.json에 저장(회전 반영).
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, channel: CHANNEL, viewport: { width: 1440, height: 900 }, args: ['--start-maximized'],
  });
  try {
    const cookies = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).cookies || [];
    if (cookies.length) await ctx.addCookies(cookies);
  } catch (e) { console.log('auth.json 쿠키 주입 실패:', e.message.slice(0, 60)); }
  const page = await ctx.newPage();
  const STAGGER_MIN = parseInt(process.argv[4] || '15', 10);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const results = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    try { const r = await postOne(page, f); results.push(r); console.log('OK', r.account, '(' + r.imgOk + '/' + r.imgN + ' img, ' + (r.tagOk || 0) + '/' + (r.tagN || 0) + ' tag, cat:' + (r.catOk ? r.section : '없음') + ') |', r.title.slice(0, 26)); }
    catch (e) { results.push({ ok: false }); console.log('FAIL', path.basename(f), '|', e.message.slice(0, 70)); }
    // CRM 게시 현황 전송(공개 발행만) — crm-notify.config.json 토큰 없으면 no-op, 실패해도 게시 흐름 무관
    if (MODE === 'publish') { const _r = results[results.length - 1]; if (_r && _r.title) { try { require('./crm-notify').notifyCrm({ account: _r.account, title: _r.title, category: _r.section || '', url: _r.url || '', status: 'posted', posted_at: new Date().toISOString() }).catch(() => {}); } catch (e) {} } }
    // 발행 모드: 다음 글까지 15분(기본) 대기 (마지막 글 뒤에는 대기 안 함)
    if (MODE !== 'draft' && fi < files.length - 1) { console.log(`... wait ${STAGGER_MIN}min`); await sleep(STAGGER_MIN * 60000); }
  }
  await ctx.storageState({ path: AUTH_FILE }).catch(() => {}); // 백업용 세션 저장
  await ctx.close();
  console.log('SUMMARY:', JSON.stringify(results.map(r => ({ acct: r.account || '?', imgs: r.imgs ?? 0 }))));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
