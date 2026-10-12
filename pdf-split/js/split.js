// 分割计划(纯函数):根据模式把 pageCount 页拆成若干组,每组 {label, pages[1 起]}
// 所有输入在此严格校验,非法输入抛错并给出具体原因,不静默修正。

function checkPage(n, pageCount, what) {
  if (!Number.isInteger(n) || n < 1 || n > pageCount) {
    throw new Error(`${what}「${n}」超出范围,PDF 共 ${pageCount} 页,请填 1–${pageCount}。`);
  }
}

// 解析 "1-10" 或 "5" 一段范围
export function parseRangeToken(tok, pageCount) {
  const m = String(tok).trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!m) throw new Error(`范围格式不对：「${tok}」,应写成 1-10 或 5。`);
  const start = parseInt(m[1], 10);
  const end = m[2] !== undefined ? parseInt(m[2], 10) : start;
  checkPage(start, pageCount, '起始页');
  checkPage(end, pageCount, '结束页');
  if (end < start) throw new Error(`范围「${tok}」结束页小于起始页。`);
  const pages = [];
  for (let p = start; p <= end; p++) pages.push(p);
  return { start, end, pages };
}

// 提取模式的页码清单:"1,3,5-8"(逗号分隔,可含范围),保序去重
export function parseExtractSpec(spec, pageCount) {
  const parts = String(spec || '').split(/[,，、\s]+/).filter(Boolean);
  if (!parts.length) throw new Error('请填写要提取的页码,例如 1,3,5-8。');
  const seen = new Set();
  const pages = [];
  for (const tok of parts) {
    const { pages: ps } = parseRangeToken(tok, pageCount);
    for (const p of ps) if (!seen.has(p)) { seen.add(p); pages.push(p); }
  }
  return pages;
}

export function planSplit(mode, pageCount, opts = {}) {
  if (!pageCount || pageCount < 1) throw new Error('PDF 没有页面。');
  if (mode === 'chunk') {
    const n = parseInt(opts.chunkSize, 10);
    if (!Number.isInteger(n) || n < 1) throw new Error('每份页数必须是 ≥1 的整数。');
    const groups = [];
    for (let s = 1; s <= pageCount; s += n) {
      const e = Math.min(pageCount, s + n - 1);
      const pages = [];
      for (let p = s; p <= e; p++) pages.push(p);
      groups.push({ label: s === e ? `p${s}` : `p${s}-${e}`, pages });
    }
    return groups;
  }
  if (mode === 'single') {
    return Array.from({ length: pageCount }, (_, i) => ({ label: `p${i + 1}`, pages: [i + 1] }));
  }
  if (mode === 'ranges') {
    const lines = String(opts.rangeText || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) throw new Error('请每行填写一个范围,例如:\n1-10\n11-20');
    return lines.map((line, i) => {
      const { start, end, pages } = parseRangeToken(line, pageCount);
      return { label: start === end ? `p${start}` : `p${start}-${end}`, pages, line: i + 1 };
    });
  }
  if (mode === 'extract') {
    const pages = parseExtractSpec(opts.extractSpec, pageCount);
    return [{ label: 'extract', pages }];
  }
  throw new Error('未知分割模式。');
}
