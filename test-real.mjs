/* 真后端端到端 v2：A 记一餐 → B 用邀请码加入 → B 点「我也吃了」打分 → 平均分正确 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = process.env.FJ_URL || ('file:///' + path.resolve('index.html').replace(/\\/g, '/'));
const stamp = Date.now();
const A = { email: `fanji.a.${stamp}@example.com`, pass: 'test-pass-111' };
const B = { email: `fanji.b.${stamp}@example.com`, pass: 'test-pass-222' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function session(port){
  const profile = path.join(os.tmpdir(), 'fj-v2-' + port + '-' + Date.now());
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
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: PAGE });
  await sleep(2500);
  return { ev, send, logs, close: async () => { try { ws.close(); } catch(e){} chrome.kill(); await sleep(300); try { fs.rmSync(profile, { recursive:true, force:true }); } catch(e){} } };
}

async function signup(env, user){
  await env.ev('document.querySelector("[data-action=open-settings]").click()');
  await sleep(500);
  await env.ev(`(()=>{document.querySelector('#login-email').value=${JSON.stringify(user.email)}; document.querySelector('#login-pass').value=${JSON.stringify(user.pass)};})()`);
  await env.ev('document.querySelector("[data-action=cloud-signup]").click()');
  await sleep(6000);
  return await env.ev('DB.mode');
}

async function signin(env, user){
  await env.ev('document.querySelector("[data-action=open-settings]").click()');
  await sleep(500);
  await env.ev(`(()=>{document.querySelector('#login-email').value=${JSON.stringify(user.email)}; document.querySelector('#login-pass').value=${JSON.stringify(user.pass)};})()`);
  await env.ev('document.querySelector("[data-action=cloud-signin]").click()');
  await sleep(6000);
  return await env.ev('DB.mode');
}

let mealId = null, code = null, failed = false;
try {
  /* ---------- A：注册 → 建空间 → 记一餐（两道菜，5 星） ---------- */
  const a = await session(9460);
  console.log('A signup:', await signup(a, A));
  await a.ev(`(()=>{const i=document.querySelector('#ws-name'); if(i) i.value='测试空间';})()`);
  await a.ev('document.querySelector("[data-action=cloud-create-ws]").click()');
  await sleep(6000);
  code = await a.ev('DB.ws && DB.ws.inviteCode');
  console.log('A workspace:', await a.ev('DB.mode + " / " + (DB.ws||{}).name'), '| invite:', code);
  await a.ev('document.querySelector("[data-action=close]").click()');
  await sleep(500);

  await a.ev(`(async()=>{
    await DB.createMeal({
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      restaurant: 'A记的店', date: '2026-11-16', mealType: '晚餐', note: 'AA 制',
      dishes: [{name:'番茄牛腩'},{name:'拍黄瓜'}], photoIds: [],
      myRating: 5, myComment: '我觉得很好吃'
    }, []);
  })()`);
  await sleep(3000);
  await a.ev('(async()=>{ state.meals = await DB.allMeals(); return state.meals.length; })()');
  mealId = await a.ev('state.meals[0] && state.meals[0].id');
  console.log('A meal:', JSON.stringify(await a.ev(`(()=>{const m=state.meals[0]; return {id:m.id, avg:m.avg, count:m.count, people:m.people, dishes:m.dishes.map(d=>d.name)};})()`)));
  await a.close();

  /* ---------- B：注册 → 邀请码加入 → 看到 A 的那餐 ---------- */
  const b = await session(9461);
  console.log('B signup:', await signup(b, B));
  await b.ev(`(()=>{const i=document.querySelector('#join-code'); if(i) i.value=${JSON.stringify(code)};})()`);
  await b.ev('document.querySelector("[data-action=cloud-join-ws]").click()');
  await sleep(6000);
  console.log('B sees:', JSON.stringify(await b.ev(`(()=>{const m=state.meals.find(x=>x.id==='${mealId}'); return m?{avg:m.avg,count:m.count,people:m.people,joined:m.joined,isMine:m.isMine}:null;})()`)));

  await b.ev(`openDetail('${mealId}')`);
  await sleep(1500);
  console.log('B detail button:', await b.ev(`(document.querySelector('[data-action=join-meal]')||{}).innerText`));
  await b.ev(`document.querySelector('[data-action=join-meal]').click()`);
  await sleep(4000);
  console.log('B review form open:', await b.ev(`!!document.querySelector('[data-action=save-review]')`));
  console.log('B dish inputs:', await b.ev(`document.querySelectorAll('[data-scope=dish-review]').length`));

  await b.ev(`(()=>{
    const meal=[...document.querySelectorAll('[data-scope=review] [data-star]')];
    if (meal[2]) meal[2].click();
    const dishes=[...document.querySelectorAll('[data-scope=dish-review]')];
    dishes[0].querySelectorAll('[data-star]')[3].click();
    dishes[1].querySelectorAll('[data-star]')[0].click();
    return 'stars';
  })()`);
  await sleep(400);
  console.log('B draft:', await b.ev(`JSON.stringify({rating:state.reviewDraft.rating, dishes:state.reviewDraft.dishes})`));
  await b.ev(`document.querySelector('[data-action=save-review]').click()`);
  await sleep(4000);
  console.log('B after save:', JSON.stringify(await b.ev(`(()=>{const m=state.meals.find(x=>x.id==='${mealId}'); return {avg:m.avg, count:m.count, people:m.people, dishes:m.dishes.map(d=>({n:d.name,avg:d.avg,c:d.count}))};})()`)));
  console.log('B logs:', b.logs.length ? b.logs.join('\n') : '(none)');
  await b.close();

  /* ---------- A 重新登录：应该看到平均分 ---------- */
  const c = await session(9462);
  console.log('A relogin:', await signin(c, A));
  await sleep(3000);
  const result = await c.ev(`(()=>{const m=state.meals.find(x=>x.id==='${mealId}'); return m?{avg:m.avg, count:m.count, people:m.people, reviewers:m.reviews.map(r=>r.name+':'+r.rating), dishes:m.dishes.map(d=>({n:d.name,avg:d.avg,c:d.count}))}:null;})()`);
  console.log('A sees after B rated:', JSON.stringify(result));
  await c.close();

  const ok = result && Math.abs(result.avg - 4) < 0.01 && result.count === 2 && result.people === 2;
  console.log(ok ? '✅ 平均分正确（5 和 3 → 4.0，2 人打分）' : '❌ 平均分不对');
  if (!ok) failed = true;
} catch(e){
  console.error('TEST FAILED:', e.message);
  failed = true;
}
console.log('ACCOUNTS', A.email, B.email, 'CODE', code, 'MEAL', mealId);
if (failed) process.exitCode = 1;
