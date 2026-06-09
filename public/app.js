const state = {
  matches: [],
  filtered: [],
  stage: "all",
  query: "",
  selectedId: null,
  meta: null,
  activeDetailTab: "news",
  activeInsights: null,
  activeProfile: null,
  promptMode: "cinematic poster",
  referenceImageNote: "",
  trendData: null,
  trendProgress: 0,
  trendCollapsed: false
};

const els = {
  syncStatus: document.querySelector("#syncStatus"),
  timeline: document.querySelector("#timeline"),
  stageFilters: document.querySelector("#stageFilters"),
  searchInput: document.querySelector("#searchInput"),
  refreshButton: document.querySelector("#refreshButton"),
  matchCount: document.querySelector("#matchCount"),
  cityCount: document.querySelector("#cityCount"),
  nextMatch: document.querySelector("#nextMatch"),
  sourceName: document.querySelector("#sourceName"),
  lastUpdated: document.querySelector("#lastUpdated"),
  drawer: document.querySelector("#drawer"),
  closeDrawer: document.querySelector("#closeDrawer"),
  matchDetail: document.querySelector("#matchDetail"),
  trendMonitor: document.querySelector("#trendMonitor"),
  trendToggle: document.querySelector("#trendToggle"),
  trendPanel: document.querySelector("#trendPanel"),
  trendMode: document.querySelector("#trendMode"),
  hashtagRow: document.querySelector("#hashtagRow"),
  trendChart: document.querySelector("#trendChart"),
  trendVideos: document.querySelector("#trendVideos"),
  trendSource: document.querySelector("#trendSource")
};

const stageOrder = ["all", "group", "round16", "quarter", "semi", "final"];
const stageNames = {
  all: "全部",
  group: "小组赛",
  round16: "16 强",
  quarter: "1/4 决赛",
  semi: "半决赛",
  final: "决赛"
};

const detailTabs = [
  ["news", "新闻"],
  ["hotspots", "热点事件"],
  ["social", "社交反馈"]
];

function formatDateLabel(value) {
  if (!value) return "待定日期";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.split(" ")[0] || "待定日期";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    weekday: "short"
  }).format(date);
}

function formatTime(value, fallback) {
  if (!value) return fallback || "待定";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback?.split(" ")[1] || "待定";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatAxisDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric"
  }).format(date);
}

function relativeTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (abs < 1000 * 60 * 60) return formatter.format(Math.round(diff / (1000 * 60)), "minute");
  if (abs < 1000 * 60 * 60 * 24) return formatter.format(Math.round(diff / (1000 * 60 * 60)), "hour");
  return formatter.format(Math.round(diff / (1000 * 60 * 60 * 24)), "day");
}

function formatVV(value = 0) {
  const number = Number(value || 0);
  if (number >= 100000000) return `${(number / 100000000).toFixed(1)}亿`;
  if (number >= 10000) return `${(number / 10000).toFixed(1)}万`;
  return new Intl.NumberFormat("zh-CN").format(number);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

function renderStageFilters() {
  const available = new Set(state.matches.map((match) => match.type));
  const stages = stageOrder.filter((stage) => stage === "all" || available.has(stage));
  els.stageFilters.innerHTML = stages
    .map((stage) => `
      <button type="button" class="${state.stage === stage ? "active" : ""}" data-stage="${stage}">
        ${stageNames[stage] || stage}
      </button>
    `)
    .join("");
}

function applyFilters() {
  const query = state.query.trim().toLowerCase();
  state.filtered = state.matches.filter((match) => {
    const stageMatch = state.stage === "all" || match.type === state.stage;
    const haystack = [
      match.homeTeam,
      match.awayTeam,
      match.group,
      match.stage,
      match.venue,
      match.city,
      match.country,
      match.matchNo
    ].join(" ").toLowerCase();
    return stageMatch && (!query || haystack.includes(query));
  });
}

function groupByDay(matches) {
  return matches.reduce((groups, match) => {
    const key = match.dateIso ? match.dateIso.slice(0, 10) : "TBD";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
    return groups;
  }, new Map());
}

function flagImg(url, name) {
  if (!url) return "";
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)} flag" loading="lazy" />`;
}

function scoreValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function getResultState(match) {
  const homeScore = scoreValue(match.homeScore);
  const awayScore = scoreValue(match.awayScore);
  const status = String(match.status || "").toLowerCase();
  const hasExplicitFinish = match.finished === true || ["true", "finished", "fulltime", "full-time", "ft", "ended"].some((token) => status.includes(token));
  const hasLiveSignal = ["live", "playing", "inprogress", "in-progress", "halftime", "half-time", "ht"].some((token) => status.includes(token)) || Number(status) > 0;
  const hasScore = hasExplicitFinish || hasLiveSignal || homeScore > 0 || awayScore > 0;
  const winner = hasExplicitFinish && homeScore !== awayScore
    ? homeScore > awayScore ? "home" : "away"
    : "";
  const isDraw = hasExplicitFinish && homeScore === awayScore;

  return {
    homeScore,
    awayScore,
    hasScore,
    winner,
    isDraw,
    label: hasExplicitFinish ? "完赛" : hasLiveSignal ? "进行中" : ""
  };
}

function renderTeamLine(match, side, result) {
  const isHome = side === "home";
  const team = isHome ? match.homeTeam : match.awayTeam;
  const flag = isHome ? match.homeFlag : match.awayFlag;
  const score = isHome ? result.homeScore : result.awayScore;
  const isWinner = result.winner === side;
  const classes = [
    "team-line",
    result.isDraw ? "draw" : "",
    isWinner ? "winner" : "",
    result.hasScore ? "has-score" : ""
  ].filter(Boolean).join(" ");

  return `
    <div class="${classes}">
      ${flagImg(flag, team)}
      <span>${escapeHtml(team)}</span>
      ${result.hasScore ? `<strong class="team-score" aria-label="${escapeHtml(team)} score">${score}</strong>` : ""}
    </div>
  `;
}

function renderTimeline() {
  if (!state.filtered.length) {
    els.timeline.innerHTML = `<div class="loader">没有匹配的赛事</div>`;
    return;
  }

  const grouped = groupByDay(state.filtered);
  els.timeline.innerHTML = [...grouped.entries()].map(([day, matches]) => `
    <div class="day-column">
      <div class="day-label">${escapeHtml(formatDateLabel(matches[0]?.dateIso || day))}</div>
      ${matches.map((match) => {
        const result = getResultState(match);
        return `
        <button class="match-node ${state.selectedId === match.id ? "active" : ""} ${result.winner ? "result-final has-winner" : ""} ${result.isDraw ? "result-final result-draw" : ""} ${result.hasScore && !result.winner && !result.isDraw ? "result-live" : ""}" type="button" data-match-id="${match.id}">
          <div class="match-meta">
            <span>#${match.matchNo || match.id} · ${escapeHtml(match.stage)}</span>
            <span>${result.label ? `<b class="result-label">${escapeHtml(result.label)}</b>` : escapeHtml(formatTime(match.dateIso, match.localDate))}</span>
          </div>
          <div class="teams">
            ${renderTeamLine(match, "home", result)}
            ${renderTeamLine(match, "away", result)}
          </div>
          ${result.hasScore ? `<div class="result-strip">${result.winner ? "胜者已高亮" : result.isDraw ? "平局" : "比分更新"} · ${result.homeScore} : ${result.awayScore}</div>` : ""}
          <p class="venue">${escapeHtml([match.venue, match.city].filter(Boolean).join(" · "))}</p>
        </button>
      `;
      }).join("")}
    </div>
  `).join("");
}

function renderMetrics() {
  const cities = new Set(state.matches.map((match) => match.city).filter(Boolean));
  const upcoming = state.matches.find((match) => !match.finished);
  els.matchCount.textContent = state.matches.length;
  els.cityCount.textContent = cities.size;
  els.nextMatch.textContent = upcoming ? `#${upcoming.matchNo}` : "--";
  els.sourceName.textContent = state.meta?.source || "未知";
  els.lastUpdated.textContent = state.meta?.updatedAt
    ? `最后同步 ${new Date(state.meta.updatedAt).toLocaleString("zh-CN")}`
    : "--";
  els.syncStatus.textContent = state.meta?.error
    ? `赛程已载入，远端提示：${state.meta.error}`
    : `实时同步中 · ${state.matches.length} 场`;
}

function rerender() {
  applyFilters();
  renderStageFilters();
  renderTimeline();
  renderMetrics();
}

async function loadSchedule() {
  els.syncStatus.textContent = "正在同步赛程";
  const data = await fetchJson("/api/schedule");
  state.matches = data.matches || [];
  state.meta = data.meta || {};
  rerender();
}

async function loadTrendData() {
  const data = await fetchJson("/api/hashtag-trends");
  state.trendData = data;
  renderTrendMonitor();
}

function renderTrendMonitor() {
  const data = state.trendData;
  if (!data) return;
  const points = data.points || [];
  const observedPoints = data.observedPoints || [];
  const clips = data.clips || [];
  const width = 1600;
  const height = 164;
  const left = 48;
  const right = 28;
  const top = 20;
  const plotBottom = 118;
  const axisY = 132;
  const labelY = 152;
  const values = [...points, ...observedPoints].length ? [...points, ...observedPoints].map((point) => point.vv || 0) : [0];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const dateValues = [...points, ...observedPoints]
    .map((point) => new Date(`${point.date}T00:00:00`).getTime())
    .filter((value) => !Number.isNaN(value));
  const minDate = dateValues.length ? Math.min(...dateValues) : Date.UTC(2026, 5, 11);
  const maxDate = dateValues.length ? Math.max(...dateValues) : Date.UTC(2026, 6, 19);
  const xForTime = (time) => {
    const safeTime = Number.isNaN(time) ? minDate : Math.min(Math.max(time, minDate), maxDate);
    if (maxDate === minDate) return left;
    return left + ((safeTime - minDate) / (maxDate - minDate)) * (width - left - right);
  };
  const scaleY = (value) => {
    if (max === min) return (top + plotBottom) / 2;
    return plotBottom - ((value - min) / (max - min)) * (plotBottom - top);
  };
  const projectPoint = (point, index, list) => {
    const dateTime = new Date(`${point.date}T00:00:00`).getTime();
    const x = dateValues.length ? xForTime(dateTime) : list.length <= 1 ? left : left + (index / (list.length - 1)) * (width - left - right);
    const y = scaleY(point.vv || 0);
    return { ...point, x, y };
  };
  const projectedXY = points.map(projectPoint);
  const observedXY = observedPoints.map(projectPoint);
  const nearestPoint = (x) => [...observedXY, ...projectedXY].reduce((nearest, point) => {
    if (!nearest) return point;
    return Math.abs(point.x - x) < Math.abs(nearest.x - x) ? point : nearest;
  }, null);
  const projectionPath = projectedXY.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const observedPath = observedXY.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const finalDate = Date.UTC(2026, 6, 19);
  const openingDate = Date.UTC(2026, 5, 11);
  const tickTimes = [minDate, openingDate, Math.round((minDate + finalDate) / 2), finalDate]
    .filter((time) => time >= minDate && time <= maxDate)
    .filter((time, index, list) => list.findIndex((item) => Math.abs(item - time) < 1000 * 60 * 60 * 24 * 2) === index);
  const axisTicks = tickTimes.map((time) => {
    const x = xForTime(time);
    const date = new Date(time).toISOString().slice(0, 10);
    return `
      <g class="trend-axis-tick">
        <line x1="${x.toFixed(1)}" y1="${axisY - 6}" x2="${x.toFixed(1)}" y2="${axisY + 4}" />
        <text x="${x.toFixed(1)}" y="${labelY}">${escapeHtml(formatAxisDate(date))}</text>
      </g>
    `;
  }).join("");
  const clipDots = clips.slice(0, 8).map((clip, index) => {
    const publishedTime = new Date(clip.publishedAt || "").getTime();
    const x = xForTime(publishedTime);
    const anchor = nearestPoint(x) || { y: scaleY(clip.views || clip.score || 0) };
    const y = Math.max(top + 7, Math.min(plotBottom - 7, anchor.y - 12 - (index % 3) * 8));
    return `
      <a href="${escapeHtml(clip.url)}" target="_blank" rel="noreferrer">
        <circle class="clip-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${index < 3 ? 7 : 5}">
          <title>${escapeHtml(clip.network)} · ${formatVV(clip.views || clip.score)} VV · ${escapeHtml(clip.title)}</title>
        </circle>
      </a>
    `;
  }).join("");

  els.trendMode.textContent = data.mode === "projection-and-observed-vv" ? "预估 VV + 真实 VV" : "赛程热度预测";
  els.hashtagRow.innerHTML = (data.hashtags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  els.trendChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="世界杯 hashtag vv 趋势图">
      <defs>
        <linearGradient id="trendFill" x1="0" x2="1">
          <stop offset="0" stop-color="#f6c13f" />
          <stop offset="1" stop-color="#0f8b74" />
        </linearGradient>
      </defs>
      <path class="trend-grid" d="M ${left} ${plotBottom} H ${width - right} M ${left} ${(top + plotBottom) / 2} H ${width - right} M ${left} ${top} H ${width - right}" />
      <path class="trend-axis" d="M ${left} ${axisY} H ${width - right}" />
      ${projectionPath ? `<path class="trend-line trend-projection-line" d="${projectionPath}" />` : ""}
      ${observedPath ? `<path class="trend-line trend-observed-line" d="${observedPath}" />` : ""}
      ${projectedXY.map((point, index) => index % 5 === 0 ? `<circle class="trend-point projection-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3"><title>${escapeHtml(point.label)} · 预估 ${formatVV(point.vv)} VV</title></circle>` : "").join("")}
      ${observedXY.map((point) => `<circle class="trend-point observed-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"><title>${escapeHtml(point.label)} · 真实观测 ${formatVV(point.vv)} VV · ${point.clipCount || 0} 条内容</title></circle>`).join("")}
      ${clipDots}
      ${axisTicks}
    </svg>
    <div class="trend-window" style="left:${Math.round(state.trendProgress * 100)}%"></div>
    <div class="trend-legend">
      <span><i class="legend-dashed"></i>虚线：赛程预估 VV</span>
      <span><i class="legend-solid"></i>实线：真实观测 VV</span>
      <span><i class="legend-dot"></i>红点：高 VV 原视频</span>
    </div>
  `;
  els.trendVideos.innerHTML = clips.length
    ? clips.slice(0, 4).map((clip) => `
      <a class="trend-video" href="${escapeHtml(clip.url)}" target="_blank" rel="noreferrer">
        <span>${escapeHtml(clip.network)}</span>
        <strong>${escapeHtml(clip.title || "Untitled video")}</strong>
        <small>${formatVV(clip.views || clip.score)} VV · ${escapeHtml(relativeTime(clip.publishedAt))}</small>
      </a>
    `).join("")
    : `<div class="trend-empty">接入 TikTok / Instagram / YouTube 桥接器后，高 VV 原视频会挂到趋势线上。</div>`;
  els.trendSource.textContent = `TikTok：${data.sources?.tiktok || ""} · Instagram：${data.sources?.instagram || ""} · YouTube：${data.sources?.youtube || ""}`;
}

function updateTrendProgress() {
  const maxScroll = els.timeline.scrollWidth - els.timeline.clientWidth;
  state.trendProgress = maxScroll > 0 ? els.timeline.scrollLeft / maxScroll : 0;
  const marker = els.trendChart?.querySelector(".trend-window");
  if (marker) marker.style.left = `${Math.round(state.trendProgress * 100)}%`;
}

function renderLoading(match) {
  els.drawer.classList.add("open");
  els.matchDetail.className = "match-detail";
  els.matchDetail.innerHTML = `
    <h2>${renderTeamButton(match.homeTeam)} <span>vs</span> ${renderTeamButton(match.awayTeam)}</h2>
    <p class="detail-sub">${escapeHtml(match.stage)} · ${escapeHtml(match.venue)} · ${escapeHtml(match.localDate)}</p>
    <div class="loader">正在聚合新闻和公开社交反馈</div>
  `;
}

function renderTeamButton(name) {
  return `<button class="team-link" type="button" data-team-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
}

function renderFeed(items, emptyText, type) {
  if (!items?.length) return `<p class="detail-sub">${emptyText}</p>`;
  return `<div class="feed-list">
    ${items.map((item, index) => `
      <article class="feed-item">
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
          <strong>${escapeHtml(item.title || "Untitled")}</strong>
        </a>
        ${item.summary ? `<em>${escapeHtml(item.summary)}</em>` : ""}
        <span>${escapeHtml(item.source || item.network || "")}${item.author ? ` · ${escapeHtml(item.author)}` : ""}</span>
        <small>${escapeHtml(relativeTime(item.publishedAt))}${type === "social" ? ` · VV ${formatVV(item.socialVV ?? item.views ?? item.score ?? item.likes ?? 0)}${item.socialRankScore ? ` · 综合热度 ${formatVV(item.socialRankScore)}` : ""}` : ""}</small>
        <button class="translate-button" type="button" data-translate-text="${escapeHtml([item.title, item.summary].filter(Boolean).join(". "))}" data-translate-target="${type}-${index}">
          翻译
        </button>
        <p class="translation-output" data-translation-result="${type}-${index}"></p>
      </article>
    `).join("")}
  </div>`;
}

function renderSummary(summary) {
  if (!summary) return "";
  return `
    <section class="ai-summary">
      <div>
        <span>AI 摘要</span>
        <strong>${escapeHtml(summary.headline)}</strong>
      </div>
      <ul>
        ${(summary.bullets || []).map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}
      </ul>
      <div class="watchlist">
        ${(summary.watchlist || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      </div>
    </section>
  `;
}

function renderHotspots(hotspots) {
  if (!hotspots?.length) return `<p class="detail-sub">暂未识别出高频热点，赛前临近时会更丰富。</p>`;
  return `
    <div class="hotspot-board">
      ${hotspots.map((topic, index) => `
        <article class="hotspot-card">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <strong>${escapeHtml(topic.name)}</strong>
          <p>在当前新闻和公开讨论中出现 ${topic.count} 次，建议继续关注相关报道变化。</p>
          <button class="translate-button compact" type="button" data-translate-text="${escapeHtml(`${topic.name}. Appeared ${topic.count} times in current news and public discussions.`)}" data-translate-target="hotspot-${index}">
            翻译说明
          </button>
          <p class="translation-output" data-translation-result="hotspot-${index}"></p>
        </article>
      `).join("")}
    </div>
  `;
}

function renderDetailTabs() {
  return `
    <div class="detail-tabs" role="tablist" aria-label="赛事信息分类">
      ${detailTabs.map(([id, label]) => `
        <button type="button" class="${state.activeDetailTab === id ? "active" : ""}" data-detail-tab="${id}" role="tab">
          ${label}
        </button>
      `).join("")}
    </div>
  `;
}

function renderActiveTabContent(data) {
  if (state.activeDetailTab === "hotspots") {
    return `<section class="panel detail-panel"><h3>热点事件</h3>${renderHotspots(data.hotspots)}</section>`;
  }
  if (state.activeDetailTab === "social") {
    return `<section class="panel detail-panel"><h3>近 3 天社交反馈</h3>${renderFeed(data.social, "最近 3 天暂时没有抓到相关公开社交平台反馈。", "social")}</section>`;
  }
  return `<section class="panel detail-panel"><h3>新闻</h3>${renderFeed(data.news, "暂时没有抓到这场比赛的相关新闻。", "news")}</section>`;
}

function renderInsights(data) {
  const { match, sources } = data;
  state.activeInsights = data;
  els.matchDetail.className = "match-detail";
  els.matchDetail.innerHTML = `
    <h2>${renderTeamButton(match.homeTeam)} <span>vs</span> ${renderTeamButton(match.awayTeam)}</h2>
    <p class="detail-sub">#${match.matchNo} · ${escapeHtml(match.stage)} · ${escapeHtml(match.venue)} · ${escapeHtml(match.localDate)}</p>
    <div class="score-strip">
      <div class="score-team">${renderTeamButton(match.homeTeam)}</div>
      <div class="score">${match.homeScore} : ${match.awayScore}</div>
      <div class="score-team">${renderTeamButton(match.awayTeam)}</div>
    </div>
    ${renderSummary(data.summary)}
    ${renderDetailTabs()}
    ${renderActiveTabContent(data)}
    <section class="panel">
      <h3>来源状态</h3>
      <p class="detail-sub">新闻：${escapeHtml(sources.news)} · Reddit：${escapeHtml(sources.reddit)} · Bluesky：${escapeHtml(sources.bluesky)} · HN：${escapeHtml(sources.hackerNews || "")} · TikTok：${escapeHtml(sources.tiktok || "")} · Instagram：${escapeHtml(sources.instagram || "")} · YouTube：${escapeHtml(sources.youtube || "")}</p>
    </section>
  `;
}

function renderPromptTools(profile) {
  return `
    <div class="prompt-toolbar">
      <label>
        <span>生成类型</span>
        <select data-prompt-mode>
          ${["cinematic poster", "vertical video", "matchday banner", "street celebration"].map((mode) => `
            <option value="${mode}" ${state.promptMode === mode ? "selected" : ""}>${mode}</option>
          `).join("")}
        </select>
      </label>
      <button type="button" data-refresh-prompt>刷新 Prompt</button>
    </div>
    <label class="reference-upload">
      <span>上传参考图生成方向</span>
      <input type="file" accept="image/*" data-reference-image />
    </label>
    <div class="reference-preview" data-reference-preview>
      ${state.referenceImageNote ? `<p>${escapeHtml(state.referenceImageNote)}</p>` : "<p>可上传参考图，prompt 会把它作为色彩、构图或风格参考。</p>"}
    </div>
    <textarea readonly>${escapeHtml(profile.prompt)}</textarea>
    <div class="prompt-actions">
      <button class="copy-prompt" type="button" data-copy-prompt>复制 Prompt</button>
    </div>
  `;
}

function renderTeamProfile(profile) {
  state.activeProfile = profile;
  els.matchDetail.className = "match-detail team-profile";
  els.matchDetail.innerHTML = `
    <div class="profile-hero">
      ${profile.flag ? `<img src="${escapeHtml(profile.flag)}" alt="${escapeHtml(profile.name)} flag" />` : ""}
      <div>
        <span>球队 / 国家文化</span>
        <h2>${escapeHtml(profile.name)}</h2>
        <p>${escapeHtml(profile.code || "National team")}${profile.group ? ` · Group ${escapeHtml(profile.group)}` : ""}</p>
      </div>
    </div>
    <section class="culture-card">
      <h3>文化画像</h3>
      <p>${escapeHtml(profile.identity)}</p>
      <div class="symbol-row">
        ${(profile.symbols || []).map((symbol) => `<span>${escapeHtml(symbol)}</span>`).join("")}
      </div>
    </section>
    <section class="culture-card">
      <h3>助力创作 Prompt</h3>
      ${renderPromptTools(profile)}
    </section>
    <section class="culture-card">
      <h3>相关赛程</h3>
      <div class="mini-fixtures">
        ${(profile.upcomingMatches || []).map((match) => `
          <button type="button" data-profile-match-id="${escapeHtml(match.id)}">
            <strong>${escapeHtml(match.label)}</strong>
            <span>${escapeHtml(match.localDate)} · ${escapeHtml(match.venue)}</span>
          </button>
        `).join("") || "<p class=\"detail-sub\">暂无相关赛程。</p>"}
      </div>
    </section>
  `;
}

async function showTeamProfile(name) {
  state.promptMode = "cinematic poster";
  state.referenceImageNote = "";
  els.drawer.classList.add("open");
  els.matchDetail.className = "match-detail";
  els.matchDetail.innerHTML = `<div class="loader">正在生成 ${escapeHtml(name)} 的球队文化画像</div>`;
  try {
    const profile = await fetchJson(`/api/teams/${encodeURIComponent(name)}/profile`);
    renderTeamProfile(profile);
  } catch (error) {
    els.matchDetail.innerHTML = `<p class="detail-sub">球队文化信息加载失败：${escapeHtml(error.message)}</p>`;
  }
}

async function refreshPrompt() {
  if (!state.activeProfile) return;
  const params = new URLSearchParams({
    mode: state.promptMode,
    referenceNote: state.referenceImageNote
  });
  const data = await fetchJson(`/api/teams/${encodeURIComponent(state.activeProfile.name)}/prompt?${params}`);
  state.activeProfile.prompt = data.prompt;
  renderTeamProfile(state.activeProfile);
}

async function translateElement(button) {
  const target = button.dataset.translateTarget;
  const resultEl = els.matchDetail.querySelector(`[data-translation-result="${CSS.escape(target)}"]`);
  if (!resultEl) return;
  button.textContent = "翻译中";
  button.disabled = true;
  try {
    const data = await postJson("/api/translate", { text: button.dataset.translateText || "" });
    resultEl.textContent = data.translated || "暂无翻译结果";
    resultEl.classList.add("visible");
    button.textContent = "重新翻译";
  } catch (error) {
    resultEl.textContent = `翻译失败：${error.message}`;
    resultEl.classList.add("visible");
    button.textContent = "重试翻译";
  } finally {
    button.disabled = false;
  }
}

async function selectMatch(id) {
  const match = state.matches.find((item) => item.id === id);
  if (!match) return;
  state.selectedId = id;
  state.activeDetailTab = "news";
  state.activeInsights = null;
  renderTimeline();
  renderLoading(match);
  try {
    const data = await fetchJson(`/api/matches/${encodeURIComponent(id)}/insights`);
    renderInsights(data);
  } catch (error) {
    els.matchDetail.innerHTML = `
      <h2>${escapeHtml(match.homeTeam)} vs ${escapeHtml(match.awayTeam)}</h2>
      <p class="detail-sub">信息聚合失败：${escapeHtml(error.message)}</p>
    `;
  }
}

els.stageFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-stage]");
  if (!button) return;
  state.stage = button.dataset.stage;
  rerender();
});

els.timeline.addEventListener("click", (event) => {
  const node = event.target.closest("[data-match-id]");
  if (!node) return;
  selectMatch(node.dataset.matchId);
});

els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  rerender();
});

els.refreshButton.addEventListener("click", () => {
  loadSchedule().catch((error) => {
    els.syncStatus.textContent = `刷新失败：${error.message}`;
  });
});

els.closeDrawer.addEventListener("click", () => {
  els.drawer.classList.remove("open");
});

els.trendToggle.addEventListener("click", () => {
  state.trendCollapsed = !state.trendCollapsed;
  els.trendMonitor.classList.toggle("collapsed", state.trendCollapsed);
  els.trendMonitor.classList.toggle("expanded", !state.trendCollapsed);
  els.trendToggle.setAttribute("aria-expanded", String(!state.trendCollapsed));
  els.trendToggle.querySelector("strong").textContent = state.trendCollapsed ? "展开" : "收起";
});

els.timeline.addEventListener("scroll", updateTrendProgress);

els.matchDetail.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-detail-tab]");
  if (tab && state.activeInsights) {
    state.activeDetailTab = tab.dataset.detailTab;
    renderInsights(state.activeInsights);
    return;
  }

  const team = event.target.closest("[data-team-name]");
  if (team) {
    showTeamProfile(team.dataset.teamName);
    return;
  }

  const fixture = event.target.closest("[data-profile-match-id]");
  if (fixture) {
    selectMatch(fixture.dataset.profileMatchId);
    return;
  }

  const copy = event.target.closest("[data-copy-prompt]");
  if (copy) {
    const textarea = els.matchDetail.querySelector("textarea");
    navigator.clipboard?.writeText(textarea?.value || "");
    copy.textContent = "已复制";
    return;
  }

  const translate = event.target.closest("[data-translate-text]");
  if (translate) {
    translateElement(translate);
    return;
  }

  const refresh = event.target.closest("[data-refresh-prompt]");
  if (refresh) {
    refresh.textContent = "刷新中";
    refreshPrompt().catch(() => {
      refresh.textContent = "刷新失败";
    });
  }
});

els.matchDetail.addEventListener("change", (event) => {
  const mode = event.target.closest("[data-prompt-mode]");
  if (mode) {
    state.promptMode = mode.value;
    refreshPrompt().catch(() => {});
    return;
  }

  const input = event.target.closest("[data-reference-image]");
  if (!input?.files?.[0]) return;
  const file = input.files[0];
  state.referenceImageNote = `${file.name} 的色彩、构图、人物姿态和整体情绪`;
  const reader = new FileReader();
  reader.onload = () => {
    const preview = els.matchDetail.querySelector("[data-reference-preview]");
    if (preview) {
      preview.innerHTML = `
        <img src="${reader.result}" alt="参考图预览" />
        <p>已使用 ${escapeHtml(file.name)} 作为风格参考。</p>
      `;
    }
  };
  reader.readAsDataURL(file);
  refreshPrompt().catch(() => {});
});

loadSchedule().catch((error) => {
  els.syncStatus.textContent = `同步失败：${error.message}`;
  els.timeline.innerHTML = `<div class="loader">赛程加载失败</div>`;
});

loadTrendData().catch((error) => {
  els.trendMode.textContent = "监控失败";
  els.trendSource.textContent = error.message;
});

setInterval(() => {
  loadSchedule().catch(() => {});
}, 1000 * 60 * 5);
