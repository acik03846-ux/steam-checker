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

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of cache) if (now - e.ts > CACHE_TTL_MS) cache.delete(k);
}, CACHE_TTL_MS).unref();

// ---------- rate limit ----------
const hits = new Map();
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

// Универсальный парсер ввода: SteamID64 | vanity | URL профиля
// Возвращает { type: "id" | "vanity", value: string }
function parseInput(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;

  // убираем пробелы и обрамляющие кавычки/уголки на всякий
  s = s.replace(/^[<"']+|[>"']+$/g, "").trim();

  // чистый SteamID64
  if (isSteamId64(s)) return { type: "id", value: s };

  // попытка распарсить как URL (даже без схемы)
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);

    // только steamcommunity.com и его поддомены
    if (/(^|\.)steamcommunity\.com$/i.test(u.hostname)) {
      const parts = u.pathname.split("/").filter(Boolean);

      // /profiles/<steamid64>
      if (parts[0] === "profiles" && parts[1] && isSteamId64(parts[1])) {
        return { type: "id", value: parts[1] };
      }

      // /id/<vanity>
      if (parts[0] === "id" && parts[1]) {
        return { type: "vanity", value: decodeURIComponent(parts[1]) };
      }

      // иногда ссылка вида /profiles/<vanity> — на всякий, трактуем как vanity
      if (parts[0] === "profiles" && parts[1]) {
        return { type: "vanity", value: decodeURIComponent(parts[1]) };
      }

      // просто steamcommunity.com/<что-то> — редкость, но попробуем
      if (parts[0]) {
        return { type: "vanity", value: decodeURIComponent(parts[0]) };
      }
    }

    // URL, но не Steam — возможно, просто вставили "https://gaben"
    // тогда берём последний сегмент пути как vanity
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg) return { type: "vanity", value: decodeURIComponent(seg) };
  } catch {
    // не URL — значит просто ник
  }

  // fallback — vanity
  return { type: "vanity", value: s };
}

async function resolveVanity(vanity) {
  const d = await fetchJson(
    `${STEAM}/ISteamUser/ResolveVanityURL/v1/?key=${KEY}&vanityurl=${encodeURIComponent(vanity)}`
  );
  if (d.response?.success !== 1) throw new Error("профиль не найден (vanity)");
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
function trustHeuristic({ summary, bans, games, level, friends }) {
  let score = 50;
  const notes = [];

  const cleanBans = !bans.VACBanned && !bans.CommunityBanned && !bans.NumberOfGameBans;
  if (bans.VACBanned) { score -= 40; notes.push(`VAC ban (${bans.NumberOfVACBans || 1})`); }
  if (bans.NumberOfGameBans > 0) { score -= 25; notes.push(`game ban: ${bans.NumberOfGameBans}`); }
  if (bans.CommunityBanned) { score -= 20; notes.push("community ban"); }
  if (bans.EconomyBan && bans.EconomyBan !== "none") { score -= 30; notes.push(`economy ban: ${bans.EconomyBan}`); }
  if (cleanBans) { score += 10; notes.push("банов нет"); }

  const ageYears = summary.timecreated
    ? (Date.now() / 1000 - summary.timecreated) / (365.25 * 86400)
    : 0;
  if (ageYears >= 10) { score += 20; notes.push(`аккаунту ${ageYears.toFixed(1)} лет`); }
  else if (ageYears >= 5) { score += 12; notes.push(`аккаунту ${ageYears.toFixed(1)} лет`); }
  else if (ageYears >= 2) { score += 5; notes.push(`аккаунту ${ageYears.toFixed(1)} лет`); }
  else if (ageYears > 0 && ageYears < 0.5) { score -= 10; notes.push("аккаунт свежий (< 6 мес)"); }

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

  if (level != null) {
    if (level >= 50) score += 8;
    else if (level >= 20) score += 4;
    else if (level < 5) score -= 4;
    notes.push(`Steam level: ${level}`);
  }

  if (friends != null) {
    if (friends >= 100) { score += 5; notes.push(`друзей: ${friends}`); }
    else if (friends < 5) { score -= 5; notes.push(`друзей: ${friends} — мало`); }
    else notes.push(`друзей: ${friends}`);
  } else {
    notes.push("список друзей скрыт");
  }

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

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' https://avatars.steamstatic.com https://avatars.cloudflare.steamstatic.com https://community.cloudflare.steamstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'",
  });
  next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/api/profile", rateLimit, async (req, res) => {
  const started = Date.now();
  try {
    const raw = String(req.query.id || "").trim();
    if (!raw) return res.status(400).json({ error: "введи ник, SteamID64 или ссылку" });
    if (raw.length > 256) return res.status(400).json({ error: "слишком длинный ввод" });

    const parsed = parseInput(raw);
    if (!parsed) return res.status(400).json({ error: "не удалось распознать ввод" });

    const refresh = req.query.refresh === "1";
    const cacheKey = `p:${parsed.type}:${parsed.value.toLowerCase()}`;

    if (!refresh) {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json({ ...cached, _cached: true });
    }

    let id;
    if (parsed.type === "id") {
      id = parsed.value;
    } else {
      id = await resolveVanity(parsed.value);
    }

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
      _input: { raw, resolved: { type: parsed.type, value: parsed.value } },
    };

    // кладём в кэш и под уже разрешённым id, чтобы повторные запросы по id тоже попадали
    cacheSet(cacheKey, payload);
    cacheSet(`p:id:${id.toLowerCase()}`, payload);

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
