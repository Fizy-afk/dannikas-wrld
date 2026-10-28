/* ============================================================================
   • ๔คภภเкคร ฬгl๔ • — chat backend (Cloudflare Pages Function → /api/chat)

   Needs on the Cloudflare Pages project (Settings):
   - a D1 database bound as  CHAT_DB   (wrld-chat)
   - a secret variable       CHAT_CODE (the short code to get into the chat)
   Push notifications use a signing key stored in the database (config table).

   GET  /api/chat?after=<id>                    → { messages: [...] }
   POST /api/chat {name, text}                  → { message }   (+ pushes to the other person)
   POST /api/chat {action:"subscribe", name, sub}   → { ok }   (turn on push for this device)
   POST /api/chat {action:"unsubscribe", endpoint}  → { ok }
   Every request sends the chat code in the  X-Chat-Code  header.
   ============================================================================ */

const KEEP = 1000;         // messages kept; older ones are trimmed
const MAX_TEXT = 1000;
const MAX_NAME = 24;
const MAX_FAILS = 10;      // wrong codes allowed per IP...
const FAIL_WINDOW = 15 * 60 * 1000; // ...per 15 minutes
const PUSH_SUBJECT = "https://mccartywebdesign.com";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

let ready = false;
async function setup(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS fails (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, ts INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
  ]);
  ready = true;
}

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
async function sameCode(given, real) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const [a, b] = await Promise.all([digest(norm(given)), digest(norm(real))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// returns a Response if the request should stop here, otherwise null
async function guard(request, env) {
  if (!env.CHAT_DB || !env.CHAT_CODE) return json({ error: "not_setup" }, 503);
  const db = env.CHAT_DB;
  await setup(db);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const row = await db.prepare("SELECT n, ts FROM fails WHERE ip = ?").bind(ip).first();
  const recent = row && now - row.ts < FAIL_WINDOW;
  if (recent && row.n >= MAX_FAILS) return json({ error: "slow_down" }, 429);

  if (!(await sameCode(request.headers.get("X-Chat-Code"), env.CHAT_CODE))) {
    const n = recent ? row.n + 1 : 1;
    await db.prepare("INSERT INTO fails (ip, n, ts) VALUES (?1, ?2, ?3) ON CONFLICT(ip) DO UPDATE SET n = ?2, ts = ?3").bind(ip, n, now).run();
    return json({ error: "bad_code" }, 401);
  }
  if (row) await db.prepare("DELETE FROM fails WHERE ip = ?").bind(ip).run();
  return null;
}

/* ---------- web push (RFC 8291 aes128gcm + VAPID), plain WebCrypto ---------- */
const enc = new TextEncoder();
const b64u = {
  encode(buf) {
    let s = "";
    new Uint8Array(buf).forEach((c) => (s += String.fromCharCode(c)));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(str) {
    const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(s + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  },
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  parts.forEach((p) => { out.set(p, i); i += p.length; });
  return out;
};
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

async function vapidKeys(db) {
  const rows = (await db.prepare("SELECT k, v FROM config WHERE k IN ('vapid_private_jwk', 'vapid_public')").all()).results || [];
  const cfg = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  if (!cfg.vapid_private_jwk || !cfg.vapid_public) return null;
  const key = await crypto.subtle.importKey("jwk", JSON.parse(cfg.vapid_private_jwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { key, pub: cfg.vapid_public };
}

async function vapidHeader(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const head = b64u.encode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.encode(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.key, enc.encode(head + "." + body));
  return "vapid t=" + head + "." + body + "." + b64u.encode(sig) + ", k=" + vapid.pub;
}

async function encryptPayload(sub, payload) {
  const uaPublic = b64u.decode(sub.p256dh);
  const authSecret = b64u.decode(sub.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(enc.encode(payload), new Uint8Array([2])); // 0x02 = last record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

async function pushOne(sub, payload, vapid) {
  const body = await encryptPayload(sub, payload);
  return fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(sub.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
      Topic: "wrld-chat",
    },
    body,
  });
}

// send the new message to everyone signed up for push except the sender
async function pushToOthers(db, msg) {
  const vapid = await vapidKeys(db);
  if (!vapid) return;
  const subs = (await db.prepare("SELECT endpoint, p256dh, auth FROM subs WHERE lower(name) != lower(?)").bind(msg.name).all()).results || [];
  const payload = JSON.stringify({ title: msg.name, body: msg.text.slice(0, 180), id: msg.id });
  await Promise.all(subs.map(async (s) => {
    try {
      const r = await pushOne(s, payload, vapid);
      if (r.status === 404 || r.status === 410) await db.prepare("DELETE FROM subs WHERE endpoint = ?").bind(s.endpoint).run();
    } catch (e) { /* one bad device shouldn't stop the rest */ }
  }));
}

const okEndpoint = (u) => {
  try { const x = new URL(u); return x.protocol === "https:" && u.length < 1000; } catch (e) { return false; }
};

/* ---------- routes ---------- */
export async function onRequestGet({ request, env }) {
  const stop = await guard(request, env);
  if (stop) return stop;
  const url = new URL(request.url);
  if (url.searchParams.get("push") === "key") {
    const row = await env.CHAT_DB.prepare("SELECT v FROM config WHERE k = 'vapid_public'").first();
    return json({ key: row ? row.v : null });
  }
  const after = Math.max(0, parseInt(url.searchParams.get("after"), 10) || 0);
  const res = after
    ? await env.CHAT_DB.prepare("SELECT id, name, text, ts FROM messages WHERE id > ? ORDER BY id ASC LIMIT 200").bind(after).all()
    : await env.CHAT_DB.prepare("SELECT * FROM (SELECT id, name, text, ts FROM messages ORDER BY id DESC LIMIT 100) ORDER BY id ASC").all();
  return json({ messages: res.results || [] });
}

export async function onRequestPost({ request, env, waitUntil }) {
  const stop = await guard(request, env);
  if (stop) return stop;
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  const db = env.CHAT_DB;

  if (body.action === "subscribe") {
    const sub = body.sub || {};
    const keys = sub.keys || {};
    const name = String(body.name || "").trim().slice(0, MAX_NAME);
    if (!okEndpoint(sub.endpoint) || !keys.p256dh || !keys.auth || !name) return json({ error: "bad_request" }, 400);
    await db.prepare("INSERT INTO subs (endpoint, p256dh, auth, name, ts) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, name = ?4, ts = ?5")
      .bind(sub.endpoint, String(keys.p256dh).slice(0, 200), String(keys.auth).slice(0, 100), name, Date.now()).run();
    return json({ ok: true });
  }
  if (body.action === "unsubscribe") {
    if (body.endpoint) await db.prepare("DELETE FROM subs WHERE endpoint = ?").bind(String(body.endpoint)).run();
    return json({ ok: true });
  }

  const name = String(body.name || "").trim().slice(0, MAX_NAME);
  const text = String(body.text || "").trim().slice(0, MAX_TEXT);
  if (!name || !text) return json({ error: "empty" }, 400);

  const ts = Date.now();
  const r = await db.prepare("INSERT INTO messages (name, text, ts) VALUES (?, ?, ?)").bind(name, text, ts).run();
  const id = r.meta.last_row_id;
  if (id % 50 === 0) await db.prepare("DELETE FROM messages WHERE id <= ?").bind(id - KEEP).run();
  const message = { id, name, text, ts };
  const sending = pushToOthers(db, message);
  if (waitUntil) waitUntil(sending); else await sending;
  return json({ message });
}

export function onRequest() {
  return json({ error: "method" }, 405);
}
