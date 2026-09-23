// hp_login.js — 하오커뮤니케이션 홈페이지 관리자(https://haoc.co.kr/admin.html) 로그인 창 열기(세션 만료 시 1회 실행).
//   이 패키지 전용 chrome-profile(E:\haoc-homepage-auto\chrome-profile)에 hub_session 쿠키(12시간)가 저장된다. 로그인 후 창을 닫으면 끝.
const fs = require('fs');
const { chromium } = require('E:/haoc-tistory-auto/node_modules/playwright-core');
function detectChannel() {
  const cands = [
    (process.env.ProgramFiles || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env['ProgramFiles(x86)'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return cands.some(p => { try { return fs.existsSync(p); } catch { return false; } }) ? 'chrome' : 'msedge';
}
const cfg = require('./writer_config.json');
(async () => {
  const ctx = await chromium.launchPersistentContext(cfg.chromeProfile, { headless: false, channel: detectChannel(), viewport: null, args: ['--start-maximized'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(cfg.adminBase, { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('관리자 로그인 창을 열었습니다(아이디/비밀번호). 로그인 후 이 창을 닫으세요(최대 10분 대기).');
  const deadline = Date.now() + 10 * 60000;
  let ok = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000).catch(() => {});
    try {
      if (!ctx.pages().length) break;
      const vis = await page.evaluate(() => { const a = document.getElementById('adminView'); return !!a && !a.hidden; }).catch(() => false);
      if (vis && !ok) { ok = true; console.log('로그인 확인됨 — 세션이 저장됐습니다. 창을 닫아도 됩니다.'); }
    } catch {}
  }
  await ctx.close().catch(() => {});
  console.log(ok ? 'OK' : '로그인 미확인(다시 실행)');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
