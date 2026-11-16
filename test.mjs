/* 本机模式 v2 回归：一餐多人、逐人评分、平均分、我也吃了 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9444;
const PROFILE = path.join(os.tmpdir(), 'foodjournal-test-profile-' + Date.now());
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
async function shot(name){
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
}

let failed = false;
try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: PAGE });
  await sleep(1800);

  console.log('BOOT', JSON.stringify(await ev('({empty: !!document.querySelector(".empty"), mode: DB.mode})')));

  // 示例数据
  await ev('seed()');
  await sleep(800);
  console.log('SEED', JSON.stringify(await ev('({cards: document.querySelectorAll(".card").length, foot: document.getElementById("foot").textContent})')));
  await shot('50-v2-list.png');

  // 搜索
  await ev(`(()=>{const q=document.getElementById('q'); q.value='牛肉'; q.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(200);
  console.log('SEARCH 牛肉 ->', await ev('document.querySelectorAll(".card").length'));
  await ev(`(()=>{const q=document.getElementById('q'); q.value=''; q.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(200);

  // 卡片上应该有平均分
  console.log('CARD SCORE:', await ev('(document.querySelector(".card .score")||{}).innerText'));

  // 详情
  await ev('document.querySelector(".card").click()');
  await sleep(600);
  console.log('DETAIL', JSON.stringify(await ev(`({
    open: document.getElementById('overlay').classList.contains('show'),
    hasAvg: !!document.querySelector('.bigscore'),
    dishRows: document.querySelectorAll('.dishrow').length,
    reviews: document.querySelectorAll('.review').length,
    myBtn: (document.querySelector('[data-action=start-review],[data-action=join-meal]')||{}).innerText
  })`)));
  await shot('51-v2-detail.png');
  await ev('document.querySelector("[data-action=close]").click()');
  await sleep(300);

  // 记一顿（带菜单 + 我的评分）
  await ev('document.getElementById("fab").click()');
  await sleep(400);
  await ev(`(()=>{
    state.draft.restaurant = '测试小馆';
    state.draft.myComment = '环境一般，但东西好吃';
    state.draft.dishes = [{name:'宫保鸡丁'},{name:'土豆丝'}];
    renderForm();
  })()`);
  await sleep(300);
  // 点第 5 颗星
  await ev(`(()=>{document.querySelectorAll('.stars.input [data-star]')[4].click();})()`);
  await sleep(200);
  console.log('DRAFT myRating:', await ev('state.draft.myRating'));
  await shot('52-v2-form.png');

  // 上传照片
  await ev(`(async()=>{
    const c=document.createElement('canvas'); c.width=800; c.height=600;
    const g=c.getContext('2d'); g.fillStyle='#c96f3d'; g.fillRect(0,0,800,600);
    g.fillStyle='#fff'; g.font='bold 60px sans-serif'; g.fillText('照片',300,320);
    const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.8));
    await onFilesPicked([new File([blob],'t.jpg',{type:'image/jpeg'})]);
  })()`);
  await sleep(700);

  await ev('document.querySelector("[data-action=save]").click()');
  await sleep(1500);
  console.log('SAVED', JSON.stringify(await ev(`({
    cards: document.querySelectorAll('.card').length,
    toast: document.getElementById('toast').textContent,
    foot: document.getElementById('foot').textContent,
    first: (()=>{const m=state.meals.find(x=>x.restaurant==='测试小馆'); return m?{dishes:m.dishes.length,avg:m.avg,count:m.count,photos:m.photoIds.length}:null;})()
  })`)).slice(0, 400));
  await shot('53-v2-list2.png');

  // 刷新持久化
  await send('Page.navigate', { url: PAGE });
  await sleep(2500);
  console.log('AFTER RELOAD', JSON.stringify(await ev(`({
    cards: document.querySelectorAll('.card').length,
    meal: (()=>{const m=state.meals.find(x=>x.restaurant==='测试小馆'); return m?{dishes:m.dishes.map(d=>d.name),avg:m.avg,count:m.count,myRating:m.myRating,photos:m.photoIds.length}:null;})()
  })`)));

  // 详情里改我的评价
  const mid = await ev(`state.meals.find(x=>x.restaurant==='测试小馆').id`);
  await ev(`openDetail(${JSON.stringify(mid)})`);
  await sleep(700);
  await ev(`document.querySelector('[data-action=start-review]').click()`);
  await sleep(500);
  console.log('REVIEW FORM:', JSON.stringify(await ev(`({
    open: !!document.querySelector('[data-action=save-review]'),
    dishStars: document.querySelectorAll('[data-scope=dish-review]').length
  })`)));
  // 给第一道菜 5 星、第二道 2 星
  await ev(`(()=>{
    const boxes=[...document.querySelectorAll('[data-scope=dish-review]')];
    boxes[0].querySelectorAll('[data-star]')[4].click();
    boxes[1].querySelectorAll('[data-star]')[1].click();
    return 'stars set';
  })()`);
  await sleep(300);
  console.log('DISH DRAFT:', await ev('JSON.stringify(state.reviewDraft.dishes)'));
  await shot('54-v2-review.png');
  await ev('document.querySelector("[data-action=save-review]").click()');
  await sleep(1500);
  console.log('AFTER REVIEW', JSON.stringify(await ev(`(()=>{const m=state.meals.find(x=>x.id==='${mid}'); return {avg:m.avg,count:m.count,dishes:m.dishes.map(d=>({n:d.name,avg:d.avg,c:d.count}))};})()`)));

  // 统计
  await ev('document.querySelector("[data-tab=stats]").click()');
  await sleep(600);
  console.log('STATS rows:', await ev('document.querySelectorAll(".rk").length'));
  await shot('55-v2-stats.png');

  // 删除测试餐
  await ev('document.querySelector("[data-tab=list]").click()');
  await sleep(400);
  await ev(`(async()=>{ window.confirm=()=>true; await deleteMeal(${JSON.stringify(mid)}); })()`);
  await sleep(1200);
  console.log('AFTER DELETE cards:', await ev('document.querySelectorAll(".card").length'));

  console.log('LOGS:', logs.length ? logs.join('\n') : '(no runtime errors)');
  if (logs.length) failed = true;
  if ((await ev('document.querySelectorAll(".card").length')) !== 3) { failed = true; console.log('FAIL: 删除后应剩 3 条'); }
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
