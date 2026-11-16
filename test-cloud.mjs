/* v2 cloud mode test against a mocked Supabase (ASCII only on purpose).
   usage: FJ_PAGE=dist/index.html node test-cloud.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9445;
const PROFILE = path.join(os.tmpdir(), 'fj-cloud-test-' + Date.now());
const PAGE = 'file:///' + path.resolve(process.env.FJ_PAGE || 'index.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=430,900', 'about:blank'
], { stdio: 'ignore' });

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

/* 假后端：两个用户已经给同一餐打过 5 分和 3 分，当前登录的是 u1 */
const MOCK = `
(() => {
  window.confirm = () => true;
  window.__calls = [];
  const U1 = '11111111-1111-1111-1111-111111111111';
  const MEALS = [{
    id:'22222222-2222-2222-2222-222222222222',
    restaurant:'Cloud Noodle House', eaten_on:'2026-11-15', meal_type:'LUNCH', note:'',
    created_by: U1, created_at:'2026-11-15T10:00:00Z',
    dishes:[{ id:'d1', name:'Beef Noodle', position:0,
      dish_reviews:[{ user_id:U1, reviewer_name:'a', rating:5, note:'' }] }],
    meal_reviews:[
      { user_id:U1, reviewer_name:'a', rating:5, comment:'good', created_at:'2026-11-15T11:00:00Z' },
      { user_id:'33333333-3333-3333-3333-333333333333', reviewer_name:'b', rating:3, comment:'ok', created_at:'2026-11-15T12:00:00Z' }
    ],
    photos:[]
  }];
  const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers:{ 'Content-Type':'application/json' } });
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://mock.supabase.co')) return origFetch(input, init);
    const u = new URL(url);
    const p = u.pathname + u.search;
    const method = (init && init.method) || 'GET';
    window.__calls.push(method + ' ' + p);
    if (p.startsWith('/auth/v1/token')) return json({ access_token:'at2', refresh_token:'rt2', expires_at: Math.floor(Date.now()/1000)+3600, user:{ id:U1, email:'a@b.c' } });
    if (p.startsWith('/auth/v1/user')) return json({ id:U1, email:'a@b.c' });
    if (p.startsWith('/auth/v1/signup')) return json({ access_token:'at3', refresh_token:'rt3', expires_at: Math.floor(Date.now()/1000)+3600, user:{ id:U1, email:'a@b.c' } });
    if (p.startsWith('/rest/v1/rpc/create_workspace')) return json('ws-1');
    if (p.startsWith('/rest/v1/workspace_members')) return json([{ workspace_id:'ws-1', role:'owner', workspaces:{ id:'ws-1', name:'Our Place', invite_code:'ABCD1234' } }]);
    if (p.startsWith('/rest/v1/meals') && method === 'GET') return json(MEALS);
    if (p.startsWith('/rest/v1/meals')) return new Response('', { status: 201 });
    if (p.startsWith('/rest/v1/dishes') && method === 'GET') return json([]);
    if (p.startsWith('/rest/v1/dishes')) return method === 'DELETE' ? new Response(null, { status: 204 }) : json([{ id:'d9', name:'New Dish', position:0 }], 201);
    if (p.startsWith('/rest/v1/meal_reviews') || p.startsWith('/rest/v1/dish_reviews')) {
      return method === 'DELETE' ? new Response(null, { status: 204 }) : new Response('', { status: 201 });
    }
    if (p.startsWith('/rest/v1/photos')) return method === 'DELETE' ? new Response(null, { status: 204 }) : new Response('', { status: 201 });
    if (p.startsWith('/storage/v1/object/sign/')) return json({ signedURL: '/object/sign/meal-photos/x.jpg?token=abc' });
    if (p.startsWith('/storage/v1/object/')) return new Response('', { status: 200 });
    return new Response('{}', { status: 200 });
  };
  localStorage.setItem('fj.cloud.cfg', JSON.stringify({ url:'https://mock.supabase.co', key:'x'.repeat(40) }));
  localStorage.setItem('fj.cloud.ses', JSON.stringify({ access_token:'at1', refresh_token:'rt1', expires_at: Math.floor(Date.now()/1000)+3600, user:{ id:U1, email:'a@b.c' } }));
})();
`;

let failed = false;
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
  await send('Page.navigate', { url: PAGE });
  await sleep(2000);

  const boot = await ev(`({ mode: DB.mode, cards: document.querySelectorAll('.card').length,
    title: (document.querySelector('.card h3')||{}).textContent,
    avg: state.meals[0] && state.meals[0].avg, count: state.meals[0] && state.meals[0].count,
    people: state.meals[0] && state.meals[0].people,
    myRating: state.meals[0] && state.meals[0].myRating,
    dishAvg: state.meals[0] && state.meals[0].dishes[0].avg })`);
  console.log('CLOUD BOOT', JSON.stringify(boot));
  if (boot.mode !== 'cloud') { failed = true; console.log('FAIL: mode'); }
  if (Math.abs((boot.avg || 0) - 4) > 0.01) { failed = true; console.log('FAIL: avg should be 4'); }
  if (boot.count !== 2) { failed = true; console.log('FAIL: count should be 2'); }

  // 详情页：应该认出「我」已经评过
  await ev(`openDetail(state.meals[0].id)`);
  await sleep(800);
  console.log('DETAIL', JSON.stringify(await ev(`({
    reviews: document.querySelectorAll('.review').length,
    dishes: document.querySelectorAll('.dishrow').length,
    myBtn: (document.querySelector('[data-action=start-review]')||{}).innerText
  })`)));

  // 保存我的评价 → 应打 meal_reviews / dish_reviews
  await ev('window.__calls = [];');
  await ev(`(async()=>{ await DB.saveMyReview(state.meals[0].id, 4, 'updated', [{dishId:'d1', rating:4, note:'x'}]); })()`);
  await sleep(600);
  const calls = await ev('JSON.stringify(window.__calls)');
  console.log('SAVE CALLS', calls);
  if (!calls.includes('POST /rest/v1/meal_reviews')) { failed = true; console.log('FAIL: missing meal_reviews call'); }
  if (!calls.includes('POST /rest/v1/dish_reviews')) { failed = true; console.log('FAIL: missing dish_reviews call'); }

  // 建一餐 → 应写 meals + dishes + meal_reviews
  await ev('window.__calls = [];');
  await ev(`(async()=>{
    await DB.createMeal({ id:'44444444-4444-4444-4444-444444444444', restaurant:'New Place', date:'2026-11-16',
      mealType:'DINNER', note:'', dishes:[{name:'Dish A'},{name:'Dish B'}], photoIds:[], myRating:5, myComment:'nice' }, []);
  })()`);
  await sleep(800);
  const calls2 = await ev('JSON.stringify(window.__calls)');
  console.log('CREATE CALLS', calls2);
  for (const need of ['POST /rest/v1/meals', 'POST /rest/v1/dishes', 'POST /rest/v1/meal_reviews']){
    if (!calls2.includes(need)) { failed = true; console.log('FAIL: missing ' + need); }
  }

  console.log('LOGS:', logs.length ? logs.join('\n') : '(no runtime errors)');
  if (logs.length) failed = true;
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
