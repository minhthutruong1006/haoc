// login.js — 카카오(티스토리) 로그인 1회. 성공을 확인한 뒤 세션을 auth.json 으로 저장.
// 창이 열리면 카카오로 직접 로그인만 하면 됩니다. (있다면 '로그인 상태 유지' 체크 권장)
const { chromium } = require('playwright-core');
const { CHANNEL, USER_DATA_DIR, AUTH_FILE } = require('./config');

const CHECK_URL = 'https://haocommunication.tistory.com/manage/newpost/';

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: CHANNEL, // 'chrome'
    viewport: null,
    args: ['--start-maximized'],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.tistory.com/auth/login', { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('Chrome 로그인 창이 열렸습니다. [카카오계정으로 로그인]으로 직접 로그인하세요.');
  console.log('(가능하면 "로그인 상태 유지"를 체크하세요.) 로그인 성공을 자동 감지합니다. 최대 8분.');

  // 로그인 성공 판정: 글쓰기 페이지가 로그인으로 튕기지 않으면 성공
  const deadline = Date.now() + 8 * 60 * 1000;
  let ok = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000).catch(() => {});
    const u = safeUrl(page);
    // 사용자가 카카오/로그인 화면을 벗어나 티스토리 페이지로 갔을 때만 검증 시도
    if (u.includes('tistory.com') && !u.includes('/auth/login') && !u.includes('kakao')) {
      await page.goto(CHECK_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2500).catch(() => {});
      if (!safeUrl(page).includes('/auth/login')) { ok = true; break; }
    }
  }

  if (ok) {
    await ctx.storageState({ path: AUTH_FILE });
    console.log('로그인 성공 — 세션을 auth.json 에 저장했습니다.');
  } else {
    console.log('시간 초과 — 로그인이 감지되지 않았습니다. 다시 시도해주세요.');
  }
  await ctx.close().catch(() => {});
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('오류:', e); process.exit(1); });

function safeUrl(page) { try { return page.url(); } catch (_) { return ''; } }
