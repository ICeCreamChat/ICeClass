'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'miniprogram', 'teacher');
const output = path.join(root, 'output', 'wechat-native-check');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const files = walk(app);
let checks = 0;
const config = JSON.parse(fs.readFileSync(path.join(app, 'app.json'), 'utf8'));
const routes = new Set(config.pages);
const retired = /^(?:pages\/(?:banban|connection-settings|quota-settings|study)\/|lib\/(?:banban-data|banban-stream|study-settings)\.js$)/;
for (const file of files) {
  const relative = path.relative(app, file).replaceAll('\\', '/');
  const text = /\.(js|json|wxml|wxss)$/.test(file) && relative !== 'project.private.config.json' ? fs.readFileSync(file, 'utf8') : '';
  if (retired.test(relative)) throw new Error('已下线的功能仍在小程序源码包中：' + relative);
  if (/^pages\/[^/]+\/index\.(?:js|json|wxml|wxss)$/.test(relative) && !routes.has(relative.slice(0, relative.lastIndexOf('.')))) {
    throw new Error('小程序源码包包含未注册页面：' + relative);
  }
  if (/\/api\/(?:self-study\b|banban\/(?!operations\b))|\benableChunked\s*:/.test(text)) {
    throw new Error('小程序源码包包含已下线的模型或监测调用：' + relative);
  }
  if (file.endsWith('.js')) { new vm.Script(text, { filename: file }); checks++; }
  if (file.endsWith('.json') && !file.endsWith('project.private.config.json')) { JSON.parse(text); checks++; }
  if (file.endsWith('.wxml') && /<web-view\b/i.test(text)) throw new Error('个人主体原生包中不能保留 web-view: ' + file);
}
for (const page of config.pages) {
  for (const extension of ['.js', '.json', '.wxml', '.wxss']) if (!fs.existsSync(path.join(app, page + extension))) throw new Error('Missing page file: ' + page + extension);
}
const project = JSON.parse(fs.readFileSync(path.join(app, 'project.config.json'), 'utf8'));
if (project.setting.urlCheck !== true) throw new Error('Domain validation must remain enabled.');
const compilerRoot = process.env.WECHAT_COMPILER_DIR || 'C:/Program Files (x86)/Tencent/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
fs.mkdirSync(output, { recursive: true });
for (const [compiler, extension, artifact] of [['wcc.exe', '.wxml', 'wxml-compiled.js'], ['wcsc.exe', '.wxss', 'wxss-compiled.js']]) {
  const binary = path.join(compilerRoot, compiler);
  if (!fs.existsSync(binary)) throw new Error('Official compiler is unavailable: ' + binary);
  const sources = files.filter(file => file.endsWith(extension)).map(file => path.relative(app, file).replaceAll('\\', '/'));
  const destination = path.join(output, artifact);
  const fd = fs.openSync(destination, 'w');
  const result = spawnSync(binary, sources, { cwd: app, encoding: 'utf8', stdio: ['ignore', fd, 'pipe'], windowsHide: true });
  fs.closeSync(fd);
  if (result.error || result.status !== 0) throw new Error(compiler + ': ' + (result.error ? result.error.message : result.stderr));
  console.log(compiler + ': compiled ' + sources.length + ' files');
}
console.log('Checked ' + checks + ' JavaScript/JSON files, ' + config.pages.length + ' registered pages, HTTPS domain checks enabled.');
