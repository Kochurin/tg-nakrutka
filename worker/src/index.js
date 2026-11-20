// Прокси для детектора накрутки: читает публичное веб-превью t.me/s/<канал> и отдаёт JSON
// Без входа в Telegram, без MTProto и сторонних API. Ответы кэшируются, частота запросов ограничена
import { parseHeader, parsePosts, beforeId } from "./parse.js";

const MIN_PAGES = 4;           // минимум 4 страницы по ~20 постов
const MAX_PAGES = 10;          // у новостных каналов листаем дальше, пока не наберём посты старше 4 дней
const CACHE_SEC = 3600;        // один канал пересчитываем не чаще раза в час
const NAME_RX = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;
const UA = "Mozilla/5.0 (compatible; tg-nakrutka/1.0; +https://github.com/Kochurin/tg-nakrutka)";

const ALLOWED = /^https:\/\/kochurin\.github\.io$|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const cors = origin => ({
  "Access-Control-Allow-Origin": origin && ALLOWED.test(origin) ? origin : "https://kochurin.github.io",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Vary": "Origin",
});
const json = (data, origin, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin), ...extra } });

// запасной лимит, если привязка ratelimits недоступна: живёт в памяти одного экземпляра
const mem = new Map();
function memLimit(key, limit = 10, windowMs = 60000) {
  const now = Date.now();
  const a = (mem.get(key) || []).filter(t => now - t < windowMs);
  if (a.length >= limit) { mem.set(key, a); return false; }
  a.push(now); mem.set(key, a);
  if (mem.size > 5000) mem.clear();
  return true;
}

async function fetchPage(name, before) {
  const url = `https://t.me/s/${name}${before ? `?before=${before}` : ""}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" }, redirect: "manual" });
  if (r.status >= 300 && r.status < 400) return null;   // такого публичного канала нет: t.me уводит на страницу контакта
  if (!r.ok) throw new Error(`t.me ответил ${r.status}`);
  return r.text();
}

async function collect(name) {
  const first = await fetchPage(name);
  if (!first) return { error: "not_found" };
  const header = parseHeader(first);
  if (!header) return { error: "not_channel" };    // личный аккаунт, бот или закрытый канал
  let posts = parsePosts(first);
  let before = beforeId(first);
  const old = () => posts.length && Date.now() - Date.parse(posts[0].date) > 4 * 864e5;
  for (let i = 1; i < MAX_PAGES && before && before > 1 && (i < MIN_PAGES || !old()); i++) {
    const html = await fetchPage(name, before);
    if (!html) break;
    const more = parsePosts(html);
    if (!more.length) break;
    posts = more.concat(posts).sort((a, b) => a.id - b.id);
    const next = beforeId(html);
    if (!next || next >= before) break;
    before = next;
  }
  const seen = new Set();
  posts = posts.filter(p => !seen.has(p.id) && seen.add(p.id)).sort((a, b) => a.id - b.id);
  return { header, posts };
}

// снимки числа подписчиков раз в сутки: так со временем видны скачки
async function history(env, name, subs) {
  if (!env.DB || subs == null) return [];
  const day = new Date().toISOString().slice(0, 10);
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO subs (name, day, n) VALUES (?, ?, ?)").bind(name, day, subs).run();
    const { results } = await env.DB.prepare("SELECT day, n FROM subs WHERE name = ? ORDER BY day DESC LIMIT 90").bind(name).all();
    return results.reverse();
  } catch (e) {
    return [];
  }
}

async function channel(req, env, ctx, url, origin) {
  const name = (url.searchParams.get("u") || "").replace(/^@|^https?:\/\/t\.me\/(s\/)?/i, "").split(/[/?#]/)[0];
  if (!NAME_RX.test(name)) return json({ error: "bad_name" }, origin, 400);
  const key = name.toLowerCase();

  const cache = caches.default;
  const cacheKey = new Request(`https://tg-nakrutka.cache/v2/${key}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    const data = await hit.json();
    return json({ ...data, cached: true }, origin);
  }

  const ip = req.headers.get("CF-Connecting-IP") || "local";
  const ok = env.LIMITER ? (await env.LIMITER.limit({ key: ip })).success : memLimit(ip);
  if (!ok) return json({ error: "rate_limited" }, origin, 429, { "Retry-After": "60" });

  let data;
  try { data = await collect(key); } catch (e) { return json({ error: "upstream", detail: String(e.message || e) }, origin, 502); }
  if (data.error) return json(data, origin, 404);

  data = { name: key, fetchedAt: new Date().toISOString(), ...data, history: await history(env, key, data.header.subscribers) };
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SEC}` },
  })));
  return json({ ...data, cached: false }, origin);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin");
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (req.method !== "GET") return json({ error: "method" }, origin, 405);
    if (url.pathname === "/api/channel") return channel(req, env, ctx, url, origin);
    if (url.pathname === "/") return json({ ok: true, about: "https://github.com/Kochurin/tg-nakrutka" }, origin);
    return json({ error: "not_found" }, origin, 404);
  },
  async scheduled(event, env) {
    if (env.DB) await env.DB.prepare("DELETE FROM subs WHERE day < ?").bind(new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10)).run();
  },
};
