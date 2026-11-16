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
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=430,900',
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitJson() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('chrome not ready');
}

const page = await waitJson();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });

let seq = 0;
const pending = new Map();
const logs = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    logs.push('CONSOLE.ERROR: ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++seq;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) {
    throw new Error('EVAL FAIL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: PAGE });
  await sleep(1500);

  const boot = await ev('({ title: document.title, cards: document.querySelectorAll(".card").length, empty: !!document.querySelector(".empty"), foot: document.getElementById("foot").textContent, idb: useIDB })');
  console.log('BOOT', JSON.stringify(boot));

  // 空状态截图
  await shot('01-empty.png');

  // 写入示例
  await ev('seed()');
  await sleep(600);
  const after = await ev('({ cards: document.querySelectorAll(".card").length, foot: document.getElementById("foot").textContent })');
  console.log('SEED', JSON.stringify(after));
  await shot('02-list.png');

  // 搜索
  await ev(`(()=>{const q=document.getElementById('q'); q.value='牛肉'; q.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(200);
  console.log('SEARCH 牛肉 ->', await ev('document.querySelectorAll(".card").length'));
  await ev(`(()=>{const q=document.getElementById('q'); q.value=''; q.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(200);

  // 详情
  await ev('document.querySelector(".card").click()');
  await sleep(500);
  console.log('DETAIL open:', await ev('document.getElementById("overlay").classList.contains("show")'));
  await shot('03-detail.png');
  await ev('document.querySelector("[data-action=close]").click()');
  await sleep(300);

  // 新建表单
  await ev('document.getElementById("fab").click()');
  await sleep(400);
  await ev(`(()=>{
    state.draft.restaurant = '测试小馆';
    state.draft.note = '环境一般，但东西好吃';
    state.draft.dishes = [{name:'宫保鸡丁', rating:5, note:'甜辣平衡'}, {name:'土豆丝', rating:2, note:'太油'}];
    renderForm();
  })()`);
  await sleep(300);
  // 点星星：把整体评分点到 4 星之外的 5 星
  await ev(`(()=>{const s=document.querySelectorAll('.stars.input[data-scope=meal] [data-star]')[4]; s.click();})()`);
  await sleep(300);
  console.log('DRAFT rating after star click:', await ev('state.draft.rating'));
  await shot('04-form.png');

  // 上传照片（合成图）
  await ev(`(async()=>{
    const c=document.createElement('canvas'); c.width=900; c.height=700;
    const g=c.getContext('2d');
    g.fillStyle='#c96f3d'; g.fillRect(0,0,900,700);
    g.fillStyle='#f7d9a0'; g.beginPath(); g.arc(450,350,220,0,7); g.fill();
    g.fillStyle='#8a4b23'; g.font='bold 64px sans-serif'; g.fillText('假照片',320,370);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const file=new File([blob],'test.png',{type:'image/png'});
    await onFilesPicked([file]);
  })()`);
  await sleep(600);
  console.log('new photos:', await ev('state.draftNewPhotos.length'));
  await shot('05-form-photo.png');

  // 保存
  await ev('document.querySelector("[data-action=save]").click()');
  await sleep(900);
  const saved = await ev('({ cards: document.querySelectorAll(".card").length, overlay: document.getElementById("overlay").classList.contains("show"), foot: document.getElementById("foot").textContent, thumbs: document.querySelectorAll(".thumbs img").length })');
  console.log('SAVED', JSON.stringify(saved));
  await shot('06-list-with-photo.png');

  // 持久化检查（刷新后是否还在）
  await send('Page.navigate', { url: PAGE });
  await sleep(1500);
  const afterReload = await ev('({ cards: document.querySelectorAll(".card").length, thumbs: document.querySelectorAll(".thumbs img").length, idb: useIDB })');
  console.log('AFTER RELOAD', JSON.stringify(afterReload));
  await shot('07-reload.png');

  // 统计页
  await ev('document.querySelector("[data-tab=stats]").click()');
  await sleep(500);
  console.log('STATS rows:', await ev('document.querySelectorAll(".rk").length'));
  await shot('08-stats.png');

  // 编辑已有记录
  await ev('document.querySelector("[data-tab=list]").click()');
  await sleep(300);
  await ev('document.querySelector(".card").click()');
  await sleep(400);
  await ev('document.querySelector("[data-action=edit]").click()');
  await sleep(500);
  console.log('EDIT form restaurant:', await ev('document.querySelector("[data-field=restaurant]").value'));
  await shot('09-edit.png');
  await ev('document.querySelector("[data-action=close]").click()');
  await sleep(300);

  console.log('LOGS:', logs.length ? logs.join('\n') : '(no runtime errors)');
} catch (e) {
  console.error('TEST FAILED:', e.message);
  console.log('LOGS:', logs.join('\n'));
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch (e) {}
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
}
