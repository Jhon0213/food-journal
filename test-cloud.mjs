/* Cloud mode test with a mocked Supabase backend (ASCII only on purpose).
   usage: FJ_PAGE=dist/index.html node test-cloud.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9445;
const PROFILE = path.join(os.tmpdir(), 'fj-cloud-test-' + Date.now());
const PAGE = 'file:///' + path.resolve(process.env.FJ_PAGE || 'index.html').replace(/\\/g, '/');
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=430,900', 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitJson(){
  for (let i = 0; i < 60; i++){
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch(e){}
    await sleep(250);
  }
  throw new Error('chrome not ready');
}

const page = await waitJson();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });

let seq = 0; const pending = new Map(); const logs = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)){ const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('CONSOLE.ERROR: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++seq; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr){
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('EVAL FAIL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

const MOCK = `
(() => {
  window.confirm = () => true;
  window.__calls = [];
  const MEALS = [
    { id:'11111111-1111-1111-1111-111111111111', restaurant:'Cloud Noodle House', eaten_on:'2026-11-15',
      meal_type:'LUNCH', rating:5, note:'good broth', created_at:'2026-11-15T10:00:00Z',
      dishes:[{ id:'d1', name:'Beef Noodle', rating:5, note:'', position:0 }],
      photos:[{ id:'22222222-2222-2222-2222-222222222222', storage_path:'ws/1111/2222.jpg' }] }
  ];
  const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers:{ 'Content-Type':'application/json' } });
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://mock.supabase.co')) return origFetch(input, init);
    const u = new URL(url);
    const p = u.pathname + u.search;
    const method = (init && init.method) || 'GET';
    window.__calls.push(method + ' ' + p);
    if (p.startsWith('/auth/v1/token')) return json({ access_token:'at2', refresh_token:'rt2', expires_at: Math.floor(Date.now()/1000)+3600, user:{ id:'11111111-1111-1111-1111-111111111111', email:'a@b.c' } });
    if (p.startsWith('/auth/v1/user')) return json({ id:'11111111-1111-1111-1111-111111111111', email:'a@b.c' });
    if (p.startsWith('/auth/v1/signup')) return json({ access_token:'at3', refresh_token:'rt3', expires_at: Math.floor(Date.now()/1000)+3600, user:{ id:'11111111-1111-1111-1111-111111111111', email:'a@b.c' } });
    if (p.startsWith('/rest/v1/rpc/create_workspace')) return json('ws-1');
    if (p.startsWith('/rest/v1/workspace_members')) return json([{ workspace_id:'ws-1', role:'owner', workspaces:{ id:'ws-1', name:'Our Place', invite_code:'ABCD1234' } }]);
    if (p.startsWith('/rest/v1/meals') && method === 'GET') return json(MEALS);
    if (p.startsWith('/rest/v1/meals')) return new Response('', { status: 201 });
    if (p.startsWith('/rest/v1/dishes') || p.startsWith('/rest/v1/photos')) {
      return method === 'DELETE' ? new Response(null, { status: 204 }) : new Response('', { status: 201 });
    }
    if (p.startsWith('/storage/v1/object/sign/')) return json({ signedURL: '/object/sign/meal-photos/x.jpg?token=abc' });
    if (p.startsWith('/storage/v1/object/')) return new Response('', { status: 200 });
    return new Response('{}', { status: 200 });
  };
  localStorage.setItem('fj.cloud.cfg', JSON.stringify({ url:'https://mock.supabase.co', key:'x'.repeat(40) }));
  localStorage.setItem('fj.cloud.ses', JSON.stringify({ access_token:'at1', refresh_token:'rt1', expires_at: Math.floor(Date.now()/1000)+3600, user:{ id:'11111111-1111-1111-1111-111111111111', email:'a@b.c' } }));
})();
`;

let failed = false;
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
  await send('Page.navigate', { url: PAGE });
  await sleep(1800);

  const boot = await ev(`({ mode: DB.mode, ws: DB.ws && DB.ws.name, cards: document.querySelectorAll('.card').length,
    title: (document.querySelector('.card h3')||{}).textContent, dishes: (state.meals[0]||{}).dishes?.length,
    photos: (state.meals[0]||{}).photoIds?.length, foot: document.getElementById('foot').textContent })`);
  console.log('CLOUD BOOT', JSON.stringify(boot));

  const purl = await ev('photoURL(state.meals[0].photoIds[0])');
  console.log('PHOTO URL', purl);

  await ev('document.querySelector("[data-action=open-settings]").click()');
  await sleep(600);
  console.log('SETTINGS:', await ev(`document.querySelector('#sheet').innerText.replace(/\\n+/g,' | ').slice(0,220)`));
  await ev('document.querySelector("[data-action=close]").click()');
  await sleep(300);

  await ev('window.__calls = [];');
  await ev(`(async () => {
    state.draft = { id:null, restaurant:'Mock Test Place', date:'2026-11-16', mealType:'DINNER', rating:4, note:'',
      dishes:[{name:'Tomato Egg',rating:4,note:''},{name:'Rice',rating:3,note:''}], photoIds:[] };
    state.draftNewPhotos = [{ tmp:'t1', blob:new Blob(['xx'],{type:'image/jpeg'}), url:'blob:fake' }];
    state.draftRemove = [];
    await saveDraft();
  })()`);
  await sleep(900);
  const calls = await ev('JSON.stringify(window.__calls)');
  console.log('SAVE CALLS', calls);
  console.log('AFTER SAVE', await ev('({ cards: document.querySelectorAll(".card").length, foot: document.getElementById("foot").textContent })'));

  const need = ['POST /rest/v1/meals?on_conflict=id', 'POST /rest/v1/dishes', 'POST /storage/v1/object/meal-photos/', 'POST /rest/v1/photos'];
  const missing = need.filter(n => !calls.includes(n));
  if (missing.length){ failed = true; console.log('MISSING CALLS:', missing.join(', ')); }

  // signup path also exercised
  await ev('window.__calls = [];');
  const signup = await ev(`(async()=>{ try { await Cloud.signUp('x@y.z','123456'); return 'signup ok, mode=' + DB.mode; } catch(e){ return 'signup err: ' + e.message; } })()`);
  console.log('SIGNUP', signup);

  console.log('LOGS:', logs.length ? logs.join('\n') : '(no runtime errors)');
  if (boot.mode !== 'cloud'){ failed = true; console.log('FAIL: mode is not cloud'); }
} catch(e){
  console.error('TEST FAILED:', e.message);
  console.log('LOGS:', logs.join('\n'));
  failed = true;
} finally {
  try { ws.close(); } catch(e){}
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(PROFILE, { recursive:true, force:true }); } catch(e){}
  if (failed) process.exitCode = 1;
}
