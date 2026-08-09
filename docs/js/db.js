// Camada simples de acesso ao IndexedDB. Tudo fica salvo localmente no dispositivo.
// Modelo minimalista: um único registro "template" (os rabiscos padrão, atualizados pelo
// botão Salvar) e um único registro "working" (o que está na tela agora, salvo automaticamente
// pra não perder nada se o app fechar no meio do atendimento).
const DB_NAME = 'prontuarios-db';
const DB_VERSION = 3;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      ['clinics', 'patients', 'visits', 'drafts', 'presets'].forEach((old) => {
        if (db.objectStoreNames.contains(old)) db.deleteObjectStore(old);
      });
      if (!db.objectStoreNames.contains('state')) {
        db.createObjectStore('state', { keyPath: 'id' });
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
  async get(storeName, id) {
    const db = await openDB();
    return reqToPromise(tx(db, storeName, 'readonly').get(id));
  },
  async put(storeName, obj) {
    const db = await openDB();
    return reqToPromise(tx(db, storeName, 'readwrite').put(obj));
  }
};

// Remove acentos (usado para montar o nome do arquivo exportado).
function normalizeSearch(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
