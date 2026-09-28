/* Armazenamento local com a mesma interface que a app usava: db + assets.
   Usa IndexedDB; se não abrir (bloqueado, versão antiga, modo privado, demora),
   passa automaticamente para localStorage e, em último caso, para memória. */
(function () {
  "use strict";
  const DB_NAME = "vida-a-dois";
  const LS_DOC = "vad:doc:", LS_BLOB = "vad:blob:";
  let idb = null, mode = "connecting"; // "idb" | "ls" | "mem"
  const mem = new Map();            // "colecao/id" -> dados
  const memBlobs = new Map();       // só no modo "mem"
  const colL = new Map();
  const docL = new Map();
  const urlCache = new Map();

  /* ---------- IndexedDB ---------- */
  const openIDB = ver => new Promise((res, rej) => {
    let r;
    try { r = ver ? indexedDB.open(DB_NAME, ver) : indexedDB.open(DB_NAME); } catch (e) { rej(e); return; }
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("docs")) d.createObjectStore("docs");
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("blocked"));
  });
  async function openDB() {
    let d = await openIDB();                       // abre a versão que existir (evita VersionError)
    if (!d.objectStoreNames.contains("docs") || !d.objectStoreNames.contains("blobs")) {
      const v = d.version + 1; d.close(); d = await openIDB(v);
    }
    d.onversionchange = () => d.close();
    return d;
  }
  const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  const tx = (store, mode_, fn) => new Promise((res, rej) => {
    let t; try { t = idb.transaction(store, mode_); } catch (e) { rej(e); return; }
    const s = t.objectStore(store);
    let out; try { out = fn(s); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });

  /* ---------- localStorage ---------- */
  let lsOK = false;
  try { localStorage.setItem("vad:test", "1"); localStorage.removeItem("vad:test"); lsOK = true; } catch (e) {}
  const lsKeys = prefix => { const out = []; if (!lsOK) return out; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(prefix)) out.push(k); } return out; };
  const toDataURL = b => new Promise((r, j) => { const f = new FileReader(); f.onload = () => r(f.result); f.onerror = () => j(f.error); f.readAsDataURL(b); });
  function fromDataURL(dataUrl) { const [h, b] = dataUrl.split(","); const mime = (h.match(/:(.*?);/) || [])[1] || "application/octet-stream"; const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: mime }); }

  /* ---------- operações de baixo nível (conforme o modo) ---------- */
  const isQuota = e => e && (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014);
  async function putDoc(path, data) {
    if (mode === "idb") return tx("docs", "readwrite", s => s.put(data, path));
    if (mode === "ls") localStorage.setItem(LS_DOC + path, JSON.stringify(data));
  }
  async function delDoc(path) {
    if (mode === "idb") return tx("docs", "readwrite", s => s.delete(path));
    if (mode === "ls") localStorage.removeItem(LS_DOC + path);
  }
  async function putBlob(id, blob) {
    if (mode === "idb") return tx("blobs", "readwrite", s => s.put(blob, id));
    if (mode === "ls") return localStorage.setItem(LS_BLOB + id, await toDataURL(blob));
    memBlobs.set(id, blob);
  }
  async function getBlob(id) {
    if (mode === "idb") return tx("blobs", "readonly", s => s.get(id));
    if (mode === "ls") { const v = localStorage.getItem(LS_BLOB + id); return v ? fromDataURL(v) : undefined; }
    return memBlobs.get(id);
  }
  async function delBlob(id) {
    if (mode === "idb") return tx("blobs", "readwrite", s => s.delete(id));
    if (mode === "ls") return localStorage.removeItem(LS_BLOB + id);
    memBlobs.delete(id);
  }
  async function blobKeys() {
    if (mode === "idb") return tx("blobs", "readonly", s => s.getAllKeys());
    if (mode === "ls") return lsKeys(LS_BLOB).map(k => k.slice(LS_BLOB.length));
    return [...memBlobs.keys()];
  }
  async function clearAll() {
    if (mode === "idb") { await tx("docs", "readwrite", s => s.clear()); await tx("blobs", "readwrite", s => s.clear()); }
    else if (mode === "ls") [...lsKeys(LS_DOC), ...lsKeys(LS_BLOB)].forEach(k => localStorage.removeItem(k));
    else memBlobs.clear();
    mem.clear();
  }

  /* ---------- interface tipo base de dados ---------- */
  const split = p => { const i = p.indexOf("/"); return [p.slice(0, i), p.slice(i + 1)]; };
  const clone = v => JSON.parse(JSON.stringify(v));
  const colSnap = c => {
    const docs = [];
    for (const [k, v] of mem) { const [cc, id] = split(k); if (cc === c) docs.push({ id, data: () => clone(v) }); }
    return { docs };
  };
  const docSnap = p => ({ exists: mem.has(p), data: () => mem.has(p) ? clone(mem.get(p)) : undefined });
  const notify = p => {
    const [c] = split(p);
    (colL.get(c) || []).forEach(cb => { try { cb(colSnap(c)); } catch (e) {} });
    (docL.get(p) || []).forEach(cb => { try { cb(docSnap(p)); } catch (e) {} });
  };
  const add = (m, k, cb) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(cb); return () => m.get(k).delete(cb); };
  const wrapErr = e => isQuota(e) ? { code: "quota_exceeded" } : e;

  function doc(path) {
    return {
      async set(data) { const v = clone(data); try { await putDoc(path, v); } catch (e) { throw wrapErr(e); } mem.set(path, v); notify(path); },
      async update(data) { if (!mem.has(path)) throw { code: "not_found" }; return this.set({ ...mem.get(path), ...data }); },
      async delete() { try { await delDoc(path); } catch (e) { throw wrapErr(e); } mem.delete(path); notify(path); },
      async get() { return docSnap(path); },
      onSnapshot(cb) { const off = add(docL, path, cb); cb(docSnap(path)); return off; }
    };
  }
  const db = {
    collection: c => ({
      doc: id => doc(c + "/" + id),
      onSnapshot(cb) { const off = add(colL, c, cb); cb(colSnap(c)); return off; }
    }),
    doc
  };

  const newAssetId = () => "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const assets = {
    async upload(blob, opts) {
      const id = newAssetId();
      const b = (opts && opts.type && !blob.type) ? new Blob([blob], { type: opts.type }) : blob;
      try { await putBlob(id, b); } catch (e) { throw isQuota(e) ? { code: "quota_or_state" } : e; }
      return { id };
    },
    async get(id) { await ready; return getBlob(id); },
    async delete(id) {
      await delBlob(id);
      const u = urlCache.get(id); if (u) { URL.revokeObjectURL(u); urlCache.delete(id); }
    }
  };

  /* fotos: <img src="/_blob/ID"> -> object URL guardado no telemóvel */
  async function fixImg(img) {
    const src = img.getAttribute("src") || "";
    if (!src.startsWith("/_blob/")) return;
    await ready;
    const id = src.slice(7);
    let u = urlCache.get(id);
    if (!u) { try { const b = await getBlob(id); if (b) { u = URL.createObjectURL(b); urlCache.set(id, u); } } catch (e) {} }
    if (u && img.getAttribute("src") === src) img.setAttribute("src", u);
  }
  const scan = root => { if (root.nodeType !== 1) return; if (root.tagName === "IMG") fixImg(root); root.querySelectorAll && root.querySelectorAll('img[src^="/_blob/"]').forEach(fixImg); };
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(scan))).observe(document.documentElement, { childList: true, subtree: true });

  /* ---------- arranque ---------- */
  async function loadIDB() {
    idb = await timeout(openDB(), 5000);
    mode = "idb";
    await new Promise((res, rej) => {
      const t = idb.transaction("docs", "readonly"), c = t.objectStore("docs").openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { mem.set(cur.key, cur.value); cur.continue(); } };
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    // se numa abertura anterior os dados ficaram no localStorage, passam agora para o IndexedDB
    for (const k of lsKeys(LS_DOC)) {
      try { const p = k.slice(LS_DOC.length), v = JSON.parse(localStorage.getItem(k)); await putDoc(p, v); mem.set(p, v); localStorage.removeItem(k); } catch (e) {}
    }
    for (const k of lsKeys(LS_BLOB)) {
      try { await putBlob(k.slice(LS_BLOB.length), fromDataURL(localStorage.getItem(k))); localStorage.removeItem(k); } catch (e) {}
    }
  }
  function loadLS() {
    mode = "ls";
    for (const k of lsKeys(LS_DOC)) { try { mem.set(k.slice(LS_DOC.length), JSON.parse(localStorage.getItem(k))); } catch (e) {} }
  }
  const ready = (async () => {
    try { await loadIDB(); }
    catch (e) {
      console.warn("[vida-a-dois] IndexedDB indisponível, a usar alternativa:", e);
      try { if (idb) idb.close(); } catch (_) {}
      idb = null; mem.clear();
      if (lsOK) loadLS(); else mode = "mem";
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  })();

  window.claude = {
    use: async name => { await ready; return name === "db" ? db : name === "assets" ? assets : null; },
    storageMode: () => mode
  };

  /* ---------- guardar/partilhar ficheiros (app Android, iPhone e navegador) ---------- */
  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  async function saveFiles(files, title) {
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (isNative() && P && P.Filesystem && P.Share) {
      const uris = [];
      for (const f of files) {
        const b64 = (await toDataURL(f)).split(",")[1];
        const r = await P.Filesystem.writeFile({ path: f.name, data: b64, directory: "CACHE" });
        uris.push(r.uri);
      }
      try { await P.Share.share({ title: title || "Vida a Dois", files: uris, dialogTitle: title || "Guardar" }); }
      catch (e) { if (/cancel/i.test(String(e && (e.message || e)))) return "cancel"; throw e; }
      return "shared";
    }
    if (navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files, title: title || "Vida a Dois" }); return "shared"; }
      catch (e) { if (e && e.name === "AbortError") return "cancel"; }
    }
    for (const f of files) { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); await new Promise(r => setTimeout(r, 250)); }
    return "downloaded";
  }
  window.vadSaveFiles = saveFiles;
  window.vadIsNative = isNative;
  const currentMe = () => { try { return localStorage.getItem("vad-me"); } catch (e) { return null; } };

  /* ---------- cópia de segurança ---------- */
  async function exportAll() {
    await ready;
    const me = currentMe(), docs = {};
    // os gastos pessoais só seguem na cópia se forem de quem a está a exportar
    mem.forEach((v, k) => { if (k.startsWith("personal/") && (!v || v.owner !== me)) return; docs[k] = v; });
    const blobs = {};
    for (const k of await blobKeys()) { const b = await getBlob(k); if (b) blobs[k] = await toDataURL(b); }
    const json = JSON.stringify({ app: "vida-a-dois", version: 1, exportedAt: new Date().toISOString(), docs, blobs });
    const name = "vida-a-dois-" + new Date().toISOString().slice(0, 10) + ".json";
    const file = new File([json], name, { type: "application/json" });
    await saveFiles([file], "Cópia de segurança da Vida a Dois");
  }
  async function importAll(file) {
    await ready;
    let data; try { data = JSON.parse(await file.text()); } catch (e) { alert("Ficheiro inválido."); return; }
    if (!data || data.app !== "vida-a-dois" || !data.docs) { alert("O ficheiro selecionado não é uma cópia de segurança válida da Vida a Dois."); return; }
    if (!confirm("Esta operação substitui todos os dados deste dispositivo pelos da cópia de segurança. Pretende continuar?")) return;
    // mantém os gastos pessoais de quem usa este telemóvel
    const me = currentMe(), keep = [];
    mem.forEach((v, k) => { if (k.startsWith("personal/") && v && v.owner === me) keep.push([k, v]); });
    await clearAll();
    urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear();
    for (const [k, v] of Object.entries(data.docs)) {
      if (k.startsWith("personal/") && (!v || v.owner !== me)) continue; // gastos pessoais de outra pessoa não entram
      await putDoc(k, v);
    }
    for (const [k, v] of Object.entries(data.blobs || {})) await putBlob(k, fromDataURL(v));
    for (const [k, v] of keep) if (!(k in data.docs)) await putDoc(k, v);
    location.reload();
  }

  document.addEventListener("click", e => {
    if (e.target.closest("#bkExport")) exportAll().catch(() => alert("Não foi possível exportar."));
    else if (e.target.closest("#bkImport")) { const f = document.getElementById("bkFile"); if (f) f.click(); }
  });
  document.addEventListener("change", e => {
    if (e.target.id === "bkFile" && e.target.files[0]) { const f = e.target.files[0]; e.target.value = ""; importAll(f).catch(() => alert("Não foi possível importar.")); }
  });
})();
