// 하커 두 PC 공유 상태 — Supabase 통신부 (2026-09-23)
//   저장 위치: haoc.co.kr Supabase overrides 테이블, 키 'auto_haoc_<이름>' (사이트는 hv_/hao_/hs_/hw_/hm_/hub_ 접두어만 읽으므로 영향 없음)
//   값 형식: { _rev, text, host, at } — _rev로 낙관적 잠금(같은 _rev일 때만 덮어씀)
//   haoc-sync.js가 동기 호출용으로 이 파일을 자식 프로세스로 실행한다:  node haoc-sync-remote.js <get|cas|insert|del> <키>  (stdin=JSON)
const fs = require('fs');
const path = require('path');

function loadCfg() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'sync.config.json'), 'utf8').replace(/^﻿/, ''));
}
const cfg = loadCfg();
const PREFIX = cfg.keyPrefix || 'auto_haoc_';
const BASE = cfg.supabaseUrl.replace(/\/$/, '') + '/rest/v1/overrides';
const H = { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + cfg.supabaseAnonKey, 'Content-Type': 'application/json' };

async function req(url, opt = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), cfg.timeoutMs || 10000);
  try {
    const r = await fetch(url, { ...opt, headers: { ...H, ...(opt.headers || {}) }, signal: ac.signal });
    const body = await r.text();
    return { status: r.status, body };
  } finally { clearTimeout(t); }
}

// → 값(object) 또는 null(없음). 통신 실패는 throw.
async function get(key) {
  const r = await req(`${BASE}?select=v&k=eq.${encodeURIComponent(PREFIX + key)}`);
  if (r.status !== 200) throw new Error('get ' + r.status + ' ' + r.body.slice(0, 120));
  const a = JSON.parse(r.body);
  return a.length ? a[0].v : null;
}
// rev가 그대로일 때만 v로 교체 → true(적용) / false(다른 PC가 먼저 바꿈)
async function cas(key, rev, v) {
  const r = await req(`${BASE}?k=eq.${encodeURIComponent(PREFIX + key)}&v->>_rev=eq.${encodeURIComponent(String(rev))}`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ v }) });
  if (r.status !== 200) throw new Error('cas ' + r.status + ' ' + r.body.slice(0, 120));
  return JSON.parse(r.body).length > 0;
}
// 새 키 만들기 → true / false(이미 있음)
async function insert(key, v) {
  const r = await req(BASE, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ k: PREFIX + key, v }) });
  if (r.status === 201) return true;
  if (r.status === 409) return false;
  throw new Error('insert ' + r.status + ' ' + r.body.slice(0, 120));
}
async function del(key) {
  const r = await req(`${BASE}?k=eq.${encodeURIComponent(PREFIX + key)}`, { method: 'DELETE' });
  if (r.status >= 300) throw new Error('del ' + r.status);
  return true;
}

module.exports = { get, cas, insert, del, PREFIX };

if (require.main === module) {
  (async () => {
    const [op, key] = process.argv.slice(2);
    let input = '';
    try { input = fs.readFileSync(0, 'utf8'); } catch {}
    const a = input ? JSON.parse(input) : {};
    let out;
    if (op === 'get') out = { ok: true, v: await get(key) };
    else if (op === 'cas') out = { ok: true, applied: await cas(key, a.rev, a.v) };
    else if (op === 'insert') out = { ok: true, applied: await insert(key, a.v) };
    else if (op === 'del') out = { ok: true, applied: await del(key) };
    else out = { ok: false, error: 'unknown op ' + op };
    process.stdout.write(JSON.stringify(out));
  })().catch(e => { process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) })); });
}
