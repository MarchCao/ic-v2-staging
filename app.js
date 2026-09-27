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

function isHeicFile(file) {
  var ext = getExt(file && file.name);
  var type = (file && file.type || '').toLowerCase();
  return ext === 'heic' || ext === 'heif' || type === 'image/heic' || type === 'image/heif';
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
var STATUS_TEXT = { wait: '待转换', doing: '转换中…', done: '已完成', fail: '失败' };

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
  var added = 0;
  files.forEach(function (f) {
    if (isHeicFile(f)) { heicNames.push(f.name); return; }
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
  if (heicNames.length) {
    showTip('⚠️ 以下 ' + heicNames.length + ' 个文件为 HEIC/HEIF 格式，浏览器无法直接读取，已跳过：<br>' +
      escapeHtml(heicNames.join('、')) + '<br>请先在手机相册中导出为 JPG 后再转换。');
  } else {
    hideTip();
  }
  if (added) toast('已添加 ' + added + ' 张图片');
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
      try {
        var imgData = ctx.getImageData(0, 0, t.w, t.h);
        var bmpBlob = new Blob([encodeBMPBuffer(imgData)], { type: 'image/bmp' });
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

function convertAll() {
  var queue = items.filter(function (it) { return it.status !== 'doing'; });
  if (!queue.length) { toast('没有可转换的图片'); return; }
  var i = 0;
  (function next() {
    if (i >= queue.length) { toast('全部转换完成'); return; }
    convertItem(queue[i++], next);
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

function downloadAllZip() {
  var doneItems = items.filter(function (it) { return it.status === 'done' && it.outBlob; });
  if (!doneItems.length) { toast('还没有转换完成的图片'); return; }
  if (typeof JSZip === 'undefined') {
    toast('ZIP 组件加载失败，已改为逐个下载（共 ' + doneItems.length + ' 张）');
    doneItems.forEach(function (it, i) {
      setTimeout(function () { downloadItem(it); }, i * 700);
    });
    return;
  }
  var zip = new JSZip();
  doneItems.forEach(function (it) { zip.file(it.outName, it.outBlob); });
  toast('正在打包…');
  zip.generateAsync({ type: 'blob' }).then(function (content) {
    downloadBlob(content, 'converted-images.zip');
  }, function () {
    toast('打包失败，请改用单张下载');
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
  $('btnConvertAll').disabled = !hasItems;
  $('btnZip').disabled = !hasDone;
  $('btnClear').disabled = !hasItems;
  $('countLabel').textContent = hasItems ? ('共 ' + items.length + ' 张') : '';
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
    if (fi.files.length) addFiles(fi.files);
    fi.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
  });
  dz.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', function (e) {
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

  /* 批量操作 */
  $('btnConvertAll').addEventListener('click', convertAll);
  $('btnZip').addEventListener('click', downloadAllZip);
  $('btnClear').addEventListener('click', function () {
    if (items.length && confirm('确定清空全部 ' + items.length + ' 张图片吗？')) clearList();
  });

  /* 弹窗 */
  $('modalClose').addEventListener('click', closeCompare);
  $('modal').addEventListener('click', function (e) {
    if (e.target === $('modal')) closeCompare();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('modal').hidden) closeCompare();
  });

  bindListEvents();
  render();
}

/* 浏览器环境才初始化;node 下可直接 require/测试纯函数 */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUI);
  } else {
    bindUI();
  }
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
    LOSSY: LOSSY
  };
}
