// rewrite-draft.js — ★원고별 다시쓰기(2026-09-21 운영자 지시) 공용 헬퍼 (티스토리·블로그스팟·홈페이지 3폴더에 같은 파일)
//  흐름: prepare(옛 원고를 _삭제보관으로 옮기고 질문·사진 정보를 읽어 둠) → 작성기가 새로 생성 →
//        성공하면 finish(옛 원고가 잡고 있던 질문/사진/폴더 기록을 풀어 줌), 실패하면 restore(옛 원고를 제자리로).
//  · mode 'same' = 같은 질문으로 다시(사진은 새로 고름 — 옛 사진은 이번 실행에서만 제외되고, 끝나면 다시 쓸 수 있게 풀린다)
//  · mode 'new'  = 새 질문으로 다시(옛 질문은 이번 실행에서만 제외되고, 끝나면 다시 쓸 수 있게 풀린다 — 발행 안 된 질문은 영구 제외가 아니므로)
//  ★발행된 글은 다시쓰기 금지 — 발행 여부 확인은 각 작성기가 prepare 전에 한다.
const fs = require('fs');
const path = require('path');

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };

// 사용내역.txt에서 이 원고의 블록(제목 앞 20자 또는 질문 앞 18자로 찾음 — 화면 표시와 같은 방식)을 읽는다
function parseBlock(dateDir, title, fileQuestion) {
  let rep = ''; try { rep = fs.readFileSync(path.join(dateDir, '사용내역.txt'), 'utf8'); } catch {}
  const t = String(title || '').slice(0, 20), q = String(fileQuestion || '').slice(0, 18);
  const blk = rep.split('■').filter(x => (t && x.includes(t)) || (q && x.includes(q))).pop() || '';
  const mq = blk.match(/질문:\s*\[([^\]]*?)열\s*(\d+)번째 질문[^\]]*\]\s*([^\n]+)/);
  const mf = blk.match(/실제 사용한 파일\([0-9]+장\):\s*([^\n]+)/);
  const mp = blk.match(/위치:\s*[^\n>]*>\s*([^\n]+)/);
  const ml = blk.match(/폴더 링크:\s*\S*\/folders\/([A-Za-z0-9_-]+)/);
  return {
    found: !!blk,
    sheetKey: mq ? mq[1].trim() : '',
    row: mq ? parseInt(mq[2], 10) : 0,
    question: mq ? mq[3].trim() : '',
    imageNames: mf ? mf[1].split(',').map(s => s.replace(/\(대표이미지\)/g, '').trim()).filter(Boolean) : [],
    folderName: mp ? mp[1].split('>').pop().trim() : '',
    folderId: ml ? ml[1] : '',
  };
}

// opts: { draftsDir, file, title, mode('same'|'new'), usedLogFile, usedKey(fn: sheetKey→사용기록 키), log }
function prepare(opts) {
  const log = opts.log || (() => {});
  const dateDir = path.join(opts.draftsDir, today());
  const abs = path.join(dateDir, opts.file);
  const content = fs.readFileSync(abs, 'utf8');
  const fileQuestion = opts.file.replace(/\.(html|txt)$/i, '').split('_').slice(2).join('_');
  const blk = parseBlock(dateDir, opts.title, fileQuestion);
  const info = {
    mode: opts.mode === 'new' ? 'new' : 'same', file: opts.file, dateDir, draftsDir: opts.draftsDir, usedLogFile: opts.usedLogFile,
    title: opts.title, question: blk.question || fileQuestion, row: blk.row, sheetKey: blk.sheetKey,
    imageNames: blk.imageNames, folderName: blk.folderName, folderId: blk.folderId,
    createdDate: (() => { try { const d = fs.statSync(abs).mtime; return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; } catch { return today(); } })(),
    moved: [], postsRec: null, reclaimed: false,
  };
  info.usedKey = opts.usedKey ? opts.usedKey(info.sheetKey) : null;

  // 1) 옛 원고 + 원고가 참조하는 이미지(스테이징 webp·대표이미지)를 보관함으로
  const hh = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  info.archiveDir = path.join(opts.draftsDir, '_삭제보관', `${today()}_다시쓰기_${hh}`);
  fs.mkdirSync(info.archiveDir, { recursive: true });
  const names = [opts.file];
  for (const x of fs.readdirSync(dateDir)) {
    if (x === opts.file || x === '사용내역.txt' || x === '_posts.json' || /\.(html|txt|json)$/i.test(x)) continue;
    if (content.includes(x)) names.push(x);
  }
  for (const x of names) { try { fs.renameSync(path.join(dateDir, x), path.join(info.archiveDir, x)); info.moved.push(x); } catch (e) { log(`  (보관 실패: ${x} — ${String(e.message).slice(0, 40)})`); } }

  // 2) 게시 기록(_posts.json)의 초안 연결을 끊는다 — 남겨 두면 같은 파일명으로 다시 쓴 글을 발행할 때 '옛 초안'이 발행된다
  const mapFile = path.join(dateDir, '_posts.json');
  const posted = readJson(mapFile, null);
  if (posted && posted[opts.file]) {
    info.postsRec = posted[opts.file];
    delete posted[opts.file];
    fs.writeFileSync(mapFile, JSON.stringify(posted, null, 2), 'utf8');
    if (info.postsRec.id) log(`  (참고) 이 원고로 등록했던 초안(id ${info.postsRec.id})은 블로그 관리자에 남아 있습니다 — 필요 없으면 직접 지우세요`);
  }

  // 3) 새 질문 모드: 옛 질문이 이번 실행에서 다시 뽑히지 않게 오늘자로 잠깐 선점(끝나면 finish가 푼다)
  if (info.mode === 'new' && info.row && info.usedKey != null) {
    const l = readJson(opts.usedLogFile, null);
    if (l) {
      const k = 'blog' + info.usedKey; l[k] = l[k] || {};
      const w = (l[k].writtenRows || []).filter(x => (typeof x === 'number' ? x : x.row) !== info.row);
      w.push({ row: info.row, date: today() }); l[k].writtenRows = w;
      fs.writeFileSync(opts.usedLogFile, JSON.stringify(l, null, 2), 'utf8'); info.reclaimed = true;
    }
  }
  log(`다시쓰기 준비: 옛 원고 ${info.moved.length}개 파일 → ${info.archiveDir}`);
  log(`  옛 질문: [${info.sheetKey || '?'}열 ${info.row || '?'}번째] ${info.question.slice(0, 50)} | 옛 사진: ${info.imageNames.join(', ') || '(없음)'}`);
  return info;
}

// 새 원고가 성공한 뒤: 옛 원고(미발행)가 잡고 있던 기록을 풀어 준다
function finish(info, log) {
  log = log || (() => {});
  const nb = (() => {  // 방금 생성이 덧붙인 마지막 블록 = 새 원고
    let rep = ''; try { rep = fs.readFileSync(path.join(info.dateDir, '사용내역.txt'), 'utf8'); } catch {}
    const last = rep.split('■').pop() || '';
    const mf = last.match(/실제 사용한 파일\([0-9]+장\):\s*([^\n]+)/), mp = last.match(/위치:\s*[^\n>]*>\s*([^\n]+)/), mq = last.match(/(\d+)번째 질문/);
    return { images: mf ? mf[1].split(',').map(s => s.replace(/\(대표이미지\)/g, '').trim()) : [], folderName: mp ? mp[1].split('>').pop().trim() : '', row: mq ? parseInt(mq[1], 10) : 0 };
  })();
  // 사진(파일 단위 기록)
  const free = info.imageNames.filter(n => !nb.images.includes(n));
  if (free.length) {
    const f = path.join(path.dirname(info.usedLogFile), '_used_images.json');
    const cur = readJson(f, null);
    if (Array.isArray(cur)) {
      const out = cur.filter(x => !(x && free.includes(x.name) && (!x.date || x.date >= info.createdDate)));
      if (out.length !== cur.length) { fs.writeFileSync(f, JSON.stringify(out, null, 2), 'utf8'); log(`  옛 사진 사용기록 해제: ${free.join(', ')}`); }
    }
  }
  const l = readJson(info.usedLogFile, null);
  if (l) {
    let dirty = false;
    // 폴더(폴더 단위 기록) — 새 원고가 다른 폴더를 썼을 때만
    if (info.folderName && nb.folderName !== info.folderName && Array.isArray(l.globalUsedFolders)) {
      const vals = [info.folderName, info.folderId].filter(Boolean);
      const out = l.globalUsedFolders.filter(e => !(e && vals.includes(e.v) && e.date && e.date >= info.createdDate));
      if (out.length !== l.globalUsedFolders.length) { l.globalUsedFolders = out; dirty = true; log(`  옛 사진 폴더 사용기록 해제: ${info.folderName}`); }
      if (l.folderClaims && Array.isArray(l.folderClaims.names)) l.folderClaims.names = l.folderClaims.names.filter(v => !vals.includes(v));
    }
    // 질문 — 새 질문으로 바꿨을 때만(같은 질문이면 새 원고가 계속 쓰는 중)
    if (info.mode === 'new' && info.row && info.usedKey != null && nb.row !== info.row) {
      const k = 'blog' + info.usedKey;
      if (l[k]) {
        l[k].writtenRows = (l[k].writtenRows || []).filter(x => (typeof x === 'number' ? x : x.row) !== info.row);
        if (!(l[k].postedRows || []).includes(info.row)) l[k].usedRows = (l[k].usedRows || []).filter(r => r !== info.row);
        dirty = true; log(`  옛 질문 선점 해제: ${info.sheetKey}열 ${info.row}번째(발행 안 됐으므로 나중에 다시 쓸 수 있음)`);
      }
    }
    if (dirty) fs.writeFileSync(info.usedLogFile, JSON.stringify(l, null, 2), 'utf8');
  }
  log(`다시쓰기 완료 — 옛 원고는 ${info.archiveDir} 에 보관`);
}

// 새 원고 생성이 실패했을 때: 옛 원고를 제자리로 되돌린다
function restore(info, log) {
  log = log || (() => {});
  for (const x of info.moved) { try { fs.renameSync(path.join(info.archiveDir, x), path.join(info.dateDir, x)); } catch {} }
  try { if (!fs.readdirSync(info.archiveDir).length) fs.rmdirSync(info.archiveDir); } catch {}
  if (info.postsRec) {
    const mapFile = path.join(info.dateDir, '_posts.json');
    const posted = readJson(mapFile, {}); posted[info.file] = info.postsRec;
    fs.writeFileSync(mapFile, JSON.stringify(posted, null, 2), 'utf8');
  }
  if (info.reclaimed && info.createdDate !== today()) {  // 이월 원고였으면 잠깐 넣은 오늘자 선점만 되돌림(원고 파일이 살아 있어 질문은 계속 잠김)
    const l = readJson(info.usedLogFile, null);
    if (l && l['blog' + info.usedKey]) {
      const k = 'blog' + info.usedKey;
      l[k].writtenRows = (l[k].writtenRows || []).map(x => (x && typeof x === 'object' && x.row === info.row) ? { row: x.row, date: info.createdDate } : x);
      fs.writeFileSync(info.usedLogFile, JSON.stringify(l, null, 2), 'utf8');
    }
  }
  log('다시쓰기 실패 → 옛 원고를 제자리로 되돌렸습니다');
}

module.exports = { prepare, finish, restore, parseBlock };
