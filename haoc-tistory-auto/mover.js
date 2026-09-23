// mover.js — 사용한 Drive 이미지를 '그 이미지가 있던 폴더의 used 하위폴더'로 이동.
// Service Account 키(sa-key.json)로 Drive를 수정한다. (이미지 루트 폴더를 SA 이메일에 '편집자'로 공유 필요)
const fs = require('fs');
const { google } = require('googleapis');

const KEY = 'E:\\haoc-tistory-auto\\sa-key.json';

function driveClient() {
  const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/drive'] });
  return google.drive({ version: 'v3', auth });
}

async function usedFolderOf(d, parentId) {
  const q = `'${parentId}' in parents and name='used' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await d.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (r.data.files.length) return r.data.files[0].id;
  const c = await d.files.create({ requestBody: { name: 'used', mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }, fields: 'id', supportsAllDrives: true });
  return c.data.id;
}

// fileIds: Drive 이미지 파일 ID 배열
async function moveToUsed(fileIds) {
  if (!fileIds || !fileIds.length) return;
  if (!fs.existsSync(KEY)) { console.log('  [mover] sa-key.json 없음 → used 이동 건너뜀'); return; }
  const d = driveClient();
  for (const id of fileIds) {
    try {
      const meta = await d.files.get({ fileId: id, fields: 'name,parents', supportsAllDrives: true });
      const parents = meta.data.parents || [];
      if (!parents.length) { console.log('  [mover] 부모 없음', id); continue; }
      const parent = parents[0];
      const pMeta = await d.files.get({ fileId: parent, fields: 'name', supportsAllDrives: true });
      if (pMeta.data.name === 'used') continue; // 이미 used
      const used = await usedFolderOf(d, parent);
      await d.files.update({ fileId: id, addParents: used, removeParents: parent, supportsAllDrives: true });
      console.log('  [mover] 이동:', meta.data.name, '→', pMeta.data.name + '/used');
    } catch (e) { console.log('  [mover] 오류', id, '|', e.message.slice(0, 70)); }
  }
}

module.exports = { moveToUsed };

// 단독 실행 테스트: node mover.js <fileId> [fileId...]
if (require.main === module) {
  moveToUsed(process.argv.slice(2)).then(() => console.log('done'));
}
