// Liga o motor de desenho ao banco local. Fluxo único: o app sempre abre com os rabiscos
// salvos prontos na tela; "Salvar" define o que fica salvo como padrão; "Exportar PDF" gera
// o arquivo e limpa a tela de volta pro padrão salvo, pronta para o próximo paciente.
(function () {
  'use strict';

  // Pede armazenamento persistente para o navegador não apagar os dados por falta de uso
  // (relevante no Safari/iOS, que pode limpar dados de site após 7 dias sem visita).
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // ---------- Modal genérico (prompt de texto) ----------
  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalBox = document.getElementById('modal-box');
  function closeModal() { modalBackdrop.classList.remove('active'); modalBox.innerHTML = ''; }
  modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });

  function promptModal(title, placeholder) {
    return new Promise((resolve) => {
      modalBox.innerHTML = `
        <h3>${title}</h3>
        <input type="text" id="modal-input" placeholder="${placeholder || ''}">
        <div class="modal-actions">
          <button class="btn-cancel" id="modal-cancel">Cancelar</button>
          <button class="btn-ok" id="modal-ok">OK</button>
        </div>`;
      modalBackdrop.classList.add('active');
      const input = document.getElementById('modal-input');
      input.focus();
      document.getElementById('modal-cancel').onclick = () => { closeModal(); resolve(null); };
      document.getElementById('modal-ok').onclick = () => { const v = input.value.trim(); closeModal(); resolve(v || ''); };
      input.onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('modal-ok').click(); };
    });
  }

  // ---------- Estado ----------
  let drawer1, drawer2;
  let lastActiveDrawer = null;
  let saveTimer = null;
  const drawersByPage = {};

  function emptyStrokes() { return { 1: [], 2: [] }; }

  function initDrawers() {
    drawer1 = new PageDrawer(document.getElementById('draw-canvas-1'));
    drawer2 = new PageDrawer(document.getElementById('draw-canvas-2'));
    drawersByPage[1] = drawer1;
    drawersByPage[2] = drawer2;
    [drawer1, drawer2].forEach(d => {
      d.onChange = () => { lastActiveDrawer = d; scheduleAutosave(); };
    });
    requestAnimationFrame(() => { drawer1.resize(); drawer2.resize(); });
  }

  function loadStrokesIntoCanvas(strokes) {
    drawer1.loadStrokes(strokes ? strokes[1] : []);
    drawer2.loadStrokes(strokes ? strokes[2] : []);
  }

  function currentStrokes() {
    return { 1: drawer1.getStrokes(), 2: drawer2.getStrokes() };
  }

  function scheduleAutosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      Store.put('state', { id: 'working', strokes: currentStrokes() });
    }, 600);
  }

  // ---------- Ferramentas ----------
  function applyToolSettings() {
    const tool = document.querySelector('#toolbar .tool-btn.active').dataset.tool;
    const color = document.getElementById('pen-color').value;
    const width = document.getElementById('pen-width').value;
    [drawer1, drawer2].forEach(d => { d.setTool(tool); d.setColor(color); d.setWidth(width); });
  }

  document.querySelectorAll('#toolbar .tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#toolbar .tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyToolSettings();
    });
  });
  document.getElementById('pen-color').addEventListener('input', applyToolSettings);
  document.getElementById('pen-width').addEventListener('change', applyToolSettings);

  document.getElementById('btn-undo').addEventListener('click', () => {
    (lastActiveDrawer || drawer1).undo();
    scheduleAutosave();
  });
  document.getElementById('btn-redo').addEventListener('click', () => {
    (lastActiveDrawer || drawer1).redo();
    scheduleAutosave();
  });

  document.getElementById('btn-canvas-menu').addEventListener('click', async () => {
    if (confirm('Descartar o que não foi salvo e voltar aos rabiscos padrão?')) {
      const template = await Store.get('state', 'template');
      loadStrokesIntoCanvas(template ? template.strokes : emptyStrokes());
      scheduleAutosave();
    }
  });

  function setupPageIndicator() {
    const scroll = document.getElementById('canvas-scroll');
    const indicator = document.getElementById('page-indicator');
    const stages = [document.getElementById('page-stage-1'), document.getElementById('page-stage-2')];
    const io = new IntersectionObserver((entries) => {
      let best = null, bestRatio = 0;
      entries.forEach(en => { if (en.intersectionRatio > bestRatio) { bestRatio = en.intersectionRatio; best = en.target; } });
      if (best) indicator.textContent = best.dataset.page + ' / 2';
    }, { root: scroll, threshold: [0.25, 0.5, 0.75] });
    stages.forEach(s => io.observe(s));
  }

  // ---------- Salvar (define o padrão que abre em todo prontuário novo) ----------
  document.getElementById('btn-save').addEventListener('click', async () => {
    if (!confirm('Salvar o que está na tela como o padrão de todo prontuário novo?')) return;
    const strokes = currentStrokes();
    await Store.put('state', { id: 'template', strokes });
    await Store.put('state', { id: 'working', strokes });
    const btn = document.getElementById('btn-save');
    const original = btn.textContent;
    btn.textContent = 'Salvo!';
    setTimeout(() => { btn.textContent = original; }, 1200);
  });

  // ---------- Exportar PDF ----------
  function buildFilename(patientName) {
    const d = new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const datePart = pad2(d.getFullYear() % 100) + pad2(d.getMonth() + 1) + pad2(d.getDate());
    const namePart = normalizeSearch(patientName)
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    return `${datePart} ${namePart || 'paciente'}.pdf`;
  }

  document.getElementById('btn-export-pdf').addEventListener('click', async () => {
    const patientName = await promptModal('Nome do paciente', 'Usado só no nome do arquivo');
    if (patientName === null) return;

    clearTimeout(saveTimer);
    const btn = document.getElementById('btn-export-pdf');
    const originalText = btn.textContent;
    btn.textContent = 'Gerando...';
    btn.disabled = true;
    try {
      const bytes = await buildRecordPDF(drawersByPage);
      const filename = buildFilename(patientName);
      const result = await exportAndSharePDF(bytes, filename);
      if (result !== 'cancelled') {
        const template = await Store.get('state', 'template');
        const baseline = template ? template.strokes : emptyStrokes();
        loadStrokesIntoCanvas(baseline);
        await Store.put('state', { id: 'working', strokes: baseline });
      }
    } catch (err) {
      console.error(err);
      alert('Não foi possível gerar o PDF. Tente novamente.');
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });

  // ---------- Início ----------
  async function boot() {
    initDrawers();
    const working = await Store.get('state', 'working');
    let baseline = working ? working.strokes : null;
    if (!baseline) {
      const template = await Store.get('state', 'template');
      baseline = template ? template.strokes : emptyStrokes();
    }
    loadStrokesIntoCanvas(baseline);
    applyToolSettings();
    requestAnimationFrame(() => { drawer1.resize(); drawer2.resize(); });
    setupPageIndicator();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    });
  }

  boot();
})();
