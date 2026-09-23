// poster_hp.js — 하오커뮤니케이션 홈페이지 5개(haoc.co.kr + design/studio/web/mkt 센터) 칼럼 게시.
//   각 사이트 /admin.html '칼럼' 폼을 Playwright로 자동 입력한다(관리자 저장 = Supabase overrides + column-{id}.html 반영).
//   · text 편집기(haoc/studio/web/mkt): #pTitle · #pDate · #pSummary · #pBody(문단은 빈 줄) · #pFile(썸네일) → #postForm [저장]
//   · rich 편집기(design 센터):        #pTitle · #pDate(type=date) · #pSummary · #pEditor(contenteditable, 문단→<p>, ■소제목→<h3>) · #pKeywords · #pFile
//   로그인: hub_session 쿠키(도메인 .haoc.co.kr, 12시간)가 이 패키지 전용 chrome-profile에 남아 5개 사이트에 공통 적용. 만료되면 창을 닫지 않고 수동 로그인을 기다린다(최대 10분).
const fs = require('fs');
const path = require('path');
const { chromium } = require('E:/haoc-tistory-auto/node_modules/playwright-core');

function loadCfg() { return JSON.parse(fs.readFileSync(path.join(__dirname, 'writer_config.json'), 'utf8').replace(/^\uFEFF/, '')); }
function detectChannel() {
  const cands = [
    (process.env.ProgramFiles || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env['ProgramFiles(x86)'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return cands.some(p => { try { return fs.existsSync(p); } catch { return false; } }) ? 'chrome' : 'msedge';
}
const LOGIN_WAIT_MS = 10 * 60000;
const normT = s => String(s || '').replace(/\s+/g, ' ').trim();
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 서버(Supabase overrides.{key}) 기준 칼럼 목록 — 읽기 전용
async function homePosts(cfg, key) {
  const k = cfg.supabaseAnonKey;
  const r = await fetch(cfg.supabaseUrl + '/rest/v1/overrides?select=v&k=eq.' + encodeURIComponent(key || 'hv_posts'), { headers: { apikey: k, Authorization: 'Bearer ' + k }, signal: AbortSignal.timeout(12000) });
  const j = await r.json();
  let v = j && j[0] && j[0].v; if (typeof v === 'string') v = JSON.parse(v);
  return (Array.isArray(v) ? v : []).map(p => (p && p.title == null && p.t != null) ? { ...p, title: p.t, summary: p.summary || p.d } : p);  // ★마케팅센터는 제목=t·요약=d
}

async function isAdminVisible(page) {
  return page.evaluate(() => { const a = document.getElementById('adminView'); return !!a && !a.hidden; }).catch(() => false);
}
async function ensureAdmin(page, adminBase, log) {
  await page.goto(adminBase, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForFunction(() => window.HAO && window.HAO.ready, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);  // HAO.ready(Supabase 로드) 대기
  if (await isAdminVisible(page)) return true;
  log && log(`  관리자 로그인이 필요합니다(${adminBase}). 열린 창에서 아이디/비밀번호로 로그인해 주세요(최대 10분 대기)...`);
  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000).catch(() => {});
    if (page.isClosed()) return false;
    if (await isAdminVisible(page)) { log && log('  로그인 확인됨. 게시를 계속합니다.'); await page.waitForTimeout(1500); return true; }
  }
  return false;
}

// 본문 텍스트 → rich 편집기용 HTML(문단 <p>, ■ 소제목 <h3>, 문단 안 줄바꿈 <br>)
function bodyToHtml(body) {
  return String(body || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => /^■/.test(p) ? `<h3>${esc(p.replace(/^■\s*/, ''))}</h3>` : `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

// '또는 썸네일 경로/URL' 칸에 넣을 값: 영문 제목(slug)에서 영문 소문자·숫자만 남기고 ".haoc.co.kr"을 붙인다. slug가 없으면 사이트 영문명+column+날짜로 대체.
const SITE_EN = { '정부지원사업': 'governmentsupport', '디자인': 'design', '스튜디오': 'studio', '웹': 'web', '마케팅': 'marketing' };
function thumbUrlLabel(post) {
  let s = String(post.slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s.length < 6) s = (SITE_EN[post.site] || 'haoc') + 'column' + String(post.date || '').replace(/\D/g, '');
  return s.slice(0, 80) + '.haoc.co.kr';
}
// 썸네일을 지정한 파일명으로 사이트 스토리지(images 버킷)에 올리고 공개 주소를 돌려준다(관리자 화면의 sbUpload와 같은 경로·같은 공개 anon 키). 실패하면 null.
async function uploadNamedThumb(cfg, abs, name) {
  try {
    const buf = fs.readFileSync(abs);
    const h = { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + cfg.supabaseAnonKey, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' };
    const r = await fetch(cfg.supabaseUrl + '/storage/v1/object/images/' + encodeURIComponent(name), { method: 'POST', headers: h, body: buf, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const url = cfg.supabaseUrl + '/storage/v1/object/public/images/' + name;
    const g = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return g.ok ? url : null;
  } catch (e) { return null; }
}
// 여러 글을 한 브라우저 세션으로 게시. posts=[{fname,site,title,date(YYYY.MM.DD),summary,body,keywords,thumbAbs}]
async function postArticles(posts, log) {
  const cfg = loadCfg();
  const ctx = await chromium.launchPersistentContext(cfg.chromeProfile, {
    headless: false, channel: detectChannel(), viewport: { width: 1440, height: 1000 },
  });
  const page = await ctx.newPage();
  page.on('dialog', async d => { await d.accept().catch(() => {}); });
  const results = [];
  try {
    let currentSite = null;
    for (const post of posts) {
      const site = (cfg.sites || {})[post.site] || cfg.sites['정부지원사업'];
      try {
        if (!site) throw new Error('사이트 설정 없음: ' + post.site);
        if (currentSite !== post.site) {
          if (!(await ensureAdmin(page, site.adminBase, log))) throw new Error('관리자 로그인 대기 시간 초과(10분) — 1_홈페이지_관리자로그인.bat 로 먼저 로그인해 주세요');
          currentSite = post.site;
        }
        // ★중복 게시 방지: 이 사이트 목록에 같은 제목이 있으면 건너뜀
        const exists = await page.evaluate(t => (window.HAO.getPosts() || []).some(p => String(p.title || '').replace(/\s+/g, ' ').trim() === t), normT(post.title));
        if (exists) { results.push({ ok: true, dup: true, site: post.site, title: post.title }); log && log(`  이미 등록된 제목 — 건너뜀: [${post.site}] ${post.title.slice(0, 30)}`); continue; }

        await page.click('#sideMenu button[data-tab="posts"]');
        await page.waitForTimeout(400);
        await page.click('#postAddBtn');
        await page.waitForSelector('#postEditPanel:not([hidden]), #postForm:not([hidden])', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(400);
        await page.fill('#pTitle', post.title);
        const dateType = await page.evaluate(() => (document.getElementById('pDate') || {}).type || 'text');
        const d = String(post.date || new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
        await page.fill('#pDate', dateType === 'date' ? d.replace(/\./g, '-') : d.replace(/-/g, '.'));
        await page.fill('#pSummary', post.summary || '').catch(() => {});
        if (site.editor === 'rich') {
          await page.evaluate((h) => { const e = document.getElementById('pEditor'); e.innerHTML = h; e.dispatchEvent(new Event('input', { bubbles: true })); }, bodyToHtml(post.body));
          if (post.keywords) await page.fill('#pKeywords', String(post.keywords)).catch(() => {});
        } else {
          await page.fill('#pBody', post.body || '');
        }

        // 대표이미지(썸네일): 파일 업로드 → 관리자가 최적화해 Supabase storage에 올리고 #pImgData에 URL을 넣는다
        let thumbOk = false;
        if (post.thumbAbs && fs.existsSync(post.thumbAbs)) {
          // ★운영자 지시(2026-09-18): '또는 썸네일 경로/URL'(#pImgUrl)을 먼저 채우고 → 그다음 썸네일 파일을 고른다.
          //   값 = 영문 제목(소문자·공백 없음) + ".haoc.co.kr". 칸이 없는 관리자(design 센터 등)는 건너뛴다. 저장 시에는 업로드된 이미지(#pImgData)가 우선한다.
          //   ★보정(같은 날 밤): 폼은 파일을 고르면 이 칸의 입력값을 버리고 자동 이름(hv_…jpg) 주소를 저장한다. 그래서 썸네일을 '영문제목.haoc.co.kr.jpg'로
          //   스토리지에 직접 올린 뒤 그 주소를 이 칸에 넣고 파일 선택은 생략한다 → 저장 후 다시 열어도 칸에 영문 제목 주소가 남는다. 업로드 실패 시 예전 방식으로 폴백.
          try {
            const label = thumbUrlLabel(post);
            const hasUrl = !!(await page.$('#pImgUrl')), hasKeep = !hasUrl && !!(await page.$('#pImgKeep'));  // design 센터는 입력 칸이 없고 숨은 칸 #pImgKeep 만 있다(저장 시 img = pImgData || pImgKeep)
            if (label && (hasUrl || hasKeep)) {
              // ① 먼저 칸에 라벨만 입력(운영자 수동 절차와 동일)
              if (hasUrl) { await page.fill('#pImgUrl', label); await page.waitForTimeout(300); log && log('  ① 썸네일 경로/URL 먼저 입력: ' + label); }
              // ② 그다음 이미지 넣기 — 라벨과 같은 이름으로 업로드해 '업로드된 이미지' 자리(#pImgData)에 넣는다
              const named = await uploadNamedThumb(cfg, post.thumbAbs, label);  // ★파일명 = 영문제목.haoc.co.kr (확장자 없음 — 운영자 지시, Content-Type image/jpeg로 서빙됨)
              if (named) {
                await page.evaluate((url) => { const d = document.getElementById('pImgData'); if (d) d.value = url; const k = document.getElementById('pImgKeep'); if (k) k.value = url; const p = document.getElementById('pPrev'); if (p) { p.src = url; p.style.display = 'block'; } }, named);
                await page.waitForTimeout(400);
                thumbOk = true;
                log && log('  ② 이미지 넣기(라벨과 같은 파일명으로 업로드): ' + named.split('/').pop());
              } else log && log('  영문 제목 파일명 업로드 실패 → 파일 선택 방식으로 진행');
            }
          } catch (e) { log && log('  썸네일 경로/URL 입력 실패(계속 진행): ' + String(e.message).split('\n')[0].slice(0, 80)); }
          if (!thumbOk) try {
            await page.setInputFiles('#pFile', post.thumbAbs);
            for (let t = 0; t < 60 && !thumbOk; t++) {
              await page.waitForTimeout(500);
              const v = await page.evaluate(() => (document.getElementById('pImgData') || {}).value || '');
              if (/^https?:/.test(v)) thumbOk = true;
              else if (/^data:/.test(v) && t >= 30) thumbOk = true;  // 스토리지 업로드 실패 시 관리자가 data:URL로 폴백
            }
            if (!thumbOk) log && log('  대표이미지 업로드 확인 안 됨(계속 진행)');
          } catch (e) { log && log(`  대표이미지 실패(무시): ${e.message.slice(0, 50)}`); }
        }

        await page.click('#postForm button[type="submit"]');
        let ok = false;
        for (let t = 0; t < 20 && !ok; t++) {
          await page.waitForTimeout(500);
          ok = await page.evaluate(t => (window.HAO.getPosts() || []).some(p => String(p.title || '').replace(/\s+/g, ' ').trim() === t), normT(post.title));
        }
        // 서버(Supabase) 반영 확인(최대 15초)
        let serverOk = false, id = null;
        if (ok) {
          for (let t = 0; t < 15 && !serverOk; t++) {
            await page.waitForTimeout(1000);
            try { const hit = (await homePosts(cfg, site.postsKey)).find(p => normT(p.title) === normT(post.title)); if (hit) { serverOk = true; id = hit.id; } } catch {}
          }
        }
        const url = id ? `${site.siteBase}/column-${id}.html` : '';
        results.push({ ok, serverOk, thumbOk, id, url, site: post.site, title: post.title });
        log && log(`  ${ok ? 'OK' : 'FAIL'} [${post.site}] ${post.title.slice(0, 30)}${thumbOk ? ' +대표이미지' : ''}${url ? ' | ' + url : ''}${ok && !serverOk ? ' (⚠ 서버 저장 확인 안 됨 — 관리자 화면에서 확인)' : ''}`);
      } catch (e) {
        results.push({ ok: false, site: post.site, title: post.title, reason: e.message.slice(0, 120) });
        log && log(`  FAIL [${post.site}] ${post.title.slice(0, 25)} | ${e.message.slice(0, 90)}`);
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  return results;
}

module.exports = { postArticles, loadCfg, homePosts };
