// PDF 导入与信息提取:页数/尺寸/文本、缩略图渲染、图片提取、主色采样
// 全部在浏览器本地完成,不发出任何网络请求(库文件为本站自托管)。

import * as pdfjsLib from '../vendor/pdf.min.mjs';

const BASE = new URL('../vendor/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';

export async function loadPdf(file, onProgress) {
  const buf = await file.arrayBuffer();
  const head = new TextDecoder().decode(buf.slice(0, 5));
  if (!head.startsWith('%PDF')) throw new Error('NOT_PDF');
  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: BASE + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: BASE + 'standard_fonts/',
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('ENCRYPTED');
    throw new Error('PARSE_FAIL');
  }
  const pages = [];
  let totalChars = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    let text = '';
    try {
      const tc = await page.getTextContent();
      text = tc.items.map(it => it.str).join('\n');
    } catch (_) { /* 单页文本失败不中断整体 */ }
    totalChars += text.trim().length;
    pages.push({ num: i, w: vp.width, h: vp.height, text });
    if (onProgress) onProgress(i, doc.numPages);
  }
  return { doc, pageCount: doc.numPages, pages, totalChars };
}

export async function renderThumb(doc, pageNum, targetW = 176) {
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = targetW / base.width;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

// 渲染(触发图片解码)后,从操作符列表枚举嵌入图片,取像素面积最大的一张转 dataURL
export async function extractLargestImage(doc, pageNum) {
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const rc = document.createElement('canvas');
  rc.width = Math.floor(vp.width); rc.height = Math.floor(vp.height);
  const rctx = rc.getContext('2d');
  try { await page.render({ canvasContext: rctx, viewport: vp }).promise; } catch (_) { return null; }
  let ops;
  try { ops = await page.getOperatorList(); } catch (_) { return null; }
  const IMG_OPS = [pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintJpegXObject];
  const ids = [];
  ops.fnArray.forEach((fn, i) => { if (IMG_OPS.includes(fn)) ids.push(ops.argsArray[i][0]); });
  let best = null;
  for (const id of ids) {
    try {
      const img = await new Promise((res, rej) => {
        let done = false;
        try { page.objs.get(id, v => { done = true; res(v); }); } catch (e) { rej(e); }
        setTimeout(() => { if (!done) rej(new Error('timeout')); }, 6000);
      });
      if (img && img.width && img.height && (!best || img.width * img.height > best.width * best.height)) best = img;
    } catch (_) { /* 单张图失败跳过 */ }
  }
  if (!best) return null;
  const c = document.createElement('canvas');
  c.width = best.width; c.height = best.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  if (best.bitmap) {
    ctx.drawImage(best.bitmap, 0, 0);
  } else if (best.data) {
    const px = new Uint8ClampedArray(best.width * best.height * 4);
    if (best.kind === 3) px.set(best.data);
    else if (best.kind === 2) {
      for (let s = 0, d = 0; s < best.data.length; s += 3, d += 4) {
        px[d] = best.data[s]; px[d + 1] = best.data[s + 1]; px[d + 2] = best.data[s + 2]; px[d + 3] = 255;
      }
    } else return null;
    ctx.putImageData(new ImageData(px, best.width, best.height), 0, 0);
  } else return null;
  const big = best.width * best.height > 1500000;
  const dataUrl = big ? c.toDataURL('image/jpeg', 0.88) : c.toDataURL('image/png');
  if (dataUrl.length > 8000000) return { tooBig: true, w: best.width, h: best.height };
  return { dataUrl, w: best.width, h: best.height };
}

// 采样主色:渲染前若干页 → 跳过近白/近黑与低饱和像素 → 粗量化分桶 → 取胜出桶内像素均值
export async function sampleMainColor(doc, pageCount) {
  const buckets = new Map();
  const n = Math.min(pageCount, 3);
  for (let p = 1; p <= n; p++) {
    try {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 0.4 });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 16) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx > 242 || mx < 18) continue;
        if (mx - mn < 28) continue; // 低饱和(灰阶)不作为品牌色
        const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
        let bk = buckets.get(key);
        if (!bk) { bk = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, bk); }
        bk.n++; bk.r += r; bk.g += g; bk.b += b;
      }
    } catch (_) { /* 单页失败跳过 */ }
  }
  let win = null;
  for (const bk of buckets.values()) if (!win || bk.n > win.n) win = bk;
  if (!win || win.n < 40) return null;
  const hex = v => Math.round(v).toString(16).padStart(2, '0');
  return ('#' + hex(win.r / win.n) + hex(win.g / win.n) + hex(win.b / win.n)).toUpperCase();
}
