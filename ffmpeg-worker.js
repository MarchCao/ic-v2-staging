/* 视频转换 Worker: FFmpeg.wasm 单线程 core(无需 COOP/COEP,可直接跑在 GitHub Pages)
   主线程通过 postMessage 通信;一次只处理一个转换任务(串行队列由主线程保证)。
   协议:
     主->从: {id, cmd:'init'}
             {id, cmd:'convert', inputName, inputData(ArrayBuffer, transfer), args:[...], outputName}
     从->主: {id, type:'ready'}
             {id, type:'progress', progress}   // progress: 0~1,可能为 NaN(未知时长)
             {id, type:'done', data(ArrayBuffer, transfer)}
             {id, type:'error', message}
*/
'use strict';

/* 自托管 FFmpeg 静态资源(与本站同源): UMD 分块在 Worker 内无法正确推导路径,
   且 UMD class worker(814)在 module worker 内调 importScripts 会抛错;
   故 class worker 与 core 改用官方 ESM 构建(其 fallback 走合法的动态 import)。
   外层 wrapper 仍用 UMD(ffmpeg.js),在 classic worker 内 importScripts 已验证可行。
   仍保持懒加载:只有进入视频模式 / 首次选择视频时才由主线程创建本 Worker 并 init。
   版本一致性:所有 FFmpeg 文件 URL 统一附加版本参数,避免新旧混用导致偶发加载失败。 */
var FF_VER = 'v20260929p';
var VENDOR = 'vendor/ffmpeg/';
var FFMPEG_JS = VENDOR + 'ffmpeg.js?' + FF_VER;            // importScripts 相对 Worker 自身 URL 解析,同源 OK
var CORE_JS_ABS = new URL(VENDOR + 'esm/ffmpeg-core.js?' + FF_VER, self.location.href).href;
// UMD 包在 Worker 内无法正确推导分块(814.ffmpeg.js)路径,必须显式传入绝对地址(同源,module worker 合规)
var CLASS_WORKER_ABS = new URL(VENDOR + 'esm/worker.js?' + FF_VER, self.location.href).href;
// wasmURL 必须显式传入:coreURL 带 ?ver 查询参数时,库内部用 /\.js$/ 推导 wasm 会失败
var WASM_ABS = new URL(VENDOR + 'esm/ffmpeg-core.wasm?' + FF_VER, self.location.href).href;

var ffmpeg = null;
var activeId = null;
var ffmpegBroken = false; /* exec 失败可能导致 wasm runtime abort,下次转换前重建 */
/* 每次转换独立收集 FFmpeg 日志,失败时把尾部带回主线程,便于定位 */
var curLogs = [];
function pushLog(msg) {
  curLogs.push(String(msg));
  if (curLogs.length > 40) curLogs.shift();
}
function logTail() {
  return curLogs.slice(-8).join(' | ').slice(0, 600);
}

/* UMD 包(@ffmpeg/ffmpeg)在顶层作用域直接引用裸 document.baseURI,而 Web Worker 里
   没有 document,会导致 importScripts 时抛 ReferenceError。垫一个最小 shim 即可
   (包内实际只用到 document.baseURI;其余带 typeof 保护或不会被调用到)。 */
if (typeof document === 'undefined') {
  var document = { baseURI: (self.location && self.location.href) || '', currentScript: null, title: '' };
}

function post(msg, transfer) {
  if (transfer) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

function toArrayBuffer(u8) {
  /* readFile 返回的 Uint8Array 做一次安全拷贝,避免 transfer 掉底层的共享 buffer */
  var buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

async function ensureFfmpeg() {
  if (ffmpeg && !ffmpegBroken) return;
  if (ffmpeg) { try { await ffmpeg.terminate(); } catch (e) {} ffmpeg = null; }
  ffmpegBroken = false;
  try {
    importScripts(FFMPEG_JS);
  } catch (e) {
    throw new Error('ffmpeg.js 加载错误(' + FFMPEG_JS + '):' + (e && e.message || e));
  }
  var FF = self.FFmpegWASM && self.FFmpegWASM.FFmpeg;
  if (!FF) throw new Error('FFmpeg 脚本加载失败(FFmpegWASM 未定义)');
  ffmpeg = new FF();
  ffmpeg.on('progress', function (p) {
    if (activeId != null) {
      post({ id: activeId, type: 'progress', progress: p && p.progress });
    }
  });
  ffmpeg.on('log', function (m) {
    if (m && m.message) pushLog(m.message);
  });
  try {
    await ffmpeg.load({ coreURL: CORE_JS_ABS, wasmURL: WASM_ABS, classWorkerURL: CLASS_WORKER_ABS });
  } catch (e) {
    throw new Error('ffmpeg.load() 错误(core:' + CORE_JS_ABS + ', wasm:' + WASM_ABS + ', worker:' + CLASS_WORKER_ABS + '):' + (e && e.message || e));
  }
}

async function handleInit(id) {
  try {
    await ensureFfmpeg();
    post({ id: id, type: 'ready' });
  } catch (e) {
    post({ id: id, type: 'error', message: '视频引擎加载失败:' + (e && e.message || e) });
  }
}

async function handleConvert(m) {
  activeId = m.id;
  curLogs = [];
  try {
    await ensureFfmpeg();
    await ffmpeg.writeFile(m.inputName, new Uint8Array(m.inputData));
    m.inputData = null; /* 已拷入 MEMFS,断开主线程 transfer 来的缓冲引用,帮助 GC */
    var ret = await ffmpeg.exec(m.args);
    if (ret !== 0) throw new Error('FFmpeg 执行失败,退出码:' + ret);
    var out = await ffmpeg.readFile(m.outputName);
    var buf = toArrayBuffer(out);
    out = null;
    try { await ffmpeg.deleteFile(m.inputName); } catch (e) {}
    try { await ffmpeg.deleteFile(m.outputName); } catch (e) {}
    activeId = null;
    post({ id: m.id, type: 'done', data: buf }, [buf]);
    buf = null;
  } catch (e) {
    activeId = null;
    ffmpegBroken = true; /* abort 后的 runtime 不可信,下次转换重建 */
    try { await ffmpeg.deleteFile(m.inputName); } catch (ee) {}
    try { await ffmpeg.deleteFile(m.outputName); } catch (ee) {}
    var tail = logTail();
    post({ id: m.id, type: 'error',
      message: ((e && e.message) || '转换失败') + (tail ? ' [日志]' + tail : '') });
  }
}

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.cmd === 'init') handleInit(m.id);
  else if (m.cmd === 'convert') handleConvert(m);
  else post({ id: m.id, type: 'error', message: '未知命令:' + m.cmd });
};
