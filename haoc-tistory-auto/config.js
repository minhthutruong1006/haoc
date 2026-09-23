// config.js — 하오커뮤니케이션(하커) 티스토리 자동화 공용 설정 (모든 스크립트가 참조)
// ★하오디자인(C:\tistory-auto)·하오팩토리(C:\haofactory-tistory-auto)와 완전 별개: 프로필·세션·원고 폴더 모두 이 패키지 전용.
const path = require('path');
// ★브라우저 자동감지: Chrome이 없으면 Edge(msedge)로 실행
function detectChannel() {
  const fs = require('fs');
  const cands = [
    (process.env.ProgramFiles || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env['ProgramFiles(x86)'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return cands.some(p => { try { return fs.existsSync(p); } catch { return false; } }) ? 'chrome' : 'msedge';
}

module.exports = {
  CHANNEL: detectChannel(),
  // 자동화 전용 Chrome 프로필(로그인 세션 저장). 다른 브랜드 자동화 프로필과 분리.
  USER_DATA_DIR: path.join(__dirname, 'chrome-profile'),
  // 로그인 세션(쿠키) 저장 파일
  AUTH_FILE: path.join(__dirname, 'auth.json'),

  // 주제(질문 블록) → 티스토리 계정 매핑 (2026-09-14 구축: 3계정 체제)
  BLOGS: {
    '정부지원사업': 'haocommunication',
    '디자인': 'haocommunication',
    '웹': 'haocommunication03',       // 2026-09-16 실제 블로그 주제(03=홈페이지 제작)에 맞춰 교정
    '스튜디오': 'haocommunication03',
    '마케팅': 'haocommunication02',   // 02=마케팅
  },

  // 원고 폴더(로컬).
  DRAFTS_DIR: 'E:\\하커_tistory_원고',
};
