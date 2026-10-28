/* ============================================================================
   • ๔คภภเкคร ฬгl๔ • — little chat room
   Works on the lock page (a floating bubble) and inside the site (a sidebar
   panel). Messages live in Cloudflare (functions/api/chat.js + a D1 database)
   and need a separate short chat code, so strangers who find the page can't
   read them. This file loads straight from index.html, before unlocking.

   Alerts: a soft chime, "(1) New message" in the tab title, and real push
   notifications (sw.js) that arrive even with the site closed, once the
   browser is allowed to show notifications. iPhone needs the site added to
   the Home Screen first; that's Apple's rule for web push.

   Device-only storage (never synced, never in backups): wrldchat.code,
   wrldchat.name, wrldchat.seen, wrldchat.sound
   ============================================================================ */
(function () {
  "use strict";

  const API = "/api/chat";
  const FAST = 3000;    // checking for new messages while the chat is open
  const SLOW = 30000;   // ...while it's closed (for the unread dot)
  const HIDDEN = 15000; // ...while on another tab (browsers may slow this to ~1/min)
  const K = { code: "wrldchat.code", name: "wrldchat.name", seen: "wrldchat.seen", sound: "wrldchat.sound", iosHint: "wrldchat.iosHint" };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const icon = (n) => (window.wrldIcon ? window.wrldIcon(n) : "");
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let code = store.get(K.code);
  let me = store.get(K.name) || "";
  let lastId = 0;
  let seenId = parseInt(store.get(K.seen), 10) || 0;
  let messages = [];
  let open = false;
  let timer = null;
  let busy = false;
  let lastDay = "";
  let soundOn = store.get(K.sound) !== "off";
  let unreadHidden = 0;
  const baseTitle = document.title;

  /* ---------- alerts: chime, tab title, desktop pop-up ---------- */
  let actx = null;
  function unlockAudio() {
    try {
      if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); }
      if (actx && actx.state === "suspended") actx.resume();
    } catch (e) { /* no audio */ }
  }
  // browsers only allow sound after the person has tapped or typed on the page once
  ["pointerdown", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));

  function tone(freqs, vol, dur, gap) {
    if (!soundOn || !actx || actx.state === "closed") return;
    if (actx.state !== "running") { actx.resume().then(() => { if (actx.state === "running") tone(freqs, vol, dur, gap); }, () => {}); return; }
    const t0 = actx.currentTime + 0.01;
    freqs.forEach((f, i) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      const st = t0 + i * gap;
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(vol, st + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
      o.connect(g).connect(actx.destination);
      o.start(st);
      o.stop(st + dur + 0.05);
    });
  }
  const chime = () => tone([880, 1318.5], 0.16, 0.5, 0.12);   // someone else's message
  const sentBlip = () => tone([740], 0.05, 0.16, 0);          // your own message going out

  function setTitle() {
    document.title = unreadHidden ? "(" + unreadHidden + ") New message · " + baseTitle : baseTitle;
  }

  /* ---------- push notifications (arrive even with the site closed) ---------- */
  const canPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let swReg = null;
  let pushActive = false;

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").then((r) => { swReg = r; if (code && soundOn) pushEnable(); }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (!e.data) return;
      if (e.data.type === "open-chat") openChat();
      if (e.data.type === "chat-push") poll();
    });
  }

  const keyBytes = (b64) => {
    const s = b64.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(s + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  };

  async function pushEnable() {
    if (!canPush || !code || !me || !soundOn || Notification.permission !== "granted") return;
    try {
      const reg = swReg || (await navigator.serviceWorker.ready);
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const res = await fetch(API + "?push=key", { headers: { "X-Chat-Code": code }, cache: "no-store" });
        const { key } = await res.json();
        if (!key) return;
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      }
      await call("POST", { action: "subscribe", name: me, sub: sub.toJSON() });
      pushActive = true;
    } catch (e) { pushActive = false; }
  }

  async function pushDisable() {
    pushActive = false;
    if (!canPush) return;
    try {
      const reg = swReg || (await navigator.serviceWorker.getRegistration());
      const sub = reg && (await reg.pushManager.getSubscription());
      if (!sub) return;
      if (code) await call("POST", { action: "unsubscribe", endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    } catch (e) { /* ignore */ }
  }

  // must run from a tap (browsers only show the "Allow notifications" prompt then)
  function askNotify() {
    try {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") { pushEnable(); return; }
      if (Notification.permission === "default") {
        Notification.requestPermission().then((p) => { if (p === "granted") pushEnable(); });
      }
    } catch (e) { /* not supported */ }
  }

  function popup(m) {
    try {
      if (pushActive) return; // the push notification covers it
      if (!("Notification" in window) || Notification.permission !== "granted" || !soundOn) return;
      const n = new Notification(m.name, { body: m.text.slice(0, 140), icon: "logo.png", tag: "wrld-chat", renotify: true, silent: true });
      n.onclick = () => { window.focus(); openChat(); n.close(); };
    } catch (e) { /* some phones only allow pop-ups from an installed app */ }
  }

  // called with the messages that just arrived from the server (not on first load)
  function alertNew(list) {
    const theirs = list.filter((m) => m.name !== me);
    if (!theirs.length) return;
    const watching = open && !document.hidden;
    if (watching) return;
    chime();
    if (document.hidden) {
      unreadHidden += theirs.length;
      setTitle();
      popup(theirs[theirs.length - 1]);
    }
  }

  /* ---------- the view (shared by the lock bubble and the sidebar panel) ---------- */
  const view = el("div", "chat");
  view.innerHTML = `
    <div class="chat-join" hidden>
      <span class="chat-join-icon">${icon("message-circle")}</span>
      <b>Our little chat</b>
      <span class="chat-join-sub">Type the chat code once and this device remembers it.</span>
      <form class="chat-join-form" autocomplete="off">
        <input class="chat-input-line" name="code" type="password" placeholder="Chat code" aria-label="Chat code" autocapitalize="off" spellcheck="false" required>
        <input class="chat-input-line" name="name" type="text" placeholder="Your name" aria-label="Your name" maxlength="24" required>
        <button class="btn" type="submit">${icon("arrow-right")}Join</button>
        <p class="chat-err" role="alert"></p>
      </form>
    </div>
    <div class="chat-room" hidden>
      <p class="chat-hint" hidden><span class="chat-hint-text">On iPhone, tap Share → <b>Add to Home Screen</b>, then open the site from there to get notifications.</span><button class="icon-btn" type="button" aria-label="Dismiss">${icon("x")}</button></p>
      <div class="chat-log" role="log" aria-live="polite" aria-label="Messages"></div>
      <form class="chat-send" autocomplete="off">
        <textarea name="text" rows="1" maxlength="1000" placeholder="Message" aria-label="Message"></textarea>
        <button class="icon-btn solid" type="submit" aria-label="Send">${icon("arrow-right")}</button>
      </form>
      <p class="chat-err chat-room-err" role="alert"></p>
    </div>`;

  const $ = (s) => view.querySelector(s);
  const joinBox = $(".chat-join");
  const room = $(".chat-room");
  const log = $(".chat-log");
  const joinForm = $(".chat-join-form");
  const sendForm = $(".chat-send");
  const textarea = sendForm.elements.text;
  const roomErr = $(".chat-room-err");
  if (me) joinForm.elements.name.value = me;

  const hint = $(".chat-hint");
  function showIosHint() {
    hint.hidden = !(isIOS && !standalone && !canPush && store.get(K.iosHint) !== "off");
  }
  hint.querySelector("button").addEventListener("click", () => { hint.hidden = true; store.set(K.iosHint, "off"); });

  function showRoom(on) {
    joinBox.hidden = on;
    room.hidden = !on;
  }

  /* ---------- talking to the server ---------- */
  async function call(method, body, codeToUse) {
    const res = await fetch(API + (method === "GET" ? "?after=" + lastId : ""), {
      method,
      headers: Object.assign({ "X-Chat-Code": codeToUse || code || "" }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* not json */ }
    // no JSON back means the chat server code isn't running (the host served a normal page)
    if (!data || typeof data !== "object") {
      const err = new Error("not_setup");
      err.status = res.status;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(data.error || (res.status === 404 || res.status === 405 ? "not_setup" : "http_" + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const ERRORS = {
    bad_code: "That chat code isn't right.",
    slow_down: "Too many tries. Wait a few minutes.",
    not_setup: "The chat isn't switched on yet.",
    offline: "Can't reach the chat right now.",
  };
  const say = (e) => ERRORS[e.message] || (e instanceof TypeError ? ERRORS.offline : "Something went wrong. Try again.");

  /* ---------- drawing messages ---------- */
  const dayLabel = (d) => {
    const today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };
  const timeLabel = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  function draw(list) {
    const fresh = [];
    if (!list.length) return fresh;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const empty = log.querySelector(".chat-empty");
    if (empty) empty.remove();
    let prev = messages[messages.length - 1];
    list.forEach((m) => {
      if (m.id <= lastId) return;
      const d = new Date(m.ts);
      const day = d.toDateString();
      if (day !== lastDay) { log.appendChild(el("div", "chat-day", dayLabel(d))); lastDay = day; prev = null; }
      const mine = m.name === me;
      const grouped = prev && prev.name === m.name && m.ts - prev.ts < 5 * 60 * 1000;
      const row = el("div", "chat-msg" + (mine ? " mine" : "") + (grouped ? " grouped" : ""));
      if (!grouped && !mine) row.appendChild(el("span", "chat-who", m.name));
      const bubble = el("div", "chat-bubble", m.text);
      bubble.title = timeLabel(d);
      row.appendChild(bubble);
      if (!grouped) row.appendChild(el("span", "chat-time", timeLabel(d)));
      log.appendChild(row);
      messages.push(m);
      fresh.push(m);
      prev = m;
      lastId = m.id;
    });
    if (messages.length > 300) messages = messages.slice(-300);
    if (nearBottom || list.some((m) => m.name === me)) log.scrollTop = log.scrollHeight;
    return fresh;
  }

  function resetLog() {
    log.innerHTML = "";
    log.appendChild(el("p", "chat-empty", "No messages yet. Say hi."));
    messages = [];
    lastId = 0;
    lastDay = "";
  }

  /* ---------- unread dot ---------- */
  function markSeen() {
    if (open && !document.hidden && lastId > seenId) { seenId = lastId; store.set(K.seen, String(seenId)); }
    const unread = messages.some((m) => m.id > seenId && m.name !== me);
    document.querySelectorAll("[data-chat-dot]").forEach((n) => n.classList.toggle("on", unread));
  }

  /* ---------- polling ---------- */
  async function poll() {
    clearTimeout(timer);
    if (!code || busy) return schedule();
    busy = true;
    try {
      const firstLoad = lastId === 0;
      const data = await call("GET");
      const fresh = draw(data.messages || []);
      if (!firstLoad) alertNew(fresh);
      roomErr.textContent = "";
      markSeen();
    } catch (e) {
      if (e.message === "bad_code") { leave(); joinForm.querySelector(".chat-err").textContent = "The chat code changed. Enter the new one."; }
      else if (open) roomErr.textContent = say(e);
    } finally {
      busy = false;
      schedule();
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (code) timer = setTimeout(poll, document.hidden ? HIDDEN : open ? FAST : SLOW);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    unreadHidden = 0;
    setTitle();
    markSeen();
    poll();
  });

  /* ---------- joining, sending, leaving ---------- */
  joinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = joinForm.querySelector(".chat-err");
    const tryCode = joinForm.elements.code.value.trim();
    const name = joinForm.elements.name.value.trim().slice(0, 24);
    if (!tryCode || !name) return;
    joinForm.classList.add("busy");
    err.textContent = "";
    askNotify();
    try {
      lastId = 0;
      const data = await call("GET", null, tryCode);
      code = tryCode; me = name;
      store.set(K.code, code); store.set(K.name, me);
      joinForm.elements.code.value = "";
      resetLog();
      showRoom(true);
      draw(data.messages || []);
      log.scrollTop = log.scrollHeight;
      markSeen();
      schedule();
      pushEnable();
      showIosHint();
      setTimeout(() => textarea.focus(), 50);
    } catch (ex) {
      err.textContent = say(ex);
    } finally {
      joinForm.classList.remove("busy");
    }
  });

  async function send() {
    const text = textarea.value.trim();
    if (!text || sendForm.classList.contains("busy")) return;
    sendForm.classList.add("busy");
    roomErr.textContent = "";
    try {
      const data = await call("POST", { name: me, text });
      textarea.value = "";
      grow();
      draw([data.message]);
      sentBlip();
      markSeen();
    } catch (e) {
      roomErr.textContent = say(e);
      if (e.message === "bad_code") leave();
    } finally {
      sendForm.classList.remove("busy");
      textarea.focus();
    }
  }
  sendForm.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  function grow() { textarea.style.height = "auto"; textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px"; }
  textarea.addEventListener("input", grow);

  function leave() {
    pushDisable();
    code = null;
    store.del(K.code);
    clearTimeout(timer);
    resetLog();
    showRoom(false);
  }

  /* ---------- header bits (sound on/off, sign out) ---------- */
  function paintBells() {
    document.querySelectorAll("[data-chat-bell]").forEach((b) => {
      b.innerHTML = icon(soundOn ? "bell" : "bell-off");
      const label = soundOn ? "Alerts on (tap to mute)" : "Alerts muted (tap to turn on)";
      b.title = label;
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-pressed", String(soundOn));
    });
  }
  function headerTools() {
    const frag = document.createDocumentFragment();
    const bell = el("button", "icon-btn chat-bell");
    bell.type = "button";
    bell.setAttribute("data-chat-bell", "");
    bell.addEventListener("click", () => {
      soundOn = !soundOn;
      store.set(K.sound, soundOn ? "on" : "off");
      paintBells();
      if (soundOn) { unlockAudio(); askNotify(); setTimeout(chime, 60); }
      else pushDisable();
    });
    frag.appendChild(bell);
    const b = el("button", "icon-btn chat-leave");
    b.type = "button";
    b.title = "Leave the chat on this device";
    b.setAttribute("aria-label", "Leave the chat on this device");
    b.innerHTML = icon("lock");
    b.addEventListener("click", () => { if (code && confirm("Leave the chat on this device? You'll need the chat code again.")) leave(); });
    frag.appendChild(b);
    return frag;
  }

  function setOpen(on) {
    open = on;
    if (on) {
      if (!code) setTimeout(() => (me ? joinForm.elements.code : joinForm.elements.name).focus(), 80);
      else { log.scrollTop = log.scrollHeight; setTimeout(() => textarea.focus({ preventScroll: true }), 80); }
      markSeen();
    }
    poll();
  }

  function openChat() {
    if (float) { if (!open) float.querySelector(".chat-fab").click(); }
    else if (window.WRLD_SIDEBAR && !open) window.WRLD_SIDEBAR.open("chat");
  }

  /* ---------- lock page: floating bubble ---------- */
  let float = null;
  function mountFloat() {
    float = el("div", "chat-float");
    float.innerHTML = `
      <section class="chat-sheet" aria-label="Chat" hidden>
        <header class="chat-head"><span class="chat-head-icon">${icon("heart")}</span><h2>Chat</h2></header>
      </section>
      <button class="chat-fab" type="button" aria-label="Open chat" aria-expanded="false">
        <span class="chat-fab-icon">${icon("message-circle")}</span><span class="chat-fab-close">${icon("x")}</span>
        <span class="chat-dot" data-chat-dot></span>
      </button>`;
    const sheet = float.querySelector(".chat-sheet");
    const fab = float.querySelector(".chat-fab");
    sheet.querySelector(".chat-head").appendChild(headerTools());
    sheet.appendChild(view);
    fab.addEventListener("click", () => {
      const on = sheet.hidden;
      sheet.hidden = !on;
      float.classList.toggle("open", on);
      fab.setAttribute("aria-expanded", String(on));
      fab.setAttribute("aria-label", on ? "Close chat" : "Open chat");
      setOpen(on);
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) fab.click(); });
    document.body.appendChild(float);
    paintBells();
  }

  /* ---------- inside the site: sidebar panel ---------- */
  function mountPanel() {
    const panel = document.getElementById("panel-chat");
    if (!panel) return false;
    if (float) { float.remove(); float = null; }
    panel.querySelector(".panel-head").insertBefore(headerTools(), panel.querySelector("[data-panel-close]"));
    paintBells();
    panel.querySelector(".chat-panel-body").appendChild(view);
    // sidebar.js opens/closes the panel; watch its class to know when the chat is on screen
    new MutationObserver(() => {
      const on = panel.classList.contains("open");
      if (on !== open) setOpen(on);
    }).observe(panel, { attributes: true, attributeFilter: ["class"] });
    return true;
  }

  function openFromLink() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("chat") !== "1") return;
      u.searchParams.delete("chat");
      history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
      setTimeout(openChat, 300);
    } catch (e) { /* ignore */ }
  }

  /* ---------- go ---------- */
  resetLog();
  showRoom(!!code);
  showIosHint();
  const unlocked = () => document.documentElement.classList.contains("unlocked");
  if (unlocked()) { mountPanel(); openFromLink(); }
  else {
    mountFloat();
    if (document.documentElement.classList.contains("locked")) openFromLink();
    window.addEventListener("wrld:ready", () => { mountPanel(); markSeen(); openFromLink(); }, { once: true });
  }
  poll();
})();
