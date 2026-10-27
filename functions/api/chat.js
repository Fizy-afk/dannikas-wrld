/* ============================================================================
   • ๔คภภเкคร ฬгl๔ • — chat backend (Cloudflare Pages Function → /api/chat)

   Needs two things set on the Cloudflare Pages project (Settings):
   - a D1 database bound as  CHAT_DB
   - a secret variable       CHAT_CODE   (the short code to get into the chat)

   GET  /api/chat?after=<id>   → { messages: [...] }  (newest 100 if after=0)
   POST /api/chat {name,text}  → { message }
   Every request sends the code in the  X-Chat-Code  header.
   ============================================================================ */

const KEEP = 1000;         // messages kept; older ones are trimmed
const MAX_TEXT = 1000;
const MAX_NAME = 24;
const MAX_FAILS = 10;      // wrong codes allowed per IP...
const FAIL_WINDOW = 15 * 60 * 1000; // ...per 15 minutes

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

export async function onRequestGet({ request, env }) {
  const stop = await guard(request, env);
  if (stop) return stop;
  const after = Math.max(0, parseInt(new URL(request.url).searchParams.get("after"), 10) || 0);
  const res = after
    ? await env.CHAT_DB.prepare("SELECT id, name, text, ts FROM messages WHERE id > ? ORDER BY id ASC LIMIT 200").bind(after).all()
    : await env.CHAT_DB.prepare("SELECT * FROM (SELECT id, name, text, ts FROM messages ORDER BY id DESC LIMIT 100) ORDER BY id ASC").all();
  return json({ messages: res.results || [] });
}

export async function onRequestPost({ request, env }) {
  const stop = await guard(request, env);
  if (stop) return stop;
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  const name = String(body.name || "").trim().slice(0, MAX_NAME);
  const text = String(body.text || "").trim().slice(0, MAX_TEXT);
  if (!name || !text) return json({ error: "empty" }, 400);

  const ts = Date.now();
  const r = await env.CHAT_DB.prepare("INSERT INTO messages (name, text, ts) VALUES (?, ?, ?)").bind(name, text, ts).run();
  const id = r.meta.last_row_id;
  if (id % 50 === 0) await env.CHAT_DB.prepare("DELETE FROM messages WHERE id <= ?").bind(id - KEEP).run();
  return json({ message: { id, name, text, ts } });
}

export function onRequest() {
  return json({ error: "method" }, 405);
}
