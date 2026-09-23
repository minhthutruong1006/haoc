// 발행 4편의 img를 '전체 주소' → '라벨만(xxx.haoc.co.kr)'으로. 사용: node label_only.js apply | revert
const fs = require('fs'), path = require('path');
const cfg = JSON.parse(fs.readFileSync('E:/haoc-homepage-auto/writer_config.json', 'utf8'));
const B = cfg.supabaseUrl, K = cfg.supabaseAnonKey, H = { apikey: K, Authorization: 'Bearer ' + K };
const PRE = B + '/storage/v1/object/public/images/';
async function getPosts(key) { const r = await fetch(`${B}/rest/v1/overrides?select=v&k=eq.${key}`, { headers: H }); const j = await r.json(); let v = j[0].v; if (typeof v === 'string') v = JSON.parse(v); return v; }
async function putPosts(key, v) { const r = await fetch(`${B}/rest/v1/overrides`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify([{ k: key, v, updated_at: new Date().toISOString() }]) }); return r.status; }
const T = [['hv_posts', 83], ['hs_posts', 30], ['hw_posts', 29], ['hm_posts', 29]];
(async () => {
  const mode = process.argv[2] || 'apply';
  const bdir = 'E:/haoc-homepage-auto/_backup_posts_20260919'; fs.mkdirSync(bdir, { recursive: true });
  for (const [key, id] of T) {
    const posts = await getPosts(key); fs.writeFileSync(path.join(bdir, key + '_' + mode + '_' + Date.now() + '.json'), JSON.stringify(posts, null, 2));
    const p = posts.find(x => x.id === id && /2026.09.18/.test(String(x.date))); if (!p) { console.log(key, id, '못 찾음'); continue; }
    const cur = String(p.img || '');
    if (mode === 'apply') { if (!cur.startsWith(PRE) || !/\.haoc\.co\.kr$/.test(cur)) { console.log(key, '대상 아님:', cur.slice(-50)); continue; } p.img = cur.slice(PRE.length); }
    else { if (/^https?:/.test(cur) || !/^[a-z0-9]+\.haoc\.co\.kr$/.test(cur)) { console.log(key, '되돌릴 것 없음:', cur.slice(-50)); continue; } p.img = PRE + cur; }
    console.log(key, 'id', id, '→ HTTP', await putPosts(key, posts), '|', p.img);
  }
})();
