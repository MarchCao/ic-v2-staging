// 译文分隔符解析与页数匹配(纯函数,可独立测试)
// 规则:译文按行扫描,某一行 trim 后与分隔符完全相等 → 新页面的开始。
// 第一个分隔符之前若有非空内容,视为第 1 页并标记 hadPreamble(提示用户检查)。

export function parseTranslation(full, sep) {
  const separator = (sep || '---PAGE---').trim() || '---PAGE---';
  const lines = String(full || '').replace(/\r\n?/g, '\n').split('\n');
  const segments = [];
  let cur = null;
  let hadPreamble = false;
  for (const line of lines) {
    if (line.trim() === separator) {
      if (cur !== null) segments.push(cur);
      cur = [];
    } else if (cur === null) {
      if (line.trim() !== '') { hadPreamble = true; cur = [line]; }
    } else {
      cur.push(line);
    }
  }
  if (cur !== null) segments.push(cur);
  const cleaned = segments.map(seg => seg.join('\n').trim());
  // 末尾空段(文本以分隔符结尾)不计为页面
  while (cleaned.length && cleaned[cleaned.length - 1] === '') cleaned.pop();
  return { segments: cleaned, hadPreamble, separator };
}

export function matchInfo(pdfCount, segCount) {
  const missing = []; // 有 PDF 页但无译文的页码(1 起)
  const extra = [];   // 译文多出的页序(1 起)
  for (let i = segCount + 1; i <= pdfCount; i++) missing.push(i);
  for (let i = pdfCount + 1; i <= segCount; i++) extra.push(i);
  return { match: pdfCount === segCount, missing, extra };
}

// 把一页译文拆成 标题 + 正文行
export function splitPageText(text) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  return { title: lines[0] || '', body: lines.slice(1) };
}
