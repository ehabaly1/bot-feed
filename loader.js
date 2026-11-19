(function () {
  "use strict";
  var KEY_SLOT = "bf_key_v1";      // derived AES key + salt (never the passcode)
  var LOCAL_SLOT = "bf_local_v1";  // comments sent from this device, until the feed includes them
  var DATA_URL = "data.enc.json";
  var te = new TextEncoder(), td = new TextDecoder();
  var state = { key: null, salt: "", payload: null, lastFetch: 0 };

  function $(id) { return document.getElementById(id); }
  function b64d(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function b64e(buf) { var u = new Uint8Array(buf), s = ""; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
  function hex(n) { var u = crypto.getRandomValues(new Uint8Array(n)); return Array.prototype.map.call(u, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }

  async function fetchDoc() {
    var res = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  async function deriveKey(pass, doc) {
    var base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: b64d(doc.salt), iterations: doc.iter },
      base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  }
  async function decrypt(key, doc) {
    var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(doc.iv) }, key, b64d(doc.ct));
    return JSON.parse(td.decode(pt));
  }
  async function saveKey(key, salt) {
    var raw = await crypto.subtle.exportKey("raw", key);
    localStorage.setItem(KEY_SLOT, JSON.stringify({ salt: salt, key: b64e(raw) }));
  }
  async function loadSavedKey(salt) {
    try {
      var s = JSON.parse(localStorage.getItem(KEY_SLOT) || "null");
      if (!s || s.salt !== salt) return null;
      return crypto.subtle.importKey("raw", b64d(s.key), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
    } catch (e) { return null; }
  }

  /* ---- local comments ---- */
  function readLocal() {
    try {
      var list = JSON.parse(localStorage.getItem(LOCAL_SLOT) || "[]");
      var cutoff = Date.now() - 7 * 864e5;
      return list.filter(function (c) { return Date.parse(c.at) > cutoff; });
    } catch (e) { return []; }
  }
  function writeLocal(list) { try { localStorage.setItem(LOCAL_SLOT, JSON.stringify(list.slice(-200))); } catch (e) { /* full */ } }
  function mergedFeed() {
    var feed = JSON.parse(JSON.stringify(state.payload.feed || { posts: [] }));
    var seen = {};
    (feed.posts || []).forEach(function (p) { (p.comments || []).forEach(function (c) { if (c.order_id) seen[c.order_id] = 1; }); });
    var local = readLocal().filter(function (c) { return !seen[c.order_id]; });
    writeLocal(local);
    local.forEach(function (c) {
      if (!c.post_id) return;
      (feed.posts || []).forEach(function (p) {
        if (p.post_id === c.post_id) { if (!Array.isArray(p.comments)) p.comments = []; p.comments.push(c.comment); }
      });
    });
    return feed;
  }
  function mergedOrders() {
    var known = {};
    (state.payload.orders || []).forEach(function (o) { known[o.order_id] = 1; });
    var local = readLocal().filter(function (c) { return !known[c.order_id]; }).map(function (c) {
      return { order_id: c.order_id, bot_name: c.bot_name, bot_id: c.bot_id, timestamp: c.at, status: c.comment.status, order: c.comment.text, error: "" };
    });
    return local.reverse().concat(state.payload.orders || []).slice(0, 50);
  }
  async function maybeRefresh() {
    if (Date.now() - state.lastFetch < 60000) return;
    state.lastFetch = Date.now();
    try {
      var doc = await fetchDoc();
      if (doc.salt !== state.salt) { localStorage.removeItem(KEY_SLOT); location.reload(); return; }
      state.payload = await decrypt(state.key, doc);
    } catch (e) { /* offline or box-independent hiccup: keep last data */ }
  }

  /* ---- sending ---- */
  async function relay(order) {
    var r = state.payload.relay || {}, w = state.payload.webhook || {};
    if (r.mode === "github" && r.token) {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, state.key, te.encode(JSON.stringify(order)));
      var res = await fetch("https://api.github.com/repos/" + r.repo + "/actions/workflows/" + r.workflow + "/dispatches", {
        method: "POST",
        headers: { "Authorization": "Bearer " + r.token, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ ref: r.ref || "main", inputs: { blob: b64e(iv) + "." + b64e(ct) } })
      });
      if (res.status !== 204) throw new Error("relay HTTP " + res.status);
      return;
    }
    if (!w.url || !w.key) throw new Error("not connected");
    var res2 = await fetch(w.url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + w.key, "Content-Type": "application/json" },
      body: JSON.stringify(order)
    });
    if (!res2.ok) throw new Error("webhook HTTP " + res2.status);
  }
  function json(code, obj) { return new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } }); }

  async function send(body, isComment) {
    var text = String((isComment ? body.text : body.order) || "").trim();
    if (!text) return json(400, { ok: false, error: "Write something first." });
    if (text.length > 4000) return json(400, { ok: false, error: "Too long (max 4000 characters)." });
    var order = { action: "order", bot_id: body.bot_id, bot_name: body.bot_name, order: text, order_id: hex(5) };
    if (isComment && body.post_id) order.post_id = body.post_id;
    try {
      await relay(order);
    } catch (e) {
      try { await navigator.clipboard.writeText(body.bot_name + ": " + text); } catch (e2) { /* ignore */ }
      return json(502, { ok: false, error: "Couldn't send (" + e.message + "). Copied — paste it in the Bot Office chat." });
    }
    var at = new Date().toISOString();
    var comment = { from: state.payload.me || "Me", text: text, at: at, status: "sent", order_id: order.order_id };
    var local = readLocal();
    local.push({ order_id: order.order_id, post_id: order.post_id || "", bot_id: order.bot_id, bot_name: order.bot_name, at: at, comment: comment });
    writeLocal(local);
    return json(200, { ok: true, order_id: order.order_id, comment: comment, status: "sent" });
  }

  function installShim() {
    var realFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.indexOf("/api/") !== 0) return realFetch(input, init);
      var path = url.split("?")[0], method = ((init && init.method) || "GET").toUpperCase();
      var body = {};
      try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { body = {}; }
      if (path === "/api/status") {
        var ok = !!((state.payload.relay || {}).token || (state.payload.webhook || {}).key);
        return json(200, { connected: ok, banner: ok ? "" : "Not connected yet", reason: ok ? "" : "Sending isn't set up yet" });
      }
      if (path === "/api/feed") { await maybeRefresh(); return json(200, mergedFeed()); }
      if (path === "/api/orders") return json(200, { orders: mergedOrders() });
      if (path === "/api/ping") return json(200, { ok: true });
      if (path === "/api/order" && method === "POST") return send(body, false);
      if (path === "/api/comment" && method === "POST") return send(body, true);
      return json(404, { ok: false, error: "Not found" });
    };
  }

  function boot() {
    $("lock").hidden = true;
    $("boot").style.display = "none";
    $("root").innerHTML = state.payload.body_html;
    installShim();
    var s = document.createElement("script");
    s.textContent = state.payload.app_js;
    document.body.appendChild(s);
  }

  async function start() {
    if ("serviceWorker" in navigator) { navigator.serviceWorker.register("sw.js").catch(function () {}); }
    $("boot").style.display = "flex";
    var doc;
    try { doc = await fetchDoc(); } catch (e) { $("boot").textContent = "Couldn't load the feed. Check your connection and reopen."; return; }
    state.salt = doc.salt; state.lastFetch = Date.now();
    var key = await loadSavedKey(doc.salt);
    if (key) {
      try { state.payload = await decrypt(key, doc); state.key = key; return boot(); } catch (e) { localStorage.removeItem(KEY_SLOT); }
    }
    $("boot").style.display = "none";
    $("lock").hidden = false;
    $("lockform").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var btn = $("unlock"), err = $("lockerr");
      btn.disabled = true; btn.textContent = "Opening…"; err.textContent = "";
      try {
        var k = await deriveKey($("pass").value, doc);
        state.payload = await decrypt(k, doc);
        state.key = k;
        await saveKey(k, doc.salt);
        $("pass").value = "";
        boot();
      } catch (e) {
        err.textContent = "Wrong passcode. Try again.";
        btn.disabled = false; btn.textContent = "Open";
      }
    });
  }
  start();
})();
