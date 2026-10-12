// 定稿 PDF 布局引擎(纯逻辑,measure 注入:浏览器用 canvas 实测,测试用假测)
// 目标:无论译文比原文长还是短,每页都排得下——字号阶梯收缩 → 图片让位 → 仍不行则自动续页。
// 不做静默溢出:所有取舍都会体现在返回的 parts/notes 中。

export const BODY_SIZES = [15, 14, 13, 12, 11, 10];
export const TITLE_SIZES = [20, 18, 16, 14, 12];
export const COVER_TITLE_SIZES = [34, 30, 26, 22, 18];
export const LINE_H = 1.55;

const CJK = /[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uAFFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\u20000-\u2FA1F]/;

// 把一段文字按实测宽度断行。CJK 逐字可断;拉丁按词断,超长单词硬断。
export function wrapParagraph(text, size, maxW, measure, firstLineInset = 0) {
  const src = String(text || '');
  if (!src.trim()) return [''];
  // 分词:CJK 单字成词,连续非空格成词,空格作为可断点
  const tokens = [];
  let word = '';
  for (const ch of src) {
    if (ch === ' ' || ch === '　') {
      if (word) { tokens.push(word); word = ''; }
      tokens.push(' ');
    } else if (CJK.test(ch)) {
      if (word) { tokens.push(word); word = ''; }
      tokens.push(ch);
    } else word += ch;
  }
  if (word) tokens.push(word);

  const lines = [];
  let cur = '';
  let avail = maxW - firstLineInset;
  const push = () => { lines.push(cur.replace(/\s+$/g, '')); cur = ''; avail = maxW; };
  for (const tok of tokens) {
    if (tok === ' ') {
      if (cur && measure(cur + ' ', size) <= avail) cur += ' ';
      continue;
    }
    // 超长 token(长单词/长串)硬断
    if (measure(tok, size) > avail && tok.length > 1) {
      let rest = tok;
      while (rest) {
        let take = rest.length;
        while (take > 1 && measure(cur + rest.slice(0, take), size) > avail) take--;
        if (measure(cur + rest.slice(0, take), size) > avail && cur) { push(); continue; }
        cur += rest.slice(0, take);
        rest = rest.slice(take);
        if (rest) push();
      }
      continue;
    }
    if (cur && measure(cur + tok, size) > avail) push();
    cur += tok;
  }
  if (cur || !lines.length) push();
  return lines;
}

// 把正文多行在给定字号/可用宽高下整体断行,返回总行数组与总高度(pt);放不下返回 null
export function fitBody(bodyLines, size, areaW, areaH, measure, bulletInsetPt) {
  const wrapped = [];
  for (const line of bodyLines) {
    const ls = wrapParagraph(line, size, areaW - bulletInsetPt, measure, 0);
    ls.forEach((l, i) => wrapped.push({ text: l, first: i === 0 }));
  }
  const h = wrapped.length * size * LINE_H;
  return h <= areaH ? { lines: wrapped, height: h } : null;
}

// 标题断行与字号选择:最多 maxLines 行
export function fitTitle(title, sizes, maxW, maxLines, measure) {
  for (const s of sizes) {
    const lines = wrapParagraph(title, s, maxW, measure, 0);
    if (lines.length <= maxLines) return { size: s, lines };
  }
  const s = sizes[sizes.length - 1];
  return { size: s, lines: wrapParagraph(title, s, maxW, measure, 0) };
}

// 内容页文本区与图片区(单位 pt,坐标系:左上原点)
export function contentAreas(pageW, pageH, titleBarH, mode) {
  const mx = pageW * 0.075;
  const top = titleBarH + pageH * 0.032;
  const bottom = pageH - pageH * 0.042;
  const fullW = pageW - mx * 2;
  const fullH = bottom - top;
  if (mode === 'side') {
    const imgW = pageW * 0.335;
    return {
      text: { x: mx, y: top, w: fullW - imgW - 16, h: fullH },
      img: { x: pageW - mx - imgW, y: top, w: imgW, h: fullH },
    };
  }
  if (mode === 'bottom') {
    const imgH = fullH * 0.30;
    return {
      text: { x: mx, y: top, w: fullW, h: fullH - imgH - 14 },
      img: { x: mx, y: bottom - imgH, w: fullW, h: imgH },
    };
  }
  return { text: { x: mx, y: top, w: fullW, h: fullH }, img: null };
}

// 为一页译文排版。返回 parts(≥1):[{bodySize, imageMode, lines}], titleFit, notes[]
export function layoutContentPage({ title, body, hasImage, pageW, pageH, measure }) {
  const notes = [];
  // 先按单行标题栏估算,标题断行后栏高随行数变
  const mx = pageW * 0.075;
  const titleFit = fitTitle(title || '(无标题)', TITLE_SIZES, pageW - mx * 2, 2, measure);
  const titleBarH = Math.max(44, titleFit.lines.length * titleFit.size * 1.35 + 18);
  const bulletInset = 14;

  const modes = hasImage ? ['side', 'bottom', 'none'] : ['none'];
  for (const mode of modes) {
    const areas = contentAreas(pageW, pageH, titleBarH, mode);
    for (const s of BODY_SIZES) {
      const fit = fitBody(body, s, areas.text.w, areas.text.h, measure, bulletInset);
      if (fit) {
        if (mode === 'none' && hasImage) notes.push('文字较多,本页图片已省略以保证排版');
        if (s < BODY_SIZES[0]) notes.push(`字号自动调整为 ${s}pt`);
        return { parts: [{ bodySize: s, imageMode: mode, lines: fit.lines }], titleFit, titleBarH, notes };
      }
    }
  }
  // 兜底:最小字号 + 图片底部小图(第一页),其余续页无图,按高度切分
  const s = BODY_SIZES[BODY_SIZES.length - 1];
  notes.push(`文字量大,已自动拆为续页(字号 ${s}pt)`);
  const firstMode = hasImage ? 'bottom' : 'none';
  const parts = [];
  let rest = body.slice();
  let first = true;
  while (rest.length) {
    const mode = first ? firstMode : 'none';
    const areas = contentAreas(pageW, pageH, titleBarH, mode);
    // 逐段贪心装入
    const availH = areas.text.h;
    const taken = [];
    let usedH = 0;
    while (rest.length) {
      const probe = wrapParagraph(rest[0], s, areas.text.w - bulletInset, measure, 0);
      const need = probe.length * s * LINE_H;
      if (taken.length && usedH + need > availH) break;
      if (!taken.length && need > availH) {
        // 单段本身超一页:按行硬切,剩余行按原文特征回写(CJK 不加空格,拉丁补空格)
        const maxLines = Math.max(1, Math.floor(availH / (s * LINE_H)));
        taken.push(...probe.slice(0, maxLines).map((t, i) => ({ text: t, first: i === 0 })));
        const restLines = probe.slice(maxLines).map(x => x.text);
        const joiner = CJK.test(restLines.join('')) ? '' : ' ';
        const remainText = restLines.join(joiner);
        rest = [remainText, ...rest.slice(1)].filter(t => t !== '');
        usedH = availH;
        break;
      }
      taken.push(...probe.map((t, i) => ({ text: t, first: i === 0 })));
      usedH += need;
      rest = rest.slice(1);
    }
    parts.push({ bodySize: s, imageMode: mode, lines: taken });
    first = false;
  }
  return { parts, titleFit, titleBarH, notes };
}

// 封面页排版:标题区在上部色块内,正文在其下;逻辑同内容页但几何不同(此处只算正文部分)
export function layoutCover({ title, body, pageW, pageH, measure }) {
  const notes = [];
  const mx = pageW * 0.075;
  const titleFit = fitTitle(title || '(无标题)', COVER_TITLE_SIZES, pageW - mx * 2, 3, measure);
  const bodyTop = pageH * 0.47;
  const bodyH = pageH - bodyTop - pageH * 0.06;
  const bulletInset = 14;
  for (const s of BODY_SIZES) {
    const fit = fitBody(body, s, pageW - mx * 2, bodyH, measure, bulletInset);
    if (fit) {
      if (s < BODY_SIZES[0]) notes.push(`封面字号自动调整为 ${s}pt`);
      return { titleFit, bodySize: s, lines: fit.lines, notes, overflow: false };
    }
  }
  const s = BODY_SIZES[BODY_SIZES.length - 1];
  const fit = fitBody(body, s, pageW - mx * 2, bodyH * 2, measure, bulletInset);
  notes.push('封面文字较多,可能超出页面,请在预览中检查并精简');
  return { titleFit, bodySize: s, lines: fit ? fit.lines : [], notes, overflow: true };
}
