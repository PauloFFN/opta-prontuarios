// Orquestra as telas, o banco local (IndexedDB) e liga tudo ao motor de desenho.
(function () {
  'use strict';

  // Pede armazenamento persistente para o navegador não apagar os dados por falta de uso
  // (relevante no Safari/iOS, que pode limpar dados de site após 7 dias sem visita).
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // ---------- Navegação entre telas ----------
  function showView(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => {
      const target = el.dataset.nav;
      if (target === 'view-patients' && currentClinic) { openPatients(currentClinic); return; }
      if (target === 'view-patient' && currentPatient) { openPatient(currentPatient); return; }
      showView(target);
      if (target === 'view-home') refreshHome();
    });
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
  let currentClinic = null;
  let currentPatient = null;
  let currentVisit = null;
  let drawer1, drawer2;
  let presetDrawer1, presetDrawer2;
  let editingPresetId = null;
  let lastActiveMainDrawer = null;
  let lastActivePresetDrawer = null;
  let saveTimer = null;
  let pendingImportFiles = [];

  const drawersByPage = {};

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString('pt-BR');
  }
  function dateInputValue(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

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
      li.querySelector('.item-title').onclick = () => openPatients(c);
      li.querySelector('[data-action="del"]').onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Remover a clínica "${c.name}"? Isso apaga também os pacientes e o histórico salvos dentro do app para essa clínica (os PDFs já exportados nas suas pastas não são afetados).`)) {
          await cascadeDeleteClinic(c.id);
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

    const visits = await Store.all('visits');
    const drafts = visits.filter(v => v.status === 'draft');
    const draftListEl = document.getElementById('draft-list');
    const draftEmptyEl = document.getElementById('draft-empty');
    draftListEl.innerHTML = '';
    drafts.sort((a, b) => b.updatedAt - a.updatedAt);
    draftEmptyEl.style.display = drafts.length ? 'none' : 'block';
    drafts.forEach(v => {
      const li = document.createElement('li');
      li.className = 'list-item';
      li.innerHTML = `<div>
          <div class="item-title">${escapeHtml(v.patientName)} — ${escapeHtml(v.clinicName)}</div>
          <div class="item-sub">${formatDate(v.updatedAt)}</div>
        </div>
        <span class="item-actions"><button data-action="del">🗑</button></span>`;
      li.querySelector('.item-title').onclick = () => resumeVisit(v);
      li.querySelector('[data-action="del"]').onclick = async (e) => {
        e.stopPropagation();
        if (confirm('Apagar este atendimento em aberto?')) { await Store.remove('visits', v.id); refreshHome(); }
      };
      draftListEl.appendChild(li);
    });
  }

  async function cascadeDeleteClinic(clinicId) {
    const [patients, visits] = await Promise.all([Store.all('patients'), Store.all('visits')]);
    await Promise.all(patients.filter(p => p.clinicId === clinicId).map(p => Store.remove('patients', p.id)));
    await Promise.all(visits.filter(v => v.clinicId === clinicId).map(v => Store.remove('visits', v.id)));
    await Store.remove('clinics', clinicId);
  }

  document.getElementById('btn-add-clinic').addEventListener('click', async () => {
    const name = await promptModal('Nova clínica', 'Ex: Clínica Visão Clara');
    if (!name) return;
    await Store.put('clinics', { id: uid(), name, createdAt: Date.now() });
    refreshHome();
  });

  // ---- Busca global de pacientes ----
  const globalSearchInput = document.getElementById('global-search');
  globalSearchInput.addEventListener('input', async () => {
    const q = normalizeSearch(globalSearchInput.value.trim());
    const resultsEl = document.getElementById('global-search-results');
    const defaultSections = document.getElementById('home-default-sections');
    if (!q) {
      resultsEl.innerHTML = '';
      defaultSections.style.display = '';
      return;
    }
    defaultSections.style.display = 'none';
    const patients = await Store.all('patients');
    const matches = patients.filter(p => normalizeSearch(p.name).includes(q)).slice(0, 30);
    resultsEl.innerHTML = '';
    if (!matches.length) {
      resultsEl.innerHTML = '<li class="empty-hint">Nenhum paciente encontrado.</li>';
      return;
    }
    matches.forEach(p => {
      const li = document.createElement('li');
      li.className = 'list-item';
      li.innerHTML = `<div>
          <div class="item-title">${escapeHtml(p.name)}</div>
          <div class="item-sub">${escapeHtml(p.clinicName)}</div>
        </div>`;
      li.onclick = async () => {
        const clinic = await Store.get('clinics', p.clinicId);
        currentClinic = clinic || { id: p.clinicId, name: p.clinicName };
        globalSearchInput.value = '';
        resultsEl.innerHTML = '';
        defaultSections.style.display = '';
        openPatient(p);
      };
      resultsEl.appendChild(li);
    });
  });

  // ================= PACIENTES DE UMA CLÍNICA =================
  async function openPatients(clinic) {
    currentClinic = clinic;
    document.getElementById('patients-clinic-title').textContent = clinic.name;
    document.getElementById('patients-search').value = '';
    await renderPatientsList('');
    showView('view-patients');
  }

  async function renderPatientsList(query) {
    const [patients, visits] = await Promise.all([Store.all('patients'), Store.all('visits')]);
    const clinicPatients = patients.filter(p => p.clinicId === currentClinic.id);
    const q = normalizeSearch(query || '');
    const filtered = q ? clinicPatients.filter(p => normalizeSearch(p.name).includes(q)) : clinicPatients;
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    const listEl = document.getElementById('patients-list');
    const emptyEl = document.getElementById('patients-empty');
    listEl.innerHTML = '';
    emptyEl.style.display = filtered.length ? 'none' : 'block';
    emptyEl.textContent = clinicPatients.length ? 'Nenhum paciente encontrado com esse nome.' : 'Nenhum paciente cadastrado ainda.';

    filtered.forEach(p => {
      const patientVisits = visits.filter(v => v.patientId === p.id);
      const lastVisit = patientVisits.sort((a, b) => b.visitDate - a.visitDate)[0];
      const li = document.createElement('li');
      li.className = 'list-item';
      li.innerHTML = `<div>
          <div class="item-title">${escapeHtml(p.name)}</div>
          <div class="item-sub">${lastVisit ? 'Último atendimento: ' + formatDate(lastVisit.visitDate) : 'Sem atendimentos'}</div>
        </div>
        <span class="item-actions"><button data-action="del">🗑</button></span>`;
      li.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="del"]')) return;
        openPatient(p);
      });
      li.querySelector('[data-action="del"]').onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Remover "${p.name}" e todo o histórico salvo no app? Os PDFs já exportados nas suas pastas não são afetados.`)) {
          await Promise.all(patientVisits.map(v => Store.remove('visits', v.id)));
          await Store.remove('patients', p.id);
          renderPatientsList(document.getElementById('patients-search').value);
        }
      };
      listEl.appendChild(li);
    });
  }

  document.getElementById('patients-search').addEventListener('input', (e) => renderPatientsList(e.target.value));

  document.getElementById('btn-add-patient').addEventListener('click', async () => {
    const name = await promptModal('Novo paciente', 'Nome completo');
    if (!name) return;
    const patient = { id: uid(), clinicId: currentClinic.id, clinicName: currentClinic.name, name, createdAt: Date.now() };
    await Store.put('patients', patient);
    openPatient(patient);
  });

  document.getElementById('btn-import-pdfs').addEventListener('click', () => {
    pendingImportFiles = [];
    document.getElementById('import-file-input').value = '';
    document.getElementById('import-rows').innerHTML = '';
    document.getElementById('btn-do-import').style.display = 'none';
    showView('view-import');
  });

  // ================= HISTÓRICO DO PACIENTE =================
  async function openPatient(patient) {
    currentPatient = patient;
    if (!currentClinic || currentClinic.id !== patient.clinicId) {
      currentClinic = (await Store.get('clinics', patient.clinicId)) || { id: patient.clinicId, name: patient.clinicName };
    }
    document.getElementById('patient-title').textContent = patient.name;
    await renderVisitList();
    showView('view-patient');
  }

  async function renderVisitList() {
    const visits = (await Store.all('visits')).filter(v => v.patientId === currentPatient.id);
    visits.sort((a, b) => b.visitDate - a.visitDate);
    const listEl = document.getElementById('visit-list');
    const emptyEl = document.getElementById('visit-empty');
    listEl.innerHTML = '';
    emptyEl.style.display = visits.length ? 'none' : 'block';

    visits.forEach(v => {
      const li = document.createElement('li');
      li.className = 'list-item';
      const badge = v.status === 'draft'
        ? '<span class="status-badge draft">Rascunho</span>'
        : '<span class="status-badge done">Concluído' + (v.source === 'imported' ? ' · importado' : '') + '</span>';
      li.innerHTML = `<div>
          <div class="item-title">${formatDate(v.visitDate)}</div>
          <div class="item-sub">${badge}</div>
        </div>
        <span class="item-actions" id="visit-actions-${v.id}"></span>`;
      const actionsEl = li.querySelector(`#visit-actions-${v.id}`);
      if (v.status === 'draft') {
        const btn = document.createElement('button');
        btn.textContent = 'Continuar';
        btn.onclick = (e) => { e.stopPropagation(); resumeVisit(v); };
        actionsEl.appendChild(btn);
      } else {
        const shareBtn = document.createElement('button');
        shareBtn.textContent = 'Compartilhar';
        shareBtn.onclick = async (e) => {
          e.stopPropagation();
          const filename = sanitizeFilename(`${v.clinicName}_${v.patientName}_${dateInputValue(v.visitDate)}`) + '.pdf';
          await exportAndSharePDF(v.pdfBlob, filename);
        };
        actionsEl.appendChild(shareBtn);
      }
      const delBtn = document.createElement('button');
      delBtn.textContent = '🗑';
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (confirm('Apagar este atendimento do histórico do app? O PDF já salvo na pasta da clínica não é afetado.')) {
          await Store.remove('visits', v.id);
          renderVisitList();
        }
      };
      actionsEl.appendChild(delBtn);
      listEl.appendChild(li);
    });
  }

  document.getElementById('btn-new-visit').addEventListener('click', async () => {
    currentVisit = {
      id: uid(),
      patientId: currentPatient.id,
      clinicId: currentClinic.id,
      clinicName: currentClinic.name,
      patientName: currentPatient.name,
      status: 'draft',
      strokes: { 1: [], 2: [] },
      pdfBlob: null,
      source: 'app',
      visitDate: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await openPresetPicker();
  });

  // ================= ESCOLHER RABISCOS / INICIAR =================
  async function openPresetPicker() {
    document.getElementById('new-patient-name').textContent = currentVisit.patientName;
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
    const pickerList = document.getElementById('preset-picker-list');
    const checkedIds = Array.from(pickerList.querySelectorAll('input:checked')).map(i => i.dataset.id);
    const presets = pickerList._presets || [];
    const chosenPresets = presets.filter(p => checkedIds.includes(p.id));
    openCanvasForVisit(currentVisit, chosenPresets);
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
    if (confirm('Limpar todos os traços deste atendimento? Essa ação não pode ser desfeita.')) {
      drawer1.loadStrokes([]);
      drawer2.loadStrokes([]);
      scheduleAutosave();
    }
  });

  function scheduleAutosave() {
    if (!currentVisit) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistCurrentVisitDraft, 600);
  }

  async function persistCurrentVisitDraft() {
    if (!currentVisit) return;
    currentVisit.strokes = { 1: drawer1.getStrokes(), 2: drawer2.getStrokes() };
    currentVisit.status = 'draft';
    currentVisit.updatedAt = Date.now();
    await Store.put('visits', currentVisit);
  }

  function openCanvasForVisit(visit, initialPresets) {
    if (!drawer1) initMainDrawers();
    currentVisit = visit;
    document.getElementById('canvas-title').textContent = `${visit.patientName} — ${formatDate(visit.visitDate)}`;
    drawer1.loadStrokes(visit.strokes ? visit.strokes[1] : []);
    drawer2.loadStrokes(visit.strokes ? visit.strokes[2] : []);
    (initialPresets || []).forEach(p => {
      drawer1.addStrokes(p.strokes && p.strokes[1]);
      drawer2.addStrokes(p.strokes && p.strokes[2]);
    });
    applyToolSettingsToMain();
    lastActiveMainDrawer = null;
    showView('view-canvas');
    requestAnimationFrame(() => { drawer1.resize(); drawer2.resize(); });
    persistCurrentVisitDraft();
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

  async function resumeVisit(visit) {
    const patient = await Store.get('patients', visit.patientId);
    currentPatient = patient || { id: visit.patientId, name: visit.patientName, clinicId: visit.clinicId, clinicName: visit.clinicName };
    currentClinic = (await Store.get('clinics', visit.clinicId)) || { id: visit.clinicId, name: visit.clinicName };
    openCanvasForVisit(visit, []);
  }

  document.getElementById('btn-save-draft').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    await persistCurrentVisitDraft();
    openPatient(currentPatient);
  });

  document.getElementById('btn-export-pdf').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    const btn = document.getElementById('btn-export-pdf');
    const originalText = btn.textContent;
    btn.textContent = 'Gerando...';
    btn.disabled = true;
    try {
      const bytes = await buildRecordPDF(drawersByPage);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      currentVisit.strokes = { 1: drawer1.getStrokes(), 2: drawer2.getStrokes() };
      currentVisit.status = 'done';
      currentVisit.pdfBlob = blob;
      currentVisit.updatedAt = Date.now();
      await Store.put('visits', currentVisit);

      const filename = sanitizeFilename(`${currentVisit.clinicName}_${currentVisit.patientName}_${dateInputValue(currentVisit.visitDate)}`) + '.pdf';
      await exportAndSharePDF(blob, filename);
      openPatient(currentPatient);
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
    await persistCurrentVisitDraft();
    openPatient(currentPatient);
  });

  // ================= IMPORTAR PDFs ANTIGOS =================
  function titleCaseName(s) {
    return s.replace(/\s+/g, ' ').trim().replace(/\p{L}[\p{L}'-]*/gu, w => w.charAt(0).toUpperCase() + w.slice(1));
  }

  // Reconhece o padrão "AAMMDD nome" usado nos arquivos antigos (ex: 230212 maria ines silva).
  function parseFilenameConvention(filename, fileLastModified) {
    const base = filename.replace(/\.pdf$/i, '');
    const m = base.match(/^(\d{2})(\d{2})(\d{2})[\s_-]+(.+)$/);
    if (m) {
      const yy = parseInt(m[1], 10), mm = parseInt(m[2], 10), dd = parseInt(m[3], 10);
      const year = yy <= 68 ? 2000 + yy : 1900 + yy;
      let ts = fileLastModified;
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        ts = new Date(year, mm - 1, dd).getTime();
      }
      return { guessedName: titleCaseName(m[4].replace(/[_-]+/g, ' ')), guessedDate: ts };
    }
    return { guessedName: titleCaseName(base.replace(/[_-]+/g, ' ')), guessedDate: fileLastModified };
  }

  document.getElementById('import-file-input').addEventListener('change', (e) => {
    pendingImportFiles = Array.from(e.target.files || []);
    const rowsEl = document.getElementById('import-rows');
    rowsEl.innerHTML = '';
    pendingImportFiles.forEach((file, idx) => {
      const guess = parseFilenameConvention(file.name, file.lastModified || Date.now());
      const row = document.createElement('div');
      row.className = 'import-row';
      row.innerHTML = `
        <div class="import-filename">${escapeHtml(file.name)}</div>
        <div class="import-fields">
          <input type="text" class="import-name" data-idx="${idx}" value="${escapeHtml(guess.guessedName)}">
          <input type="date" class="import-date" data-idx="${idx}" value="${dateInputValue(guess.guessedDate)}">
        </div>`;
      rowsEl.appendChild(row);
    });
    document.getElementById('btn-do-import').style.display = pendingImportFiles.length ? 'block' : 'none';
    document.getElementById('btn-do-import').textContent = `Importar ${pendingImportFiles.length} arquivo(s)`;
  });

  document.getElementById('btn-do-import').addEventListener('click', async () => {
    const btn = document.getElementById('btn-do-import');
    btn.disabled = true;
    btn.textContent = 'Importando...';
    try {
      const existingPatients = (await Store.all('patients')).filter(p => p.clinicId === currentClinic.id);
      let created = 0;
      for (let idx = 0; idx < pendingImportFiles.length; idx++) {
        const file = pendingImportFiles[idx];
        const nameInput = document.querySelector(`.import-name[data-idx="${idx}"]`);
        const dateInput = document.querySelector(`.import-date[data-idx="${idx}"]`);
        const name = (nameInput.value || 'Sem nome').trim();
        const visitDate = dateInput.value ? new Date(dateInput.value + 'T12:00:00').getTime() : Date.now();

        let patient = existingPatients.find(p => normalizeSearch(p.name) === normalizeSearch(name));
        if (!patient) {
          patient = { id: uid(), clinicId: currentClinic.id, clinicName: currentClinic.name, name, createdAt: Date.now() };
          await Store.put('patients', patient);
          existingPatients.push(patient);
        }

        await Store.put('visits', {
          id: uid(),
          patientId: patient.id,
          clinicId: currentClinic.id,
          clinicName: currentClinic.name,
          patientName: patient.name,
          status: 'done',
          strokes: null,
          pdfBlob: file,
          source: 'imported',
          visitDate,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        created++;
      }
      alert(`${created} PDF(s) importado(s) com sucesso.`);
      openPatients(currentClinic);
    } catch (err) {
      console.error(err);
      alert('Não foi possível importar um ou mais arquivos.');
    } finally {
      btn.disabled = false;
    }
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
