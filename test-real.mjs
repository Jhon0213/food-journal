/* 真实后端端到端测试：真 Supabase + 真页面（file://） */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9446;
const PROFILE = path.join(os.tmpdir(), 'fj-real-' + Date.now());
const PAGE = process.env.FJ_URL || ('file:///' + path.resolve('index.html').replace(/\\/g, '/'));
const OUT = path.resolve('shots');
const EMAIL = 'fanji.test.' + Date.now() + '@example.com';
const PASS = 'fanji-test-123456';

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=430,900', 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitJson(){
  for (let i = 0; i < 80; i++){
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

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: PAGE });
  await sleep(2000);

  console.log('BOOT', JSON.stringify(await ev('({cfg: !!Cloud.config(), url: (Cloud.config()||{}).url, mode: DB.mode})')));

  // 打开设置 → 注册
  await ev('document.querySelector("[data-action=open-settings]").click()');
  await sleep(600);
  console.log('SETTINGS HAS FORM:', await ev('!!document.querySelector("#login-email")'));
  await ev(`(()=>{document.querySelector('#login-email').value=${JSON.stringify(EMAIL)}; document.querySelector('#login-pass').value=${JSON.stringify(PASS)}; return 'filled';})()`);
  await ev('document.querySelector("[data-action=cloud-signup]").click()');
  await sleep(6000);
  const afterSignup = await ev('({mode: DB.mode, ses: !!Cloud.session(), email: (Cloud.session().user||{}).email, sheet: document.querySelector("#sheet").innerText.replace(/\\n+/g," | ").slice(0,300)})');
  console.log('AFTER SIGNUP', JSON.stringify(afterSignup));
  await shot('20-real-signup.png');

  // 新建空间
  if (afterSignup.mode === 'cloud-no-ws'){
    await ev(`(()=>{const i=document.querySelector('#ws-name'); if(i) i.value='测试空间'; return 'ok';})()`);
    await ev('document.querySelector("[data-action=cloud-create-ws]").click()');
    await sleep(5000);
    console.log('AFTER WS', JSON.stringify(await ev('({mode: DB.mode, ws: DB.ws && DB.ws.name, code: DB.ws && DB.ws.inviteCode})')));
  }
  await shot('21-real-workspace.png');
  await ev('document.querySelector("[data-action=close]").click()');
  await sleep(500);

  // 记一顿带照片
  await ev(`(async () => {
    state.draft = { id:null, restaurant:'真实后端测试店', date:'2026-11-16', mealType:'晚餐', rating:5,
      dishes:[{name:'番茄牛腩',rating:5,note:'好吃'},{name:'拍黄瓜',rating:2,note:'太咸'}], photoIds:[], note:'端到端测试' };
    const c = document.createElement('canvas'); c.width=800; c.height=600;
    const g = c.getContext('2d'); g.fillStyle='#2e7d32'; g.fillRect(0,0,800,600);
    g.fillStyle='#fff'; g.font='bold 72px sans-serif'; g.fillText('真照片',250,320);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
    state.draftNewPhotos = [{ tmp:'t1', blob, url:URL.createObjectURL(blob) }];
    state.draftRemove = [];
    await saveDraft();
    return 'saved';
  })()`);
  await sleep(5000);
  console.log('AFTER SAVE', JSON.stringify(await ev('({cards: document.querySelectorAll(".card").length, meals: state.meals.length, thumbs: document.querySelectorAll(".thumbs img").length, title: (document.querySelector(".card h3")||{}).textContent, foot: document.getElementById("foot").textContent, toast: document.getElementById("toast").textContent})')));
  await shot('22-real-list.png');

  // 刷新看持久化
  await send('Page.navigate', { url: PAGE });
  await sleep(4000);
  console.log('AFTER RELOAD', JSON.stringify(await ev('({mode: DB.mode, meals: state.meals.length, cards: document.querySelectorAll(".card").length, thumbs: document.querySelectorAll(".thumbs img").length})')));
  await shot('23-real-reload.png');

  // 用 token 直接查 REST 交叉验证
  const token = await ev('Cloud.session().access_token');
  const cross = await ev(`(async()=>{ const r = await fetch(Cloud.config().url + '/rest/v1/meals?select=id,restaurant,eaten_on,rating,dishes(name,rating),photos(id,storage_path)', { headers: { apikey: Cloud.config().key, Authorization: 'Bearer ${token}' } }); return { status: r.status, body: await r.text() }; })()`);
  console.log('REST CROSS CHECK', JSON.stringify(cross).slice(0, 900));

  console.log('EMAIL', EMAIL);
  console.log('LOGS:', logs.length ? logs.join('\n') : '(no runtime errors)');
} catch(e){
  console.error('TEST FAILED:', e.message);
  console.log('LOGS:', logs.join('\n'));
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch(e){}
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(PROFILE, { recursive:true, force:true }); } catch(e){}
}
