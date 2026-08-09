// Orquestra as telas, o banco local (IndexedDB) e liga tudo ao motor de desenho.
(function () {
  'use strict';

  // ---------- Navegação entre telas ----------
  function showView(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => showView(el.dataset.nav));
  });

  // ---------- Modal genérico (prompt de texto) ----------
  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalBox = document.getElementById('modal-box');
  function closeModal() { modalBackdrop.classList.remove('active'); modalBox.innerHTML = ''; }
  modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });

  function promptModal(title, placeholder, initial) {
    return new Promise((resolve) => {
      modalBox.innerHTML = `
        <h3>${title}</h3>
        <input type="text" id="modal-input" placeholder="${placeholder || ''}" value="${initial || ''}">
        <div class="modal-actions">
          <button class="btn-cancel" id="modal-cancel">Cancelar</button>
          <button class="btn-ok" id="modal-ok">OK</button>
        </div>`;
      modalBackdrop.classList.add('active');
      const input = document.getElementById('modal-input');
      input.focus();
      document.getElementById('modal-cancel').onclick = () => { closeModal(); resolve(null); };
      document.getElementById('modal-ok').onclick = () => { const v = input.value.trim(); closeModal(); resolve(v || null); };
      input.onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('modal-ok').click(); };
    });
  }

  function listModal(title, items, renderLabel) {
    // items: array; retorna o item escolhido ou null
    return new Promise((resolve) => {
      const rows = items.map((it, idx) =>
        `<div class="list-item" data-idx="${idx}"><span class="item-title">${renderLabel(it)}</span></div>`
      ).join('') || '<p class="empty-hint">Nenhum rabisco salvo ainda.</p>';
      modalBox.innerHTML = `<h3>${title}</h3><div style="max-height:50vh;overflow-y:auto">${rows}</div>
        <div class="modal-actions"><button class="btn-cancel" id="modal-cancel">Fechar</button></div>`;
      modalBackdrop.classList.add('active');
      document.getElementById('modal-cancel').onclick = () => { closeModal(); resolve(null); };
      modalBox.querySelectorAll('.list-item').forEach(row => {
        row.onclick = () => { const it = items[Number(row.dataset.idx)]; closeModal(); resolve(it); };
      });
    });
  }

  // ---------- Estado ----------
  let currentClinic = null;      // {id, name}
  let currentDraft = null;       // {id, clinicId, clinicName, patientName, strokes, createdAt, updatedAt}
  let drawer1, drawer2;          // PageDrawer da tela de prontuário
  let presetDrawer1, presetDrawer2; // PageDrawer da tela de edição de rabisco
  let editingPresetId = null;
  let lastActiveMainDrawer = null;
  let lastActivePresetDrawer = null;
  let saveTimer = null;

  const drawersByPage = {}; // preenchido depois de instanciar

  // ================= HOME =================
  async function refreshHome() {
    const clinics = await Store.all('clinics');
    const clinicListEl = document.getElementById('clinic-list');
    clinicListEl.innerHTML = '';
    clinics.sort((a, b) => a.name.localeCompare(b.name)).forEach(c => {
      const li = document.createElement('li');
      li.className = 'list-item';
      li.innerHTML = `<span class="item-title">${escapeHtml(c.name)}</span>
        <span class="item-actions"><button data-action="del">🗑</button></span>`;
      li.querySelector('.item-title').onclick = () => openNewRecord(c);
      li.querySelector('[data-action="del"]').onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Remover a clínica "${c.name}"? Os prontuários já exportados não são afetados.`)) {
          await Store.remove('clinics', c.id);
          refreshHome();
        }
      };
      clinicListEl.appendChild(li);
    });
    if (!clinics.length) {
      const li = document.createElement('li');
      li.className = 'empty-hint';
      li.textContent = 'Nenhuma clínica cadastrada ainda.';
      clinicListEl.appendChild(li);
    }

    const drafts = await Store.all('drafts');
    const draftListEl = document.getElementById('draft-list');
    const draftEmptyEl = document.getElementById('draft-empty');
    draftListEl.innerHTML = '';
    drafts.sort((a, b) => b.updatedAt - a.updatedAt);
    draftEmptyEl.style.display = drafts.length ? 'none' : 'block';
    drafts.forEach(d => {
      const li = document.createElement('li');
      li.className = 'list-item';
      const dt = new Date(d.updatedAt);
      li.innerHTML = `<div>
          <div class="item-title">${escapeHtml(d.clinicName)}${d.patientName ? ' — ' + escapeHtml(d.patientName) : ''}</div>
          <div class="item-sub">${dt.toLocaleDateString('pt-BR')} ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <span class="item-actions"><button data-action="del">🗑</button></span>`;
      li.querySelector('.item-title').onclick = () => resumeDraft(d);
      li.querySelector('[data-action="del"]').onclick = async (e) => {
        e.stopPropagation();
        if (confirm('Apagar este rascunho?')) { await Store.remove('drafts', d.id); refreshHome(); }
      };
      draftListEl.appendChild(li);
    });
  }

  document.getElementById('btn-add-clinic').addEventListener('click', async () => {
    const name = await promptModal('Nova clínica', 'Ex: Clínica Visão Clara');
    if (!name) return;
    await Store.put('clinics', { id: uid(), name, createdAt: Date.now() });
    refreshHome();
  });

  // ================= NOVO PRONTUÁRIO =================
  async function openNewRecord(clinic) {
    currentClinic = clinic;
    document.getElementById('new-clinic-name').textContent = clinic.name;
    document.getElementById('new-patient').value = '';

    const presets = await Store.all('presets');
    const pickerList = document.getElementById('preset-picker-list');
    const pickerEmpty = document.getElementById('preset-picker-empty');
    pickerList.innerHTML = '';
    pickerEmpty.style.display = presets.length ? 'none' : 'block';
    presets.sort((a, b) => a.name.localeCompare(b.name)).forEach(p => {
      const li = document.createElement('li');
      li.className = 'list-item';
      li.innerHTML = `<span class="item-title">${escapeHtml(p.name)}</span>
        <input type="checkbox" class="preset-check" data-id="${p.id}" ${p.autoLoad ? 'checked' : ''}>`;
      li.onclick = (e) => {
        if (e.target.tagName !== 'INPUT') {
          const cb = li.querySelector('input');
          cb.checked = !cb.checked;
        }
      };
      pickerList.appendChild(li);
    });
    pickerList._presets = presets;
    showView('view-new');
  }

  document.getElementById('btn-start-record').addEventListener('click', async () => {
    const patientName = document.getElementById('new-patient').value.trim();
    const pickerList = document.getElementById('preset-picker-list');
    const checkedIds = Array.from(pickerList.querySelectorAll('input:checked')).map(i => i.dataset.id);
    const presets = pickerList._presets || [];
    const chosenPresets = presets.filter(p => checkedIds.includes(p.id));

    currentDraft = {
      id: uid(),
      clinicId: currentClinic.id,
      clinicName: currentClinic.name,
      patientName,
      strokes: { 1: [], 2: [] },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    openCanvasForDraft(currentDraft, chosenPresets);
  });

  // ================= TELA CANVAS (prontuário) =================
  function initMainDrawers() {
    drawer1 = new PageDrawer(document.getElementById('draw-canvas-1'));
    drawer2 = new PageDrawer(document.getElementById('draw-canvas-2'));
    drawersByPage[1] = drawer1;
    drawersByPage[2] = drawer2;
    [drawer1, drawer2].forEach(d => {
      d.onChange = () => { lastActiveMainDrawer = d; scheduleAutosave(); };
    });
    requestAnimationFrame(() => { drawer1.resize(); drawer2.resize(); });
  }

  function applyToolSettingsToMain() {
    const tool = document.querySelector('#toolbar .tool-btn.active').dataset.tool;
    const color = document.getElementById('pen-color').value;
    const width = document.getElementById('pen-width').value;
    [drawer1, drawer2].forEach(d => { d.setTool(tool); d.setColor(color); d.setWidth(width); });
  }

  document.querySelectorAll('#toolbar .tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#toolbar .tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyToolSettingsToMain();
    });
  });
  document.getElementById('pen-color').addEventListener('input', applyToolSettingsToMain);
  document.getElementById('pen-width').addEventListener('change', applyToolSettingsToMain);

  document.getElementById('btn-undo').addEventListener('click', () => {
    (lastActiveMainDrawer || drawer1).undo();
    scheduleAutosave();
  });
  document.getElementById('btn-redo').addEventListener('click', () => {
    (lastActiveMainDrawer || drawer1).redo();
    scheduleAutosave();
  });

  document.getElementById('btn-insert-preset').addEventListener('click', async () => {
    const presets = await Store.all('presets');
    const chosen = await listModal('Inserir rabisco', presets, p => escapeHtml(p.name));
    if (!chosen) return;
    drawer1.addStrokes(chosen.strokes && chosen.strokes[1]);
    drawer2.addStrokes(chosen.strokes && chosen.strokes[2]);
    scheduleAutosave();
  });

  document.getElementById('btn-canvas-menu').addEventListener('click', () => {
    if (confirm('Limpar todos os traços deste prontuário? Essa ação não pode ser desfeita.')) {
      drawer1.loadStrokes([]);
      drawer2.loadStrokes([]);
      scheduleAutosave();
    }
  });

  function scheduleAutosave() {
    if (!currentDraft) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistCurrentDraft, 600);
  }

  async function persistCurrentDraft() {
    if (!currentDraft) return;
    currentDraft.strokes = { 1: drawer1.getStrokes(), 2: drawer2.getStrokes() };
    currentDraft.updatedAt = Date.now();
    await Store.put('drafts', currentDraft);
  }

  function openCanvasForDraft(draft, initialPresets) {
    if (!drawer1) initMainDrawers();
    document.getElementById('canvas-title').textContent =
      draft.clinicName + (draft.patientName ? ' — ' + draft.patientName : '');
    drawer1.loadStrokes(draft.strokes[1]);
    drawer2.loadStrokes(draft.strokes[2]);
    (initialPresets || []).forEach(p => {
      drawer1.addStrokes(p.strokes && p.strokes[1]);
      drawer2.addStrokes(p.strokes && p.strokes[2]);
    });
    applyToolSettingsToMain();
    lastActiveMainDrawer = null;
    showView('view-canvas');
    requestAnimationFrame(() => { drawer1.resize(); drawer2.resize(); });
    persistCurrentDraft();
    setupPageIndicator();
  }

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

  async function resumeDraft(draft) {
    currentDraft = draft;
    openCanvasForDraft(draft, []);
  }

  document.getElementById('btn-save-draft').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    await persistCurrentDraft();
    showView('view-home');
    refreshHome();
  });

  document.getElementById('btn-export-pdf').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    await persistCurrentDraft();
    const btn = document.getElementById('btn-export-pdf');
    const originalText = btn.textContent;
    btn.textContent = 'Gerando...';
    btn.disabled = true;
    try {
      const bytes = await buildRecordPDF(drawersByPage);
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = sanitizeFilename(`${currentDraft.clinicName}_${currentDraft.patientName || 'paciente'}_${dateStr}`) + '.pdf';
      const result = await exportAndSharePDF(bytes, filename);
      if (result !== 'cancelled') {
        if (confirm('PDF exportado. Apagar o rascunho salvo localmente?')) {
          await Store.remove('drafts', currentDraft.id);
          currentDraft = null;
          showView('view-home');
          refreshHome();
        }
      }
    } catch (err) {
      console.error(err);
      alert('Não foi possível gerar o PDF. Tente novamente.');
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });

  document.getElementById('btn-canvas-back').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    await persistCurrentDraft();
    refreshHome();
  });

  // ================= MEUS RABISCOS (lista) =================
  document.getElementById('btn-open-presets').addEventListener('click', openPresetsList);

  async function openPresetsList() {
    const presets = await Store.all('presets');
    const listEl = document.getElementById('presets-manage-list');
    listEl.innerHTML = '';
    presets.sort((a, b) => a.name.localeCompare(b.name)).forEach(p => {
      const li = document.createElement('li');
      li.className = 'list-item';
      li.innerHTML = `
        <div>
          <div class="item-title">${escapeHtml(p.name)}</div>
          <div class="item-sub">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="checkbox" data-action="autoload" ${p.autoLoad ? 'checked' : ''}>
              Carregar automaticamente em prontuários novos
            </label>
          </div>
        </div>
        <span class="item-actions">
          <button data-action="edit">Editar</button>
          <button data-action="del">🗑</button>
        </span>`;
      li.querySelector('[data-action="edit"]').onclick = () => openPresetEditor(p);
      li.querySelector('[data-action="del"]').onclick = async () => {
        if (confirm(`Apagar o rabisco "${p.name}"?`)) { await Store.remove('presets', p.id); openPresetsList(); }
      };
      li.querySelector('[data-action="autoload"]').onchange = async (e) => {
        p.autoLoad = e.target.checked;
        await Store.put('presets', p);
      };
      listEl.appendChild(li);
    });
    if (!presets.length) {
      listEl.innerHTML = '<li class="empty-hint">Nenhum rabisco salvo ainda. Toque em "+" para criar um.</li>';
    }
    showView('view-presets');
  }

  document.getElementById('btn-new-preset').addEventListener('click', () => openPresetEditor(null));

  // ================= EDITOR DE RABISCO =================
  function initPresetDrawers() {
    presetDrawer1 = new PageDrawer(document.getElementById('preset-draw-canvas-1'));
    presetDrawer2 = new PageDrawer(document.getElementById('preset-draw-canvas-2'));
    [presetDrawer1, presetDrawer2].forEach(d => {
      d.onChange = () => { lastActivePresetDrawer = d; };
    });
  }

  function applyToolSettingsToPreset() {
    const tool = document.querySelector('#view-preset-editor .tool-btn.active').dataset.tool;
    const color = document.getElementById('preset-pen-color').value;
    const width = document.getElementById('preset-pen-width').value;
    [presetDrawer1, presetDrawer2].forEach(d => { d.setTool(tool); d.setColor(color); d.setWidth(width); });
  }

  document.querySelectorAll('#view-preset-editor .tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#view-preset-editor .tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyToolSettingsToPreset();
    });
  });
  document.getElementById('preset-pen-color').addEventListener('input', applyToolSettingsToPreset);
  document.getElementById('preset-pen-width').addEventListener('change', applyToolSettingsToPreset);
  document.getElementById('btn-preset-undo').addEventListener('click', () => (lastActivePresetDrawer || presetDrawer1).undo());
  document.getElementById('btn-preset-redo').addEventListener('click', () => (lastActivePresetDrawer || presetDrawer1).redo());

  function openPresetEditor(preset) {
    if (!presetDrawer1) initPresetDrawers();
    editingPresetId = preset ? preset.id : null;
    document.getElementById('preset-name-input').value = preset ? preset.name : '';
    presetDrawer1.loadStrokes(preset && preset.strokes ? preset.strokes[1] : []);
    presetDrawer2.loadStrokes(preset && preset.strokes ? preset.strokes[2] : []);
    applyToolSettingsToPreset();
    lastActivePresetDrawer = null;
    showView('view-preset-editor');
    requestAnimationFrame(() => { presetDrawer1.resize(); presetDrawer2.resize(); });
  }

  document.getElementById('btn-save-preset').addEventListener('click', async () => {
    const name = document.getElementById('preset-name-input').value.trim();
    if (!name) { alert('Dê um nome para esse rabisco.'); return; }
    const existing = editingPresetId ? await Store.get('presets', editingPresetId) : null;
    const preset = {
      id: editingPresetId || uid(),
      name,
      autoLoad: existing ? existing.autoLoad : false,
      strokes: { 1: presetDrawer1.getStrokes(), 2: presetDrawer2.getStrokes() },
      createdAt: existing ? existing.createdAt : Date.now()
    };
    await Store.put('presets', preset);
    openPresetsList();
  });

  // ---------- util ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Service worker (offline) ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    });
  }

  refreshHome();
})();
