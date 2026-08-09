// Camada simples de acesso ao IndexedDB. Tudo fica salvo localmente no dispositivo.
const DB_NAME = 'prontuarios-db';
const DB_VERSION = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('clinics')) {
        db.createObjectStore('clinics', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('presets')) {
        db.createObjectStore('presets', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('patients')) {
        db.createObjectStore('patients', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('visits')) {
        db.createObjectStore('visits', { keyPath: 'id' });
      }

      // Migra rascunhos do modelo antigo (v1) para o novo modelo de paciente + atendimento.
      if (event.oldVersion < 2) {
        const tx = req.transaction;
        const draftsStore = tx.objectStore('drafts');
        const patientsStore = tx.objectStore('patients');
        const visitsStore = tx.objectStore('visits');
        draftsStore.getAll().onsuccess = (e) => {
          const oldDrafts = e.target.result || [];
          oldDrafts.forEach((d) => {
            const patientId = uid();
            patientsStore.add({
              id: patientId,
              clinicId: d.clinicId,
              clinicName: d.clinicName,
              name: d.patientName || 'Sem nome',
              createdAt: d.createdAt || Date.now()
            });
            visitsStore.add({
              id: d.id,
              patientId,
              clinicId: d.clinicId,
              clinicName: d.clinicName,
              patientName: d.patientName || 'Sem nome',
              status: 'draft',
              strokes: d.strokes || { 1: [], 2: [] },
              pdfBlob: null,
              source: 'app',
              visitDate: d.createdAt || Date.now(),
              createdAt: d.createdAt || Date.now(),
              updatedAt: d.updatedAt || Date.now()
            });
          });
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const Store = {
  async all(storeName) {
    const db = await openDB();
    return reqToPromise(tx(db, storeName, 'readonly').getAll());
  },
  async get(storeName, id) {
    const db = await openDB();
    return reqToPromise(tx(db, storeName, 'readonly').get(id));
  },
  async put(storeName, obj) {
    const db = await openDB();
    return reqToPromise(tx(db, storeName, 'readwrite').put(obj));
  },
  async remove(storeName, id) {
    const db = await openDB();
    return reqToPromise(tx(db, storeName, 'readwrite').delete(id));
  }
};

function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// Remove acentos para permitir busca sem diferenciar "José" de "jose".
function normalizeSearch(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
