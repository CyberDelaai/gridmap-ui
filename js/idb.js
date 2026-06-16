(function (GM) {
  'use strict';
  // ---- Persistence: keep the last loaded map across reloads (IndexedDB) ----
  // One slot ('current') holding the source image Blob; on load we restore it
  // and re-run analysis. Wrapped in try/catch so a blocked IDB never breaks
  // the app (it just won't persist).
  const IDB = (function () {
    const NAME = 'gridmap', STORE = 'map', KEY = 'current';
    function open() {
      return new Promise((res, rej) => {
        let r;
        try { r = indexedDB.open(NAME, 1); } catch (e) { return rej(e); }
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    function tx(mode, run) {
      return open().then((db) => new Promise((res, rej) => {
        const t = db.transaction(STORE, mode);
        const rq = run(t.objectStore(STORE));
        t.oncomplete = () => res(rq && rq.result);
        t.onerror = t.onabort = () => rej(t.error);
      }));
    }
    return {
      put: (blob) => tx('readwrite', (s) => s.put(blob, KEY)),
      get: () => tx('readonly', (s) => s.get(KEY)),
      clear: () => tx('readwrite', (s) => s.delete(KEY)),
    };
  })();
  GM.idb = IDB;
})(window.GM);
