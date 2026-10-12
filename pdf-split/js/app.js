// PDF 分割编排:加载(pdf-lib,原样复制页面)→ 计划 → 生成 → 单文件直下/多文件 ZIP
import { PDFDocument } from '../vendor/pdf-lib.esm.min.js';
import { planSplit } from './split.js';
import { buildZipBlob } from './zip.js';

const $ = id => document.getElementById(id);
const setStatus = t => { $('status').textContent = t; };
window.addEventListener('error', e => setStatus('页面错误：' + e.message + '（可刷新页面后重试）'));

const state = { src: null, bytes: null, pageCount: 0, base: 'document' };

function mode() {
  const r = document.querySelector('input[name="mode"]:checked');
  return r ? r.value : 'chunk';
}

function refreshModeUI() {
  const m = mode();
  $('rangeText').hidden = m !== 'ranges';
  $('extractSpec').hidden = m !== 'extract';
  showPlan();
}

function currentPlan() {
  if (!state.src) return null;
  return planSplit(mode(), state.pageCount, {
    chunkSize: $('chunkSize').value,
    rangeText: $('rangeText').value,
    extractSpec: $('extractSpec').value,
  });
}

function showPlan() {
  const btn = $('btnSplit');
  const hint = $('gateHint');
  if (!state.src) { btn.disabled = true; hint.textContent = '请先上传 PDF。'; $('planInfo').textContent = ''; return; }
  try {
    const plan = currentPlan();
    $('planInfo').textContent = `将生成 ${plan.length} 个文件：` +
      plan.slice(0, 8).map(g => `${state.base}_${g.label}.pdf`).join('、') +
      (plan.length > 8 ? ` 等（共 ${plan.length} 个）` : '');
    btn.disabled = false;
    hint.textContent = '已就绪，可以分割。';
  } catch (e) {
    $('planInfo').textContent = '';
    btn.disabled = true;
    hint.textContent = e.message;
  }
}

async function handleFile(file) {
  if (!file) return;
  $('result').textContent = '';
  try {
    setStatus('正在读取 PDF…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const head = new TextDecoder().decode(bytes.slice(0, 5));
    if (!head.startsWith('%PDF')) throw new Error('该文件不是有效的 PDF（文件头校验失败）。');
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
    } catch (e) {
      if (String(e && e.message).includes('encrypted') || (e && e.name === 'EncryptedPDFError')) {
        throw new Error('该 PDF 已加密，无法分割，请提供未加密版本。');
      }
      throw new Error('PDF 解析失败，文件可能已损坏。');
    }
    state.src = doc;
    state.bytes = bytes;
    state.pageCount = doc.getPageCount();
    state.base = (file.name || 'document').replace(/\.pdf$/i, '');
    $('pdfInfo').textContent =
      `文件：${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）\n共 ${state.pageCount} 页`;
    setStatus(`PDF 已就绪：共 ${state.pageCount} 页。请选择分割方式。`);
  } catch (e) {
    state.src = null;
    setStatus('读取失败');
    $('pdfInfo').innerHTML = '';
    $('result').textContent = e.message;
  }
  showPlan();
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

$('btnSplit').addEventListener('click', async () => {
  let plan;
  try { plan = currentPlan(); } catch (e) { setStatus(e.message); return; }
  const btn = $('btnSplit');
  btn.disabled = true;
  try {
    const outputs = [];
    for (let i = 0; i < plan.length; i++) {
      setStatus(`正在生成 ${i + 1}/${plan.length}：${plan[i].label}…`);
      const out = await PDFDocument.create();
      const idx = plan[i].pages.map(p => p - 1);
      const copied = await out.copyPages(state.src, idx);
      copied.forEach(pg => out.addPage(pg));
      const data = await out.save();
      outputs.push({ name: `${state.base}_${plan[i].label}.pdf`, data });
    }
    if (outputs.length === 1) {
      download(new Blob([new Uint8Array(outputs[0].data)], { type: 'application/pdf' }), outputs[0].name);
      $('result').textContent = `✓ 已生成 ${outputs[0].name}（${plan[0].pages.length} 页），已开始下载。`;
    } else {
      const zip = buildZipBlob(outputs);
      download(zip, `${state.base}_split.zip`);
      $('result').textContent = `✓ 已生成 ${outputs.length} 个 PDF 并打包为 ${state.base}_split.zip（共 ${plan.reduce((a, g) => a + g.pages.length, 0)} 页），已开始下载。`;
    }
    setStatus('分割完成，已开始下载。');
  } catch (e) {
    setStatus('分割失败');
    $('result').textContent = '分割失败：' + e.message;
  }
  showPlan();
});

// ---- 事件接线 ----
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
document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', refreshModeUI));
['chunkSize', 'rangeText', 'extractSpec'].forEach(id => $(id).addEventListener('input', showPlan));
$('btnClear').addEventListener('click', () => {
  if (confirm('清除当前 PDF 和设置？页面将刷新。')) location.reload();
});
refreshModeUI();
