// language: Node.js, runtime: Node 20+, deps: express
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
function loadKey(name) {
  if (process.env[name]) return process.env[name];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    return cfg[name.toLowerCase()] || null;
  } catch { return null; }
}

const STEAM_KEY = process.env.STEAM_API_KEY || loadKey("STEAM_API_KEY");
if (!STEAM_KEY) {
  console.error("[fatal] STEAM_API_KEY не задан");
  process.exit(1);
}
const LEETIFY_KEY = process.env.LEETIFY_API_KEY || loadKey("LEETIFY_API_KEY") || "";

const PORT = Number(process.env.PORT) || 8080;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 30;
const STEAM = "https://api.steampowered.com";
const LEETIFY = "https://api-public.cs-prod.leetify.com";
const FETCH_TIMEOUT_MS = 10000;
const CS2_APPID = 730;

// ---------- cache ----------
const cache = new Map();
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

// ---------- helpers ----------
async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`steam ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`steam ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const isSteamId64 = (s) => /^\d{17}$/.test(s);

function parseInput(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  s = s.replace(/^[<"']+|[>"']+$/g, "").trim();
  if (isSteamId64(s)) return { type: "id", value: s };
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);
    if (/(^|\.)steamcommunity\.com$/i.test(u.hostname)) {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] === "profiles" && parts[1] && isSteamId64(parts[1])) return { type: "id", value: parts[1] };
      if (parts[0] === "id" && parts[1]) return { type: "vanity", value: decodeURIComponent(parts[1]) };
      if (parts[0] === "profiles" && parts[1]) return { type: "vanity", value: decodeURIComponent(parts[1]) };
      if (parts[0]) return { type: "vanity", value: decodeURIComponent(parts[0]) };
    }
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg) return { type: "vanity", value: decodeURIComponent(seg) };
  } catch { /* not URL */ }
  return { type: "vanity", value: s };
}

// ---------- Steam API ----------
async function resolveVanity(vanity) {
  const d = await fetchJson(`${STEAM}/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_KEY}&vanityurl=${encodeURIComponent(vanity)}`);
  if (d.response?.success !== 1) throw new Error("профиль не найден (vanity)");
  return d.response.steamid;
}
async function getSummary(id) {
  const d = await fetchJson(`${STEAM}/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${id}`);
  const p = d.response?.players?.[0];
  if (!p) throw new Error("профиль не найден");
  return p;
}
async function getBans(id) {
  const d = await fetchJson(`${STEAM}/ISteamUser/GetPlayerBans/v1/?key=${STEAM_KEY}&steamids=${id}`);
  return d.players?.[0] || {};
}
async function getOwnedGames(id) {
  try {
    const d = await fetchJson(`${STEAM}/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${id}&include_appinfo=1&include_played_free_games=1`);
    return d.response?.games || [];
  } catch { return []; }
}
async function getSteamLevel(id) {
  try {
    const d = await fetchJson(`${STEAM}/IPlayerService/GetSteamLevel/v1/?key=${STEAM_KEY}&steamid=${id}`);
    return d.response?.player_level ?? null;
  } catch { return null; }
}
async function getFriends(id) {
  try {
    const d = await fetchJson(`${STEAM}/ISteamUser/GetFriendList/v1/?key=${STEAM_KEY}&steamid=${id}`);
    return d.friendslist?.friends || null;
  } catch { return null; }
}
async function getGameStats(id, appid = CS2_APPID) {
  try {
    const d = await fetchJson(`${STEAM}/ISteamUserStats/GetUserStatsForGame/v2/?key=${STEAM_KEY}&steamid=${id}&appid=${appid}`);
    return d.playerstats?.stats || null;
  } catch { return null; }
}
async function getAchievements(id, appid = CS2_APPID) {
  try {
    const d = await fetchJson(`${STEAM}/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_KEY}&steamid=${id}&appid=${appid}&l=russian`);
    return d.playerstats?.achievements || null;
  } catch { return null; }
}
async function getRecentGames(id) {
  try {
    const d = await fetchJson(`${STEAM}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${STEAM_KEY}&steamid=${id}&count=10`);
    return d.response?.games || [];
  } catch { return []; }
}
async function getXmlProfile(id) {
  try {
    const text = await fetchText(`https://steamcommunity.com/profiles/${id}/?xml=1`);
    const pick = (tag) => {
      const m = text.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
      return m ? m[1].trim() : null;
    };
    return {
      headline: pick("headline"),
      summary: pick("summary"),
      hours_played_2wk: pick("hoursPlayed2Wk"),
      steam_rating: pick("steamRating"),
      trade_ban_state: pick("tradeBanState"),
      vac_banned: pick("vacBanned"),
      most_played_games: (() => {
        const games = [];
        const re = /<mostPlayedGame>[\s\S]*?<gameName>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/gameName>[\s\S]*?<hoursPlayed>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/hoursPlayed>[\s\S]*?<\/mostPlayedGame>/g;
        let m;
        while ((m = re.exec(text)) !== null) games.push({ name: m[1].trim(), hours: m[2].trim() });
        return games;
      })(),
    };
  } catch { return null; }
}

// ---------- Leetify API ----------
async function getLeetifyProfile(steamId) {
  if (!LEETIFY_KEY) return null; // без ключа не дёргаем, чтобы не ловить 429
  try {
    const headers = { "Authorization": `Bearer ${LEETIFY_KEY}` };
    const d = await fetchJson(`${LEETIFY}/v3/profile?steam64_id=${steamId}`, { headers });
    return {
      name: d.name || null,
      privacy_mode: d.privacy_mode || null,
      winrate: d.winrate ?? null,
      total_matches: d.total_matches ?? null,
      ranks: d.ranks ? {
        premier: d.ranks.premier ?? null,
        faceit: d.ranks.faceit ?? null,
        wingman: d.ranks.wingman ?? null,
      } : null,
      rating: d.rating ? {
        aim: d.rating.aim ?? null,
        utility: d.rating.utility ?? null,
        positioning: d.rating.positioning ?? null,
        clutch: d.rating.clutch ?? null,
        opening: d.rating.opening ?? null,
        ct_leetify: d.rating.ct_leetify ?? null,
        t_leetify: d.rating.t_leetify ?? null,
      } : null,
      stats: d.stats ? {
        preaim: d.stats.preaim ?? null,
        reaction_time: d.stats.reaction_time ?? null,
        accuracy_enemy_spotted: d.stats.accuracy_enemy_spotted ?? null,
        accuracy_head: d.stats.accuracy_head ?? null,
        spray_accuracy: d.stats.spray_accuracy ?? null,
        he_foes_damage_avg: d.stats.he_foes_damage_avg ?? null,
        flashbang_hit_foe_avg: d.stats.flashbang_hit_foe_avg ?? null,
        flashbang_hit_friend_avg: d.stats.flashbang_hit_friend_avg ?? null,
      } : null,
      recent_matches: (d.recent_matches || []).slice(0, 5).map(m => ({
        map: m.map_name || null,
        score: m.team_scores ? m.team_scores.map(t => t.score).join(" : ") : null,
        result: m.outcome || null,
        leetify_rating: m.leetify_rating ?? null,
        finished_at: m.finished_at || null,
      })),
    };
  } catch (e) {
    console.warn("[leetify] error:", e.message);
    return null;
  }
}

// ---------- trust heuristic ----------
function trustHeuristic({ summary, bans, games, level, friends, gameStats, achievements }) {
  let score = 50;
  const notes = [];
  const cleanBans = !bans.VACBanned && !bans.CommunityBanned && !bans.NumberOfGameBans;
  if (bans.VACBanned) { score -= 40; notes.push(`VAC ban (${bans.NumberOfVACBans || 1})`); }
  if (bans.NumberOfGameBans > 0) { score -= 25; notes.push(`game ban: ${bans.NumberOfGameBans}`); }
  if (bans.CommunityBanned) { score -= 20; notes.push("community ban"); }
  if (bans.EconomyBan && bans.EconomyBan !== "none") { score -= 30; notes.push(`economy ban: ${bans.EconomyBan}`); }
  if (cleanBans) { score += 10; notes.push("банов нет"); }
  const ageYears = summary.timecreated ? (Date.now() / 1000 - summary.timecreated) / (365.25 * 86400) : 0;
  if (ageYears >= 10) { score += 20; notes.push(`аккаунту ${ageYears.toFixed(1)} лет`); }
  else if (ageYears >= 5) { score += 12; notes.push(`аккаунту ${ageYears.toFixed(1)} лет`); }
  else if (ageYears >= 2) { score += 5; notes.push(`аккаунту ${ageYears.toFixed(1)} лет`); }
  else if (ageYears > 0 && ageYears < 0.5) { score -= 10; notes.push("аккаунт свежий (< 6 мес)"); }
  const cs = games.find(g => g.appid === CS2_APPID);
  if (cs) {
    const h = Math.round(cs.playtime_forever / 60);
    if (h >= 2000) { score += 15; notes.push(`CS2: ${h} ч`); }
    else if (h >= 500) { score += 8; notes.push(`CS2: ${h} ч`); }
    else if (h >= 100) { notes.push(`CS2: ${h} ч`); }
    else if (h < 20) { score -= 8; notes.push(`CS2: ${h} ч — мало`); }
  } else notes.push("CS2 не в библиотеке");
  if (level != null) {
    if (level >= 50) score += 8;
    else if (level >= 20) score += 4;
    else if (level < 5) score -= 4;
    notes.push(`Steam level: ${level}`);
  }
  if (friends != null) {
    const n = friends.length;
    if (n >= 100) { score += 5; notes.push(`друзей: ${n}`); }
    else if (n < 5) { score -= 5; notes.push(`друзей: ${n} — мало`); }
    else notes.push(`друзей: ${n}`);
  } else notes.push("список друзей скрыт");
  if (summary.communityvisibilitystate === 3) { score += 5; notes.push("профиль публичный"); }
  else { score -= 5; notes.push("профиль частично закрыт"); }
  if (gameStats) {
    const kills = gameStats.find(s => s.name === "total_kills")?.value;
    const deaths = gameStats.find(s => s.name === "total_deaths")?.value;
    if (kills && deaths) notes.push(`CS2 K/D: ${(kills/deaths).toFixed(2)} (${kills}/${deaths})`);
  }
  if (achievements) {
    const unlocked = achievements.filter(a => a.achieved === 1).length;
    notes.push(`достижений CS2: ${unlocked}/${achievements.length}`);
  }
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
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https://avatars.steamstatic.com https://avatars.cloudflare.steamstatic.com https://community.cloudflare.steamstatic.com https://cdn.cloudflare.steamstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'",
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
    if (parsed.type === "id") id = parsed.value;
    else id = await resolveVanity(parsed.value);

    const [summary, bans, games, level, friends, gameStats, achievements, recentGames, xmlProfile, leetify] = await Promise.all([
      getSummary(id),
      getBans(id),
      getOwnedGames(id),
      getSteamLevel(id),
      getFriends(id),
      getGameStats(id, CS2_APPID),
      getAchievements(id, CS2_APPID),
      getRecentGames(id),
      getXmlProfile(id),
      getLeetifyProfile(id),
    ]);

    const ageYears = summary.timecreated
      ? +((Date.now() / 1000 - summary.timecreated) / (365.25 * 86400)).toFixed(1)
      : null;
    const cs = games.find(g => g.appid === CS2_APPID) || null;
    const trust = trustHeuristic({ summary, bans, games, level, friends, gameStats, achievements });

    let cs2Stats = null;
    if (gameStats) {
      const get = (name) => gameStats.find(s => s.name === name)?.value ?? null;
      const kills = get("total_kills"), deaths = get("total_deaths");
      const headshots = get("total_kills_headshot");
      const shotsHit = get("total_shots_hit"), shotsFired = get("total_shots_fired");
      cs2Stats = {
        kills, deaths,
        kd: kills && deaths ? +(kills / deaths).toFixed(2) : null,
        headshots,
        headshot_pct: kills && headshots ? +((headshots / kills) * 100).toFixed(1) : null,
        accuracy: shotsFired && shotsHit ? +((shotsHit / shotsFired) * 100).toFixed(1) : null,
        wins: get("total_wins"),
        mvps: get("total_mvps"),
        bombs_planted: get("total_planted_bombs"),
        hostages_rescued: get("total_rescued_hostages"),
      };
    }

    let cs2Achievements = null;
    if (achievements) {
      const unlocked = achievements.filter(a => a.achieved === 1);
      cs2Achievements = {
        total: achievements.length,
        unlocked: unlocked.length,
        pct: achievements.length ? +((unlocked.length / achievements.length) * 100).toFixed(1) : 0,
      };
    }

    const payload = {
      steamid: id,
      persona: summary.personaname,
      real_name: summary.realname || null,
      avatar: summary.avatarfull,
      profile_url: summary.profileurl,
      country: summary.loccountrycode || null,
      created: summary.timecreated || null,
      age_years: ageYears,
      visibility: summary.communityvisibilitystate,
      persona_state: summary.personastate,
      last_logoff: summary.lastlogoff || null,
      in_game: summary.gameextrainfo || null,
      level,
      friends: friends ? friends.length : null,
      bans,
      games: {
        total: games.length,
        cs2: cs ? {
          hours: Math.round(cs.playtime_forever / 60),
          hours_2wk: Math.round((cs.playtime_2weeks || 0) / 60),
          last_played: cs.rtime_last_played || null,
        } : null,
        recent: recentGames.map(g => ({
          appid: g.appid, name: g.name,
          hours_2wk: Math.round((g.playtime_2weeks || 0) / 60),
          hours_total: Math.round(g.playtime_forever / 60),
        })),
        top: xmlProfile?.most_played_games || [],
      },
      cs2_stats: cs2Stats,
      cs2_achievements: cs2Achievements,
      xml: xmlProfile ? {
        headline: xmlProfile.headline,
        summary: xmlProfile.summary,
        hours_played_2wk: xmlProfile.hours_played_2wk,
        trade_ban_state: xmlProfile.trade_ban_state,
      } : null,
      leetify: leetify || null,
      trust,
      _input: { raw, resolved: { type: parsed.type, value: parsed.value } },
    };

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
