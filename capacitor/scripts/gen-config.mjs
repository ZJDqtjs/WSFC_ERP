/**
 * 合成 capacitor.config.json
 *
 *   capacitor.config.template.json  入库，只放结构 + 占位地址
 *   capacitor.config.local.json     本机私有（已 gitignore），放真实服务端地址等
 *   capacitor.config.json           本脚本生成的产物（已 gitignore），Capacitor CLI 只认这个文件名
 *
 * 为什么要有这一层：Capacitor CLI 只读取当前目录下的 capacitor.config.json，
 * 且 JSON 配置不支持读环境变量，所以真实服务器地址不能直接写进入库文件。
 *
 * 用法：npm run config   （下面的 sync / copy / open:android 都会先自动执行它）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(root, 'capacitor.config.template.json');
const LOCAL = join(root, 'capacitor.config.local.json');
const OUT = join(root, 'capacitor.config.json');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** 深合并：dict 递归合并，数组与标量整体覆盖（与后端 app/config.py 的规则保持一致）。 */
function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : value;
  }
  return out;
}

if (!existsSync(TEMPLATE)) {
  console.error(`[cap-config] 缺少模板文件：${TEMPLATE}`);
  process.exit(1);
}

const hasLocal = existsSync(LOCAL);
const config = merge(readJson(TEMPLATE), hasLocal ? readJson(LOCAL) : {});
writeFileSync(OUT, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

// cap sync 要往 android/app/src/main/assets 写 capacitor.config.json 与 capacitor.plugins.json，
// 而该目录被 .gitignore 排除（构建产物），新克隆的仓库里不存在时 sync 会直接 ENOENT 失败，这里兜底创建。
const ASSETS_DIR = join(root, 'android/app/src/main/assets');
if (existsSync(join(root, 'android'))) mkdirSync(ASSETS_DIR, { recursive: true });

console.log(`[cap-config] 已生成 capacitor.config.json（server.url = ${config?.server?.url ?? '未设置'}）`);
if (!hasLocal) {
  console.warn('[cap-config] 未找到 capacitor.config.local.json，当前使用的是模板占位地址，');
  console.warn('[cap-config] 这样打出来的 App 连不上后端。请在 capacitor/ 下自建该文件，例如：');
  console.warn('[cap-config]   { "server": { "url": "http://<你的服务器地址>/mobile/" } }');
}
