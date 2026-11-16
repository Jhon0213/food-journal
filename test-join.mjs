/* 两个账号：A 建空间记一条，B 用邀请码加入，验证能看到同一份数据（RLS 跨用户） */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
const stamp = Date.now();
const A = { email: `fanji.a.${stamp}@example.com`, pass: 'test-pass-111' };
const B = { email: `fanji.b.${stamp}@example.com`, pass: 'test-pass-222' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function session(port){
  const profile = path.join(os.tmpdir(), 'fj-join-' + port + '-' + Date.now());
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=430,900', 'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80; i++){
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch(e){}
    await sleep(250);
  }
  if (!target) throw new Error('chrome not ready');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let seq = 0; const pending = new Map(); const logs = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)){ const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++seq; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('EVAL FAIL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(2000);
  return { ev, send, logs, close: async () => { try { ws.close(); } catch(e){} chrome.kill(); await sleep(300); try { fs.rmSync(profile, { recursive:true, force:true }); } catch(e){} } };
}

async function signup(env, user){
  await env.ev('document.querySelector("[data-action=open-settings]").click()');
  await sleep(500);
  await env.ev(`(()=>{document.querySelector('#login-email').value=${JSON.stringify(user.email)}; document.querySelector('#login-pass').value=${JSON.stringify(user.pass)};})()`);
  await env.ev('document.querySelector("[data-action=cloud-signup]").click()');
  await sleep(6000);
}

let code = null;
try {
  /* ---------- A：注册、建空间、记一条 ---------- */
  const a = await session(9450);
  await signup(a, A);
  console.log('A after signup:', await a.ev('DB.mode'));
  await a.ev(`(()=>{const i=document.querySelector('#ws-name'); if(i) i.value='我们的饭记';})()`);
  await a.ev('document.querySelector("[data-action=cloud-create-ws]").click()');
  await sleep(5000);
  code = await a.ev('DB.ws && DB.ws.inviteCode');
  console.log('A workspace:', await a.ev('DB.mode + " / " + (DB.ws||{}).name'), 'invite:', code);
  await a.ev('document.querySelector("[data-action=close]").click()');
  await sleep(400);
  await a.ev(`(async()=>{ state.draft={ id:null, restaurant:'A先记的店', date:'2026-11-16', mealType:'晚餐', rating:5, dishes:[{name:'招牌菜',rating:5,note:''}], photoIds:[], note:'来自A' }; state.draftNewPhotos=[]; state.draftRemove=[]; await saveDraft(); })()`);
  await sleep(4000);
  console.log('A meals:', await a.ev('state.meals.length'), '| foot:', await a.ev('document.getElementById("foot").textContent'));
  await a.close();

  /* ---------- B：注册、用邀请码加入 ---------- */
  const b = await session(9451);
  await signup(b, B);
  console.log('B after signup:', await b.ev('DB.mode'));
  await b.ev(`(()=>{const i=document.querySelector('#join-code'); if(i) i.value=${JSON.stringify(code)};})()`);
  await b.ev('document.querySelector("[data-action=cloud-join-ws]").click()');
  await sleep(6000);
  console.log('B workspace:', await b.ev('DB.mode + " / " + (DB.ws||{}).name'));
  console.log('B sees meals:', await b.ev('JSON.stringify(state.meals.map(m=>({r:m.restaurant,n:m.note,d:m.dishes.length})))'));
  console.log('B foot:', await b.ev('document.getElementById("foot").textContent'));
  console.log('B cards:', await b.ev('document.querySelectorAll(".card").length'));

  // B 记一条，看 A 那边是否也能看到（换个会话刷新）
  await b.ev(`(async()=>{ state.draft={ id:null, restaurant:'B后来加的店', date:'2026-11-16', mealType:'夜宵', rating:4, dishes:[], photoIds:[], note:'来自B' }; state.draftNewPhotos=[]; state.draftRemove=[]; await saveDraft(); })()`);
  await sleep(4000);
  console.log('B after own save:', await b.ev('state.meals.length'));
  console.log('B logs:', b.logs.length ? b.logs.join('\n') : '(none)');
  await b.close();

  const c = await session(9452);
  await c.ev(`(()=>{document.querySelector('[data-action=open-settings]').click();})()`);
  await sleep(400);
  await c.ev(`(()=>{document.querySelector('#login-email').value=${JSON.stringify(A.email)}; document.querySelector('#login-pass').value=${JSON.stringify(A.pass)};})()`);
  await c.ev('document.querySelector("[data-action=cloud-signin]").click()');
  await sleep(6000);
  console.log('A re-login mode:', await c.ev('DB.mode'), '| sees:', await c.ev('JSON.stringify(state.meals.map(m=>m.restaurant))'));
  await c.close();
} catch(e){
  console.error('TEST FAILED:', e.message);
  process.exitCode = 1;
}
console.log('ACCOUNTS', A.email, B.email, 'CODE', code);
