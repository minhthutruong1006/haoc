// post.js — 한 개 HTML 원고를 티스토리에 올린다.
// 사용법: node post.js "<html경로>" <계정> [draft|publish]
//   기본은 draft(임시저장) = 비공개 테스트. publish 는 아직 미구현(예약발행은 다음 단계).
const fs = require('fs');
const { chromium } = require('playwright-core');
const { CHANNEL, AUTH_FILE } = require('./config');

const FILE = process.argv[2];
const ACCOUNT = process.argv[3] || 'haocommunication';
const MODE = process.argv[4] || 'draft';

function extractTitle(html) {
  const m = html.match(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) return m[1].replace(/\\"/g, '"');
  const s = html.match(/font-size:27px[^>]*>\s*<strong>([^<]+)</);
  return s ? s[1].trim() : '제목';
}

(async () => {
  if (!FILE || !fs.existsSync(FILE)) { console.log('NO_FILE:', FILE); process.exit(3); }
  const html = fs.readFileSync(FILE, 'utf8');
  const title = extractTitle(html);
  console.log('TITLE:', title);
  console.log('ACCOUNT:', ACCOUNT, 'MODE:', MODE);

  const browser = await chromium.launch({ headless: false, channel: CHANNEL, args: ['--start-maximized'] });
  const ctx = await browser.newContext({ storageState: AUTH_FILE, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`https://${ACCOUNT}.tistory.com/manage/newpost/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);

  // 임시저장 복원 팝업 뜨면 '취소'
  await page.getByRole('button', { name: /취소|아니오|닫기/ }).first().click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(500);

  // 제목
  await page.fill('#post-title-inp', title).catch(async () => {
    await page.click('#post-title-inp').catch(() => {});
    await page.keyboard.type(title).catch(() => {});
  });

  // TinyMCE 에 직접 본문 주입 (기본모드). script 는 TinyMCE가 제거하므로 본문 표시용 HTML만 넣는다.
  const setOk = await page.evaluate((h) => {
    try {
      const ed = window.tinymce && window.tinymce.get('editor-tistory');
      if (!ed) return 'no-editor';
      ed.setContent(h);
      ed.fire('change');
      if (ed.save) ed.save(); // 내부 textarea 로 동기화
      return true;
    } catch (e) { return 'err:' + e.message; }
  }, html);
  console.log('SET_CONTENT:', setOk);
  await page.waitForTimeout(2000);

  if (MODE === 'draft') {
    await page.locator('button:has-text("임시저장"), a:has-text("임시저장")').first().click().catch(() => {});
    await page.waitForTimeout(3500);
    await page.screenshot({ path: 'E:/haoc-tistory-auto/shot_after.png' });
    console.log('DRAFT_SAVED');
  } else {
    console.log('PUBLISH_NOT_IMPLEMENTED_YET');
    await page.screenshot({ path: 'E:/haoc-tistory-auto/shot_after.png' });
  }

  await page.waitForTimeout(1500);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
