// 页面编排:状态管理、步骤门控、事件接线。所有数据仅存于内存会话,不写任何持久化存储。
import { loadPdf, renderThumb, extractLargestImage, sampleMainColor } from './pdf-import.js';
import { parseTranslation, matchInfo } from './parse.js';
import { buildPptx, LANGS } from './pptx-build.js';

const $ = id => document.getElementById(id);
const statusEl = $('status');
const setStatus = t => { statusEl.textContent = t; };
window.addEventListener('error', e => setStatus('页面错误：' + e.message + '（可刷新页面后重试）'));

const state = {
  pdf: null,        // loadPdf 结果 {doc, pageCount, pages, totalChars}
  images: [],       // 每页提取结果
  segments: null,   // 解析后的译文页数组(以编辑器为准,生成时回读)
  parsed: false,
  fileBase: 'presentation',
};

const ERR = {
  NOT_PDF: '该文件不是有效的 PDF（文件头校验失败）。',
  ENCRYPTED: '该 PDF 已加密或需要密码，浏览器无法解析，请提供未加密版本。',
  PARSE_FAIL: 'PDF 解析失败，文件可能已损坏。',
};

function gate() {
  const parts = [];
  if (!state.pdf) parts.push('上传 PDF');
  if (!state.parsed) parts.push('粘贴并解析译文');
  let mismatchOk = true;
  if (state.pdf && state.parsed) {
    const mi = matchInfo(state.pdf.pageCount, readSegments().length);
    mismatchOk = mi.match || $('confirmMismatch').checked;
    if (!mi.match && !$('confirmMismatch').checked) parts.push('确认页数不一致');
  }
  const ok = state.pdf && state.parsed && mismatchOk;
  $('btnGenerate').disabled = !ok;
  $('gateHint').textContent = ok ? '已就绪，可以生成。' : '请先完成：' + parts.join(' → ') + '。';
  return ok;
}

function readSegments() {
  const tas = document.querySelectorAll('#pageEditors textarea');
  if (tas.length) return [...tas].map(t => t.value);
  return state.segments || [];
}

async function handleFile(file) {
  if (!file) return;
  $('pdfInfo').textContent = '';
  $('thumbs').innerHTML = '';
  $('scanWarn').hidden = true;
  $('genResult').textContent = '';
  $('warnList').innerHTML = '';
  try {
    setStatus('正在读取 PDF…');
    const pdf = await loadPdf(file, (i, n) => setStatus(`正在提取页面信息 ${i}/${n}…`));
    state.pdf = pdf;
    state.fileBase = (file.name || 'presentation').replace(/\.pdf$/i, '');
    const ratio = pdf.pages[0] ? (pdf.pages[0].w / pdf.pages[0].h) : 0;
    $('pdfInfo').innerHTML =
      `文件：${file.name}（${(file.size / 1024).toFixed(0)} KB）\n` +
      `页数：${pdf.pageCount} 页 · 页面尺寸：${pdf.pages[0].w.toFixed(0)} × ${pdf.pages[0].h.toFixed(0)} pt（比例 ${ratio.toFixed(2)}）\n` +
      `可提取文本总量：约 ${pdf.totalChars} 字符`;
    if (pdf.totalChars < 20) $('scanWarn').hidden = false;

    setStatus('正在渲染页面预览…');
    for (let i = 1; i <= pdf.pageCount; i++) {
      try {
        const cv = await renderThumb(pdf.doc, i);
        const wrap = document.createElement('div');
        wrap.className = 'thumb';
        wrap.appendChild(cv);
        const lab = document.createElement('div');
        lab.textContent = '第 ' + i + ' 页';
        wrap.appendChild(lab);
        $('thumbs').appendChild(wrap);
      } catch (_) { /* 单页预览失败跳过 */ }
    }

    setStatus('正在提取各页图片…');
    state.images = [];
    for (let i = 1; i <= pdf.pageCount; i++) {
      state.images.push(await extractLargestImage(pdf.doc, i));
      setStatus(`正在提取各页图片 ${i}/${pdf.pageCount}…`);
    }

    setStatus('正在采样原 PDF 主色…');
    const col = await sampleMainColor(pdf.doc, pdf.pageCount);
    if (col) {
      $('colorInput').value = col;
      $('colorNote').textContent = '已从原 PDF 采样主色 ' + col + '，可手动修改';
    } else {
      $('colorNote').textContent = '未能可靠采样主色，使用默认商务蓝，可手动修改';
    }
    const nImg = state.images.filter(x => x && x.dataUrl).length;
    setStatus(`PDF 已就绪：${pdf.pageCount} 页，提取到图片 ${nImg} 张。请粘贴译文并解析。`);
    refreshMatch();
  } catch (e) {
    state.pdf = null;
    setStatus('读取失败');
    $('pdfInfo').innerHTML = '<span class="bad">' + (ERR[e.message] || ('读取失败：' + e.message)) + '</span>';
  }
  gate();
}

function refreshMatch() {
  const card = $('matchCard');
  if (!state.parsed) { card.hidden = true; return; }
  card.hidden = false;
  const segs = state.segments || [];
  const pdfCount = state.pdf ? state.pdf.pageCount : 0;
  const editors = $('pageEditors');
  editors.innerHTML = '';
  segs.forEach((seg, i) => {
    const div = document.createElement('div');
    div.className = 'editor';
    const h = document.createElement('h3');
    h.textContent = `译文第 ${i + 1} 页` + (state.pdf && i < pdfCount ? `（对应 PDF 第 ${i + 1} 页）` : '（PDF 中无对应页，将作为新增页）');
    div.appendChild(h);
    if (state.pdf && i < pdfCount) {
      const orig = document.createElement('div');
      orig.className = 'orig';
      const t = (state.pdf.pages[i].text || '').replace(/\s+/g, ' ').trim();
      orig.textContent = '原 PDF 本页文本参考：' + (t ? t.slice(0, 220) : '（无可提取文本）');
      div.appendChild(orig);
    }
    const ta = document.createElement('textarea');
    ta.rows = Math.min(10, Math.max(3, seg.split('\n').length + 1));
    ta.value = seg;
    ta.addEventListener('input', gate);
    div.appendChild(ta);
    editors.appendChild(div);
  });
  updateMatchInfo();
}

function updateMatchInfo() {
  if (!state.pdf || !state.parsed) return;
  const n = readSegments().length;
  const mi = matchInfo(state.pdf.pageCount, n);
  const el = $('matchInfo');
  if (mi.match) {
    el.innerHTML = `<span class="ok">✓ 页数一致：PDF ${state.pdf.pageCount} 页 = 译文 ${n} 页。</span>`;
    $('confirmWrap').hidden = true;
  } else {
    let msg = `⚠ 页数不一致：PDF ${state.pdf.pageCount} 页，译文 ${n} 页。`;
    if (mi.missing.length) msg += `\n缺少译文的 PDF 页：${mi.missing.join(', ')}`;
    if (mi.extra.length) msg += `\n译文多出的页序：${mi.extra.join(', ')}`;
    el.textContent = msg;
    $('confirmWrap').hidden = false;
  }
  gate();
}

// ---- 事件 ----
const dz = $('dropzone');
const fi = $('fileInput');
dz.addEventListener('click', () => fi.click());
dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('dragover');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});
fi.addEventListener('change', () => { if (fi.files[0]) handleFile(fi.files[0]); fi.value = ''; });

$('btnParse').addEventListener('click', () => {
  const full = $('fullText').value;
  if (!full.trim()) {
    $('parseInfo').innerHTML = '<span class="bad">译文为空，请先粘贴翻译好的全文。</span>';
    return;
  }
  const { segments, hadPreamble, separator } = parseTranslation(full, $('sepInput').value);
  state.segments = segments;
  state.parsed = segments.length > 0;
  $('parseInfo').textContent =
    `已按 "${separator}" 解析出 ${segments.length} 页译文。` +
    (hadPreamble ? ' 注意：第一个分隔符之前有内容，已作为第 1 页，请在下方检查。' : '');
  refreshMatch();
  gate();
});

$('confirmMismatch').addEventListener('change', updateMatchInfo);

$('btnGenerate').addEventListener('click', async () => {
  if (!gate()) return;
  const segments = readSegments().map(s => s.trim());
  if (segments.some(s => !s)) {
    setStatus('有页面译文为空，请先补全或删除该页内容再生成。');
    return;
  }
  setStatus('正在生成 PPTX…');
  $('btnGenerate').disabled = true;
  try {
    const pdfRatio = state.pdf.pages[0].w / state.pdf.pages[0].h;
    const imgs = segments.map((_, i) => state.images[i] || null);
    const { warnings, slideCount, fileName } = await buildPptx({
      segments,
      images: imgs,
      lang: $('langSel').value,
      sizeMode: $('sizeSel').value === 'pdf' ? 'pdf' : 'wide',
      pdfRatio,
      mainColor: $('colorInput').value,
      fileBase: state.fileBase,
    });
    setStatus('生成完成，已开始下载。');
    $('genResult').innerHTML =
      `<span class="ok">✓ 已生成 ${fileName}（共 ${slideCount} 页，${LANGS[$('langSel').value].label}）。</span>\n文字为可编辑文本框，请在 PowerPoint 中打开检查排版。`;
    const ul = $('warnList');
    ul.innerHTML = '';
    warnings.forEach(w => { const li = document.createElement('li'); li.textContent = w; ul.appendChild(li); });
    if (!warnings.length) {
      const li = document.createElement('li');
      li.textContent = '排版检查：未发现明显溢出风险（估算值，仍建议逐页目视确认）。';
      li.style.color = 'var(--ok)';
      ul.appendChild(li);
    }
    $('imgNote').hidden = !imgs.some(x => x && x.dataUrl);
  } catch (e) {
    setStatus('生成失败');
    $('genResult').innerHTML = '<span class="bad">PPTX 生成失败：' + (e.message === 'LIB_MISSING' ? '组件加载失败，请刷新页面重试。' : e.message) + '</span>';
  }
  gate();
});

$('btnClear').addEventListener('click', () => {
  if (confirm('清除当前 PDF、译文和生成结果？页面将刷新，未下载的内容会丢失。')) location.reload();
});
