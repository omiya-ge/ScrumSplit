import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import { PDFDocument, degrees } from './vendor/pdf-lib/pdf-lib.esm.min.js';
import { DEFAULT_OPTIONS, computeLayout, pageOrder } from './imposition.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const PREVIEW_PAGES = 4;
const PREVIEW_MAX_DIM = 1600; // プレビュー用にレンダリングするスキャン画像の長辺(px)

const $ = (sel) => document.querySelector(sel);
const els = {
  dropzone: $('#dropzone'),
  fileInput: $('#file-input'),
  fileInfo: $('#file-info'),
  workspace: $('#workspace'),
  settings: $('#settings'),
  preview: $('#preview'),
  previewNote: $('#preview-note'),
  filename: $('#filename'),
  download: $('#download'),
  saveAs: $('#save-as'),
  status: $('#status'),
  warning: $('#warning'),
};

const state = {
  file: null,
  bytes: null, // 元 PDF のバイト列（pdf-lib 用）
  pdf: null, // pdf.js のドキュメント
  scanCount: 0,
  opts: { ...DEFAULT_OPTIONS },
  renderCache: new Map(), // scan index -> Promise<HTMLCanvasElement>
  previewToken: 0,
};

// ---------- ファイル読み込み ----------

els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files[0]) loadFile(els.fileInput.files[0]);
});

for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  window.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'dragleave' && e.relatedTarget) return;
    document.body.classList.remove('dragging');
  });
}
window.addEventListener('drop', (e) => {
  const file = [...(e.dataTransfer?.files ?? [])].find(
    (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name),
  );
  if (file) loadFile(file);
  else setStatus('PDF ファイルをドロップしてください。', 'error');
});

async function loadFile(file) {
  setStatus('読み込み中…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // pdf.js は渡したバッファをワーカーへ移すので、コピーを渡す
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;

    if (state.pdf) state.pdf.destroy();
    Object.assign(state, {
      file,
      bytes,
      pdf,
      scanCount: pdf.numPages,
      renderCache: new Map(),
    });

    els.fileInfo.textContent = `${file.name}（スキャン ${pdf.numPages} 枚）`;
    els.filename.value = file.name.replace(/\.pdf$/i, '') + '_単ページ.pdf';
    els.workspace.hidden = false;
    document.body.classList.add('loaded');
    setStatus('');
    updatePreview();
  } catch (err) {
    console.error(err);
    setStatus(`PDF を読み込めませんでした: ${err.message}`, 'error');
  }
}

// ---------- 設定 ----------

els.settings.addEventListener('change', (e) => {
  const input = e.target;
  if (!input.name) return;
  let value;
  if (input.type === 'checkbox') value = input.checked;
  else if (/^\d+$/.test(input.value)) value = Number(input.value);
  else value = input.value;
  state.opts[input.name] = value;
  updatePreview();
});

// ---------- プレビュー ----------

function renderScan(index) {
  if (!state.renderCache.has(index)) {
    const promise = (async () => {
      const page = await state.pdf.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = PREVIEW_MAX_DIM / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      return canvas;
    })();
    state.renderCache.set(index, promise);
  }
  return state.renderCache.get(index);
}

/** スキャン画像を時計回りに rotation 度回し、左右どちらかの半分を切り出す */
function drawHalf(source, rotation, half) {
  const quarter = rotation % 180 !== 0;
  const fullW = quarter ? source.height : source.width;
  const fullH = quarter ? source.width : source.height;
  const halfW = Math.floor(fullW / 2);

  const canvas = document.createElement('canvas');
  canvas.width = halfW;
  canvas.height = fullH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(-half * (fullW - halfW), 0);
  ctx.translate(fullW / 2, fullH / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

async function updatePreview() {
  if (!state.pdf) return;
  const token = ++state.previewToken;
  const layout = computeLayout(state.scanCount, state.opts);
  const order = pageOrder(layout);
  const targets = order.slice(0, PREVIEW_PAGES);

  showWarning();

  const sources = await Promise.all(
    targets.map((t) => (t ? renderScan(t.scan) : null)),
  ).catch((err) => {
    console.error(err);
    setStatus(`プレビューを描画できませんでした: ${err.message}`, 'error');
    return null;
  });
  if (!sources || token !== state.previewToken) return; // 新しい設定で描き直し中

  const halfLabel = ['左', '右'];
  const figures = targets.map((t, i) => {
    const fig = document.createElement('figure');
    if (t) {
      fig.append(drawHalf(sources[i], t.rotation, t.half));
    } else {
      const blank = document.createElement('div');
      blank.className = 'blank';
      blank.textContent = '白紙';
      fig.append(blank);
    }
    const cap = document.createElement('figcaption');
    cap.innerHTML = `<strong>${i + 1} ページ</strong>`;
    if (t) cap.innerHTML += `<span>スキャン ${t.scan + 1} の${halfLabel[t.half]}半分</span>`;
    fig.append(cap);
    return fig;
  });
  els.preview.replaceChildren(...figures);
  els.previewNote.textContent = `全 ${layout.totalPages} ページ（${layout.sheets} 枚の紙）のうち最初の ${targets.length} ページ`;
}

function showWarning() {
  if (state.scanCount % 2 === 1) {
    els.warning.textContent =
      `スキャンが奇数枚（${state.scanCount} 枚）です。表裏がそろっていない可能性があります。` +
      '足りない面のページは白紙として出力します。';
    els.warning.hidden = false;
  } else {
    els.warning.hidden = true;
  }
}

// ---------- 書き出し ----------

async function buildPdf() {
  const layout = computeLayout(state.scanCount, state.opts);
  const order = pageOrder(layout);

  const src = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const srcPages = src.getPages();
  const boxes = srcPages.map((p) => {
    const b = p.getCropBox();
    return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height };
  });
  const embedded = await out.embedPages(srcPages, boxes);

  let lastSize = null;
  for (const entry of order) {
    if (!entry) {
      out.addPage(lastSize ?? [595.28, 841.89]);
      continue;
    }
    const srcPage = srcPages[entry.scan];
    const form = embedded[entry.scan];
    const W = form.width;
    const H = form.height;
    // ページ自体の /Rotate とスキャン向きの補正を合わせた、時計回りの回転角
    const own = ((srcPage.getRotation().angle % 360) + 360) % 360;
    const T = (own + entry.rotation) % 360;
    const [fullW, fullH] = T % 180 === 0 ? [W, H] : [H, W];
    const halfW = fullW / 2;

    // 回転後の画像の左下が (0, 0) に来る描画位置。pdf-lib の rotate は反時計回り。
    const anchor = { 0: [0, 0], 90: [0, W], 180: [W, H], 270: [H, 0] }[T];

    const page = out.addPage([halfW, fullH]);
    page.drawPage(form, {
      x: anchor[0] - entry.half * halfW,
      y: anchor[1],
      rotate: degrees((360 - T) % 360),
    });
    lastSize = [halfW, fullH];
  }

  out.setTitle(els.filename.value.replace(/\.pdf$/i, ''));
  out.setProducer('ScrumSplit');
  return out.save();
}

function outputName() {
  const name = els.filename.value.trim() || 'output.pdf';
  return /\.pdf$/i.test(name) ? name : name + '.pdf';
}

async function withBusy(task) {
  els.download.disabled = els.saveAs.disabled = true;
  setStatus('PDF を作成中…');
  try {
    await task();
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('');
      return;
    }
    console.error(err);
    setStatus(`作成に失敗しました: ${err.message}`, 'error');
  } finally {
    els.download.disabled = els.saveAs.disabled = false;
  }
}

els.download.addEventListener('click', () =>
  withBusy(async () => {
    const bytes = await buildPdf();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = outputName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setStatus(`${outputName()} をダウンロードしました。`, 'ok');
  }),
);

if ('showSaveFilePicker' in window) {
  els.saveAs.hidden = false;
  els.saveAs.addEventListener('click', () =>
    withBusy(async () => {
      // ユーザー操作の直後に呼ぶ必要があるので、PDF の作成より先にダイアログを開く
      const handle = await window.showSaveFilePicker({
        suggestedName: outputName(),
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
      const bytes = await buildPdf();
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      setStatus(`${handle.name} に保存しました。`, 'ok');
    }),
  );
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}
