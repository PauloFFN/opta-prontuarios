// Monta o PDF final: imagem da planilha (fundo) + traços desenhados (camada transparente).
const TEMPLATE_PAGES = [
  { src: 'assets/template/page-1.png', w: 1836, h: 3024, ptW: 612, ptH: 1008 },
  { src: 'assets/template/page-2.png', w: 1836, h: 3024, ptW: 612, ptH: 1008 }
];

let _bgBytesCache = null;
async function loadBackgroundBytes() {
  if (_bgBytesCache) return _bgBytesCache;
  _bgBytesCache = await Promise.all(
    TEMPLATE_PAGES.map(p => fetch(p.src).then(r => r.arrayBuffer()))
  );
  return _bgBytesCache;
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function buildRecordPDF(drawersByPage) {
  const { PDFDocument } = PDFLib;
  const bgBytesList = await loadBackgroundBytes();
  const pdfDoc = await PDFDocument.create();

  for (let i = 0; i < TEMPLATE_PAGES.length; i++) {
    const pageNum = i + 1;
    const spec = TEMPLATE_PAGES[i];
    const bgImage = await pdfDoc.embedPng(bgBytesList[i]);
    const page = pdfDoc.addPage([spec.ptW, spec.ptH]);
    page.drawImage(bgImage, { x: 0, y: 0, width: spec.ptW, height: spec.ptH });

    const drawer = drawersByPage[pageNum];
    if (drawer && !drawer.isEmpty()) {
      const inkDataUrl = drawer.renderToImage(spec.w, spec.h);
      const inkBytes = dataUrlToBytes(inkDataUrl);
      const inkImage = await pdfDoc.embedPng(inkBytes);
      page.drawImage(inkImage, { x: 0, y: 0, width: spec.ptW, height: spec.ptH });
    }
  }

  return pdfDoc.save();
}

function sanitizeFilename(name) {
  return (name || 'prontuario')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim().replace(/\s+/g, '_') || 'prontuario';
}

// Tenta abrir o menu nativo de compartilhar (Salvar em Arquivos / iCloud Drive / Android).
// Se o navegador não suportar, cai para o download tradicional.
// `bytesOrBlob` aceita tanto o retorno de buildRecordPDF (Uint8Array) quanto um Blob já pronto
// (usado para compartilhar de novo um PDF antigo, seja gerado pelo app ou importado).
async function exportAndSharePDF(bytesOrBlob, filename) {
  const blob = bytesOrBlob instanceof Blob ? bytesOrBlob : new Blob([bytesOrBlob], { type: 'application/pdf' });
  const file = new File([blob], filename, { type: 'application/pdf' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // se falhar por outro motivo, cai para download abaixo
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
