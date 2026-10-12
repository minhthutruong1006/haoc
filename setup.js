// 새 PC 설치 / 두 번째 PC 연결 (2026-09-23)
//   1) git clone https://github.com/minhthutruong1006/haoc E:\haoc
//   2) E:\haoc\설치.bat 실행 (= node setup.js)
// 하는 일: E:\haoc-* 정션 만들기(코드가 E:\haoc-tistory-auto 같은 경로를 씀) · 원고 폴더 만들기 · npm install ·
//          바탕화면 HAOC.bat 복사 · 로그인/비밀 파일 점검. 사용기록(_used_log 등)은 Supabase에서 자동으로 받아온다.
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = __dirname;
const DRIVE = path.parse(ROOT).root;          // 'E:\\'
const ok = m => console.log('  [OK] ' + m);
const warn = m => console.log('  [!!] ' + m);

console.log('\n=== HAOC 설치 / Cài đặt HAOC ===\n');
if (DRIVE.toUpperCase() !== 'E:\\') {
  warn(`저장소가 ${DRIVE}에 있습니다. 프로그램은 E:\\ 경로를 씁니다.`);
  warn('  E:\\haoc 에 clone 하세요. (E: 드라이브가 없으면: subst E: C:\\HAOC_E  를 먼저 실행)');
  warn(`  Repo đang ở ${DRIVE}. Hãy clone vào E:\\haoc (không có ổ E: thì chạy: subst E: C:\\HAOC_E)`);
  process.exit(1);
}

// 1) 코드 폴더 정션 E:\haoc-xxx → E:\haoc\haoc-xxx
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
for (const d of ['haoc-tistory-auto', 'haoc-blogger-auto', 'haoc-homepage-auto', 'haoc-hub']) {
  const link = path.join(DRIVE, d), target = path.join(ROOT, d);
  let st = null; try { st = fs.lstatSync(link); } catch {}
  if (st) {
    let real = ''; try { real = fs.realpathSync.native(link); } catch {}
    if (real.toLowerCase() === target.toLowerCase()) { ok(`${link} → ${target}`); continue; }
    if (st.isSymbolicLink()) fs.unlinkSync(link);
    else {
      const old = `${link}_old_${stamp}`;
      fs.renameSync(link, old);
      warn(`예전 설치 폴더를 ${old} 로 이름 변경 (로그인 파일은 여기서 복사) / Thư mục cũ đổi tên thành ${old}`);
      // 로그인·비밀 파일은 옛 폴더에서 그대로 가져온다
      for (const f of ['auth.json', 'token.json', 'client_secret_json_hao.json', 'crm-notify.config.json', 'categories.json']) {
        const src = path.join(old, f), dst = path.join(target, f);
        if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.copyFileSync(src, dst); ok(`  옛 폴더에서 복사: ${d}\\${f}`); }
      }
    }
  }
  cp.execSync(`mklink /J "${link}" "${target}"`, { shell: 'cmd.exe', stdio: 'ignore' });
  ok(`정션 생성 ${link} → ${target}`);
}

// 2) 원고 폴더 + ASCII 정션
for (const [dir, j] of [['하커_tistory_원고', 'haoc_drafts'], ['하커_blogspot_원고', 'haoc_drafts_blogspot'], ['하커_homepage_원고', 'haoc_drafts_homepage']]) {
  const p = path.join(DRIVE, dir);
  if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); ok('원고 폴더 생성 ' + p); } else ok('원고 폴더 있음 ' + p);
  const jp = path.join(DRIVE, j);
  if (!fs.existsSync(jp)) { try { cp.execSync(`mklink /J "${jp}" "${p}"`, { shell: 'cmd.exe', stdio: 'ignore' }); ok('정션 ' + jp); } catch { warn('정션 실패 ' + jp); } }
}

// 3) npm install (blogger/homepage는 E:/haoc-tistory-auto/node_modules 를 같이 씀)
const tdir = path.join(ROOT, 'haoc-tistory-auto');
if (!fs.existsSync(path.join(tdir, 'node_modules', 'playwright-core'))) {
  console.log('\n  npm install 중... (1~3분)');
  const r = cp.spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: tdir, shell: true, stdio: 'inherit' });
  if (r.status === 0) ok('npm install 완료'); else warn('npm install 실패 — 인터넷/Node 설치 확인');
} else ok('node_modules 있음');

// 4) 바탕화면 HAOC.bat
try {
  const desk = path.join(os.homedir(), 'Desktop');
  fs.copyFileSync(path.join(ROOT, 'HAOC.bat'), path.join(desk, 'HAOC.bat'));
  ok('바탕화면 HAOC.bat 복사');
} catch (e) { warn('바탕화면 복사 실패: ' + e.message); }

// 5) 점검
console.log('\n--- 점검 / Kiểm tra ---');
const need = [
  ['haoc-blogger-auto/client_secret_json_hao.json', '블로거 구글 인증용 — 기존 PC에서 복사 / copy từ máy cũ'],
  ['haoc-tistory-auto/crm-notify.config.json', 'CRM 게시현황(없으면 알림만 꺼짐) / không có thì chỉ tắt báo CRM'],
  ['haoc-blogger-auto/crm-notify.config.json', 'CRM'],
  ['haoc-homepage-auto/crm-notify.config.json', 'CRM'],
];
for (const [f, why] of need) (fs.existsSync(path.join(ROOT, f)) ? ok : warn)(`${f}${fs.existsSync(path.join(ROOT, f)) ? '' : '  ← 없음: ' + why}`);
try { const v = cp.execSync('node -v').toString().trim(); ok('Node ' + v); } catch { warn('Node 없음'); }
try {
  require(path.join(ROOT, 'shared', 'haoc-sync.js'));
  const r = JSON.parse(cp.execFileSync(process.execPath, [path.join(ROOT, 'shared', 'haoc-sync-remote.js'), 'get', 'used_log'], { input: '{}' }).toString());
  if (r.ok && r.v) ok(`Supabase 공유 기록 연결 OK (rev ${r.v._rev}, 마지막 기록 PC: ${r.v.host})`); else warn('Supabase 연결 확인 필요: ' + JSON.stringify(r).slice(0, 120));
} catch (e) { warn('Supabase 연결 실패: ' + e.message); }

if (!process.env.HAOC_ONECLICK) console.log(`
=== 다음 단계 / Bước tiếp theo ===
 1. 로그인(처음 한 번):  E:\\haoc-tistory-auto\\1_티스토리_로그인.bat · 2_티스토리_카테고리가져오기.bat · 3_CLAUDE_로그인.bat
                        E:\\haoc-blogger-auto\\1_블로거_구글인증.bat · E:\\haoc-homepage-auto\\1_홈페이지_관리자로그인.bat
 2. 실행: 바탕화면 HAOC.bat
 3. 코드 업데이트: E:\\haoc\\업데이트.bat (git pull 후 자동 재시작)
`);
