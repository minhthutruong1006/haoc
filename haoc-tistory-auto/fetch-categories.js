// fetch-categories.js — 로그인 후(node login.js) 각 티스토리 블로그의 '카테고리 목록(id·이름)'을
//   글쓰기 화면에서 읽어 categories.json 으로 저장한다. watcher.js가 이 파일로 카테고리를 선택한다.
// 실행: node fetch-categories.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { CHANNEL, USER_DATA_DIR, AUTH_FILE, BLOGS } = require('./config');

const OUT = path.join(__dirname, 'categories.json');
const ACCOUNTS = [...new Set(Object.values(BLOGS))];

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, channel: CHANNEL, viewport: { width: 1440, height: 900 },
  });
  try {
    const cookies = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).cookies || [];
    if (cookies.length) await ctx.addCookies(cookies);
  } catch (e) { console.log('auth.json 쿠키 주입 실패:', e.message.slice(0, 60), '— 먼저 node login.js 를 실행하세요.'); }

  const page = await ctx.newPage();
  const out = {};
  for (const acct of ACCOUNTS) {
    try {
      await page.goto(`https://${acct}.tistory.com/manage/newpost/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      if (page.url().includes('/auth/login')) { console.log(`${acct}: 로그인 필요 — node login.js 먼저 실행`); continue; }
      await page.locator('#category-btn').click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const cats = await page.evaluate(() => {
        const list = [];
        document.querySelectorAll('[id^="category-item-"]').forEach(el => {
          const id = el.id.replace('category-item-', '');
          const name = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (/^\d+$/.test(id) && name) list.push({ id, name });
        });
        return list;
      });
      out[acct] = cats;
      console.log(`${acct}: ${cats.length}개 — ${cats.map(c => c.name).join(' / ')}`);
    } catch (e) { console.log(`${acct}: 실패 — ${e.message.slice(0, 60)}`); }
  }
  await ctx.storageState({ path: AUTH_FILE }).catch(() => {});
  await ctx.close();

  if (Object.keys(out).length) {
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    console.log('저장:', OUT);
    console.log('★ 프롬프트가 내는 articleSection 값과 카테고리 이름이 다르면, 티스토리 카테고리 이름을 맞추거나');
    console.log('  prompts\\하오_칼럼_엔진.md 의 카테고리 목록을 실제 이름으로 고치세요.');
  } else {
    console.log('가져온 카테고리가 없습니다. 로그인 상태를 확인하세요.');
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
