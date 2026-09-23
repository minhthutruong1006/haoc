// normalize-drafts.js — 클라우드 루틴이 날짜 폴더를 못 만들고 'YYYY-MM-DD__파일명.html'로
// 평면 저장한 경우, 해당 날짜 폴더로 이동시켜 watcher가 읽을 수 있게 한다.
const fs = require('fs');
const path = require('path');
const { DRAFTS_DIR } = require('./config');

const files = fs.readdirSync(DRAFTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}__.+\.html$/i.test(f));
for (const f of files) {
  const date = f.slice(0, 10);
  const dir = path.join(DRAFTS_DIR, date);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const dest = path.join(dir, f.slice(12)); // 'YYYY-MM-DD__' 접두어 제거
  fs.renameSync(path.join(DRAFTS_DIR, f), dest);
  console.log('이동:', f, '->', date + '\\' + f.slice(12));
}
if (!files.length) console.log('이동할 평면 원고 없음');
