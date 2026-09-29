/* 图片格式转换 - 纯本地(canvas)实现,ES5 风格,无构建步骤
   所有转换均在浏览器本地完成,图片不上传任何服务器。 */

/* ============ 纯函数(可在 node 下直接测试,不依赖 DOM) ============ */

var MIME_OF = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif'
};
var EXT_OF = { png: 'png', jpeg: 'jpg', webp: 'webp', bmp: 'bmp', avif: 'avif' };
var LOSSY = { jpeg: 1, webp: 1, avif: 1 }; /* 质量滑杆生效的格式 */

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '-';
  if (bytes === 0) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB'];
  var i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n = n / 1024; i++; }
  return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + units[i];
}

function getExt(filename) {
  var m = /\.([a-z0-9]+)$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

function baseName(filename) {
  var i = Math.max((filename || '').lastIndexOf('/'), (filename || '').lastIndexOf('\\'));
  var base = i >= 0 ? filename.slice(i + 1) : (filename || 'image');
  var dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function buildFileName(origName, fmt) {
  return baseName(origName) + '.' + (EXT_OF[fmt] || fmt);
}

/* 纯函数:根据输入文件名和输出扩展名生成输出文件名(同步,无异步依赖)
   movie.mov + webm -> movie.webm
   movie.MOV + webm -> movie.webm
   test.video.avi + mp4 -> test.video.mp4
   movie + mp4 -> movie.mp4
   test video.mov + webm -> test video.webm */
function getOutputFilename(inputName, outputExt) {
  var base = baseName(inputName || 'video');
  if (!base) base = 'video';
  var ext = String(outputExt || 'mp4').toLowerCase().replace(/^\.+/, '');
  if (!ext) ext = 'mp4';
  return base + '.' + ext;
}

function isHeicFile(file) {
  var ext = getExt(file && file.name);
  var type = (file && file.type || '').toLowerCase();
  return ext === 'heic' || ext === 'heif' || type === 'image/heic' || type === 'image/heif';
}

/* P2 HEIC/HEIF 说明(2026-09-29 评估结论):
   - 浏览器原生:仅 Safari 可解码 HEIC;Chrome/Firefox/Edge 均不支持 canvas 绘制 HEIC。
   - WASM 方案需引入 libheif(约 2MB),且 iPhone 直出的 HEIC 多为 12MP+,
     与 MAX_IMAGE_PIXELS 内存保护存在叠加风险;暂无经过验证的自托管构建。
   - 结论:本次不强行加入,保持"跳过+中文提示"逻辑;检测集中在 isHeicFile(),
     未来如需支持,在此接入按需加载的 HEIC WASM(普通 JPG/PNG 用户零成本)。 */
function heicSkipTip(names) {
  return '⚠️ 以下 ' + names.length + ' 个文件为 HEIC/HEIF 格式，浏览器无法直接读取，已跳过：<br>' +
    escapeHtml(names.join('、')) + '<br>请先在手机相册中导出为 JPG 后再转换。';
}

/* 计算目标尺寸;非法输入一律回退为原尺寸 */
function computeTargetSize(origW, origH, mode, w, h, keepRatio) {
  origW = Math.round(origW) || 0;
  origH = Math.round(origH) || 0;
  w = Math.max(0, Math.round(w) || 0);
  h = Math.max(0, Math.round(h) || 0);
  var out = { w: origW, h: origH };
  if (origW <= 0 || origH <= 0) return out;
  if (mode === 'width' && w > 0) {
    out = { w: w, h: Math.max(1, Math.round(origH * w / origW)) };
  } else if (mode === 'height' && h > 0) {
    out = { w: Math.max(1, Math.round(origW * h / origH)), h: h };
  } else if (mode === 'custom') {
    if (w > 0 && h > 0) {
      out = { w: w, h: h };
    } else if (w > 0 && keepRatio) {
      out = { w: w, h: Math.max(1, Math.round(origH * w / origW)) };
    } else if (h > 0 && keepRatio) {
      out = { w: Math.max(1, Math.round(origW * h / origH)), h: h };
    }
  }
  out.w = Math.min(out.w, 16000);
  out.h = Math.min(out.h, 16000);
  return out;
}

/* 压缩率文字:新大小相对原大小的变化,正数=变小 */
function compressionText(origSize, newSize) {
  if (!origSize || !newSize) return '-';
  var ratio = (1 - newSize / origSize) * 100;
  var sign = ratio >= 0 ? '↓' : '↑';
  return sign + ' ' + Math.abs(ratio).toFixed(1) + '%';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* 手动编码 32 位 BMP(自上而下,BGRA);浏览器 canvas 普遍不支持 BMP 输出编码,
   手动编码保证各浏览器都能真正输出 BMP */
function encodeBMPBuffer(imgData) {
  var w = imgData.width | 0, h = imgData.height | 0;
  var px = imgData.data;
  if (w <= 0 || h <= 0 || !px || px.length < w * h * 4) throw new Error('图像数据无效');
  var headerSize = 54; /* 14 文件头 + 40 信息头 */
  var pixelBytes = w * h * 4;
  var buf = new ArrayBuffer(headerSize + pixelBytes);
  var dv = new DataView(buf);
  dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);       /* 'BM' */
  dv.setUint32(2, headerSize + pixelBytes, true);    /* 文件总大小 */
  dv.setUint32(10, headerSize, true);                /* 像素数据偏移 */
  dv.setUint32(14, 40, true);                        /* 信息头长度 */
  dv.setInt32(18, w, true);                          /* 宽 */
  dv.setInt32(22, -h, true);                         /* 高(负数=自上而下,免翻转) */
  dv.setUint16(26, 1, true);                         /* planes */
  dv.setUint16(28, 32, true);                        /* 32 位色深,无需行填充 */
  dv.setUint32(30, 0, true);                         /* BI_RGB 无压缩 */
  dv.setUint32(34, pixelBytes, true);                 /* 像素数据大小 */
  dv.setInt32(38, 2835, true);                       /* 水平分辨率 */
  dv.setInt32(42, 2835, true);                       /* 垂直分辨率 */
  var u8 = new Uint8Array(buf);
  var o = headerSize;
  for (var i = 0; i < pixelBytes; i += 4) {
    u8[o++] = px[i + 2];  /* B */
    u8[o++] = px[i + 1];  /* G */
    u8[o++] = px[i];      /* R */
    u8[o++] = px[i + 3];  /* A */
  }
  return u8;
}

/* ============ 状态(仅浏览器中使用) ============ */
var items = [];          /* 转换任务列表 */
var uidSeed = 0;
var settings = {
  fmt: 'jpeg',
  quality: 85,
  sizeMode: 'orig',
  width: 0,
  height: 0,
  keepRatio: true
};
var STATUS_TEXT = { wait: '待转换', doing: '转换中…', done: '已完成', fail: '失败', cancelled: '已取消' };

/* ============ DOM 工具 ============ */
function $(id) { return document.getElementById(id); }

var toastTimer = null;
function toast(msg) {
  var el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
}

function showTip(html) {
  var el = $('uploadTip');
  el.innerHTML = html;
  el.hidden = false;
}
function hideTip() { $('uploadTip').hidden = true; }

/* ============ 文件管理 ============ */
function addFiles(fileList) {
  var files = [];
  for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
  var heicNames = [];
  var badNames = [];
  var dupNames = [];
  var added = 0;
  var existKeys = {};
  items.forEach(function (it) { existKeys[fileKey(it.file)] = 1; });
  files.forEach(function (f) {
    if (isHeicFile(f)) { heicNames.push(f.name); return; }
    var ft = (f.type || '').toLowerCase();
    var isImg = ft.indexOf('image/') === 0 ||
      /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|tiff?)$/i.test(f.name || '');
    if (!isImg) { badNames.push(f.name || '未命名文件'); return; }
    if (existKeys[fileKey(f)]) { dupNames.push(f.name || '未命名文件'); return; }
    existKeys[fileKey(f)] = 1;
    items.push({
      id: 'f' + (++uidSeed),
      file: f,
      name: f.name || '未命名图片',
      origSize: f.size,
      origType: (f.type || ('image/' + getExt(f.name))).toLowerCase(),
      thumbUrl: (window.URL || window.webkitURL).createObjectURL(f),
      status: 'wait',
      failMsg: '',
      imgW: 0, imgH: 0,
      outBlob: null, outUrl: '', outName: '', outSize: 0, outW: 0, outH: 0
    });
    added++;
  });
  var tips = [];
  if (heicNames.length) {
    tips.push(heicSkipTip(heicNames));
  }
  if (badNames.length) {
    tips.push('⚠️ 以下 ' + badNames.length + ' 个文件不是图片格式，已跳过：<br>' +
      escapeHtml(badNames.join('、')) + '<br>图片模式请选择图片文件。');
  }
  if (dupNames.length) {
    tips.push('ℹ️ 以下 ' + dupNames.length + ' 个文件已经添加，不再重复添加：<br>' +
      escapeHtml(dupNames.join('、')));
  }
  if (tips.length) { showTip(tips.join('<br><br>')); } else { hideTip(); }
  if (added) toast('已添加 ' + added + ' 张图片');
  else if (dupNames.length && !badNames.length && !heicNames.length) toast('该文件已经添加。');
  render();
}

function removeItem(id) {
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === id) {
      revokeItem(items[i]);
      items.splice(i, 1);
      break;
    }
  }
  render();
}

function revokeItem(it) {
  try {
    if (it.thumbUrl) (window.URL || window.webkitURL).revokeObjectURL(it.thumbUrl);
    if (it.outUrl) (window.URL || window.webkitURL).revokeObjectURL(it.outUrl);
  } catch (e) {}
}

function clearList() {
  items.forEach(revokeItem);
  items = [];
  hideTip();
  render();
}

/* ============ 转换 ============ */
function loadImage(it, cb) {
  var img = new Image();
  img.onload = function () {
    it.imgW = img.naturalWidth || img.width;
    it.imgH = img.naturalHeight || img.height;
    cb(null, img);
  };
  img.onerror = function () { cb(new Error('图片解码失败，格式可能不受支持')); };
  img.src = it.thumbUrl;
}

function finishConvert(it, blob, fmt, t) {
  if (it.outUrl) { try { (window.URL || window.webkitURL).revokeObjectURL(it.outUrl); } catch (e) {} }
  it.outBlob = blob;
  it.outUrl = (window.URL || window.webkitURL).createObjectURL(blob);
  it.outName = buildFileName(it.name, fmt);
  it.outSize = blob.size;
  it.outW = t.w;
  it.outH = t.h;
  it.status = 'done';
}

function failConvert(it, msg, done) {
  it.status = 'fail';
  it.failMsg = msg;
  render();
  done();
}

function convertItem(it, done) {
  it.status = 'doing';
  it.failMsg = '';
  render();
  loadImage(it, function (err, img) {
    if (err) { failConvert(it, err.message, done); return; }
    var t = computeTargetSize(it.imgW, it.imgH, settings.sizeMode,
      settings.width, settings.height, settings.keepRatio);
    var canvas = document.createElement('canvas');
    canvas.width = t.w;
    canvas.height = t.h;
    var ctx = canvas.getContext('2d');
    /* JPEG/BMP 不支持透明,先铺白底避免黑底 */
    if (settings.fmt === 'jpeg' || settings.fmt === 'bmp') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, t.w, t.h);
    }
    ctx.drawImage(img, 0, 0, t.w, t.h);
    /* BMP:浏览器 canvas 普遍不支持 BMP 编码,改用手动编码,保证各浏览器可用 */
    if (settings.fmt === 'bmp') {
      /* P1:BMP 手动编码峰值约 12 字节/像素;超限则提示(用户若选了缩小输出则目标尺寸已变小,可继续) */
      if (t.w * t.h > MAX_IMAGE_PIXELS) {
        failConvert(it, '图片分辨率过高，浏览器转换可能占用大量内存。请先缩小图片尺寸。', done);
        return;
      }
      try {
        var imgData = ctx.getImageData(0, 0, t.w, t.h);
        var bmpBlob = new Blob([encodeBMPBuffer(imgData)], { type: 'image/bmp' });
        /* 显式释放中间大对象引用 */
        imgData = null;
        finishConvert(it, bmpBlob, 'bmp', t);
      } catch (e) {
        failConvert(it, '转换出错：' + e.message, done);
        return;
      }
      render();
      done();
      return;
    }
    var mime = MIME_OF[settings.fmt];
    var q = LOSSY[settings.fmt] ? settings.quality / 100 : undefined;
    try {
      canvas.toBlob(function (blob) {
        if (!blob) {
          failConvert(it, '该浏览器不支持输出 ' + settings.fmt.toUpperCase() + ' 格式', done);
        } else if (blob.type && blob.type !== mime) {
          /* 按规范:不支持的编码会静默回退为 PNG;此时明确报错,绝不给出名不副实的文件 */
          failConvert(it, '该浏览器不支持输出 ' + settings.fmt.toUpperCase() + ' 格式', done);
        } else {
          finishConvert(it, blob, settings.fmt, t);
          render();
          done();
        }
      }, mime, q);
    } catch (e) {
      failConvert(it, '转换出错：' + e.message, done);
    }
  });
}

var imgBatch = null; /* {done,total} 图片批量进度,供统计显示 */
function convertAll() {
  if (items.some(function (it) { return it.status === 'doing'; })) return; /* 转换中,防重复启动 */
  var queue = items.filter(function (it) { return it.status !== 'doing'; });
  if (!queue.length) { toast('没有可转换的图片'); return; }
  imgBatch = { done: 0, total: queue.length };
  render();
  var i = 0;
  (function next() {
    if (i >= queue.length) {
      imgBatch = null;
      toast('全部转换完成');
      render();
      return;
    }
    var cur = queue[i++];
    convertItem(cur, function () {
      if (imgBatch) imgBatch.done++;
      next();
    });
  })();
}

/* ============ 下载 ============ */
function downloadBlob(blob, filename) {
  var url = (window.URL || window.webkitURL).createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    document.body.removeChild(a);
    (window.URL || window.webkitURL).revokeObjectURL(url);
  }, 800);
}

function downloadItem(it) {
  if (it.status === 'done' && it.outBlob) downloadBlob(it.outBlob, it.outName);
}

/* P1:ZIP 按需加载;加载失败则回退逐个下载,单个下载不受影响 */
var jszipPromise = null;
function ensureJSZip() {
  if (typeof JSZip !== 'undefined') return Promise.resolve();
  if (!jszipPromise) {
    jszipPromise = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = function () { res(); };
      s.onerror = function () { jszipPromise = null; rej(new Error('ZIP 组件加载失败')); };
      document.head.appendChild(s);
    });
  }
  return jszipPromise;
}

function downloadAllZip() {
  var doneItems = items.filter(function (it) { return it.status === 'done' && it.outBlob; });
  if (!doneItems.length) { toast('还没有转换完成的图片'); return; }
  toast('正在准备打包…');
  ensureJSZip().then(function () {
    if (typeof JSZip === 'undefined') throw new Error('ZIP 组件加载失败');
    var zip = new JSZip();
    doneItems.forEach(function (it) { zip.file(it.outName, it.outBlob); });
    return zip.generateAsync({ type: 'blob' });
  }).then(function (content) {
    downloadBlob(content, 'converted-images.zip');
  }, function () {
    toast('ZIP 组件加载失败，已改为逐个下载（共 ' + doneItems.length + ' 张）');
    doneItems.forEach(function (it, i) {
      setTimeout(function () { downloadItem(it); }, i * 700);
    });
  });
}

/* ============ 对比预览 ============ */
function openCompare(id) {
  var it = null;
  for (var i = 0; i < items.length; i++) if (items[i].id === id) it = items[i];
  if (!it || it.status !== 'done') return;
  $('modalTitle').textContent = '原图 / 结果对比';
  $('modalOrig').src = it.thumbUrl;
  $('modalNew').src = it.outUrl;
  $('modalOrigInfo').textContent = '（' + formatBytes(it.origSize) + '）';
  $('modalNewInfo').textContent = '（' + formatBytes(it.outSize) + '，' +
    compressionText(it.origSize, it.outSize) + '）';
  $('modal').hidden = false;
}
function closeCompare() { $('modal').hidden = true; }

/* ============ 渲染 ============ */
function render() {
  var list = $('fileList');
  if (!items.length) $('emptyState').textContent = '还没有图片，快去添加吧 👆';
  $('emptyState').style.display = items.length ? 'none' : 'block';
  var html = '';
  items.forEach(function (it) {
    html += '<li class="file-item" data-id="' + it.id + '">';
    html += '<img class="thumb" src="' + it.thumbUrl + '" alt="">';
    html += '<div class="file-info">';
    html += '<div class="file-name">' + escapeHtml(it.name) +
      '<span class="status ' + it.status + '">' + STATUS_TEXT[it.status] + '</span></div>';
    html += '<div class="file-meta">原格式：' + escapeHtml(getExt(it.name).toUpperCase() || it.origType) +
      ' · 原大小：' + formatBytes(it.origSize) + '</div>';
    html += '<div class="file-result">';
    if (it.status === 'done') {
      html += '<span class="ok">' + formatBytes(it.origSize) + ' → ' + formatBytes(it.outSize) +
        '（' + compressionText(it.origSize, it.outSize) + '）</span>';
    } else if (it.status === 'fail') {
      html += '<span class="bad">' + escapeHtml(it.failMsg || '转换失败') + '</span>';
    }
    html += '</div></div>';
    html += '<div class="item-btns">';
    if (it.status === 'wait' || it.status === 'fail') {
      html += '<button class="btn" data-act="convert">转换</button>';
    }
    if (it.status === 'done') {
      html += '<button class="btn" data-act="download">下载</button>';
      html += '<button class="btn" data-act="compare">对比</button>';
    }
    html += '<button class="btn danger" data-act="remove">移除</button>';
    html += '</div></li>';
  });
  list.innerHTML = html;

  var hasItems = items.length > 0;
  var hasDone = items.some(function (it) { return it.status === 'done'; });
  var converting = items.some(function (it) { return it.status === 'doing'; });
  /* P1:转换中禁用"全部转换"并显示状态,防重复启动 */
  $('btnConvertAll').disabled = !hasItems || converting;
  $('btnConvertAll').textContent = converting ? '转换中…' : '⚡ 全部转换';
  $('btnZip').disabled = !hasDone;
  $('btnClear').disabled = !hasItems;
  $('btnCancelVideo').hidden = true; /* 取消按钮只属于视频模式 */
  /* P1:统一任务统计 */
  $('countLabel').textContent = hasItems ? imageCountText() : '';
}

/* P1:图片任务统计:共 X 张 · 已完成 X · 失败 X[ · 正在处理 X/Y] */
function imageCountText() {
  var done = 0, fail = 0;
  items.forEach(function (it) {
    if (it.status === 'done') done++;
    else if (it.status === 'fail') fail++;
  });
  var t = '共 ' + items.length + ' 张 · 已完成 ' + done + ' · 失败 ' + fail;
  if (imgBatch) t += ' · 正在处理 ' + Math.min(imgBatch.done + 1, imgBatch.total) + ' / ' + imgBatch.total;
  return t;
}

/* 列表内按钮事件委托 */
function bindListEvents() {
  $('fileList').addEventListener('click', function (e) {
    var btn = e.target;
    if (btn.tagName !== 'BUTTON') return;
    var li = btn;
    while (li && li.tagName !== 'LI') li = li.parentNode;
    if (!li) return;
    var id = li.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    var it = null;
    for (var i = 0; i < items.length; i++) if (items[i].id === id) it = items[i];
    if (!it) return;
    if (act === 'remove') removeItem(id);
    else if (act === 'download') downloadItem(it);
    else if (act === 'compare') openCompare(id);
    else if (act === 'convert') convertItem(it, function () {});
  });
}

/* 检测浏览器 canvas 是否支持某种输出编码(同步) */
function canvasEncodeSupported(mime) {
  try {
    var c = document.createElement('canvas');
    c.width = 2; c.height = 2;
    return c.toDataURL(mime).indexOf('data:' + mime) === 0;
  } catch (e) { return false; }
}

/* ============ UI 绑定 ============ */
function refreshQualityRow() {
  $('qualityRow').style.display = LOSSY[settings.fmt] ? '' : 'none';
}

function bindUI() {
  var dz = $('dropzone'), fi = $('fileInput');

  dz.addEventListener('click', function () { fi.click(); });
  dz.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); }
  });
  fi.addEventListener('change', function () {
    if (fi.files.length) (mode === 'video' ? addVideoFiles : addFiles)(fi.files);
    fi.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
  });
  dz.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) {
      (mode === 'video' ? addVideoFiles : addFiles)(e.dataTransfer.files);
    }
  });

  document.addEventListener('paste', function (e) {
    if (mode === 'video') return; /* 视频模式不支持粘贴添加 */
    var cd = e.clipboardData;
    if (!cd || !cd.items) return;
    var imgs = [];
    for (var i = 0; i < cd.items.length; i++) {
      var item = cd.items[i];
      if (item.kind === 'file' && item.type.indexOf('image/') === 0) {
        var f = item.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  });

  /* 输出格式 */
  var fmtBtns = $('fmtBtns').getElementsByClassName('fmt-btn');
  for (var i = 0; i < fmtBtns.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        for (var j = 0; j < fmtBtns.length; j++) fmtBtns[j].classList.remove('active');
        btn.classList.add('active');
        settings.fmt = btn.getAttribute('data-fmt');
        refreshQualityRow();
      });
    })(fmtBtns[i]);
  }
  /* 不支持的输出编码直接隐藏按钮,避免用户选到名不副实的格式(BMP 走手动编码,始终可用) */
  if (!canvasEncodeSupported('image/webp')) { $('webpBtn').hidden = true; }
  if (canvasEncodeSupported('image/avif')) { $('avifBtn').hidden = false; }

  /* 质量 */
  $('quality').addEventListener('input', function () {
    settings.quality = parseInt($('quality').value, 10) || 85;
    $('qualityVal').textContent = settings.quality;
  });
  refreshQualityRow();

  /* 尺寸模式 */
  var radios = document.getElementsByName('sizeMode');
  for (var r = 0; r < radios.length; r++) {
    radios[r].addEventListener('change', function () {
      settings.sizeMode = this.value;
      var show = settings.sizeMode !== 'orig';
      $('sizeInputs').hidden = !show;
      $('inWidth').style.display = (settings.sizeMode === 'height') ? 'none' : '';
      $('inHeight').style.display = (settings.sizeMode === 'width') ? 'none' : '';
      document.querySelector('.times').style.display =
        (settings.sizeMode === 'custom') ? '' : 'none';
      $('ratioWrap').hidden = (settings.sizeMode !== 'custom');
    });
  }
  $('inWidth').addEventListener('input', function () {
    settings.width = parseInt($('inWidth').value, 10) || 0;
  });
  $('inHeight').addEventListener('input', function () {
    settings.height = parseInt($('inHeight').value, 10) || 0;
  });
  $('keepRatio').addEventListener('change', function () {
    settings.keepRatio = $('keepRatio').checked;
  });

  /* 批量操作(按模式分支) */
  $('btnConvertAll').addEventListener('click', function () {
    if (mode === 'video') convertAllVideos(); else convertAll();
  });
  $('btnCancelVideo').addEventListener('click', function () {
    if (mode === 'video') cancelVideoConvert();
  });
  var btnRetry = $('btnRetryEngine');
  if (btnRetry) {
    btnRetry.addEventListener('click', function () {
      if (mode === 'video') retryVideoEngine();
    });
  }
  $('btnZip').addEventListener('click', function () {
    if (mode === 'video') downloadAllZipVideos(); else downloadAllZip();
  });
  $('btnClear').addEventListener('click', function () {
    if (mode === 'video') {
      if (vitems.length && confirm('确定清空全部 ' + vitems.length + ' 个视频吗？')) clearVideos();
    } else {
      if (items.length && confirm('确定清空全部 ' + items.length + ' 张图片吗？')) clearList();
    }
  });

  /* 弹窗 */
  $('modalClose').addEventListener('click', closeCompare);
  $('modal').addEventListener('click', function (e) {
    if (e.target === $('modal')) closeCompare();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('modal').hidden) closeCompare();
  });

  bindVideoUI(); /* V2:模式切换与视频设置绑定 */
  bindListEvents();
  render();
}

/* 浏览器环境才初始化;node 下可直接 require/测试纯函数 */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindUI(); initMode(); });
  } else {
    bindUI();
    initMode();
  }
}

/* ============ V2: 视频模式(增量追加,图片逻辑保持原样) ============ */

var mode = 'image'; /* 'image' | 'video' */
var vitems = [];    /* 视频任务列表,与图片 items 完全独立 */
var vsettings = {
  fmt: 'mp4',
  quality: 'balanced', /* small | balanced | high */
  sizeMode: 'orig',    /* orig | 1080p | 720p | 480p | custom */
  width: 0,
  height: 0,
  keepRatio: true,
  fps: 'keep',         /* keep | 24 | 30 | 60 */
  audio: 'keep'        /* keep | mute */
};
var VEXT_OF = { mp4: 'mp4', webm: 'webm', mov: 'mov', mkv: 'mkv' };
var VMIME_OF = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska' };
var VCRF = {
  small: { x264: 28, vp9: 38 },
  balanced: { x264: 23, vp9: 32 },
  high: { x264: 18, vp9: 24 }
};
var VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', '3gp', 'flv', 'wmv'];

/* ---- 集中定义的限制常量(方便未来调整) ----
   WASM/Worker 内存模型:输入 ArrayBuffer(主线程)→ transfer 给 Worker(零拷贝)
   → FFmpeg writeFile 拷入 MEMFS(1x 文件大小,wasm 堆内)
   → 解码帧缓冲 + 编码 + 输出文件(MEMFS 内)
   单线程 wasm32 地址空间上限 4GB,实测大文件在 2x 文件大小附近即吃紧;
   移动端 Safari 单标签页内存更低,故按"文件大小 2x + 编解码缓冲 < 地址空间"取保守值 */
var MAX_VIDEO_FILE_SIZE = 2 * 1024 * 1024 * 1024;  /* 2GB:超过则阻止转换 */
var WARN_VIDEO_FILE_SIZE = 200 * 1024 * 1024;     /* 200MB:超过则提示内存占用 */
/* 图片:BMP 走手动 getImageData+逐像素拷贝,峰值约 12 字节/像素(canvas+ImageData+输出缓冲);
   16MP(4096×4096)峰值约 192MB,桌面与主流移动端可承受;24MP+ 在移动端易崩溃 */
var MAX_IMAGE_PIXELS = 16 * 1024 * 1024;          /* 16MP:仅限制 BMP 手动编码路径的目标尺寸 */
var THUMB_CONCURRENCY = 2;                        /* 视频缩略图最大并发数 */

/* ---- 纯函数(可在 node 下测试) ---- */

function isVideoFile(file) {
  var ext = getExt(file && file.name);
  var type = (file && file.type || '').toLowerCase();
  if (type.indexOf('video/') === 0) return true;
  return VIDEO_EXTS.indexOf(ext) >= 0;
}

function isImageFile(file) {
  var type = (file && file.type || '').toLowerCase();
  if (type.indexOf('image/') === 0) return true;
  var ext = getExt(file && file.name);
  return ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'gif'].indexOf(ext) >= 0;
}

function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return h > 0 ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
}

function even2(n) {
  n = Math.round(n) || 0;
  return n - (n % 2);
}

/* 视频目标尺寸:一律取偶数(编码器要求);非法输入回退原尺寸 */
function computeVideoSize(srcW, srcH, sizeMode, w, h, keepRatio) {
  srcW = Math.round(srcW) || 0;
  srcH = Math.round(srcH) || 0;
  var out = { w: even2(srcW), h: even2(srcH) };
  if (srcW <= 0 || srcH <= 0) return out;
  function fitH(targetH) {
    return { w: even2(srcW * targetH / srcH), h: even2(targetH) };
  }
  if (sizeMode === '1080p') out = fitH(1080);
  else if (sizeMode === '720p') out = fitH(720);
  else if (sizeMode === '480p') out = fitH(480);
  else if (sizeMode === 'custom') {
    var t = computeTargetSize(srcW, srcH, 'custom', w, h, keepRatio);
    out = { w: even2(t.w), h: even2(t.h) };
  }
  out.w = Math.max(2, Math.min(out.w, 7680));
  out.h = Math.max(2, Math.min(out.h, 7680));
  return out;
}

/* 组装 FFmpeg 参数;返回 argv 数组(不含可执行文件名) */
function buildFfmpegArgs(o) {
  var a = ['-y', '-i', o.inName];
  var vf = [];
  if (o.fps && o.fps !== 'keep') vf.push('fps=' + o.fps);
  if (o.w > 0 && o.h > 0) vf.push('scale=' + o.w + ':' + o.h);
  var isVp9 = o.outFmt === 'webm';
  if (isVp9) {
    /* 注意:此单线程 wasm 版 libvpx 的帧间预测路径会崩溃或停滞(wasm OOB,第 2 帧起),
       2026-09-29 实测:正常 GOP 下 10 秒 640×360 视频 10 分钟无法完成;
       已实测 -g 1(全关键帧)可稳定编码;文件会比帧间编码大,但保证可用 */
    a.push('-c:v', 'libvpx-vp9', '-b:v', '0',
      '-crf', String((VCRF[o.quality] || VCRF.balanced).vp9), '-cpu-used', '2', '-g', '1');
  } else {
    a.push('-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', String((VCRF[o.quality] || VCRF.balanced).x264), '-pix_fmt', 'yuv420p');
  }
  if (vf.length) a.push('-vf', vf.join(','));
  if (o.outFmt === 'mp4') a.push('-movflags', '+faststart');
  if (o.audio === 'mute') a.push('-an');
  else a.push('-c:a', isVp9 ? 'libopus' : 'aac');
  a.push(o.outName);
  return a;
}

/* 视频结果大小文字:变小才显示百分比,变大只显示前后大小(不说"节省") */
function videoSizeText(origSize, newSize) {
  var t = formatBytes(origSize) + ' → ' + formatBytes(newSize);
  if (origSize && newSize && newSize < origSize) {
    t += '（↓ ' + ((1 - newSize / origSize) * 100).toFixed(1) + '%）';
  }
  return t;
}

/* ---- 视频错误分类(纯函数):技术细节写 console,UI 只显示简单中文 ---- */
var VERR_TEXT = {
  read: '文件读取失败，请重试',
  demux: '无法解析该视频，输入格式可能不受支持',
  enc: '编码器不支持，请换个输出格式试试',
  mux: '输出的视频文件校验失败，请换个输出格式试试',
  worker: '视频引擎异常，请重试',
  exec: '视频处理失败，请重试',
  mem: '内存不足，转换失败。请用更小的文件或降低输出尺寸后重试',
  cancel: '已取消',
  nowasm: '当前浏览器暂不支持视频转换。请升级浏览器后重试。'
};

function classifyVideoError(e) {
  var msg = String((e && e.message) || '');
  if (msg === '__cancelled__') return 'cancel';
  if (e && e.code && VERR_TEXT[e.code]) return e.code;
  if (/cannot allocate memory|out of memory|allocation failed|memory access out of bounds/i.test(msg)) return 'mem';
  if (/unknown encoder|encoder .*not found|codec not supported/i.test(msg)) return 'enc';
  if (/invalid data|could not find codec parameters|moov atom not found|demuxer|partial file/i.test(msg)) return 'demux';
  if (/muxer|not a valid|校验失败/i.test(msg)) return 'mux';
  if (/文件读取失败/i.test(msg)) return 'read';
  if (/WebAssembly/i.test(msg)) return 'nowasm';
  if (/Worker/i.test(msg)) return 'worker';
  return 'exec';
}

function videoErrorText(e) {
  var code = classifyVideoError(e);
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[视频转换][' + code + ']', (e && e.message) || e);
  }
  return VERR_TEXT[code] || VERR_TEXT.exec;
}

/* ---- 输出容器真实性检查(纯函数):不只看扩展名,验魔数 ----
   MP4/MOV: 以 ftyp box 开头; WebM/MKV: EBML 头(0x1A45DFA3)+DocType(webm/matroska) */
function verifyVideoOutput(buf, fmt) {
  if (!buf || buf.byteLength <= 0) return '输出文件为空';
  var u8 = new Uint8Array(buf);
  function ascii(o, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(u8[o + i] || 0);
    return s;
  }
  var label = String(fmt || '').toUpperCase();
  if (fmt === 'mp4' || fmt === 'mov') {
    var ok = ascii(4, 4) === 'ftyp';
    if (!ok) {
      /* 宽容:前 32 字节内找 ftyp */
      for (var i = 0; i + 4 <= Math.min(32, u8.length); i++) {
        if (ascii(i, 4) === 'ftyp') { ok = true; break; }
      }
    }
    if (!ok) return '输出文件不是有效的 ' + label + ' 容器';
  } else if (fmt === 'webm' || fmt === 'mkv') {
    if (u8.length < 4 || u8[0] !== 0x1A || u8[1] !== 0x45 || u8[2] !== 0xDF || u8[3] !== 0xA3) {
      return '输出文件不是有效的 ' + label + ' 容器';
    }
    var head = '';
    var n = Math.min(u8.length, 4096);
    for (var j = 0; j < n; j++) head += String.fromCharCode(u8[j]);
    var want = fmt === 'webm' ? 'webm' : 'matroska';
    if (head.indexOf(want) < 0) return '输出文件不是有效的 ' + label + ' 容器';
  } else {
    return '不支持的输出格式:' + label;
  }
  return null; /* 通过 */
}

/* ---- 视频引擎(FFmpeg.wasm,懒加载,只在视频模式初始化) ---- */

/* worker 脚本版本: 修改 ffmpeg-worker.js 后务必同步 bump,让浏览器丢弃旧缓存 worker */
var FFMPEG_WORKER_VER = 'v20260929o';
var ffmpegWorker = null;
var ffmpegReady = false;
var ffmpegFailed = false;
var engineWaiters = [];
var msgSeq = 0;
var pendingCalls = {};
var videoBatchToken = 0; /* 批量转换令牌;取消时递增,让旧队列停止推进 */

function setEngineStatus(cls, text) {
  var el = $('engineStatus');
  if (!el) return;
  el.className = 'engine-status' + (cls ? ' ' + cls : '');
  el.textContent = text;
}

function flushEngineWaiters(err) {
  var ws = engineWaiters;
  engineWaiters = [];
  ws.forEach(function (cb) { try { cb(err); } catch (e) {} });
}

function ensureVideoEngine() {
  if (ffmpegReady || ffmpegWorker || typeof window === 'undefined') return;
  if (typeof WebAssembly === 'undefined') {
    ffmpegFailed = true;
    setEngineStatus('err', '当前浏览器暂不支持视频转换。请升级浏览器后重试。');
    try { console.error('[VideoEngine] WebAssembly 不可用'); } catch (e) {}
    flushEngineWaiters(new Error('WebAssembly 不可用'));
    return;
  }
  setEngineStatus('loading', '视频引擎加载中（首次约需下载 30MB，请稍候）…');
  var workerUrl = 'ffmpeg-worker.js?' + FFMPEG_WORKER_VER;
  try { console.log('[VideoEngine] 创建 Worker: ' + workerUrl); } catch (e) {}
  var worker;
  try {
    worker = new Worker(workerUrl);
  } catch (e) {
    ffmpegFailed = true;
    setEngineStatus('err', '视频引擎加载失败');
    try {
      console.error('[VideoEngine] Worker 初始化错误: ' + workerUrl);
      console.error('[VideoEngine] 原始 exception:', e);
    } catch (ee) {}
    showEngineRetry();
    flushEngineWaiters(e);
    return;
  }
  ffmpegWorker = worker;
  var initId = 'init' + (++msgSeq);
  pendingCalls[initId] = {
    resolve: function () {
      ffmpegReady = true;
      ffmpegFailed = false;
      setEngineStatus('ok', '✓ 视频引擎就绪（本地转换，不上传）');
      hideEngineRetry();
      try { console.log('[VideoEngine] 初始化成功'); } catch (e) {}
      flushEngineWaiters(null);
    },
    reject: function (err) {
      ffmpegFailed = true;
      try { ffmpegWorker.terminate(); } catch (e) {}
      ffmpegWorker = null;
      delete pendingCalls[initId];
      setEngineStatus('err', '视频引擎加载失败');
      try {
        console.error('[VideoEngine] 初始化失败');
        console.error('[VideoEngine] 原始 exception:', err);
      } catch (ee) {}
      showEngineRetry();
      flushEngineWaiters(err);
    }
  };
  worker.onmessage = function (e) {
    var m = e.data || {};
    if (m.type === 'progress') {
      var p = pendingCalls[m.id];
      if (p && p.onProgress) { try { p.onProgress(m.progress); } catch (ee) {} }
      return;
    }
    var call = pendingCalls[m.id];
    if (!call) return;
    delete pendingCalls[m.id];
    if (m.type === 'error') {
      try { console.error('[VideoEngine] Worker 返回错误: ' + (m.message || '未知错误')); } catch (ee) {}
      call.reject(new Error(m.message || '未知错误'));
    }
    else if (m.type === 'ready') call.resolve();
    else if (m.type === 'done') call.resolve(m.data);
    else call.reject(new Error('未知响应:' + m.type));
  };
  worker.onerror = function (ev) {
    try {
      console.error('[VideoEngine] worker.onerror 触发');
      console.error('[VideoEngine] message: ' + ((ev && ev.message) || '(无)'));
      console.error('[VideoEngine] filename: ' + ((ev && ev.filename) || '(无)'));
      console.error('[VideoEngine] lineno: ' + ((ev && ev.lineno) || '(无)'));
      console.error('[VideoEngine] 原始 event:', ev);
    } catch (ee) {}
    var call = pendingCalls[initId];
    if (call) {
      delete pendingCalls[initId];
      call.reject(new Error((ev && ev.message) || 'Worker 出错'));
    }
  };
  worker.onmessageerror = function (ev) {
    try {
      console.error('[VideoEngine] worker.onmessageerror 触发(消息反序列化失败)');
      console.error('[VideoEngine] 原始 event:', ev);
    } catch (ee) {}
    var call = pendingCalls[initId];
    if (call) {
      delete pendingCalls[initId];
      call.reject(new Error('Worker 消息错误'));
    }
  };
  /* 60 秒超时保护 */
  var tid = setTimeout(function () {
    var call = pendingCalls[initId];
    if (call) {
      delete pendingCalls[initId];
      try { console.error('[VideoEngine] 加载超时(60s): ' + workerUrl); } catch (ee) {}
      call.reject(new Error('视频引擎加载超时，请检查网络后重试'));
    }
  }, 60000);
  var origResolve = pendingCalls[initId].resolve;
  var origReject = pendingCalls[initId].reject;
  pendingCalls[initId].resolve = function (v) { clearTimeout(tid); origResolve(v); };
  pendingCalls[initId].reject = function (e) { clearTimeout(tid); origReject(e); };
  try { console.log('[VideoEngine] 发送 init 命令'); } catch (e) {}
  worker.postMessage({ id: initId, cmd: 'init' });
}

/* 真正的 Retry:终止 Worker,清理状态,重新创建并初始化 */
function retryVideoEngine() {
  try { console.log('[VideoEngine] 用户点击重试,开始重建'); } catch (e) {}
  /* 1. terminate 当前 Worker */
  if (ffmpegWorker) {
    try { ffmpegWorker.terminate(); } catch (e) {}
    ffmpegWorker = null;
  }
  /* 2. 清理 pendingCalls */
  var calls = pendingCalls;
  pendingCalls = {};
  Object.keys(calls).forEach(function (id) {
    try { calls[id].reject(new Error('引擎重建,旧请求已取消')); } catch (e) {}
  });
  /* 3. 清理 engineWaiters */
  engineWaiters = [];
  /* 4-6. 重置状态 */
  ffmpegWorker = null;
  ffmpegReady = false;
  ffmpegFailed = false;
  hideEngineRetry();
  /* 7-8. 重新创建 Worker 并初始化 */
  ensureVideoEngine();
}

function showEngineRetry() {
  var btn = $('btnRetryEngine');
  if (btn) btn.hidden = false;
}

function hideEngineRetry() {
  var btn = $('btnRetryEngine');
  if (btn) btn.hidden = true;
}

function whenEngineReady(cb) {
  if (ffmpegReady) { cb(null); return; }
  if (ffmpegFailed) { cb(new Error('视频引擎不可用')); return; }
  engineWaiters.push(cb);
  ensureVideoEngine();
}

/* 单个视频转换;onProgress(progress: 0~1,可能为 NaN) */
function videoConvert(inputData, inputName, args, outputName, onProgress) {
  return new Promise(function (resolve, reject) {
    whenEngineReady(function (err) {
      if (err) { reject(err); return; }
      var id = 'cv' + (++msgSeq);
      pendingCalls[id] = {
        resolve: resolve,
        reject: reject,
        onProgress: onProgress
      };
      ffmpegWorker.postMessage({
        id: id, cmd: 'convert',
        inputName: inputName, inputData: inputData,
        args: args, outputName: outputName
      }, [inputData]);
    });
  });
}

/* ---- 视频文件管理 ---- */

function readVideoMeta(file) {
  return new Promise(function (resolve) {
    var url = (window.URL || window.webkitURL).createObjectURL(file);
    var v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    var timer = null;
    function done(meta) {
      if (timer) clearTimeout(timer);
      try { (window.URL || window.webkitURL).revokeObjectURL(url); } catch (e) {}
      resolve(meta);
    }
    timer = setTimeout(function () { done({ w: 0, h: 0, duration: 0 }); }, 10000);
    v.onloadedmetadata = function () {
      done({ w: v.videoWidth || 0, h: v.videoHeight || 0, duration: v.duration || 0 });
    };
    v.onerror = function () { done({ w: 0, h: 0, duration: 0 }); };
    v.src = url;
  });
}

function captureVideoThumb(file) {
  return new Promise(function (resolve) {
    var url = (window.URL || window.webkitURL).createObjectURL(file);
    var v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    var timer = setTimeout(function () { cleanup(); resolve(null); }, 12000);
    function cleanup() {
      clearTimeout(timer);
      try { (window.URL || window.webkitURL).revokeObjectURL(url); } catch (e) {}
    }
    v.onloadeddata = function () {
      try {
        var d = v.duration || 1;
        v.currentTime = Math.min(0.5, d / 3);
      } catch (e) { cleanup(); resolve(null); }
    };
    v.onseeked = function () {
      try {
        var w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) { cleanup(); resolve(null); return; }
        var tw = 144, th = Math.max(1, Math.round(tw * h / w));
        var c = document.createElement('canvas');
        c.width = tw; c.height = th;
        c.getContext('2d').drawImage(v, 0, 0, tw, th);
        var dataUrl = c.toDataURL('image/jpeg', 0.7);
        cleanup();
        resolve(dataUrl);
      } catch (e) { cleanup(); resolve(null); }
    };
    v.onerror = function () { cleanup(); resolve(null); };
    v.src = url;
  });
}

/* P1:缩略图任务队列,最多 THUMB_CONCURRENCY 个并发,避免大量添加时 CPU/内存峰值 */
var thumbQueue = [];
var thumbActive = 0;
function pumpThumbQueue() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    var task = thumbQueue.shift();
    thumbActive++;
    task().then(function () {
      thumbActive--;
      pumpThumbQueue();
    }, function () {
      thumbActive--;
      pumpThumbQueue();
    });
  }
}
function enqueueThumbTask(task) {
  thumbQueue.push(task);
  pumpThumbQueue();
}

/* 文件去重键:name+size+lastModified */
function fileKey(f) {
  return (f && f.name || '') + '|' + (f && f.size || 0) + '|' + (f && f.lastModified || 0);
}

function addVideoFiles(fileList) {
  var files = [];
  for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
  var badNames = [];
  var dupNames = [];
  var tooBigNames = [];
  var added = 0;
  var existKeys = {};
  vitems.forEach(function (it) { existKeys[fileKey(it.file)] = 1; });
  files.forEach(function (f) {
    if (!isVideoFile(f)) { badNames.push(f.name || '未命名文件'); return; }
    if (existKeys[fileKey(f)]) { dupNames.push(f.name || '未命名文件'); return; }
    /* 添加时即做大小保护:超过 2GB 直接阻止,不加入列表 */
    if (f.size > MAX_VIDEO_FILE_SIZE) { tooBigNames.push(f.name || '未命名文件'); return; }
    /* 超过 200MB 允许添加,但提示内存占用 */
    var warnBig = f.size > WARN_VIDEO_FILE_SIZE;
    existKeys[fileKey(f)] = 1;
    var it = {
      id: 'v' + (++uidSeed),
      file: f,
      name: f.name || '未命名视频',
      origSize: f.size,
      vfmt: vsettings.fmt,
      thumbUrl: null, /* 缩略图异步生成;失败则显示 🎬 */
      status: 'wait',
      failMsg: '',
      progress: 0,
      vw: 0, vh: 0, duration: 0,
      outBlob: null, outUrl: '', outName: '', outSize: 0, outW: 0, outH: 0,
      _lastProg: -1
    };
    vitems.push(it);
    added++;
    /* 元信息+缩略图走并发队列,不阻塞列表渲染;最终结果与之前一致 */
    (function (item, file) {
      enqueueThumbTask(function () {
        return readVideoMeta(file).then(function (meta) {
          item.vw = meta.w; item.vh = meta.h; item.duration = meta.duration;
          if (mode === 'video') renderVideos();
          return captureVideoThumb(file);
        }).then(function (dataUrl) {
          item.thumbUrl = dataUrl;
          if (mode === 'video') renderVideos();
        });
      });
    })(it, f);
  });
  var tips = [];
  if (badNames.length) {
    tips.push('⚠️ 以下 ' + badNames.length + ' 个文件不是视频格式，已跳过：<br>' +
      escapeHtml(badNames.join('、')) + '<br>视频模式请选择视频文件。');
  }
  if (dupNames.length) {
    tips.push('ℹ️ 以下 ' + dupNames.length + ' 个文件已经添加，不再重复添加：<br>' +
      escapeHtml(dupNames.join('、')));
  }
  if (tooBigNames.length) {
    tips.push('⚠️ 以下 ' + tooBigNames.length + ' 个文件过大，已跳过：<br>' +
      escapeHtml(tooBigNames.join('、')) + '<br>文件过大，浏览器本地转换可能需要大量内存。');
  }
  if (tips.length) { showTip(tips.join('<br><br>')); } else { hideTip(); }
  if (added) {
    toast('已添加 ' + added + ' 个视频');
    /* 大文件警告:添加成功但提示内存占用 */
    var warnItem = null;
    vitems.slice(-added).forEach(function (it) {
      if (!warnItem && it.file && it.file.size > WARN_VIDEO_FILE_SIZE) warnItem = it;
    });
    if (warnItem) {
      toast('⚠️ 文件较大（' + formatBytes(warnItem.file.size) + '），转换可能需要较多内存，请耐心等待');
    }
  }
  else if (dupNames.length && !badNames.length && !tooBigNames.length) toast('该文件已经添加。');
  renderVideos();
}

function revokeVideoItem(it) {
  try {
    if (it.outUrl) (window.URL || window.webkitURL).revokeObjectURL(it.outUrl);
  } catch (e) {}
}

function removeVideoItem(id) {
  for (var i = 0; i < vitems.length; i++) {
    if (vitems[i].id === id) {
      revokeVideoItem(vitems[i]);
      vitems.splice(i, 1);
      break;
    }
  }
  renderVideos();
}

function clearVideos() {
  vitems.forEach(revokeVideoItem);
  vitems = [];
  hideTip();
  /* 关闭 Worker:释放内存并清理 FFmpeg 虚拟文件系统;下次转换时重新加载 */
  if (ffmpegWorker) {
    try { ffmpegWorker.terminate(); } catch (e) {}
    ffmpegWorker = null;
  }
  ffmpegReady = false;
  ffmpegFailed = false;
  pendingCalls = {};
  engineWaiters = [];
  setEngineStatus('', '未加载（首次进入视频模式时加载）');
  renderVideos();
}

/* P0:取消当前视频转换(页面不刷新)
   1.立即终止 Worker(整个 wasm 实例销毁,MEMFS 随之释放,无残留)
   2.清理全部 pendingCalls(逐个 reject,不断链)
   3.当前 doing 项标记"已取消";其余待转换/已完成保留
   4.引擎回到"未加载",下次转换重新创建 Worker(绝不复用已 terminate 的实例) */
function cancelVideoConvert() {
  videoBatchToken++; /* 让批量队列的 next() 停止推进 */
  if (ffmpegWorker) {
    try { ffmpegWorker.terminate(); } catch (e) {}
    ffmpegWorker = null;
  }
  ffmpegReady = false;
  ffmpegFailed = false;
  var calls = pendingCalls;
  pendingCalls = {};
  Object.keys(calls).forEach(function (id) {
    try { calls[id].reject(new Error('__cancelled__')); } catch (e) {}
  });
  engineWaiters = [];
  vitems.forEach(function (it) {
    if (it.status === 'doing') {
      it.status = 'cancelled';
      it.failMsg = '';
      it.progress = 0;
    }
  });
  setEngineStatus('', '未加载（首次进入视频模式时加载）');
  renderVideos();
  toast('已取消转换');
}

/* ---- 视频转换 ---- */

function failVideoConvert(it, msg, done) {
  it.status = 'fail';
  it.failMsg = msg;
  it.progress = 0;
  renderVideos();
  done();
}

function finishVideoConvert(it, outBuf, fmt, t) {
  if (it.outUrl) {
    try { (window.URL || window.webkitURL).revokeObjectURL(it.outUrl); } catch (e) {}
  }
  var blob = new Blob([outBuf], { type: VMIME_OF[fmt] || 'video/mp4' });
  it.outBlob = blob;
  it.outUrl = (window.URL || window.webkitURL).createObjectURL(blob);
  /* 文件名同步生成:不等待异步,不依赖 FFmpeg,不依赖 metadata */
  it.outName = getOutputFilename(it.name, VEXT_OF[fmt] || fmt);
  it.outSize = blob.size;
  it.outW = t.w;
  it.outH = t.h;
  it.status = 'done';
  it.progress = 1;
  /* 开发者日志:下载失败时快速定位 */
  try {
    console.log('[VideoConverter] input: ' + it.name +
      ' | output: ' + it.outName +
      ' | inputSize: ' + it.origSize +
      ' | outputSize: ' + it.outSize +
      ' | outputUrl: ' + (it.outUrl ? 'created' : 'FAILED') +
      ' | outputName: ' + it.outName +
      ' | status: done');
  } catch (e) {}
}

function convertVideoItem(it, done) {
  done = done || function () {};
  if (it.status === 'doing') { done(); return; }
  /* P0:文件大小保护(转换前检查,此时才真正消耗内存) */
  var fsize = (it.file && it.file.size) || 0;
  if (fsize > MAX_VIDEO_FILE_SIZE) {
    failVideoConvert(it, '文件过大，浏览器本地转换可能需要大量内存。', done);
    return;
  }
  it.status = 'doing';
  it.failMsg = '';
  it.progress = 0;
  it._lastProg = -1;
  renderVideos();
  if (fsize > WARN_VIDEO_FILE_SIZE) {
    toast('文件较大（' + formatBytes(fsize) + '），转换可能需要较多内存，请耐心等待');
  }
  whenEngineReady(function (err) {
    if (err) {
      /* 取消:不标记失败,交给批量循环按 token 停止 */
      if (classifyVideoError(err) === 'cancel' || it.status === 'cancelled') {
        renderVideos();
        done();
        return;
      }
      failVideoConvert(it, videoErrorText(err), done);
      return;
    }
    var t = computeVideoSize(it.vw, it.vh, vsettings.sizeMode,
      vsettings.width, vsettings.height, vsettings.keepRatio);
    var fmt = it.vfmt || vsettings.fmt;
    var inName = 'in_' + it.id + '.' + (getExt(it.name) || 'mp4');
    var outName = 'out_' + it.id + '.' + (VEXT_OF[fmt] || fmt);
    var args = buildFfmpegArgs({
      inName: inName, outName: outName, outFmt: fmt,
      quality: vsettings.quality, w: t.w, h: t.h,
      fps: vsettings.fps, audio: vsettings.audio
    });
    var file = it.file;
    var getBuf = file.arrayBuffer ?
      file.arrayBuffer() :
      new Promise(function (res, rej) {
        var r = new FileReader();
        r.onload = function () { res(r.result); };
        r.onerror = function () { rej(new Error('文件读取失败')); };
        r.readAsArrayBuffer(file);
      });
    getBuf.then(function (ab) {
      /* transfer 给 Worker:主线程侧 ab 被剥离,内存所有权转移,不再双份占用 */
      return videoConvert(ab, inName, args, outName, function (p) {
        /* 真实 FFmpeg 进度;NaN(未知时长)时保持不确定状态 */
        if (typeof p === 'number' && isFinite(p)) {
          it.progress = Math.max(0, Math.min(1, p));
        }
        var shown = Math.floor(it.progress * 100);
        if (shown !== it._lastProg) {
          it._lastProg = shown;
          renderVideos();
        }
      });
    }).then(function (outBuf) {
      /* P0:输出真实性检查(魔数+DocType),不只看扩展名 */
      var vErr = verifyVideoOutput(outBuf, fmt);
      if (vErr) {
        var ve = new Error(vErr);
        ve.code = 'mux';
        throw ve;
      }
      finishVideoConvert(it, outBuf, fmt, t);
      outBuf = null; /* 显式断开引用,帮助 GC 及时回收输出缓冲 */
      renderVideos();
      done();
    }).catch(function (e) {
      if (classifyVideoError(e) === 'cancel' || it.status === 'cancelled') {
        renderVideos();
        done();
        return;
      }
      failVideoConvert(it, videoErrorText(e), done);
    });
  });
}

/* 串行批量转换:一次只跑一个 FFmpeg,避免移动端内存爆炸 */
var videoBatch = null; /* {done,total} 批量进度,供统计显示 */
function convertAllVideos() {
  if (vitems.some(function (it) { return it.status === 'doing'; })) return; /* 转换中,防重复启动 */
  var queue = vitems.filter(function (it) { return it.status !== 'doing'; });
  if (!queue.length) { toast('没有可转换的视频'); return; }
  whenEngineReady(function (err) {
    if (err) { toast(videoErrorText(err)); return; }
    var token = ++videoBatchToken;
    var i = 0;
    videoBatch = { done: 0, total: queue.length };
    renderVideos();
    (function next() {
      if (token !== videoBatchToken) { videoBatch = null; renderVideos(); return; } /* 已取消 */
      if (i >= queue.length) {
        videoBatch = null;
        toast('全部转换完成');
        renderVideos();
        return;
      }
      var cur = queue[i++];
      convertVideoItem(cur, function () {
        if (token === videoBatchToken && videoBatch) videoBatch.done++;
        next();
      });
    })();
  });
}

function downloadVideoItem(it) {
  if (it.status !== 'done' || !it.outBlob) return;
  /* 防御:确保 URL 和文件名有效;文件名缺失时同步生成,不阻塞下载 */
  var url = it.outUrl;
  if (!url) {
    try { url = (window.URL || window.webkitURL).createObjectURL(it.outBlob); it.outUrl = url; } catch (e) { return; }
  }
  var fname = it.outName;
  if (!fname) {
    fname = getOutputFilename(it.name, VEXT_OF[it.vfmt] || it.vfmt || 'mp4');
    it.outName = fname;
  }
  var a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadAllZipVideos() {
  var doneItems = vitems.filter(function (it) { return it.status === 'done' && it.outBlob; });
  if (!doneItems.length) { toast('还没有转换完成的视频'); return; }
  toast('正在准备打包…');
  ensureJSZip().then(function () {
    if (typeof JSZip === 'undefined') throw new Error('ZIP 组件加载失败');
    var zip = new JSZip();
    doneItems.forEach(function (it) { zip.file(it.outName, it.outBlob); });
    return zip.generateAsync({ type: 'blob' });
  }).then(function (content) {
    downloadBlob(content, 'converted-videos.zip');
  }, function () {
    toast('ZIP 组件加载失败，已改为逐个下载（共 ' + doneItems.length + ' 个）');
    doneItems.forEach(function (it, i) {
      setTimeout(function () { downloadVideoItem(it); }, i * 1200);
    });
  });
}

/* ---- 视频列表渲染 ---- */

function videoMetaLine(it) {
  var parts = [formatBytes(it.origSize)];
  if (it.vw > 0 && it.vh > 0) parts.push(it.vw + '×' + it.vh);
  if (it.duration > 0) parts.push(formatDuration(it.duration));
  return parts.join(' · ');
}

function renderVideos() {
  var list = $('fileList');
  $('emptyState').style.display = vitems.length ? 'none' : 'block';
  if (!vitems.length) $('emptyState').textContent = '还没有视频，快去添加吧 👆';
  var converting = vitems.some(function (it) { return it.status === 'doing'; });
  var html = '';
  vitems.forEach(function (it) {
    html += '<li class="file-item" data-id="' + it.id + '">';
    if (it.thumbUrl) {
      html += '<img class="thumb" src="' + it.thumbUrl + '" alt="">';
    } else {
      html += '<div class="vthumb" aria-hidden="true">🎬</div>';
    }
    html += '<div class="file-info">';
    html += '<div class="file-name">' + escapeHtml(it.name) +
      '<span class="status ' + it.status + '">' + STATUS_TEXT[it.status] + '</span></div>';
    html += '<div class="file-meta">' + escapeHtml(videoMetaLine(it)) + '</div>';
    html += '<div class="file-result">';
    if (it.status === 'doing') {
      var pct = Math.floor(it.progress * 100);
      html += '<div class="progress"><i style="width:' + pct + '%"></i></div>';
      html += '<div class="prog-text">' +
        (pct > 0 ? '转换中… ' + pct + '%' : '转换中…') + '</div>';
    } else if (it.status === 'done') {
      html += '<span class="ok">✓ 转换完成 · ' +
        escapeHtml(videoSizeText(it.origSize, it.outSize)) + '</span>';
      html += '<div class="file-meta">' +
        escapeHtml((it.vfmt || vsettings.fmt).toUpperCase()) +
        (it.outW > 0 ? ' · ' + it.outW + '×' + it.outH : '') + '</div>';
    } else if (it.status === 'fail') {
      html += '<span class="bad">' + escapeHtml(it.failMsg || '转换失败') + '</span>';
    }
    html += '</div></div>';
    html += '<div class="item-btns">';
    /* 批量转换中隐藏单项"转换"按钮:Worker 一次只处理一个,避免并发错乱 */
    if ((it.status === 'wait' || it.status === 'fail' || it.status === 'cancelled') && !converting) {
      html += '<select class="vfmt" data-id="' + it.id + '" aria-label="输出格式">' +
        '<option value="mp4"' + ((it.vfmt === 'mp4') ? ' selected' : '') + '>MP4</option>' +
        '<option value="webm"' + ((it.vfmt === 'webm') ? ' selected' : '') + '>WebM</option>' +
        '<option value="mov"' + ((it.vfmt === 'mov') ? ' selected' : '') + '>MOV</option>' +
        '<option value="mkv"' + ((it.vfmt === 'mkv') ? ' selected' : '') + '>MKV</option>' +
        '</select>';
      html += '<button class="btn" data-act="vconvert">转换</button>';
    }
    if (it.status === 'done') {
      html += '<button class="btn" data-act="vdownload">下载</button>';
    }
    html += '<button class="btn danger" data-act="vremove">移除</button>';
    html += '</div></li>';
  });
  list.innerHTML = html;

  var hasItems = vitems.length > 0;
  var hasDone = vitems.some(function (it) { return it.status === 'done'; });
  /* P1:转换中禁用"全部转换"并显示状态,防重复启动;转换中显示"取消转换" */
  $('btnConvertAll').disabled = !hasItems || converting;
  $('btnConvertAll').textContent = converting ? '转换中…' : '⚡ 全部转换';
  $('btnZip').disabled = !hasDone;
  $('btnClear').disabled = !hasItems;
  $('btnCancelVideo').hidden = !converting;
  /* P1:统一任务统计 */
  $('countLabel').textContent = hasItems ? videoCountText() : '';
}

/* P1:视频任务统计:共 X 个 · 已完成 X · 失败 X · 已取消 X[ · 正在处理 X/Y] */
function videoCountText() {
  var done = 0, fail = 0, cancelled = 0;
  vitems.forEach(function (it) {
    if (it.status === 'done') done++;
    else if (it.status === 'fail') fail++;
    else if (it.status === 'cancelled') cancelled++;
  });
  var t = '共 ' + vitems.length + ' 个 · 已完成 ' + done + ' · 失败 ' + fail + ' · 已取消 ' + cancelled;
  if (videoBatch) t += ' · 正在处理 ' + Math.min(videoBatch.done + 1, videoBatch.total) + ' / ' + videoBatch.total;
  return t;
}

function bindVideoListEvents() {
  $('fileList').addEventListener('click', function (e) {
    var btn = e.target;
    if (btn.tagName !== 'BUTTON') return;
    var li = btn;
    while (li && li.tagName !== 'LI') li = li.parentNode;
    if (!li) return;
    var id = li.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act !== 'vconvert' && act !== 'vdownload' && act !== 'vremove') return;
    var it = null;
    for (var i = 0; i < vitems.length; i++) if (vitems[i].id === id) it = vitems[i];
    if (!it) return;
    if (act === 'vremove') removeVideoItem(id);
    else if (act === 'vdownload') downloadVideoItem(it);
    else if (act === 'vconvert') convertVideoItem(it, function () {});
  });
  $('fileList').addEventListener('change', function (e) {
    var sel = e.target;
    if (!sel || sel.tagName !== 'SELECT' || sel.className !== 'vfmt') return;
    var id = sel.getAttribute('data-id');
    for (var i = 0; i < vitems.length; i++) {
      if (vitems[i].id === id) { vitems[i].vfmt = sel.value; break; }
    }
  });
}

/* ---- 模式切换 ---- */

function renderCurrent() {
  if (mode === 'video') renderVideos();
  else render();
}

function setMode(m) {
  if (m !== 'image' && m !== 'video') m = 'image';
  var tabs = $('modeTabs').getElementsByClassName('fmt-btn');
  for (var i = 0; i < tabs.length; i++) {
    var active = tabs[i].getAttribute('data-mode') === m;
    tabs[i].classList.toggle('active', active);
    tabs[i].setAttribute('aria-selected', active ? 'true' : 'false');
  }
  var changed = (mode !== m);
  mode = m;
  $('imgSettings').hidden = (m !== 'image');
  $('vidSettings').hidden = (m !== 'video');
  if (m === 'video') {
    $('dzIcon').textContent = '🎬';
    $('dzText').textContent = '点击选择视频，或拖拽到这里';
    $('dzHint').textContent = '支持多选 · MP4 / MOV / MKV / WebM / AVI';
    $('dropzone').setAttribute('aria-label', '选择视频');
    $('fileInput').accept = 'video/*,.mkv,.avi,.mov,.mp4,.webm,.m4v,.3gp';
    $('listTitle').textContent = '🎬 视频列表';
    ensureVideoEngine(); /* 懒加载:只有进入视频模式才下载 FFmpeg */
  } else {
    $('dzIcon').textContent = '📤';
    $('dzText').textContent = '点击选择图片，或拖拽到这里';
    $('dzHint').textContent = '支持多选 · 也可直接 Ctrl+V 粘贴截图';
    $('dropzone').setAttribute('aria-label', '选择图片');
    $('fileInput').accept = 'image/*';
    $('listTitle').textContent = '📋 图片列表';
  }
  hideTip();
  renderCurrent();
  return changed;
}

function bindVideoUI() {
  /* 模式切换 tabs */
  var tabs = $('modeTabs').getElementsByClassName('fmt-btn');
  for (var i = 0; i < tabs.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () { setMode(btn.getAttribute('data-mode')); });
    })(tabs[i]);
  }

  /* 视频输出格式 */
  var vfmtBtns = $('vfmtBtns').getElementsByClassName('fmt-btn');
  for (var f = 0; f < vfmtBtns.length; f++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        for (var j = 0; j < vfmtBtns.length; j++) vfmtBtns[j].classList.remove('active');
        btn.classList.add('active');
        vsettings.fmt = btn.getAttribute('data-fmt');
        /* 全局格式同步到所有待转换/失败可重试项(转换中与已完成的不动);单项下拉仍可单独覆盖 */
        for (var k = 0; k < vitems.length; k++) {
          if (vitems[k].status === 'wait' || vitems[k].status === 'fail') vitems[k].vfmt = vsettings.fmt;
        }
        renderVideos();
      });
    })(vfmtBtns[f]);
  }

  /* 视频质量 */
  var vqBtns = $('vqBtns').getElementsByClassName('fmt-btn');
  for (var q = 0; q < vqBtns.length; q++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        for (var j = 0; j < vqBtns.length; j++) vqBtns[j].classList.remove('active');
        btn.classList.add('active');
        vsettings.quality = btn.getAttribute('data-q');
      });
    })(vqBtns[q]);
  }

  /* 视频尺寸模式 */
  var vradios = document.getElementsByName('vsizeMode');
  for (var r = 0; r < vradios.length; r++) {
    vradios[r].addEventListener('change', function () {
      vsettings.sizeMode = this.value;
      $('vsizeInputs').hidden = (vsettings.sizeMode !== 'custom');
    });
  }
  $('vinWidth').addEventListener('input', function () {
    vsettings.width = parseInt($('vinWidth').value, 10) || 0;
  });
  $('vinHeight').addEventListener('input', function () {
    vsettings.height = parseInt($('vinHeight').value, 10) || 0;
  });
  $('vkeepRatio').addEventListener('change', function () {
    vsettings.keepRatio = $('vkeepRatio').checked;
  });

  /* 视频帧率 */
  var fradios = document.getElementsByName('vfps');
  for (var fr = 0; fr < fradios.length; fr++) {
    fradios[fr].addEventListener('change', function () {
      vsettings.fps = this.value;
    });
  }

  /* 视频音频 */
  var aradios = document.getElementsByName('vaudio');
  for (var ar = 0; ar < aradios.length; ar++) {
    aradios[ar].addEventListener('change', function () {
      vsettings.audio = this.value;
    });
  }

  bindVideoListEvents();
}

/* 初始模式:/video 入口、?mode=video、或 video 页跳转标记 */
function initMode() {
  var m = 'image';
  try {
    if (window.location.pathname.indexOf('/video') === 0) m = 'video';
    if (/[?&]mode=video\b/.test(window.location.search)) m = 'video';
    if (window.sessionStorage && window.sessionStorage.getItem('conv_mode') === 'video') {
      m = 'video';
      window.sessionStorage.removeItem('conv_mode');
    }
  } catch (e) {}
  if (m === 'video') setMode('video');
}

/* node 测试导出 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatBytes: formatBytes,
    getExt: getExt,
    baseName: baseName,
    buildFileName: buildFileName,
    isHeicFile: isHeicFile,
    computeTargetSize: computeTargetSize,
    compressionText: compressionText,
    escapeHtml: escapeHtml,
    encodeBMPBuffer: encodeBMPBuffer,
    MIME_OF: MIME_OF,
    EXT_OF: EXT_OF,
    LOSSY: LOSSY,
    /* V2 视频纯函数 */
    isVideoFile: isVideoFile,
    isImageFile: isImageFile,
    formatDuration: formatDuration,
    computeVideoSize: computeVideoSize,
    buildFfmpegArgs: buildFfmpegArgs,
    videoSizeText: videoSizeText,
    VEXT_OF: VEXT_OF,
    VCRF: VCRF,
    /* V2.1 新增纯函数 */
    classifyVideoError: classifyVideoError,
    verifyVideoOutput: verifyVideoOutput,
    fileKey: fileKey,
    heicSkipTip: heicSkipTip,
    VERR_TEXT: VERR_TEXT,
    MAX_VIDEO_FILE_SIZE: MAX_VIDEO_FILE_SIZE,
    WARN_VIDEO_FILE_SIZE: WARN_VIDEO_FILE_SIZE,
    MAX_IMAGE_PIXELS: MAX_IMAGE_PIXELS,
    THUMB_CONCURRENCY: THUMB_CONCURRENCY
  };
}
