import express from "express";
import cors from "cors";
import Parser from "rss-parser";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const PORT = Number(process.env.PORT || 4173);
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

const scheduleCache = {
  updatedAt: null,
  source: "not-loaded",
  error: null,
  data: { matches: [], teams: [], stadiums: [] }
};

const insightsCache = new Map();
const translationCache = new Map();

const fallbackSchedule = {
  source: "local-fallback",
  matches: [
    {
      id: "1",
      matchNo: 1,
      homeTeam: "Mexico",
      awayTeam: "South Africa",
      group: "A",
      stage: "Group A",
      type: "group",
      matchday: "1",
      localDate: "06/11/2026 13:00",
      venue: "Estadio Azteca",
      city: "Mexico City",
      country: "Mexico",
      status: "notstarted",
      homeScore: 0,
      awayScore: 0
    },
    {
      id: "2",
      matchNo: 2,
      homeTeam: "South Korea",
      awayTeam: "Czech Republic",
      group: "A",
      stage: "Group A",
      type: "group",
      matchday: "1",
      localDate: "06/11/2026 20:00",
      venue: "Estadio Akron",
      city: "Guadalajara",
      country: "Mexico",
      status: "notstarted",
      homeScore: 0,
      awayScore: 0
    },
    {
      id: "3",
      matchNo: 3,
      homeTeam: "Canada",
      awayTeam: "Bosnia and Herzegovina",
      group: "B",
      stage: "Group B",
      type: "group",
      matchday: "1",
      localDate: "06/12/2026 15:00",
      venue: "BMO Field",
      city: "Toronto",
      country: "Canada",
      status: "notstarted",
      homeScore: 0,
      awayScore: 0
    }
  ],
  teams: [],
  stadiums: []
};

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

async function refreshSchedule() {
  try {
    const [games, teams, stadiums] = await Promise.all([
      fetchJson("/get/games"),
      fetchJson("/get/teams"),
      fetchJson("/get/stadiums")
    ]);
    scheduleCache.data = normalizeSchedule(games, teams, stadiums);
    scheduleCache.updatedAt = new Date().toISOString();
    scheduleCache.source = WORLDCUP_API_BASE;
    scheduleCache.error = null;
  } catch (error) {
    if (!scheduleCache.data.matches.length) {
      scheduleCache.data = fallbackSchedule;
    }
    scheduleCache.updatedAt = scheduleCache.updatedAt || new Date().toISOString();
    scheduleCache.source = scheduleCache.data.matches.length ? `${scheduleCache.source} + fallback` : "local-fallback";
    scheduleCache.error = error.message;
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

function buildAISummary(match, news, social, hotspots) {
  const titles = news.map((item) => item.title).filter(Boolean);
  const outlets = [...new Set(titles.map(extractOutlet).filter(Boolean))].slice(0, 4);
  const topSocial = social
    .filter((item) => item.title)
    .sort((a, b) => (b.score || b.likes || 0) - (a.score || a.likes || 0))
    .slice(0, 2);
  const topHotspots = hotspots.slice(0, 3).map((topic) => topic.name);
  const matchup = `${match.homeTeam} vs ${match.awayTeam}`;

  const bullets = [];
  if (news.length) {
    bullets.push(`当前围绕 ${matchup} 已聚合 ${news.length} 条新闻，主要关注赛前展望、球队状态和赛事背景。`);
  } else {
    bullets.push(`${matchup} 的相关新闻还不多，临近比赛日后信息密度会明显提升。`);
  }
  if (topHotspots.length) {
    bullets.push(`热度最高的议题集中在：${topHotspots.join("、")}。`);
  } else {
    bullets.push("目前还没有形成特别集中的热点议题，适合持续观察后续变化。");
  }
  if (topSocial.length) {
    bullets.push(`公开讨论里最活跃的反馈来自 ${[...new Set(topSocial.map((item) => item.network))].join("、")}，话题更偏球迷预测和情绪表达。`);
  }
  if (outlets.length) {
    bullets.push(`新闻来源覆盖 ${outlets.join("、")} 等媒体，可点击原文进一步核验。`);
  }

  return {
    headline: `${matchup}：赛前信息雷达`,
    bullets: bullets.slice(0, 4),
    watchlist: topHotspots.length ? topHotspots : ["球队名单", "赛前发布会", "球迷反馈"],
    generatedBy: "local-news-summarizer"
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

function findTeamByName(name = "") {
  const normalized = name.toLowerCase();
  return scheduleCache.data.teams.find((team) => {
    return [team.name_en, team.fifa_code, team.iso2].filter(Boolean).some((value) => String(value).toLowerCase() === normalized);
  });
}

function getTeamMatches(teamName) {
  return scheduleCache.data.matches.filter((match) => match.homeTeam === teamName || match.awayTeam === teamName);
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
    prompt: buildSupportPrompt(teamName, profile.visualStyle, "cinematic poster")
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
  if (!scheduleCache.data.matches.length) await refreshSchedule();
  response.json({
    ...scheduleCache.data,
    meta: {
      updatedAt: scheduleCache.updatedAt,
      source: scheduleCache.source,
      error: scheduleCache.error,
      refreshMs: REFRESH_MS
    }
  });
});

app.get("/api/matches/:id/insights", async (request, response) => {
  if (!scheduleCache.data.matches.length) await refreshSchedule();
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
  const [newsResult, redditResult, blueskyResult, hackerNewsResult, tiktokResult, instagramResult, youtubeResult] = await Promise.allSettled([
    getGoogleNews(query),
    getReddit(`${match.homeTeam} ${match.awayTeam} World Cup`),
    getBluesky(`${match.homeTeam} ${match.awayTeam} World Cup`),
    getHackerNews(`${match.homeTeam} ${match.awayTeam} World Cup`),
    getPlatformBridge("TikTok", `${match.homeTeam} ${match.awayTeam} World Cup`, TIKTOK_BRIDGE_URL, { since }),
    getPlatformBridge("Instagram", `${match.homeTeam} ${match.awayTeam} World Cup`, INSTAGRAM_BRIDGE_URL, { since }),
    getPlatformBridge("YouTube", `${match.homeTeam} ${match.awayTeam} World Cup`, YOUTUBE_BRIDGE_URL, { since })
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
    .sort((a, b) => {
      const aDate = new Date(a.publishedAt || 0).getTime();
      const bDate = new Date(b.publishedAt || 0).getTime();
      return bDate - aDate;
    });

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
  if (!scheduleCache.data.matches.length) await refreshSchedule();
  response.json(buildTeamProfile(request.params.name));
});

app.get("/api/teams/:name/prompt", async (request, response) => {
  if (!scheduleCache.data.matches.length) await refreshSchedule();
  const profile = buildTeamProfile(request.params.name);
  const mode = request.query.mode || "cinematic poster";
  const referenceNote = request.query.referenceNote || "";
  response.json({
    name: profile.name,
    prompt: buildSupportPrompt(profile.name, profile.visualStyle, mode, referenceNote)
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
  if (!scheduleCache.data.matches.length) await refreshSchedule();
  const { clips, sources } = await getHashtagTrendClips();
  response.json({
    hashtags: ["#WorldCup2026", "#FIFAWorldCup", "#WeAre26"],
    mode: clips.length ? "live-video-vv" : "schedule-projection",
    points: buildTrendProjection(),
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
