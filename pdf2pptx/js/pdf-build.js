// 定稿 PDF 生成:逐页 canvas 渲染(实测字宽排版)→ JPEG 装订为与原 PDF 同尺寸的 PDF
// 渲染即最终效果,不存在打开软件后的二次排版偏差。文字为定稿形态(不可复制/编辑)。

import { PDFDocument } from '../vendor/pdf-lib.esm.min.js';
import { splitPageText } from './parse.js';
import { layoutContentPage, layoutCover, contentAreas, LINE_H } from './layout.js';

const SCALE = 2.5; // ≈180 DPI
const FONT_STACKS = {
  zh: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
  ja: '"Hiragino Sans","Yu Gothic","Noto Sans CJK JP","Microsoft YaHei",sans-serif',
  en: 'Arial,Helvetica,sans-serif',
};
const ACCENT = '#E8A33D';

function font(size, lang, bold) {
  return `${bold ? '700 ' : ''}${size}pt ${FONT_STACKS[lang] || FONT_STACKS.zh}`;
}

function loadImage(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = dataUrl;
  });
}

function drawImageContain(ctx, img, box) {
  const r = Math.min(box.w / img.naturalWidth, box.h / img.naturalHeight);
  const w = img.naturalWidth * r, h = img.naturalHeight * r;
  ctx.drawImage(img, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
}

export async function buildPdf(opts) {
  const { segments, images, lang, mainColor, pageW, pageH, fileBase, onProgress, onThumb } = opts;
  const color = mainColor || '#1F4E79';
  const measureCtx = document.createElement('canvas').getContext('2d');
  // 统一按粗体字宽测算(粗体≥常规宽),正文排版留安全余量,标题也不会低估
  const measure = (text, size) => {
    measureCtx.font = font(size, lang, true);
    return measureCtx.measureText(text).width;
  };

  const out = await PDFDocument.create();
  const notes = [];
  let outPage = 0;

  async function emit(canvas) {
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const jpg = await out.embedJpg(bytes);
    const page = out.addPage([pageW, pageH]);
    page.drawImage(jpg, { x: 0, y: 0, width: pageW, height: pageH });
    outPage++;
    if (onThumb) onThumb(canvas, outPage);
  }

  function newCanvas() {
    const c = document.createElement('canvas');
    c.width = Math.round(pageW * SCALE);
    c.height = Math.round(pageH * SCALE);
    const ctx = c.getContext('2d');
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, pageW, pageH);
    ctx.textBaseline = 'alphabetic';
    return [c, ctx];
  }

  function drawBody(ctx, lines, area, size, colorHex, bulletColor) {
    ctx.font = font(size, lang, false);
    ctx.fillStyle = colorHex;
    let y = area.y + size; // 基线
    for (const ln of lines) {
      if (ln.first) {
        ctx.fillStyle = bulletColor || color;
        ctx.fillText('•', area.x, y);
        ctx.fillStyle = colorHex;
      }
      ctx.fillText(ln.text, area.x + 14, y);
      y += size * LINE_H;
    }
  }

  for (let idx = 0; idx < segments.length; idx++) {
    if (onProgress) onProgress(idx + 1, segments.length);
    const { title, body } = splitPageText(segments[idx]);
    const imgInfo = images[idx];
    let imgEl = null;
    if (imgInfo && imgInfo.dataUrl) {
      try { imgEl = await loadImage(imgInfo.dataUrl); } catch (_) { imgEl = null; }
    }
    if (imgInfo && imgInfo.tooBig) notes.push(`第 ${idx + 1} 页图片过大,已跳过`);

    if (idx === 0) {
      const plan = layoutCover({ title, body, pageW, pageH, measure });
      plan.notes.forEach(n => notes.push(`第 1 页:${n}`));
      const [c, ctx] = newCanvas();
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, pageW, pageH);
      ctx.fillStyle = ACCENT;
      ctx.fillRect(pageW * 0.075, pageH * 0.14, 64, 5);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = font(plan.titleFit.size, lang, true);
      let ty = pageH * 0.14 + 26 + plan.titleFit.size;
      for (const line of plan.titleFit.lines) { ctx.fillText(line, pageW * 0.075, ty); ty += plan.titleFit.size * 1.3; }
      if (plan.lines.length) {
        drawBody(ctx, plan.lines, { x: pageW * 0.075, y: pageH * 0.47, w: pageW * 0.85 }, plan.bodySize, '#EAF1F8', ACCENT);
      }
      if (imgEl) {
        const box = { x: pageW - pageW * 0.075 - pageW * 0.3, y: pageH - pageH * 0.06 - pageH * 0.2, w: pageW * 0.3, h: pageH * 0.2 };
        drawImageContain(ctx, imgEl, box);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = font(10, lang, false);
      ctx.fillText(`1 / ${segments.length}`, pageW - 64, pageH - 16);
      await emit(c);
      continue;
    }

    const plan = layoutContentPage({ title, body, hasImage: !!imgEl, pageW, pageH, measure });
    plan.notes.forEach(n => notes.push(`第 ${idx + 1} 页:${n}`));
    if (plan.parts.length > 1) notes.push(`第 ${idx + 1} 页内容较多,已自动生成 ${plan.parts.length} 页(含续页)`);

    for (let pi = 0; pi < plan.parts.length; pi++) {
      const part = plan.parts[pi];
      const [c, ctx] = newCanvas();
      // 标题栏
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, pageW, plan.titleBarH);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = font(plan.titleFit.size, lang, true);
      let ty = 16 + plan.titleFit.size;
      const titleLines = pi === 0 ? plan.titleFit.lines
        : plan.titleFit.lines.map((l, i) => i === plan.titleFit.lines.length - 1 ? l + '（续）' : l);
      for (const line of titleLines) { ctx.fillText(line, pageW * 0.075, ty); ty += plan.titleFit.size * 1.35; }
      const areas = contentAreas(pageW, pageH, plan.titleBarH, part.imageMode);
      if (imgEl && areas.img) drawImageContain(ctx, imgEl, areas.img);
      drawBody(ctx, part.lines, areas.text, part.bodySize, '#222222');
      ctx.fillStyle = '#999999';
      ctx.font = font(10, lang, false);
      ctx.fillText(`${idx + 1} / ${segments.length}`, pageW - 64, pageH - 16);
      await emit(c);
    }
  }

  const data = await out.save();
  const blob = new Blob([new Uint8Array(data)], { type: 'application/pdf' });
  return {
    blob,
    fileName: `${fileBase || 'presentation'}_${lang}.pdf`,
    outPages: outPage,
    notes,
  };
}
