/* 连上正在跑的 Edge，打开饭记页面，收集控制台错误和运行状态 */
import fs from 'node:fs';

const PORT = 9333;
const URL = 'file:///C:/Users/20232/Documents/deepseek-harness/default-workspace/food-journal/index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });

let seq = 0; const pending = new Map(); const events = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)){ const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown'){
    const d = m.params.exceptionDetails;
    events.push('EXCEPTION: ' + (d.exception?.description || d.text));
  }
  if (m.method === 'Runtime.consoleAPICalled'){
    events.push('console.' + m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
  }
  if (m.method === 'Log.entryAdded'){
    const e = m.params.entry;
    if (e.level === 'error' || e.level === 'warning') events.push('LOG.' + e.level + ': ' + e.text + (e.url ? ' @ ' + e.url : ''));
  }
  if (m.method === 'Network.loadingFailed') events.push('NET FAIL: ' + m.params.errorText + ' ' + (m.params.type || ''));
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++seq; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr){
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await sleep(6000);

const state = await ev(`(() => {
  const out = { title: document.title, url: location.href };
  try {
    out.hasCloud = typeof Cloud !== 'undefined';
    out.cfg = Cloud.config();
    out.session = Cloud.session() ? { email: (Cloud.session().user||{}).email, exp: Cloud.session().expires_at } : null;
    out.mode = DB.mode;
    out.ws = DB.ws;
    out.lastError = DB.lastError;
    out.cloudError = DB.cloudError;
    out.meals = (state.meals || []).map(m => ({ r: m.restaurant, d: (m.dishes||[]).map(x=>x.name+':'+x.rating), p: (m.photoIds||[]).length, note: m.note }));
    out.foot = (document.getElementById('foot')||{}).textContent;
    out.cards = document.querySelectorAll('.card').length;
  } catch (e) { out.evalError = e.message; }
  return out;
})()`);

console.log('STATE', JSON.stringify(state, null, 2));
console.log('EVENTS:', events.length ? '\n' + events.join('\n') : '(无错误)');

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shots/30-live.png', Buffer.from(shot.data, 'base64'));
console.log('screenshot: shots/30-live.png');
ws.close();
