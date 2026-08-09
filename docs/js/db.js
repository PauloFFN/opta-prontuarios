// Camada simples de acesso ao IndexedDB. Tudo fica salvo localmente no dispositivo.
const DB_NAME = 'prontuarios-db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
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
