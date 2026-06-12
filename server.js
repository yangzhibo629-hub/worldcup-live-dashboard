import express from "express";
import cors from "cors";
import Parser from "rss-parser";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 4173);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const SCHEDULE_SNAPSHOT_PATH = path.join(__dirname, "data", "schedule-snapshot.json");
const WORLDCUP_API_BASE = process.env.WORLDCUP_API_BASE || "https://worldcup26.ir";
const REFRESH_MS = Number(process.env.REFRESH_MS || 1000 * 60 * 5);
const INSIGHTS_TTL_MS = Number(process.env.INSIGHTS_TTL_MS || 1000 * 60 * 8);
const SOCIAL_LOOKBACK_MS = Number(process.env.SOCIAL_LOOKBACK_MS || 1000 * 60 * 60 * 24 * 3);
const TREND_LOOKBACK_MS = Number(process.env.TREND_LOOKBACK_MS || 1000 * 60 * 60 * 24 * 30);
const TIKTOK_BRIDGE_URL = process.env.TIKTOK_BRIDGE_URL || "";
const INSTAGRAM_BRIDGE_URL = process.env.INSTAGRAM_BRIDGE_URL || "";
const YOUTUBE_BRIDGE_URL = process.env.YOUTUBE_BRIDGE_URL || "";
const TIKTOK_PROXY_URL = process.env.TIKTOK_PROXY_URL || "https://lv-api-sinfonlinea.ulikecam.com/agent/proxy/tiktok/search_posts";
const TIKTOK_API_KEY = process.env.TIKTOK_API_KEY || "";
const INSTAGRAM_PROXY_URL = process.env.INSTAGRAM_PROXY_URL || "https://lv-api-sinfonlinea.ulikecam.com/agent/proxy/instagram/search_posts";
const INSTAGRAM_API_KEY = process.env.INSTAGRAM_API_KEY || "";
const YOUTUBE_PROXY_URL = process.env.YOUTUBE_PROXY_URL || "https://lv-api-sinfonlinea.ulikecam.com/agent/proxy/youtube/video_search";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "";
const API_FOOTBALL_BASE = process.env.API_FOOTBALL_BASE || "https://v3.football.api-sports.io";
const API_FOOTBALL_LEAGUE = process.env.API_FOOTBALL_LEAGUE || "1";
const API_FOOTBALL_SEASON = process.env.API_FOOTBALL_SEASON || "2026";
const ESPN_SCOREBOARD_URL = process.env.ESPN_SCOREBOARD_URL || "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const ESPN_SCOREBOARD_DATES = process.env.ESPN_SCOREBOARD_DATES || "20260611-20260719";

const app = express();
const execFileAsync = promisify(execFile);
const SOCIAL_SEARCH_SKILL_DIR = "/Users/bytedance/.codex/skills/social-media-content-search";
const rss = new Parser({
  timeout: 9000,
  headers: {
    "User-Agent": "WorldCup2026LiveDashboard/1.0"
  }
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.get("/", (_request, response) => {
  response.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get(["/app.js", "/styles.css"], (request, response) => {
  response.sendFile(path.join(PUBLIC_DIR, request.path.slice(1)));
});

const scheduleCache = {
  updatedAt: null,
  source: "not-loaded",
  liveScoreSource: API_FOOTBALL_KEY ? "api-football" : "not-configured",
  liveScoreUpdatedAt: null,
  error: null,
  liveScoreError: null,
  data: { matches: [], teams: [], stadiums: [] }
};

const insightsCache = new Map();
const translationCache = new Map();

function loadScheduleSnapshot() {
  try {
    const snapshot = JSON.parse(readFileSync(SCHEDULE_SNAPSHOT_PATH, "utf8"));
    if (!Array.isArray(snapshot.matches) || snapshot.matches.length < 100) {
      throw new Error("schedule snapshot is incomplete");
    }
    return {
      matches: snapshot.matches,
      teams: snapshot.teams || [],
      stadiums: snapshot.stadiums || []
    };
  } catch (error) {
    console.warn(`Schedule snapshot unavailable: ${error.message}`);
    return { matches: [], teams: [], stadiums: [] };
  }
}

const fallbackSchedule = loadScheduleSnapshot();

function withTimeout(ms = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timeout) };
}

async function fetchJson(path) {
  const timer = withTimeout(30000);
  try {
    const response = await fetch(`${WORLDCUP_API_BASE}${path}`, {
      signal: timer.signal,
      headers: {
        "User-Agent": "WorldCup2026LiveDashboard/1.0",
        Accept: "application/json"
      }
    });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return await response.json();
  } finally {
    timer.done();
  }
}

function parseLocalDate(raw) {
  if (!raw) return null;
  const match = String(raw).match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, month, day, year, hour, minute] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:00`;
}

function normalizeStage(game) {
  if (game.type === "group") return `Group ${game.group || ""}`.trim();
  const labels = {
    round16: "Round of 16",
    quarter: "Quarterfinal",
    semi: "Semifinal",
    third: "Third-place",
    final: "Final"
  };
  return labels[game.type] || game.type || "Fixture";
}

function normalizeSchedule(gamesPayload, teamsPayload, stadiumsPayload) {
  const games = gamesPayload?.games || [];
  const teams = teamsPayload?.teams || [];
  const stadiums = stadiumsPayload?.stadiums || [];
  const stadiumById = new Map(stadiums.map((stadium) => [String(stadium.id), stadium]));

  const matches = games.map((game) => {
    const stadium = stadiumById.get(String(game.stadium_id)) || {};
    const homeTeam = game.home_team_name_en || game.homeTeam || "TBD";
    const awayTeam = game.away_team_name_en || game.awayTeam || "TBD";
    const dateIso = parseLocalDate(game.local_date);
    return {
      id: String(game.id || game._id),
      matchNo: Number(game.id || 0),
      homeTeam,
      awayTeam,
      group: game.group || "",
      stage: normalizeStage(game),
      type: game.type || "group",
      matchday: String(game.matchday || ""),
      localDate: game.local_date || "",
      dateIso,
      venue: stadium.fifa_name || stadium.name_en || "TBD venue",
      city: stadium.city_en || "",
      country: stadium.country_en || "",
      status: String(game.time_elapsed || game.finished || "notstarted"),
      finished: String(game.finished).toLowerCase() === "true",
      homeScore: Number(game.home_score || 0),
      awayScore: Number(game.away_score || 0),
      homeFlag: teams.find((team) => String(team.id) === String(game.home_team_id))?.flag || "",
      awayFlag: teams.find((team) => String(team.id) === String(game.away_team_id))?.flag || "",
      homeCode: teams.find((team) => String(team.id) === String(game.home_team_id))?.fifa_code || "",
      awayCode: teams.find((team) => String(team.id) === String(game.away_team_id))?.fifa_code || "",
      homeIso2: teams.find((team) => String(team.id) === String(game.home_team_id))?.iso2 || "",
      awayIso2: teams.find((team) => String(team.id) === String(game.away_team_id))?.iso2 || "",
      query: `${homeTeam} vs ${awayTeam} 2026 World Cup`
    };
  });

  matches.sort((a, b) => {
    const byDate = String(a.dateIso || "").localeCompare(String(b.dateIso || ""));
    return byDate || a.matchNo - b.matchNo;
  });

  return { matches, teams, stadiums };
}

function normalizeName(value = "") {
  const cleaned = String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
  const aliases = {
    "bosnia herzegovina": "bosnia and herzegovina",
    czechia: "czech republic",
    "korea republic": "south korea",
    "usa": "united states",
    "u s": "united states",
    "u s a": "united states",
    "ivory coast": "cote d ivoire",
    "cote d ivoire": "ivory coast",
    "curacao": "curacao"
  };
  return aliases[cleaned] || cleaned;
}

function normalizeApiFootballStatus(status = {}) {
  const short = String(status.short || "").toUpperCase();
  const elapsed = status.elapsed ?? null;
  const finished = ["FT", "AET", "PEN"].includes(short);
  const live = ["1H", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"].includes(short);
  const labelMap = {
    NS: "notstarted",
    TBD: "notstarted",
    "1H": "live",
    HT: "halftime",
    "2H": "live",
    ET: "extra-time",
    BT: "break-time",
    P: "penalties",
    FT: "finished",
    AET: "finished",
    PEN: "finished",
    PST: "postponed",
    CANC: "cancelled",
    ABD: "abandoned",
    AWD: "awarded",
    WO: "walkover"
  };
  return {
    status: labelMap[short] || short.toLowerCase() || "notstarted",
    finished,
    live,
    elapsed,
    short
  };
}

function normalizeEspnStatus(status = {}) {
  const type = status.type || {};
  const state = String(type.state || "").toLowerCase();
  const name = String(type.name || "").toUpperCase();
  const completed = Boolean(type.completed);
  const live = state === "in" || ["STATUS_IN_PROGRESS", "STATUS_HALFTIME"].includes(name);
  return {
    status: completed ? "finished" : live ? "live" : state === "pre" ? "notstarted" : (type.description || "notstarted").toLowerCase(),
    finished: completed,
    live,
    elapsed: status.clock || null,
    short: type.shortDetail || type.description || ""
  };
}

async function fetchEspnScoreboard() {
  const timer = withTimeout(20000);
  try {
    const url = new URL(ESPN_SCOREBOARD_URL);
    url.searchParams.set("dates", ESPN_SCOREBOARD_DATES);
    const response = await fetch(url, {
      signal: timer.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "WorldCup2026LiveDashboard/1.0"
      }
    });
    if (!response.ok) throw new Error(`ESPN scoreboard returned ${response.status}`);
    const payload = await response.json();
    return {
      events: payload.events || [],
      source: "ESPN public scoreboard",
      error: null
    };
  } catch (error) {
    return { events: [], source: "espn:error", error: error.message };
  } finally {
    timer.done();
  }
}

async function fetchApiFootballEndpoint(params) {
  const url = new URL("/fixtures", API_FOOTBALL_BASE);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "x-apisports-key": API_FOOTBALL_KEY,
      "User-Agent": "WorldCup2026LiveDashboard/1.0"
    }
  });
  if (!response.ok) throw new Error(`API-FOOTBALL fixtures returned ${response.status}`);
  return response.json();
}

function extractApiFootballError(payload) {
  if (Array.isArray(payload.errors) && payload.errors.length) return payload.errors.join(", ");
  if (payload.errors && typeof payload.errors === "object" && Object.keys(payload.errors).length) {
    return JSON.stringify(payload.errors);
  }
  return "";
}

async function fetchApiFootballFixtures() {
  if (!API_FOOTBALL_KEY) {
    return { fixtures: [], source: "api-football:not-configured", error: "API_FOOTBALL_KEY is not configured" };
  }

  const timer = withTimeout(30000);
  try {
    const seasonPayload = await fetchApiFootballEndpoint({
      league: API_FOOTBALL_LEAGUE,
      season: API_FOOTBALL_SEASON
    });

    const seasonError = extractApiFootballError(seasonPayload);
    if (!seasonError) {
      return {
        fixtures: seasonPayload.response || [],
        source: `API-FOOTBALL league=${API_FOOTBALL_LEAGUE} season=${API_FOOTBALL_SEASON}`,
        error: null
      };
    }

    const livePayload = await fetchApiFootballEndpoint({ live: "all" });
    const liveError = extractApiFootballError(livePayload);
    if (liveError) throw new Error(`API-FOOTBALL error: ${seasonError}; live fallback: ${liveError}`);

    return {
      fixtures: livePayload.response || [],
      source: "API-FOOTBALL live=all fallback",
      error: `Season fixtures unavailable for current plan: ${seasonError}`
    };
  } catch (error) {
    return { fixtures: [], source: "api-football:error", error: error.message };
  } finally {
    timer.done();
  }
}

function mergeLiveScores(schedule, fixtures = []) {
  if (!fixtures.length) return { ...schedule, liveScoreMatches: Number(schedule.liveScoreMatches || 0) };

  let liveScoreMatches = Number(schedule.liveScoreMatches || 0);
  const normalizedFixtures = fixtures.map((fixture) => {
    const homeName = fixture.teams?.home?.name || "";
    const awayName = fixture.teams?.away?.name || "";
    const status = normalizeApiFootballStatus(fixture.fixture?.status);
    return {
      fixture,
      homeName,
      awayName,
      homeKey: normalizeName(homeName),
      awayKey: normalizeName(awayName),
      startsAt: new Date(fixture.fixture?.date || 0).getTime(),
      homeScore: Number(fixture.goals?.home ?? fixture.score?.fulltime?.home ?? 0),
      awayScore: Number(fixture.goals?.away ?? fixture.score?.fulltime?.away ?? 0),
      status
    };
  });

  const matches = schedule.matches.map((match) => {
    const homeKey = normalizeName(match.homeTeam);
    const awayKey = normalizeName(match.awayTeam);
    const matchTime = new Date(match.dateIso || parseLocalDate(match.localDate) || 0).getTime();
    const liveFixture = normalizedFixtures.find((fixture) => {
      const sameTeams = fixture.homeKey === homeKey && fixture.awayKey === awayKey;
      if (!sameTeams) return false;
      if (Number.isNaN(matchTime) || Number.isNaN(fixture.startsAt)) return true;
      return Math.abs(fixture.startsAt - matchTime) <= 1000 * 60 * 60 * 36;
    });

    if (!liveFixture) return match;
    liveScoreMatches += 1;
    return {
      ...match,
      status: liveFixture.status.elapsed ? String(liveFixture.status.elapsed) : liveFixture.status.status,
      statusLabel: liveFixture.status.status,
      finished: liveFixture.status.finished,
      live: liveFixture.status.live,
      elapsed: liveFixture.status.elapsed,
      homeScore: liveFixture.homeScore,
      awayScore: liveFixture.awayScore,
      liveScoreProvider: "api-football",
      liveScoreFixtureId: liveFixture.fixture.fixture?.id || null,
      liveScoreUpdatedAt: new Date().toISOString()
    };
  });

  return { ...schedule, matches, liveScoreMatches };
}

function mergeEspnScores(schedule, events = []) {
  if (!events.length) return { ...schedule, liveScoreMatches: Number(schedule.liveScoreMatches || 0) };

  let liveScoreMatches = Number(schedule.liveScoreMatches || 0);
  const normalizedEvents = events.map((event) => {
    const competition = event.competitions?.[0] || {};
    const competitors = competition.competitors || [];
    const home = competitors.find((item) => item.homeAway === "home") || {};
    const away = competitors.find((item) => item.homeAway === "away") || {};
    const status = normalizeEspnStatus(event.status);
    return {
      event,
      homeName: home.team?.displayName || home.team?.name || "",
      awayName: away.team?.displayName || away.team?.name || "",
      homeKey: normalizeName(home.team?.displayName || home.team?.name || ""),
      awayKey: normalizeName(away.team?.displayName || away.team?.name || ""),
      startsAt: new Date(event.date || competition.date || 0).getTime(),
      homeScore: Number(home.score || 0),
      awayScore: Number(away.score || 0),
      status
    };
  });

  const matches = schedule.matches.map((match) => {
    const homeKey = normalizeName(match.homeTeam);
    const awayKey = normalizeName(match.awayTeam);
    const matchTime = new Date(match.dateIso || parseLocalDate(match.localDate) || 0).getTime();
    const espnEvent = normalizedEvents.find((event) => {
      const sameTeams = event.homeKey === homeKey && event.awayKey === awayKey;
      if (!sameTeams) return false;
      if (Number.isNaN(matchTime) || Number.isNaN(event.startsAt)) return true;
      return Math.abs(event.startsAt - matchTime) <= 1000 * 60 * 60 * 36;
    });

    if (!espnEvent) return match;
    liveScoreMatches += 1;
    return {
      ...match,
      status: espnEvent.status.elapsed ? String(espnEvent.status.elapsed) : espnEvent.status.status,
      statusLabel: espnEvent.status.status,
      finished: espnEvent.status.finished,
      live: espnEvent.status.live,
      elapsed: espnEvent.status.elapsed,
      homeScore: espnEvent.homeScore,
      awayScore: espnEvent.awayScore,
      liveScoreProvider: "espn",
      liveScoreFixtureId: espnEvent.event.id || null,
      liveScoreUpdatedAt: new Date().toISOString()
    };
  });

  return { ...schedule, matches, liveScoreMatches };
}

async function refreshSchedule() {
  try {
    const [games, teams, stadiums, espnScores, liveScores] = await Promise.all([
      fetchJson("/get/games"),
      fetchJson("/get/teams"),
      fetchJson("/get/stadiums"),
      fetchEspnScoreboard(),
      fetchApiFootballFixtures()
    ]);
    const normalized = normalizeSchedule(games, teams, stadiums);
    const withEspnScores = mergeEspnScores(normalized, espnScores.events);
    scheduleCache.data = mergeLiveScores(withEspnScores, liveScores.fixtures);
    scheduleCache.updatedAt = new Date().toISOString();
    scheduleCache.source = `${WORLDCUP_API_BASE} + ${espnScores.source} + ${liveScores.source}`;
    scheduleCache.liveScoreSource = `${espnScores.source} + ${liveScores.source}`;
    scheduleCache.liveScoreUpdatedAt = espnScores.error && liveScores.error ? scheduleCache.liveScoreUpdatedAt : scheduleCache.updatedAt;
    scheduleCache.error = null;
    scheduleCache.liveScoreError = [espnScores.error, liveScores.error].filter(Boolean).join(" | ") || null;
  } catch (error) {
    if (!scheduleCache.data.matches.length) {
      scheduleCache.data = fallbackSchedule;
    }
    scheduleCache.updatedAt = scheduleCache.updatedAt || new Date().toISOString();
    scheduleCache.source = scheduleCache.data.matches.length ? "bundled-2026-schedule-snapshot" : "empty-fallback";
    scheduleCache.error = error.message;
  }
}

async function ensureScheduleFresh() {
  const lastUpdated = scheduleCache.updatedAt ? new Date(scheduleCache.updatedAt).getTime() : 0;
  const isStale = !lastUpdated || Date.now() - lastUpdated > REFRESH_MS;
  if (!scheduleCache.data.matches.length || isStale) {
    await refreshSchedule();
  }
}

function cleanText(text = "") {
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGoogleNewsLink(link = "") {
  return link || "#";
}

async function getGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const feed = await rss.parseURL(url);
  return (feed.items || []).slice(0, 10).map((item) => ({
    source: item.source?.title || item.creator || "Google News",
    title: cleanText(item.title),
    summary: cleanText(item.contentSnippet || item.content || ""),
    url: normalizeGoogleNewsLink(item.link),
    publishedAt: item.isoDate || item.pubDate || null
  }));
}

async function getReddit(query) {
  const url = `https://api.pullpush.io/reddit/search/submission/?q=${encodeURIComponent(query)}&size=8&sort_type=score&sort=desc`;
  const timer = withTimeout(9000);
  try {
    const response = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "WorldCup2026LiveDashboard/1.0" }
    });
    if (!response.ok) throw new Error(`PullPush Reddit returned ${response.status}`);
    const data = await response.json();
    return (data.data || []).map((post) => ({
      network: "Reddit",
      author: post.subreddit ? `r/${post.subreddit}` : post.author,
      title: cleanText(post.title),
      url: post.permalink ? `https://www.reddit.com${post.permalink}` : post.full_link || "https://www.reddit.com/search/",
      score: post.score || 0,
      comments: post.num_comments || 0,
      publishedAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null
    }));
  } finally {
    timer.done();
  }
}

async function getHackerNews(query) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=6`;
  const timer = withTimeout(9000);
  try {
    const response = await fetch(url, {
      signal: timer.signal,
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Hacker News returned ${response.status}`);
    const data = await response.json();
    return (data.hits || []).map((hit) => ({
      network: "Hacker News",
      author: hit.author,
      title: cleanText(hit.title || hit.story_title),
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      score: hit.points || 0,
      comments: hit.num_comments || 0,
      publishedAt: hit.created_at || null
    }));
  } finally {
    timer.done();
  }
}

async function getBluesky(query) {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=10&sort=latest`;
  const timer = withTimeout(9000);
  try {
    const response = await fetch(url, {
      signal: timer.signal,
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Bluesky returned ${response.status}`);
    const data = await response.json();
    return (data.posts || []).map((post) => ({
      network: "Bluesky",
      author: post.author?.displayName || post.author?.handle || "Bluesky user",
      handle: post.author?.handle,
      title: cleanText(post.record?.text || ""),
      url: `https://bsky.app/profile/${post.author?.handle}/post/${post.uri?.split("/").pop()}`,
      likes: post.likeCount || 0,
      replies: post.replyCount || 0,
      reposts: post.repostCount || 0,
      publishedAt: post.record?.createdAt || post.indexedAt || null
    }));
  } finally {
    timer.done();
  }
}

async function getPlatformBridge(platform, query, bridgeUrl, options = {}) {
  if (platform === "TikTok" && !bridgeUrl && TIKTOK_API_KEY) {
    return getTikTokProxy(query, options);
  }

  if (platform === "Instagram" && !bridgeUrl && INSTAGRAM_API_KEY) {
    return getInstagramProxy(query, options);
  }

  if (platform === "YouTube" && !bridgeUrl && YOUTUBE_API_KEY) {
    return getYouTubeProxy(query, options);
  }

  if (!bridgeUrl) {
    return getPlatformSkill(platform, query, options);
  }

  const timer = withTimeout(10000);
  try {
    const url = new URL(bridgeUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(options.limit || 12));
    if (options.since) url.searchParams.set("since", options.since);
    const response = await fetch(url, {
      signal: timer.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "WorldCup2026LiveDashboard/1.0"
      }
    });
    if (!response.ok) throw new Error(`${platform} bridge returned ${response.status}`);
    const data = await response.json();
    const rawItems = Array.isArray(data) ? data : data.items || data.posts || [];
    return {
      items: rawItems.slice(0, 8).map((item) => ({
        network: platform,
        author: item.author || item.username || item.handle || platform,
        title: cleanText(item.title || item.caption || item.text || item.description || ""),
        url: item.url || item.permalink || "#",
        views: Number(item.views || item.viewCount || item.playCount || item.vv || item.score || 0),
        score: item.score || item.likes || item.likeCount || item.views || item.viewCount || item.playCount || item.vv || 0,
        comments: item.comments || item.commentCount || 0,
        publishedAt: item.publishedAt || item.createdAt || item.timestamp || null
      })),
      source: `${platform} configured bridge`
    };
  } finally {
    timer.done();
  }
}

function extractProxyItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

async function getTikTokProxy(query, options = {}) {
  const timer = withTimeout(20000);
  try {
    const response = await fetch(TIKTOK_PROXY_URL, {
      method: "POST",
      signal: timer.signal,
      headers: {
        "Content-Type": "application/json",
        "x-tiktok-api-key": TIKTOK_API_KEY,
        "User-Agent": "WorldCup2026LiveDashboard/1.0"
      },
      body: JSON.stringify({
        query,
        region: "us",
        media_type: "video",
        count: options.limit || 12
      })
    });
    if (!response.ok) throw new Error(`TikTok proxy returned ${response.status}`);
    const payload = await response.json();
    return {
      items: extractProxyItems(payload).map((item) => normalizeSkillItem("TikTok", item)),
      source: "TikTok proxy search_posts"
    };
  } finally {
    timer.done();
  }
}

async function getInstagramProxy(query, options = {}) {
  const timer = withTimeout(20000);
  try {
    const response = await fetch(INSTAGRAM_PROXY_URL, {
      method: "POST",
      signal: timer.signal,
      headers: {
        "Content-Type": "application/json",
        "x-instagram-api-key": INSTAGRAM_API_KEY,
        "User-Agent": "WorldCup2026LiveDashboard/1.0"
      },
      body: JSON.stringify({
        query,
        count: options.limit || 12,
        order: options.order || "relevance"
      })
    });
    if (!response.ok) throw new Error(`Instagram proxy returned ${response.status}`);
    const payload = await response.json();
    return {
      items: extractProxyItems(payload).map((item) => normalizeSkillItem("Instagram", item)),
      source: "Instagram proxy search_posts"
    };
  } finally {
    timer.done();
  }
}

async function getYouTubeProxy(query, options = {}) {
  const timer = withTimeout(20000);
  try {
    const response = await fetch(YOUTUBE_PROXY_URL, {
      method: "POST",
      signal: timer.signal,
      headers: {
        "Content-Type": "application/json",
        "x-youtube-api-key": YOUTUBE_API_KEY,
        "User-Agent": "WorldCup2026LiveDashboard/1.0"
      },
      body: JSON.stringify({
        query,
        region: "US",
        count: options.limit || 12,
        order: options.order || "viewCount"
      })
    });
    if (!response.ok) throw new Error(`YouTube proxy returned ${response.status}`);
    const payload = await response.json();
    return {
      items: extractProxyItems(payload).map((item) => normalizeSkillItem("YouTube", item)),
      source: "YouTube proxy video_search"
    };
  } finally {
    timer.done();
  }
}

function normalizeSkillItem(platform, item) {
  const statistics = item.statistics || {};
  const author = item.author || {};
  const url = item.item_url || item.url || item.permalink || item.webpage_url || "#";
  const title = item.title || item.description || item.caption || item.video_description || item.text || "";
  return {
    network: platform,
    author: author.name || author.unique_id || author.username || item.username || item.author || platform,
    title: cleanText(title),
    url,
    views: Number(statistics.view_count || item.view_count || item.views || item.play_count || item.playCount || item.vv || 0),
    score: Number(statistics.like_count || item.like_count || item.likes || item.score || statistics.view_count || 0),
    comments: Number(statistics.comment_count || item.comment_count || item.comments || 0),
    publishedAt: item.publish_time || item.publishedAt || item.createdAt || item.create_time || null
  };
}

async function getPlatformSkill(platform, query, options = {}) {
  const platformId = platform.toLowerCase();
  const args = ["scripts/search_content.py", platformId, query, "--count", String(options.limit || 12)];
  if (platformId === "youtube") args.push("--region", "US", "--order", "viewCount");
  if (platformId === "tiktok") args.push("--region", "us");
  if (platformId === "instagram") args.push("--order", "publishDate");
  if (options.since) args.push("--published-after", options.since);

  try {
    const { stdout } = await execFileAsync("python3", args, {
      cwd: SOCIAL_SEARCH_SKILL_DIR,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 4,
      env: {
        ...process.env,
        SKILL_HTTP_DISABLE_PPE: "1"
      }
    });
    const payload = JSON.parse(stdout);
    if (!payload.success) {
      return {
        items: [],
        source: `${platform} skill unavailable: ${payload.error_msg || "unknown error"}`
      };
    }
    return {
      items: (payload.items || []).map((item) => normalizeSkillItem(platform, item)),
      source: `${platform} social-media-content-search skill`
    };
  } catch (error) {
    const detail = cleanText(error.stdout || error.stderr || error.message || "unknown error");
    return {
      items: [],
      source: `${platform} skill unavailable: ${detail}`
    };
  }
}

function buildHotspots(news, social) {
  const allText = [...news.map((item) => item.title), ...social.map((item) => item.title)].join(" ").toLowerCase();
  const topics = [
    ["阵容与名单", ["lineup", "starting xi", "squad", "roster", "call-up"]],
    ["伤病与状态", ["injury", "injured", "fitness", "doubt", "recovery"]],
    ["票务与出行", ["ticket", "price", "sale", "resale", "travel"]],
    ["场馆与安保", ["stadium", "venue", "transport", "security", "host city"]],
    ["预测与赔率", ["predict", "odds", "favorite", "preview", "power ranking"]],
    ["争议与判罚", ["var", "referee", "controversy", "ban", "appeal"]]
  ];
  return topics
    .map(([name, keywords]) => ({
      name,
      count: keywords.reduce((total, keyword) => total + (allText.match(new RegExp(keyword, "g")) || []).length, 0)
    }))
    .filter((topic) => topic.count > 0)
    .sort((a, b) => b.count - a.count);
}

function extractOutlet(title = "") {
  const parts = title.split(" - ");
  return parts.length > 1 ? parts.at(-1) : "";
}

const insightStopwords = new Set([
  "world",
  "cup",
  "fifa",
  "fifaworldcup",
  "worldcup",
  "worldcup2026",
  "viral",
  "vairal",
  "fyp",
  "foryou",
  "foryoupage",
  "football",
  "soccer",
  "official",
  "video",
  "highlights",
  "news",
  "2026",
  "match",
  "matches",
  "vs",
  "and",
  "the",
  "for",
  "with",
  "from",
  "this",
  "that",
  "today",
  "live",
  "vivo",
  "game",
  "games",
  "goal",
  "goals",
  "about",
  "team",
  "teams"
]);

function getProfileForSummary(teamName) {
  const profile = cultureProfiles[teamName];
  if (profile) return profile;
  return {
    identity: `${teamName} 的国家队内容可以从国旗配色、球迷入场、城市地标和赛前情绪里提炼。`,
    symbols: [teamName, "national colors", "supporter chants"],
    visualStyle: "national colors, supporter culture, stadium atmosphere"
  };
}

function getSummaryPlayers(teamName, limit = 3) {
  return buildTeamPlayers(teamName)
    .slice(0, limit)
    .map((player) => `${player.name}（${player.role}）`);
}

function formatVVCompact(value = 0) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "未知 VV";
  if (number >= 100000000) return `${(number / 100000000).toFixed(1).replace(/\.0$/, "")}亿 VV`;
  if (number >= 10000) return `${(number / 10000).toFixed(1).replace(/\.0$/, "")}万 VV`;
  return `${Math.round(number)} VV`;
}

function compactTitle(title = "", maxLength = 54) {
  const cleaned = cleanText(title);
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

function getTeamSymbols(teamName) {
  return getProfileForSummary(teamName).symbols.slice(0, 3);
}

function extractSignalTerms(match, news, social) {
  const text = [...news, ...social]
    .map((item) => `${item.title || ""} ${item.summary || ""}`)
    .join(" ");
  const lowerText = text.toLowerCase();
  const tagTerms = [];
  const playerTerms = [];
  const conceptTerms = [];
  const tags = text.match(/#[\w\u4e00-\u9fff]+/g) || [];
  tags.forEach((tag) => {
    const normalized = tag.toLowerCase().replace(/^#/, "");
    if (!insightStopwords.has(normalized)) tagTerms.push(tag);
  });

  [...buildTeamPlayers(match.homeTeam), ...buildTeamPlayers(match.awayTeam)].forEach((player) => {
    const name = player.name;
    const nameKey = name.toLowerCase();
    const lastName = nameKey.split(/\s+/).at(-1);
    if (lowerText.includes(nameKey) || (lastName && lowerText.includes(lastName))) {
      playerTerms.push(name);
    }
  });

  const concepts = [
    ["红牌/争议判罚", /(red card|tarjetas rojas|var|referee|controversy|appeal)/i],
    ["门将扑救", /(save|saves|arquero|goalkeeper|keeper|扑救)/i],
    ["进球瞬间", /(goal|gol|goles|scored|进球)/i],
    ["首战氛围", /(opening|starts now|first game|首战|揭幕)/i],
    ["球迷反应", /(fan|fans|aficionados|reaction|celebration|球迷|庆祝)/i],
    ["赛前预测", /(predict|prediction|odds|favorite|win today|预测|赔率)/i],
    ["高光二创", /(highlight|clip|edit|template|高光|剪辑)/i]
  ];
  concepts.forEach(([label, pattern]) => {
    if (pattern.test(text)) conceptTerms.push(label);
  });

  const unique = [...new Set([...conceptTerms, ...playerTerms, ...tagTerms])].slice(0, 6);
  return unique.length ? unique : ["比分预测", "球员对位", "球迷反应", "国旗视觉"];
}

function getBestSocialByNetwork(social) {
  const byNetwork = new Map();
  social.forEach((item) => {
    const network = item.network || "Social";
    const current = byNetwork.get(network);
    if (!current || (item.socialRankScore || 0) > (current.socialRankScore || 0)) {
      byNetwork.set(network, item);
    }
  });
  return [...byNetwork.values()]
    .sort((a, b) => (b.socialRankScore || 0) - (a.socialRankScore || 0))
    .slice(0, 3);
}

function buildConcreteAngles(match, news, social, hotspots) {
  const matchup = `${match.homeTeam} vs ${match.awayTeam}`;
  const homePlayers = getSummaryPlayers(match.homeTeam, 2);
  const awayPlayers = getSummaryPlayers(match.awayTeam, 2);
  const homeSymbols = getTeamSymbols(match.homeTeam);
  const awaySymbols = getTeamSymbols(match.awayTeam);
  const signalTerms = extractSignalTerms(match, news, social);
  const bestSocial = getBestSocialByNetwork(social);
  const topHotspots = hotspots.slice(0, 3).map((topic) => topic.name);
  const bullets = [];

  bullets.push(`核心选题：把 ${match.homeTeam} 的「${homeSymbols.join(" / ")}」和 ${match.awayTeam} 的「${awaySymbols.join(" / ")}」做成对照，标题可以走“同一座球场里的两种国家队气质”。`);

  bullets.push(`球员切入：优先围绕 ${homePlayers.join("、")} 对上 ${awayPlayers.join("、")} 做“关键人物 + 位置职责 + 谁能改变比赛节奏”的短视频脚本。`);

  if (bestSocial.length) {
    const examples = bestSocial
      .map((item) => `${item.network}《${compactTitle(item.title || item.author || "高热内容")}》${formatVVCompact(item.socialVV)}`)
      .join("；");
    bullets.push(`社交借势：近 3 天高热样本里，${examples}，可以拆成“同款情绪开头 + 本场预测 + 球迷反应”的投稿结构。`);
  } else {
    bullets.push(`社交借势：近 3 天暂时没有足够强的高 VV 样本，建议先做“比分预测、球迷第一反应、队旗变装、球星出场想象”四类低成本内容。`);
  }

  if (signalTerms.length) {
    bullets.push(`标题关键词：当前可抓 ${signalTerms.slice(0, 5).join("、")}，适合放在封面、副标题或口播前三秒。`);
  } else if (topHotspots.length) {
    bullets.push(`标题关键词：当前热点偏向 ${topHotspots.join("、")}，适合做“赛前 30 秒看懂本场”的信息流内容。`);
  }

  const venueLine = [match.venue, match.city].filter(Boolean).join(" · ");
  if (venueLine) {
    bullets.push(`现场感素材：用 ${venueLine} 做开场锚点，叠加两队国旗色、球迷歌声、入场镜头，能让内容比普通赛前预测更有画面。`);
  }

  if (news.length) {
    const usefulNews = news
      .slice(0, 2)
      .map((item) => compactTitle(item.title, 42))
      .filter(Boolean);
    if (usefulNews.length) {
      bullets.push(`事实核验：可参考新闻里的「${usefulNews.join("」和「")}」，把预测内容补上具体事实点。`);
    }
  }

  return bullets.slice(0, 5).map((bullet) => bullet.replace(matchup, matchup));
}

function buildAISummary(match, news, social, hotspots) {
  const titles = news.map((item) => item.title).filter(Boolean);
  const outlets = [...new Set(titles.map(extractOutlet).filter(Boolean))].slice(0, 3);
  const topHotspots = hotspots.slice(0, 3).map((topic) => topic.name);
  const matchup = `${match.homeTeam} vs ${match.awayTeam}`;
  const bullets = buildConcreteAngles(match, news, social, hotspots);

  if (outlets.length) {
    bullets.push(`媒体线索：新闻来源覆盖 ${outlets.join("、")}，发布前可以用这些来源校验阵容、伤病和赛程事实。`);
  }
  const watchlist = [
    ...getSummaryPlayers(match.homeTeam, 2).map((item) => item.replace(/（.*$/, "")),
    ...getSummaryPlayers(match.awayTeam, 2).map((item) => item.replace(/（.*$/, "")),
    ...topHotspots,
    ...extractSignalTerms(match, news, social)
  ];

  return {
    headline: `${matchup}：本场看点与投稿灵感`,
    bullets: bullets.slice(0, 4),
    watchlist: [...new Set(watchlist)].slice(0, 8),
    generatedBy: "local-match-creative-brief"
  };
}

function isRelevantSocialItem(item, match) {
  const text = `${item.title || ""} ${item.author || ""}`.toLowerCase();
  const home = match.homeTeam.toLowerCase();
  const away = match.awayTeam.toLowerCase();
  const footballSignal = /(world cup|fifa|soccer|football|世界杯)/i.test(text);
  const teamSignal = text.includes(home) || text.includes(away);
  return footballSignal && (teamSignal || /2026/.test(text));
}

function isRecentSocialItem(item, now = Date.now()) {
  if (!item.publishedAt) return false;
  const publishedAt = new Date(item.publishedAt).getTime();
  if (Number.isNaN(publishedAt)) return false;
  return now - publishedAt >= 0 && now - publishedAt <= SOCIAL_LOOKBACK_MS;
}

function numberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function getSocialVV(item) {
  return Math.max(
    numberValue(item.views),
    numberValue(item.viewCount),
    numberValue(item.playCount),
    numberValue(item.vv),
    numberValue(item.score),
    numberValue(item.likes)
  );
}

function getSocialRankScore(item, now = Date.now()) {
  const vv = getSocialVV(item);
  const likes = numberValue(item.likes || item.score);
  const comments = numberValue(item.comments || item.replies);
  const reposts = numberValue(item.reposts || item.shares);
  const publishedAt = new Date(item.publishedAt || 0).getTime();
  const ageHours = Number.isNaN(publishedAt) ? 72 : Math.max(0, (now - publishedAt) / (1000 * 60 * 60));
  const freshness = Math.exp(-ageHours / 72);
  const engagement = likes * 2 + comments * 8 + reposts * 6;
  const network = String(item.network || "").toLowerCase();
  const platformBoost = /tiktok|instagram|youtube/.test(network) ? 1.12 : 1;

  return Math.round((
    Math.log10(vv + 1) * 48 +
    Math.log10(engagement + 1) * 34 +
    freshness * 28
  ) * platformBoost);
}

function enrichSocialItem(item) {
  const socialVV = getSocialVV(item);
  return {
    ...item,
    socialVV,
    socialRankScore: getSocialRankScore(item)
  };
}

function buildTrendProjection() {
  const matches = scheduleCache.data.matches;
  if (matches.length < 10) return buildTournamentDateProjection();
  const byDate = matches.reduce((map, match) => {
    const key = match.dateIso?.slice(0, 10) || parseLocalDate(match.localDate)?.slice(0, 10) || "TBD";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(match);
    return map;
  }, new Map());

  return [...byDate.entries()].map(([date, dateMatches], index) => {
    const marquee = dateMatches.find((match) => match.type !== "group") || dateMatches[0];
    const stageBoost = marquee.type === "final" ? 9 : marquee.type === "semi" ? 7 : marquee.type === "quarter" ? 5 : marquee.type === "round16" ? 4 : 2;
    return {
      date,
      label: formatTrendLabel(date),
      vv: 900000 + dateMatches.length * 260000 + stageBoost * 180000 + index * 28000,
      matchId: marquee.id,
      matchLabel: `${marquee.homeTeam} vs ${marquee.awayTeam}`,
      source: "schedule-projection"
    };
  });
}

function buildTournamentDateProjection() {
  const start = Date.UTC(2026, 5, 11);
  const end = Date.UTC(2026, 6, 19);
  const points = [];
  for (let time = start, index = 0; time <= end; time += 1000 * 60 * 60 * 24, index += 1) {
    const date = new Date(time).toISOString().slice(0, 10);
    const phaseBoost = index > 31 ? 9 : index > 25 ? 6 : index > 16 ? 4 : 2;
    points.push({
      date,
      label: formatTrendLabel(date),
      vv: 1200000 + Math.round(Math.sin(index / 2.8) * 220000) + phaseBoost * 190000 + index * 42000,
      matchId: "",
      matchLabel: index === 0 ? "Opening match" : index > 36 ? "Final week" : "World Cup matchday",
      source: "tournament-date-projection"
    });
  }
  return points;
}

function formatTrendLabel(date) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function getHashtagTrendClips() {
  const query = "#WorldCup2026 OR #FIFAWorldCup OR #WeAre26";
  const [tiktokResult, instagramResult, youtubeResult] = await Promise.allSettled([
    getPlatformBridge("TikTok", query, TIKTOK_BRIDGE_URL, { limit: 16 }),
    getPlatformBridge("Instagram", query, INSTAGRAM_BRIDGE_URL, { limit: 16 }),
    getPlatformBridge("YouTube", query, YOUTUBE_BRIDGE_URL, { limit: 16 })
  ]);

  const sources = {
    tiktok: tiktokResult.status === "fulfilled" ? tiktokResult.value.source : tiktokResult.reason.message,
    instagram: instagramResult.status === "fulfilled" ? instagramResult.value.source : instagramResult.reason.message,
    youtube: youtubeResult.status === "fulfilled" ? youtubeResult.value.source : youtubeResult.reason.message
  };
  const clips = [
    ...(tiktokResult.status === "fulfilled" ? tiktokResult.value.items : []),
    ...(instagramResult.status === "fulfilled" ? instagramResult.value.items : []),
    ...(youtubeResult.status === "fulfilled" ? youtubeResult.value.items : [])
  ]
    .filter((item) => item.url && item.url !== "#")
    .filter((item) => {
      if (!item.publishedAt) return true;
      const publishedAt = new Date(item.publishedAt).getTime();
      return !Number.isNaN(publishedAt) && Date.now() - publishedAt <= TREND_LOOKBACK_MS;
    })
    .sort((a, b) => (b.views || b.score || 0) - (a.views || a.score || 0))
    .slice(0, 8);

  return { clips, sources };
}

function buildObservedTrendPoints(clips) {
  const byDate = clips.reduce((map, clip) => {
    const publishedAt = new Date(clip.publishedAt || "");
    if (Number.isNaN(publishedAt.getTime())) return map;
    const date = publishedAt.toISOString().slice(0, 10);
    const current = map.get(date) || {
      date,
      label: formatTrendLabel(date),
      vv: 0,
      clipCount: 0,
      source: "live-platform-search"
    };
    current.vv += Number(clip.views || clip.score || 0);
    current.clipCount += 1;
    map.set(date, current);
    return map;
  }, new Map());

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const cultureProfiles = {
  Mexico: {
    identity: "墨西哥足球常带有强烈的节奏感、街头足球气质和主场声浪，绿色球衣与鹰蛇纹章是非常鲜明的国家符号。",
    symbols: ["绿色球衣", "鹰蛇纹章", "墨西哥城", "拉丁鼓点"],
    visualStyle: "vivid green, red and white, Aztec-inspired geometric pattern, stadium chants"
  },
  Canada: {
    identity: "加拿大队近年崛起速度很快，视觉文化常与枫叶、多元城市、冰雪与北美新生代足球气质联系在一起。",
    symbols: ["枫叶", "红白配色", "多元城市", "北境气质"],
    visualStyle: "red maple leaf, crisp white snow light, modern North American football energy"
  },
  "United States": {
    identity: "美国队强调速度、身体对抗和年轻化，文化符号常来自星条旗、城市体育场、校园体育与多元球迷社区。",
    symbols: ["星条旗", "红白蓝", "城市体育", "年轻阵容"],
    visualStyle: "red white and blue, bold stripes, modern arena lights, energetic supporters"
  },
  Brazil: {
    identity: "巴西足球代表桑巴节奏、黄色战袍和高创造力，球迷文化里有音乐、海滩、街头球场与进攻美学。",
    symbols: ["黄色球衣", "桑巴", "街头足球", "五冠传统"],
    visualStyle: "canary yellow and green, samba rhythm, beach football, joyful attacking flair"
  },
  Argentina: {
    identity: "阿根廷足球有蓝白条纹、探戈气质和强烈的国家队情感，球迷文化以歌声、旗帜和历史巨星记忆闻名。",
    symbols: ["蓝白条纹", "五月太阳", "探戈", "看台歌声"],
    visualStyle: "sky blue and white stripes, golden sun emblem, passionate terraces, cinematic emotion"
  },
  "South Africa": {
    identity: "南非队常与彩虹之国、多元文化和高能看台联系在一起，绿色与金色能自然带出国家队的视觉识别。",
    symbols: ["绿色与金色", "彩虹之国", "约翰内斯堡", "节奏看台"],
    visualStyle: "green and gold, rainbow nation energy, rhythmic supporters, African textile details"
  }
};

const playerProfiles = {
  Mexico: [
    ["Santiago Gimenez", "Forward"],
    ["Hirving Lozano", "Winger"],
    ["Edson Alvarez", "Midfielder"],
    ["Raul Jimenez", "Forward"],
    ["Guillermo Ochoa", "Goalkeeper"]
  ],
  "South Africa": [
    ["Ronwen Williams", "Goalkeeper"],
    ["Percy Tau", "Forward"],
    ["Teboho Mokoena", "Midfielder"],
    ["Themba Zwane", "Midfielder"],
    ["Lyle Foster", "Forward"]
  ],
  Canada: [
    ["Alphonso Davies", "Left back"],
    ["Jonathan David", "Forward"],
    ["Tajon Buchanan", "Winger"],
    ["Stephen Eustaquio", "Midfielder"],
    ["Cyle Larin", "Forward"]
  ],
  "United States": [
    ["Christian Pulisic", "Winger"],
    ["Weston McKennie", "Midfielder"],
    ["Tyler Adams", "Midfielder"],
    ["Gio Reyna", "Attacking midfielder"],
    ["Folarin Balogun", "Forward"]
  ],
  Brazil: [
    ["Vinicius Junior", "Winger"],
    ["Rodrygo", "Forward"],
    ["Endrick", "Forward"],
    ["Bruno Guimaraes", "Midfielder"],
    ["Alisson Becker", "Goalkeeper"]
  ],
  Argentina: [
    ["Lionel Messi", "Forward"],
    ["Julian Alvarez", "Forward"],
    ["Lautaro Martinez", "Forward"],
    ["Enzo Fernandez", "Midfielder"],
    ["Emiliano Martinez", "Goalkeeper"]
  ],
  France: [
    ["Kylian Mbappe", "Forward"],
    ["Antoine Griezmann", "Forward"],
    ["Aurelien Tchouameni", "Midfielder"],
    ["Eduardo Camavinga", "Midfielder"],
    ["Mike Maignan", "Goalkeeper"]
  ],
  England: [
    ["Harry Kane", "Forward"],
    ["Jude Bellingham", "Midfielder"],
    ["Bukayo Saka", "Winger"],
    ["Phil Foden", "Attacking midfielder"],
    ["Declan Rice", "Midfielder"]
  ],
  Portugal: [
    ["Cristiano Ronaldo", "Forward"],
    ["Bruno Fernandes", "Midfielder"],
    ["Bernardo Silva", "Midfielder"],
    ["Rafael Leao", "Winger"],
    ["Diogo Costa", "Goalkeeper"]
  ],
  Germany: [
    ["Florian Wirtz", "Attacking midfielder"],
    ["Jamal Musiala", "Attacking midfielder"],
    ["Kai Havertz", "Forward"],
    ["Joshua Kimmich", "Midfielder"],
    ["Manuel Neuer", "Goalkeeper"]
  ],
  Spain: [
    ["Lamine Yamal", "Winger"],
    ["Pedri", "Midfielder"],
    ["Gavi", "Midfielder"],
    ["Nico Williams", "Winger"],
    ["Rodri", "Midfielder"]
  ],
  Netherlands: [
    ["Virgil van Dijk", "Defender"],
    ["Frenkie de Jong", "Midfielder"],
    ["Cody Gakpo", "Forward"],
    ["Xavi Simons", "Attacking midfielder"],
    ["Denzel Dumfries", "Defender"]
  ],
  Japan: [
    ["Kaoru Mitoma", "Winger"],
    ["Takefusa Kubo", "Winger"],
    ["Wataru Endo", "Midfielder"],
    ["Takumi Minamino", "Forward"],
    ["Zion Suzuki", "Goalkeeper"]
  ],
  "South Korea": [
    ["Son Heung-min", "Forward"],
    ["Kim Min-jae", "Defender"],
    ["Lee Kang-in", "Midfielder"],
    ["Hwang Hee-chan", "Forward"],
    ["Cho Gue-sung", "Forward"]
  ],
  Morocco: [
    ["Achraf Hakimi", "Defender"],
    ["Hakim Ziyech", "Winger"],
    ["Sofyan Amrabat", "Midfielder"],
    ["Youssef En-Nesyri", "Forward"],
    ["Bono", "Goalkeeper"]
  ],
  Belgium: [
    ["Kevin De Bruyne", "Midfielder"],
    ["Romelu Lukaku", "Forward"],
    ["Jeremy Doku", "Winger"],
    ["Youri Tielemans", "Midfielder"],
    ["Thibaut Courtois", "Goalkeeper"]
  ],
  Croatia: [
    ["Luka Modric", "Midfielder"],
    ["Josko Gvardiol", "Defender"],
    ["Mateo Kovacic", "Midfielder"],
    ["Marcelo Brozovic", "Midfielder"],
    ["Andrej Kramaric", "Forward"]
  ],
  Uruguay: [
    ["Federico Valverde", "Midfielder"],
    ["Darwin Nunez", "Forward"],
    ["Ronald Araujo", "Defender"],
    ["Manuel Ugarte", "Midfielder"],
    ["Luis Suarez", "Forward"]
  ],
  Norway: [
    ["Erling Haaland", "Forward"],
    ["Martin Odegaard", "Midfielder"],
    ["Alexander Sorloth", "Forward"],
    ["Oscar Bobb", "Winger"],
    ["Orjan Nyland", "Goalkeeper"]
  ]
};

function findTeamByName(name = "") {
  const normalized = name.toLowerCase();
  return scheduleCache.data.teams.find((team) => {
    return [team.name_en, team.fifa_code, team.iso2].filter(Boolean).some((value) => String(value).toLowerCase() === normalized);
  });
}

function getTeamMatches(teamName) {
  return scheduleCache.data.matches.filter((match) => match.homeTeam === teamName || match.awayTeam === teamName);
}

function avatarSeed(name = "") {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "XI";
}

function buildFallbackPlayers(teamName) {
  return [
    [`${teamName} Captain`, "Captain"],
    [`${teamName} Striker`, "Forward"],
    [`${teamName} Playmaker`, "Midfielder"],
    [`${teamName} Defender`, "Defender"],
    [`${teamName} Goalkeeper`, "Goalkeeper"]
  ];
}

function buildTeamPlayers(teamName) {
  const roster = playerProfiles[teamName] || buildFallbackPlayers(teamName);
  return roster.map(([name, role], index) => ({
    id: `${teamName}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
    name,
    role,
    initials: avatarSeed(name),
    avatarTone: index % 5,
    note: playerProfiles[teamName] ? "代表球员参考，非 2026 最终名单" : "成员角色占位，可用于创作 prompt"
  }));
}

function buildTeamProfile(name) {
  const team = findTeamByName(name);
  const teamName = team?.name_en || name;
  const profile = cultureProfiles[teamName] || {
    identity: `${teamName} 的国家队文化可以从国旗色彩、球迷歌声、城市地标和本土足球传统中提炼。当前资料源未提供更细的文化标签，因此这里生成一个稳健的创作方向，适合继续人工细化。`,
    symbols: [team?.fifa_code || teamName, "national colors", "supporter chants", "stadium atmosphere"],
    visualStyle: "national flag colors, authentic supporter culture, cinematic stadium atmosphere"
  };
  const matches = getTeamMatches(teamName).slice(0, 5);
  return {
    name: teamName,
    code: team?.fifa_code || "",
    flag: team?.flag || "",
    group: team?.groups || "",
    identity: profile.identity,
    symbols: profile.symbols,
    upcomingMatches: matches.map((match) => ({
      id: match.id,
      label: `${match.homeTeam} vs ${match.awayTeam}`,
      localDate: match.localDate,
      venue: match.venue
    })),
    visualStyle: profile.visualStyle,
    prompt: buildSupportPrompt(teamName, profile.visualStyle, "cinematic poster"),
    players: buildTeamPlayers(teamName)
  };
}

function buildSupportPrompt(teamName, visualStyle, mode = "cinematic poster", referenceNote = "") {
  const modeMap = {
    "cinematic poster": "a cinematic 2026 World Cup supporter poster",
    "vertical video": "a 9:16 vertical AI video storyboard with energetic camera movement",
    "matchday banner": "a bold matchday banner for social media",
    "street celebration": "a street celebration scene with authentic local supporters"
  };
  return `Create ${modeMap[mode] || modeMap["cinematic poster"]} for ${teamName}. Feature ${visualStyle}. Show passionate fans lifting scarves and flags, authentic national colors, dynamic stadium floodlights, confetti, dramatic sports photography, high detail, editorial composition, no text, no logos, suitable for AI image or video generation.${referenceNote ? ` Use the uploaded reference image as visual guidance for ${referenceNote}.` : ""}`;
}

function buildPlayerSelfiePrompt(teamName, playerName, role = "football player") {
  const profile = cultureProfiles[teamName] || {};
  const visualStyle = profile.visualStyle || "authentic national colors, energetic stadium atmosphere, football supporter culture";
  return `Create a realistic AI fan selfie with ${playerName}, ${role} for ${teamName}. Show the user standing beside the player in a lively World Cup stadium concourse, both smiling naturally, wearing ${teamName} inspired colors, soft cinematic lighting, handheld phone selfie perspective, authentic crowd energy, ${visualStyle}, high-detail portrait photography, respectful likeness, no text, no logos, suitable for AI image generation.`;
}

function hasChinese(text = "") {
  return /[\u3400-\u9fff]/.test(text);
}

async function translateToChinese(text = "") {
  const cleaned = cleanText(text).slice(0, 900);
  if (!cleaned || hasChinese(cleaned)) return cleaned;
  if (translationCache.has(cleaned)) return translationCache.get(cleaned);

  const timer = withTimeout(10000);
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(cleaned)}&langpair=en|zh-CN`;
    const response = await fetch(url, {
      signal: timer.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "WorldCup2026LiveDashboard/1.0"
      }
    });
    if (!response.ok) throw new Error(`translation returned ${response.status}`);
    const data = await response.json();
    const translated = cleanText(data.responseData?.translatedText || "");
    const result = translated || cleaned;
    translationCache.set(cleaned, result);
    return result;
  } finally {
    timer.done();
  }
}

function findMatch(id) {
  return scheduleCache.data.matches.find((match) => String(match.id) === String(id));
}

app.get("/api/schedule", async (_request, response) => {
  await ensureScheduleFresh();
  response.json({
    ...scheduleCache.data,
    meta: {
      updatedAt: scheduleCache.updatedAt,
      source: scheduleCache.source,
      liveScoreSource: scheduleCache.liveScoreSource,
      liveScoreUpdatedAt: scheduleCache.liveScoreUpdatedAt,
      liveScoreError: scheduleCache.liveScoreError,
      liveScoreMatches: scheduleCache.data.liveScoreMatches || 0,
      error: scheduleCache.error,
      refreshMs: REFRESH_MS
    }
  });
});

app.get("/api/matches/:id/insights", async (request, response) => {
  await ensureScheduleFresh();
  const match = findMatch(request.params.id);
  if (!match) {
    response.status(404).json({ error: "Match not found" });
    return;
  }

  const query = request.query.q || `"${match.homeTeam}" "${match.awayTeam}" "2026 World Cup"`;
  const cacheKey = `${match.id}:${query}`;
  const cached = insightsCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < INSIGHTS_TTL_MS) {
    response.json({ ...cached.data, cached: true });
    return;
  }

  const since = new Date(Date.now() - SOCIAL_LOOKBACK_MS).toISOString();
  const homeLeadPlayer = buildTeamPlayers(match.homeTeam)[0]?.name || "";
  const awayLeadPlayer = buildTeamPlayers(match.awayTeam)[0]?.name || "";
  const socialQuery = `${match.homeTeam} ${match.awayTeam} ${homeLeadPlayer} ${awayLeadPlayer} World Cup 2026`;
  const [newsResult, redditResult, blueskyResult, hackerNewsResult, tiktokResult, instagramResult, youtubeResult] = await Promise.allSettled([
    getGoogleNews(query),
    getReddit(socialQuery),
    getBluesky(socialQuery),
    getHackerNews(socialQuery),
    getPlatformBridge("TikTok", socialQuery, TIKTOK_BRIDGE_URL, { since }),
    getPlatformBridge("Instagram", socialQuery, INSTAGRAM_BRIDGE_URL, { since }),
    getPlatformBridge("YouTube", socialQuery, YOUTUBE_BRIDGE_URL, { since })
  ]);

  const news = newsResult.status === "fulfilled" ? newsResult.value : [];
  const reddit = redditResult.status === "fulfilled" ? redditResult.value : [];
  const bluesky = blueskyResult.status === "fulfilled" ? blueskyResult.value : [];
  const hackerNews = hackerNewsResult.status === "fulfilled" ? hackerNewsResult.value : [];
  const tiktok = tiktokResult.status === "fulfilled" ? tiktokResult.value.items : [];
  const instagram = instagramResult.status === "fulfilled" ? instagramResult.value.items : [];
  const youtube = youtubeResult.status === "fulfilled" ? youtubeResult.value.items : [];
  const social = [...reddit, ...bluesky, ...hackerNews, ...tiktok, ...instagram, ...youtube]
    .filter((item) => isRecentSocialItem(item))
    .filter((item) => isRelevantSocialItem(item, match))
    .map((item) => enrichSocialItem(item))
    .filter((item) => item.socialVV >= 500)
    .sort((a, b) => (b.socialRankScore || 0) - (a.socialRankScore || 0));

  const data = {
    match,
    query,
    summary: buildAISummary(match, news, social, buildHotspots(news, social)),
    news,
    social,
    hotspots: buildHotspots(news, social),
    sources: {
      news: newsResult.status === "fulfilled" ? "Google News RSS" : newsResult.reason.message,
      reddit: redditResult.status === "fulfilled" ? "PullPush Reddit index" : redditResult.reason.message,
      bluesky: blueskyResult.status === "fulfilled" ? "Bluesky public search" : blueskyResult.reason.message,
      hackerNews: hackerNewsResult.status === "fulfilled" ? "Hacker News Algolia" : hackerNewsResult.reason.message,
      tiktok: tiktokResult.status === "fulfilled" ? tiktokResult.value.source : tiktokResult.reason.message,
      instagram: instagramResult.status === "fulfilled" ? instagramResult.value.source : instagramResult.reason.message,
      youtube: youtubeResult.status === "fulfilled" ? youtubeResult.value.source : youtubeResult.reason.message
    },
    updatedAt: new Date().toISOString()
  };

  insightsCache.set(cacheKey, { createdAt: Date.now(), data });
  response.json(data);
});

app.get("/api/teams/:name/profile", async (request, response) => {
  await ensureScheduleFresh();
  response.json(buildTeamProfile(request.params.name));
});

app.get("/api/teams/:name/prompt", async (request, response) => {
  await ensureScheduleFresh();
  const profile = buildTeamProfile(request.params.name);
  const mode = request.query.mode || "cinematic poster";
  const referenceNote = request.query.referenceNote || "";
  response.json({
    name: profile.name,
    prompt: buildSupportPrompt(profile.name, profile.visualStyle, mode, referenceNote)
  });
});

app.get("/api/teams/:name/players/:playerName/prompt", async (request, response) => {
  await ensureScheduleFresh();
  const profile = buildTeamProfile(request.params.name);
  const playerName = request.params.playerName;
  const player = (profile.players || []).find((item) => item.name.toLowerCase() === playerName.toLowerCase()) || {
    name: playerName,
    role: "football player"
  };
  response.json({
    team: profile.name,
    player: player.name,
    prompt: buildPlayerSelfiePrompt(profile.name, player.name, player.role)
  });
});

app.post("/api/translate", async (request, response) => {
  const text = request.body?.text || "";
  if (!text || typeof text !== "string") {
    response.status(400).json({ error: "text is required" });
    return;
  }
  try {
    response.json({
      original: text,
      translated: await translateToChinese(text)
    });
  } catch (error) {
    response.status(502).json({ error: error.message, original: text });
  }
});

app.get("/api/hashtag-trends", async (_request, response) => {
  await ensureScheduleFresh();
  const { clips, sources } = await getHashtagTrendClips();
  const observedPoints = buildObservedTrendPoints(clips);
  response.json({
    hashtags: ["#WorldCup2026", "#FIFAWorldCup", "#WeAre26"],
    mode: observedPoints.length ? "projection-and-observed-vv" : "schedule-projection",
    pointSource: "schedule-projection",
    clipSource: "live-platform-search",
    explanation: "Dashed line is a schedule-based VV projection. Solid line is observed published-content VV from TikTok, Instagram, and YouTube.",
    points: buildTrendProjection(),
    observedPoints,
    clips,
    sources,
    updatedAt: new Date().toISOString()
  });
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, updatedAt: new Date().toISOString() });
});

refreshSchedule();

if (!process.env.VERCEL) {
  setInterval(refreshSchedule, REFRESH_MS);
  app.listen(PORT, () => {
    console.log(`World Cup live dashboard running at http://localhost:${PORT}`);
  });
}

export default app;
