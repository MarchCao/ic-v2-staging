// PPTX 生成:通用商务模板(封面 + 标题栏正文),按语言字体、采样主色、原页图片排版
// 文本全部为可编辑文本框;生成前做溢出估算,自动降字号并对仍有风险的页给出警告。

import { splitPageText } from './parse.js';

export const LANGS = {
  zh: { label: '中文', font: 'Microsoft YaHei', titleSize: 26, bodySizes: [18, 16, 14, 12] },
  ja: { label: '日本語', font: 'Yu Gothic', titleSize: 26, bodySizes: [18, 16, 14, 12] },
  en: { label: 'English', font: 'Arial', titleSize: 26, bodySizes: [17, 15.5, 14, 12] },
};

function emWidth(text, fontSize) {
  let em = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x1100 && cp <= 0x11FF) || (cp >= 0x2E80 && cp <= 0x9FFF) ||
      (cp >= 0xA000 && cp <= 0xAFFF) || (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0x20000);
    em += wide ? 1 : 0.52;
  }
  return em * fontSize; // 单位 pt
}

export function estimateBodyHeightIn(bodyLines, fontSize, boxWIn) {
  const boxWPt = boxWIn * 72;
  let lines = 0;
  for (const t of bodyLines) lines += Math.max(1, Math.ceil(emWidth(t, fontSize) / boxWPt));
  return (lines * fontSize * 1.32) / 72 + 0.15;
}

function fitBox(imgW, imgH, maxW, maxH) {
  const r = Math.min(maxW / imgW, maxH / imgH);
  return { w: imgW * r, h: imgH * r };
}

export async function buildPptx(opts) {
  const { segments, images, lang, sizeMode, pdfRatio, mainColor, fileBase } = opts;
  const L = LANGS[lang] || LANGS.zh;
  const PptxGenJS = window.PptxGenJS;
  if (!PptxGenJS) throw new Error('LIB_MISSING');
  const pptx = new PptxGenJS();
  let W = 13.333, H = 7.5;
  if (sizeMode === 'pdf' && pdfRatio > 0) {
    H = 7.5; W = Math.min(16, Math.max(4.2, 7.5 * pdfRatio));
  }
  pptx.defineLayout({ name: 'LAY', width: W, height: H });
  pptx.layout = 'LAY';
  const color = (mainColor || '#1F4E79').replace('#', '');
  const warnings = [];

  segments.forEach((seg, idx) => {
    const { title, body } = splitPageText(seg);
    const img = images[idx]; // {dataUrl,w,h} | {tooBig} | null
    const slide = pptx.addSlide();

    if (idx === 0) {
      // 封面:主色底 + 大标题 + 副信息
      slide.background = { color };
      slide.addShape('rect', { x: 0.7, y: 1.15, w: 1.6, h: 0.07, fill: { color: 'E8A33D' } });
      slide.addText(title || '(无标题)', {
        x: 0.7, y: 1.45, w: W - 1.4, h: 2.2, fontSize: 40, bold: true,
        color: 'FFFFFF', fontFace: L.font, lineSpacingMultiple: 1.15,
      });
      if (body.length) {
        slide.addText(body.map(t => ({ text: t, options: { breakLine: true } })), {
          x: 0.7, y: 3.9, w: W - 1.4, h: H - 4.4, fontSize: 17,
          color: 'EAF1F8', fontFace: L.font, lineSpacingMultiple: 1.35,
        });
        if (estimateBodyHeightIn(body, 17, W - 1.4) > H - 4.4) warnings.push(`第 1 页(封面)文字较多,可能溢出,请在 PowerPoint 中检查。`);
      }
      if (img && img.dataUrl) {
        const box = fitBox(img.w, img.h, W * 0.34, H * 0.3);
        slide.addImage({ data: img.dataUrl, x: W - box.w - 0.7, y: H - box.h - 0.6, w: box.w, h: box.h });
      }
    } else {
      slide.background = { color: 'FFFFFF' };
      slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.98, fill: { color } });
      slide.addText(title || '(无标题)', {
        x: 0.55, y: 0.16, w: W - 1.1, h: 0.68, fontSize: L.titleSize, bold: true,
        color: 'FFFFFF', fontFace: L.font,
      });
      const hasImg = !!(img && img.dataUrl);
      const bodyX = 0.55, bodyY = 1.3, bodyH = H - 1.75;
      const bodyW = hasImg ? W * 0.55 : W - 1.1;
      if (body.length) {
        let chosen = L.bodySizes[L.bodySizes.length - 1];
        for (const s of L.bodySizes) {
          if (estimateBodyHeightIn(body, s, bodyW) <= bodyH) { chosen = s; break; }
        }
        if (estimateBodyHeightIn(body, chosen, bodyW) > bodyH) {
          warnings.push(`第 ${idx + 1} 页文字较多,即使用最小字号仍可能溢出,建议拆分该页或在 PowerPoint 中调整。`);
        }
        slide.addText(body.map(t => ({ text: t, options: { bullet: true, breakLine: true } })), {
          x: bodyX, y: bodyY, w: bodyW, h: bodyH, fontSize: chosen,
          color: '222222', fontFace: L.font, lineSpacingMultiple: 1.3, valign: 'top',
        });
      }
      if (hasImg) {
        const maxW = W * 0.38, maxH = bodyH;
        const box = fitBox(img.w, img.h, maxW, maxH);
        slide.addImage({ data: img.dataUrl, x: W - box.w - 0.45, y: bodyY + (maxH - box.h) / 2, w: box.w, h: box.h });
      }
      if (img && img.tooBig) warnings.push(`第 ${idx + 1} 页图片过大(>${img.w}×${img.h}),已跳过嵌入,请手动补图。`);
    }
    slide.addText(String(idx + 1), {
      x: W - 0.85, y: H - 0.42, w: 0.55, h: 0.28, fontSize: 10.5, color: '999999', align: 'right',
    });
  });

  const name = `${fileBase || 'presentation'}_${lang}.pptx`;
  await pptx.writeFile({ fileName: name });
  return { warnings, slideCount: segments.length, fileName: name };
}
