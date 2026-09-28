/* Sincronização entre telemóveis (Firebase) com cifragem ponta-a-ponta.
   - Tudo o que sai do telemóvel é cifrado (AES-GCM) com a "palavra-passe do casal".
   - Os gastos pessoais já vêm cifrados com a palavra-passe pessoal e ficam numa área só do próprio (users/{uid}).
   - Só viajam alterações (campo "u" = hora do servidor); as fotografias são descarregadas quando são precisas. */
(function () {
  "use strict";
  const CONFIG = {
    apiKey: "AIzaSyCFpuXWTVsGCIj2aCDNDznMfnypfhvo0Co",
    authDomain: "vida-a-dois-f848c.firebaseapp.com",
    projectId: "vida-a-dois-f848c",
    storageBucket: "vida-a-dois-f848c.firebasestorage.app",
    messagingSenderId: "551834027913",
    appId: "1:551834027913:web:806d752aa10ecca4cf8358"
  };
  const CHUNK = 700 * 1024, ITER = 310000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64e = u8 => { let s = ""; const a = new Uint8Array(u8); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
  const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + ":" + s.length; };
  const sha = async s => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 40);

  let fb = null, fs = null, auth = null, user = null, coupleKey = null, running = false, unsubs = [], me = null;
  let status = { state: "off", last: lsGet("vad-sync-last", 0), error: "" };
  const listeners = new Set();
  const emit = () => listeners.forEach(f => { try { f(status); } catch (e) {} });
  const setStatus = (o) => { Object.assign(status, o); emit(); };

  /* ---------- chave do casal guardada no telemóvel (não exportável) ---------- */
  const keyDB = () => new Promise((res, rej) => { const r = indexedDB.open("vida-a-dois-keys", 1); r.onupgradeneeded = () => r.result.createObjectStore("k"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function keyGet() { try { const d = await keyDB(); return await new Promise(r => { const q = d.transaction("k").objectStore("k").get("couple"); q.onsuccess = () => r(q.result || null); q.onerror = () => r(null); }); } catch (e) { return null; } }
  async function keyPut(v) { const d = await keyDB(); await new Promise((r, j) => { const t = d.transaction("k", "readwrite"); v ? t.objectStore("k").put(v, "couple") : t.objectStore("k").delete("couple"); t.oncomplete = r; t.onerror = () => j(t.error); }); }
  async function deriveCouple(pass, salt) {
    const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64d(salt), iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function seal(obj) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, coupleKey, enc.encode(JSON.stringify(obj)))); return { iv: b64e(iv), ct: firebase.firestore.Blob.fromUint8Array(ct) }; }
  async function open_(d) { const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(d.iv) }, coupleKey, d.ct.toUint8Array()); return JSON.parse(dec.decode(pt)); }

  /* ---------- Firebase ---------- */
  function init() {
    if (fb) return true;
    if (!window.firebase || !firebase.initializeApp) return false;
    fb = firebase.initializeApp(CONFIG);
    auth = firebase.auth();
    fs = firebase.firestore();
    try { fs.settings({ experimentalAutoDetectLongPolling: true, merge: true }); } catch (e) {}
    try { fs.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) {}
    auth.onAuthStateChanged(u => { user = u; if (!u) stop(); emit(); maybeStart(); });
    return true;
  }
  const isPrivate = p => p.startsWith("personal/") || p.startsWith("auth/");
  const colFor = p => isPrivate(p) ? fs.collection("users").doc(user.uid).collection("items") : fs.collection("items");

  /* ---------- enviar ---------- */
  const H = () => lsGet("vad-sync-h", {});
  async function pushDoc(path, data) {
    if (!running) return;
    if (path.startsWith("personal/") && (!data || data.owner !== me) && data !== null) return; // só os meus gastos pessoais
    if (path.startsWith("auth/") && path !== "auth/" + me) return;
    const id = await sha(path);
    const payload = data === null ? { p: path, del: true } : { p: path, d: data };
    const sealed = await seal(payload);
    await colFor(path).doc(id).set({ ...sealed, u: firebase.firestore.FieldValue.serverTimestamp(), ...(data === null ? { del: true } : {}) });
    const h = H(); if (data === null) delete h[path]; else h[path] = fnv(JSON.stringify(data)); lsSet("vad-sync-h", h);
  }
  async function pushBlob(id, blob) {
    if (!running) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, coupleKey, new Uint8Array(await blob.arrayBuffer())));
    const n = Math.ceil(ct.length / CHUNK) || 1;
    for (let i = 0; i < n; i++) await fs.collection("blobs").doc(id + "_" + i).set({ d: firebase.firestore.Blob.fromUint8Array(ct.subarray(i * CHUNK, (i + 1) * CHUNK)) });
    await fs.collection("blobs").doc(id).set({ iv: b64e(iv), n, type: blob.type || "image/jpeg", u: firebase.firestore.FieldValue.serverTimestamp() });
    const s = new Set(lsGet("vad-sync-b", [])); s.add(id); lsSet("vad-sync-b", [...s]);
  }
  async function delBlobRemote(id) {
    if (!running) return;
    try { const m = await fs.collection("blobs").doc(id).get(); const n = m.exists ? (m.data().n || 1) : 0; for (let i = 0; i < n; i++) await fs.collection("blobs").doc(id + "_" + i).delete(); await fs.collection("blobs").doc(id).delete(); } catch (e) {}
    const s = new Set(lsGet("vad-sync-b", [])); s.delete(id); lsSet("vad-sync-b", [...s]);
  }
  async function fetchBlob(id) {
    if (!running) return null;
    try {
      const m = await fs.collection("blobs").doc(id).get(); if (!m.exists) return null;
      const meta = m.data(), parts = [];
      for (let i = 0; i < meta.n; i++) { const c = await fs.collection("blobs").doc(id + "_" + i).get(); if (!c.exists) return null; parts.push(c.data().d.toUint8Array()); }
      const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; parts.forEach(p => { all.set(p, o); o += p.length; });
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(meta.iv) }, coupleKey, all);
      const blob = new Blob([pt], { type: meta.type || "image/jpeg" });
      const s = new Set(lsGet("vad-sync-b", [])); s.add(id); lsSet("vad-sync-b", [...s]);
      return blob;
    } catch (e) { return null; }
  }

  /* ---------- receber ---------- */
  async function applySnap(snap, key) {
    let maxU = lsGet(key, 0), changed = false;
    for (const ch of snap.docChanges()) {
      const d = ch.doc.data(); if (!d || !d.iv || !d.ct || ch.doc.metadata.hasPendingWrites) continue;
      const u = d.u && d.u.toMillis ? d.u.toMillis() : 0; if (u > maxU) maxU = u;
      let obj; try { obj = await open_(d); } catch (e) { continue; }
      const path = obj.p; if (!path) continue;
      const h = H();
      if (obj.del) { if (window.vadStore.has(path)) { await window.vadStore.applyRemote(path, null); changed = true; } delete h[path]; lsSet("vad-sync-h", h); continue; }
      if (path.startsWith("auth/")) { // conta pessoal vinda de outro telemóvel
        const local = window.vadStore.get(path);
        if (local && local.salt !== obj.d.salt) { window.vadSyncAuthConflict = obj.d; emit(); continue; }
      }
      const f = fnv(JSON.stringify(obj.d));
      if (h[path] !== f || !window.vadStore.has(path)) { await window.vadStore.applyRemote(path, obj.d); changed = true; }
      h[path] = f; lsSet("vad-sync-h", h);
    }
    lsSet(key, maxU);
    const now = Date.now(); lsSet("vad-sync-last", now); setStatus({ state: "on", last: now, error: "" });
    return changed;
  }
  function listen(col, key) {
    const since = firebase.firestore.Timestamp.fromMillis(lsGet(key, 0));
    return new Promise(res => {
      let first = true;
      const off = col.where("u", ">", since).orderBy("u").onSnapshot({ includeMetadataChanges: false }, async snap => {
        await applySnap(snap, key); if (first) { first = false; res(); }
      }, err => { setStatus({ state: "error", error: String(err && err.code || err) }); if (first) { first = false; res(); } });
      unsubs.push(off);
    });
  }

  /* ---------- reconciliação: envia o que mudou localmente desde a última vez ---------- */
  async function reconcile() {
    const h = H(), docs = window.vadStore.all(), seen = new Set();
    for (const [path, data] of Object.entries(docs)) {
      if (path.startsWith("personal/") && data.owner !== me) continue;
      if (path.startsWith("auth/") && path !== "auth/" + me) continue;
      seen.add(path);
      if (h[path] !== fnv(JSON.stringify(data))) { try { await pushDoc(path, data); } catch (e) {} }
    }
    for (const path of Object.keys(h)) if (!seen.has(path) && !(path.startsWith("personal/") || path.startsWith("auth/")) ) { try { await pushDoc(path, null); } catch (e) {} }
    const synced = new Set(lsGet("vad-sync-b", []));
    for (const id of await window.vadStore.blobKeys()) if (!synced.has(id)) { try { const b = await window.vadStore.getBlob(id); if (b) await pushBlob(id, b); } catch (e) {} }
  }

  async function maybeStart() {
    if (running || !user || !me) return;
    if (!coupleKey) coupleKey = await keyGet();
    if (!coupleKey) { setStatus({ state: "needkey" }); return; }
    running = true; setStatus({ state: "syncing" });
    try {
      await Promise.all([listen(fs.collection("items"), "vad-sync-u"), listen(fs.collection("users").doc(user.uid).collection("items"), "vad-sync-up")]);
      await reconcile();
      setStatus({ state: "on", last: Date.now() });
    } catch (e) { setStatus({ state: "error", error: String(e && e.message || e) }); }
  }
  function stop() { unsubs.forEach(f => { try { f(); } catch (e) {} }); unsubs = []; running = false; if (status.state !== "off") setStatus({ state: user ? "paused" : "off" }); }

  /* ---------- API para a app ---------- */
  window.vadSync = {
    available: () => init(),
    status: () => ({ ...status, email: user && user.email, signedIn: !!user, hasKey: !!coupleKey }),
    onChange: f => { listeners.add(f); return () => listeners.delete(f); },
    setUser: u => { me = u; if (!u) stop(); else maybeStart(); },
    async signIn(email, pass) { init(); await auth.signInWithEmailAndPassword(email.trim(), pass); },
    async coupleExists() { const m = await fs.collection("meta").doc("couple").get(); return m.exists ? m.data() : null; },
    async setCouplePass(pass, create) {
      let meta = await this.coupleExists();
      if (!meta) {
        if (!create) throw { code: "no_couple" };
        const salt = b64e(crypto.getRandomValues(new Uint8Array(16)));
        coupleKey = await deriveCouple(pass, salt);
        const chk = await seal({ ok: "vida-a-dois" });
        await fs.collection("meta").doc("couple").set({ salt, iter: ITER, check: chk });
      } else {
        const k = await deriveCouple(pass, meta.salt); const old = coupleKey; coupleKey = k;
        try { const o = await open_(meta.check); if (o.ok !== "vida-a-dois") throw 0; } catch (e) { coupleKey = old; throw { code: "wrong_couple" }; }
      }
      await keyPut(coupleKey); maybeStart();
    },
    async disconnect() { stop(); coupleKey = null; await keyPut(null); ["vad-sync-h", "vad-sync-b", "vad-sync-u", "vad-sync-up", "vad-sync-last"].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} }); if (auth) await auth.signOut(); setStatus({ state: "off" }); },
    async now() { stop(); await maybeStart(); },
    pushDoc: (p, d) => pushDoc(p, d).catch(() => {}),
    pushBlob: (id, b) => pushBlob(id, b).catch(() => {}),
    delBlob: id => delBlobRemote(id),
    fetchBlob,
    running: () => running
  };
  init();
})();
