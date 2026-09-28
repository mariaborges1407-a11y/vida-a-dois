const V = "vad-v33";
const SHELL = ["./", "./index.html", "./local-store.js", "./sync.js", "./vendor/firebase-app-compat.js", "./vendor/firebase-auth-compat.js", "./vendor/firebase-firestore-compat.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== "vad-flags").map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url);
  const fonts = u.hostname === "fonts.googleapis.com" || u.hostname === "fonts.gstatic.com";
  if (u.origin !== location.origin && !fonts) return;
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(r, { ignoreSearch: true });
    const net = fetch(r).then(res => { if (res && (res.ok || res.type === "opaque")) c.put(r, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || (r.mode === "navigate" ? c.match("./index.html") : Response.error());
  }));
});

/* ---------- lembrete mensal ---------- */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./index.html#invest", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    for (const c of cs) { if ("focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
function readDocs() {
  return new Promise(res => {
    let r; try { r = indexedDB.open("vida-a-dois"); } catch (e) { res(null); return; }
    r.onerror = () => res(null);
    r.onupgradeneeded = () => { try { r.transaction.abort(); } catch (e) {} res(null); };
    r.onsuccess = () => {
      const d = r.result; if (!d.objectStoreNames.contains("docs")) { d.close(); res(null); return; }
      const out = {}, c = d.transaction("docs", "readonly").objectStore("docs").openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } else { d.close(); res(out); } };
      c.onerror = () => { d.close(); res(null); };
    };
  });
}
async function monthlyCheck() {
  const now = new Date(), last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (now.getDate() < Math.min(30, last)) return;
  const key = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  const docs = await readDocs(); if (!docs) return;
  const cfg = docs["config/settings"] || {};
  if ((cfg.monthly ?? 250) <= 0) return;
  if (Object.entries(docs).some(([k, v]) => k.startsWith("investments/") && v && v.kind === "mensal" && v.month === key)) return;
  const flags = await caches.open("vad-flags"), flag = "./_flag/notified-" + key;
  if (await flags.match(flag)) return;
  await flags.put(flag, new Response("1"));
  await self.registration.showNotification("Transferência mensal para investir", {
    body: "Está pendente a transferência mensal de " + (cfg.p1 || "Maria") + " para " + (cfg.p2 || "Bruno") + ".",
    icon: "./icons/icon-192.png", badge: "./icons/icon-192.png", tag: "vad-mensal", data: { url: "./index.html#invest" }
  });
}
self.addEventListener("periodicsync", e => { if (e.tag === "vad-mensal") e.waitUntil(monthlyCheck()); });
