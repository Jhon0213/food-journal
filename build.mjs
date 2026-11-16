/* 打包：把 config.js + cloud.js 内联进 index.html，产出一个单文件 dist/index.html
   用途：拖到任何静态托管（Cloudflare Pages / Netlify / Vercel），或者直接微信发给朋友 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let html = read('index.html');
const cfg = read('config.js');
const cloud = read('cloud.js');

const marker = '<script src="config.js"></script>\n<script src="cloud.js"></script>';
if (!html.includes(marker)) {
  console.error('找不到脚本占位，index.html 结构变了？');
  process.exit(1);
}

const inline =
  '<script>\n/* ==== config.js ==== */\n' + cfg + '\n</script>\n' +
  '<script>\n/* ==== cloud.js ==== */\n' + cloud + '\n</script>';

html = html.replace(marker, inline);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'index.html'), html, 'utf8');

const size = fs.statSync(path.join(root, 'dist', 'index.html')).size;
console.log('dist/index.html  ' + Math.round(size / 1024) + ' KB');
