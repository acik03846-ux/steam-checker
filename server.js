// language: Node.js, runtime: Node 20+, deps: express
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
function loadKey() {
  if (process.env.STEAM_API_KEY) return process.env.STEAM_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    return cfg.api_key;
  } catch {
    return null;
  }
}

const KEY = loadKey();
if (!KEY) {
  console.error("[fatal] STEAM_API_KEY не задан (env или config.json)");
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 8080;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 30;
const STEAM = "https://api.steampowered.com";
const FETCH_TIMEOUT_MS = 8000;

// ---------- cache ----------
const cache = new Map(); // key -> { ts, value }
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(k); return null; }
  return e.value;
}
function cacheSet(k, v) { cache.set(k, { ts: Date.now(), value: v }); }

// периодическая чистка
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of cache) if (now - e.ts > CACHE_TTL_MS) cache.delete(k);
}, CACHE_TTL_MS).unref();

// ---------- rate limit (in-memory, по IP) ----------
const hits = new Map(); // ip -> { count, reset }
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "?";
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset) { h = { count: 0, reset: now + 60_000 }; hits.set(ip, h); }
  h.count++;
  if (h.count > RATE_LIMIT_MAX) {
    res.set("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
    return res.status(429).json({ error: "rate limit exceeded" });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (now > h.reset) hits.delete(ip);
}, 60_000).unref();

// ---------- steam api ----------
async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`steam ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const isSteamId64 = (s) => /^\d{17}$/.test(s);

async function resolveVanity(vanity) {
  const d = await fetchJson(
    `${STEAM}/ISteamUser/ResolveVanityURL/v1/?key=${KEY}&vanityurl=${encodeURIComponent(vanity)}`
  );
  if (d.response?.success !== 1) throw new Error("vanity не найден");
  return d.response.steamid;
}

async function getSummary(id) {
  const d = await fetchJson(`${STEAM}/ISteamUser/GetPlayerSummaries/v2/?key=${KEY}&steamids=${id}`);
  const p = d.response?.players?.[0];
  if (!p) throw new Error("профиль не найден");
  return p;
}

async function getBans(id) {
  const d = await fetchJson(`${STEAM}/ISteamUser/GetPlayerBans/v1/?key=${KEY}&steamids=${id}`);
  return d.players?.[0] || {};
}

async function safe(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

const getOwnedGames = (id) => safe(async () => {
  const d = await fetchJson(
    `${STEAM}/IPlayerService/GetOwnedGames/v1/?key=${KEY}&steamid=${id}&include_appinfo=1&include_played_free_games=1`
  );
  return d.response?.games || [];
}, []);

const getSteamLevel = (id) => safe(async () => {
  const d = await fetchJson(`${STEAM}/IPlayerService/GetSteamLevel/v1/?key=${KEY}&steamid=${id}`);
  return d.response?.player_level ?? null;
});

const getFriends = (id) => safe(async () => {
  const d = await fetchJson(`${STEAM}/ISteamUser/GetFriendList/v1/?key=${KEY}&steamid=${id}`);
  return d.friendslist?.friends?.length ?? null;
});

// ---------- trust heuristic ----------
// НЕ официальный Trust Factor Valve. Скоринг на публичных сигналах.
function trustHeuristic({ summary, bans, games, level, friends }) {
  let score = 50;
  const notes = [];

  // баны
  const cleanBans = !bans.VACBanned && !bans.CommunityBanned && !bans.NumberOfGameBans;
  if (bans.VACBanned) { score -= 40; notes.push(`VAC ban (${bans.NumberOfVACBans || 1})`); }
  if (bans.NumberOfGameBans > 0) { score -= 25; notes.push(`game ban: ${bans.NumberOfGameBans}`); }
  if (bans.CommunityBanned) { score -= 20; notes.push("community ban"); }
  if (bans.EconomyBan && bans.EconomyBan !== "none") { score -= 30; notes.push(`economy ban: ${bans.EconomyBan}`); }
  if (cleanBans) { score += 10; notes.push("банов нет"); }

  // возраст
  const ageYears = summary.timecreated
    ? (Date.now() / 1000 - summary.timecreated) / (365.25 * 86400)
    : 0;
  if (ageYears >= 10) { score += 20; notes.push(`аккаунту ${ageYears.toFixed(1)} лет`); }
  else if (ageYears >= 5) { score += 12; notes.push(`аккаунту ${ageYears.toFixed(1)} лет`); }
  else if (ageYears >= 2) { score += 5; notes.push(`аккаунту ${ageYears.toFixed(1)} лет`); }
  else if (ageYears > 0 && ageYears < 0.5) { score -= 10; notes.push("аккаунт свежий (< 6 мес)"); }

  // cs2
  const cs = games.find(g => g.appid === 730);
  if (cs) {
    const h = Math.round(cs.playtime_forever / 60);
    if (h >= 2000) { score += 15; notes.push(`CS2: ${h} ч`); }
    else if (h >= 500) { score += 8; notes.push(`CS2: ${h} ч`); }
    else if (h >= 100) { notes.push(`CS2: ${h} ч`); }
    else if (h < 20) { score -= 8; notes.push(`CS2: ${h} ч — подозрительно мало`); }
  } else {
    notes.push("CS2 не в библиотеке");
  }

  // level
  if (level != null) {
    if (level >= 50) score += 8;
    else if (level >= 20) score += 4;
    else if (level < 5) score -= 4;
    notes.push(`Steam level: ${level}`);
  }

  // друзья
  if (friends != null) {
    if (friends >= 100) { score += 5; notes.push(`друзей: ${friends}`); }
    else if (friends < 5) { score -= 5; notes.push(`друзей: ${friends} — мало`); }
    else notes.push(`друзей: ${friends}`);
  } else {
    notes.push("список друзей скрыт");
  }

  // приватность
  if (summary.communityvisibilitystate === 3) { score += 5; notes.push("профиль публичный"); }
  else { score -= 5; notes.push("профиль частично закрыт"); }

  score = Math.max(0, Math.min(100, score));
  const band = score >= 70 ? "высокий" : score >= 45 ? "средний" : "низкий";
  return { score, band, notes };
}

// ---------- app ----------
const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

// базовые security-заголовки
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' https://avatars.steamstatic.com https://avatars.cloudflare.steamstatic.com data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
  });
  next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/api/profile", rateLimit, async (req, res) => {
  const started = Date.now();
  try {
    let id = String(req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "параметр id обязателен" });
    if (id.length > 64) return res.status(400).json({ error: "слишком длинный id" });

    const refresh = req.query.refresh === "1";
    const cacheKey = `p:${id.toLowerCase()}`;

    if (!refresh) {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json({ ...cached, _cached: true });
    }

    if (!isSteamId64(id)) id = await resolveVanity(id);

    const [summary, bans, games, level, friends] = await Promise.all([
      getSummary(id),
      getBans(id),
      getOwnedGames(id),
      getSteamLevel(id),
      getFriends(id),
    ]);

    const ageYears = summary.timecreated
      ? +((Date.now() / 1000 - summary.timecreated) / (365.25 * 86400)).toFixed(1)
      : null;

    const cs = games.find(g => g.appid === 730) || null;
    const trust = trustHeuristic({ summary, bans, games, level, friends });

    const payload = {
      steamid: id,
      persona: summary.personaname,
      avatar: summary.avatarfull,
      profile_url: summary.profileurl,
      country: summary.loccountrycode || null,
      created: summary.timecreated || null,
      age_years: ageYears,
      visibility: summary.communityvisibilitystate,
      in_game: summary.gameextrainfo || null,
      level,
      friends,
      bans,
      games: {
        total: games.length,
        cs2: cs ? {
          hours: Math.round(cs.playtime_forever / 60),
          hours_2wk: Math.round((cs.playtime_2weeks || 0) / 60),
          last_played: cs.rtime_last_played || null,
        } : null,
      },
      trust,
    };

    cacheSet(cacheKey, payload);
    res.json({ ...payload, _cached: false });
  } catch (e) {
    const msg = e.name === "AbortError" ? "Steam API не ответил вовремя" : e.message;
    res.status(500).json({ error: msg });
  } finally {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
  }
});

app.use((req, res) => res.status(404).json({ error: "not found" }));

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
