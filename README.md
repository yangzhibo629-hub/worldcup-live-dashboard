# 2026 World Cup Live Match Atlas

一个可本机访问的 2026 世界杯赛事聚合网页。它提供赛程全景图、阶段筛选、赛事节点点击详情，并按比赛聚合新闻、热点事件和公开讨论反馈。

新增能力：

- 详情抽屉顶部提供基于新闻与公开讨论的本地 AI 摘要
- 新闻、热点事件、社交反馈以 Tab 方式并列切换
- 点击球队/国家名称可查看文化画像、视觉符号、相关赛程
- 自动生成可用于 AI 图片或视频生成的球队助力 prompt
- 顶部紧凑展示已载入赛事、承办城市、下一场和数据源状态
- 新闻、热点、社交反馈支持一键翻译成中文
- Prompt 支持刷新生成类型，并可上传参考图作为风格/构图提示
- 右上角悬浮世界杯 hashtag VV 监控层，支持展开/收起，并随赛程时间轴滚动同步观察窗口

## 启动

```bash
npm install --cache ../work/npm-cache
npm start
```

打开：

```text
http://localhost:4173
```

## 当前数据源

- 赛程、球队、场馆：`https://worldcup26.ir/get/games`、`/get/teams`、`/get/stadiums`
- 新闻：Google News RSS
- 公开讨论反馈：PullPush Reddit index、Hacker News Algolia
- Bluesky：已接入公共搜索接口，但当前环境会返回 403，页面会在来源状态里显示该情况
- TikTok / Instagram：已预留可配置采集桥接器，需要官方授权或合规第三方采集服务

TikTok / Instagram 桥接器配置示例：

```bash
TIKTOK_BRIDGE_URL="https://your-service.example.com/tiktok/search" \
INSTAGRAM_BRIDGE_URL="https://your-service.example.com/instagram/search" \
npm start
```

桥接器返回格式可以是数组，或 `{ "items": [...] }`，每条可包含 `author`、`title`、`caption`、`text`、`url`、`likes`、`comments`、`publishedAt`。

## 实时更新策略

- 赛程每 5 分钟自动刷新一次
- 单场赛事的新闻和讨论聚合缓存 8 分钟
- 点击赛事节点时会按双方球队和世界杯关键词重新聚合信息
- 社交反馈按发布时间过滤最近 3 天数据，来源包括 Reddit、Bluesky、Hacker News，以及配置后的 TikTok / Instagram / YouTube 桥接器
- 球队文化画像来自内置文化标签和赛程数据组合生成，可继续扩展为更完整的国家文化库

## Hashtag VV 监控

悬浮监控层请求：

```text
GET /api/hashtag-trends
```

未配置短视频平台桥接器时，趋势线使用 `2026-06-11` 到 `2026-07-19` 的赛程热度投影，并显示平台待接入状态。配置桥接器后，高 VV 视频会作为节点挂到趋势线上，点击可跳转原视频。

桥接器建议返回：

```json
{
  "items": [
    {
      "network": "TikTok",
      "author": "creator",
      "title": "video caption",
      "url": "https://...",
      "views": 1234567,
      "publishedAt": "2026-06-12T10:00:00Z"
    }
  ]
}
```

可配置环境变量：

```bash
TIKTOK_BRIDGE_URL="https://your-service.example.com/tiktok/search" \
INSTAGRAM_BRIDGE_URL="https://your-service.example.com/instagram/search" \
YOUTUBE_BRIDGE_URL="https://your-service.example.com/youtube/search" \
npm start
```

桥接器会收到查询参数：

```text
q=Mexico%20South%20Africa%20World%20Cup
limit=12
since=2026-06-05T00:00:00.000Z
```

`since` 用于赛事详情的“近 3 天社交反馈”。Hashtag VV 监控会发送 hashtag 查询，并按 `views / viewCount / playCount / vv` 读取播放量。

## 部署到公网

不需要先购买正式域名。Render、Railway、Vercel 都会自动分配可公开访问的免费域名：

- Render：`https://你的服务名.onrender.com`
- Railway：平台生成的 `*.up.railway.app` 或等效 Public URL
- Vercel：`https://你的项目名.vercel.app`

### 推荐方案：Render

Render 最适合当前这种 Express 常驻服务，配置最直接。

1. 把 `worldcup-live` 目录推到 GitHub 仓库。
2. 打开 Render Dashboard，选择 `New > Web Service`。
3. 连接 GitHub 仓库。
4. 如果仓库根目录不是 `worldcup-live`，把 `Root Directory` 设置为 `worldcup-live`。
5. 设置：
   - Build Command：`npm install`
   - Start Command：`npm start`
6. 在 Environment Variables 里添加：
   - `TIKTOK_API_KEY`
   - `INSTAGRAM_API_KEY`
   - `YOUTUBE_API_KEY`
7. 部署完成后，Render 会给一个 `onrender.com` 公网地址。

仓库里已经包含 `render.yaml`，也可以在 Render 里使用 Blueprint 方式导入。

### 备选方案：Railway

Railway 部署也很顺滑，适合想快速上线和看实时日志的场景。

1. 把 `worldcup-live` 目录推到 GitHub 仓库。
2. 打开 Railway，选择 `New Project > Deploy from GitHub repo`。
3. 如果仓库根目录不是 `worldcup-live`，在服务设置里指定 Root Directory。
4. 在 Variables 里添加：
   - `TIKTOK_API_KEY`
   - `INSTAGRAM_API_KEY`
   - `YOUTUBE_API_KEY`
5. 部署后进入服务的 Networking，点击 `Generate Domain`，Railway 会生成公网地址。

仓库里已经包含 `railway.json`，Railway 会按 `npm start` 启动服务，并用 `/api/health` 做健康检查。

### 备选方案：Vercel

Vercel 也可以部署 Express，但它会把 Express 应用作为函数运行，更适合轻量 API 和前端页面。如果你优先追求稳定常驻服务，建议先用 Render 或 Railway。

1. 把 `worldcup-live` 目录推到 GitHub 仓库。
2. 在 Vercel 导入项目。
3. 如果仓库根目录不是 `worldcup-live`，把 Root Directory 设置为 `worldcup-live`。
4. 在 Environment Variables 里添加：
   - `TIKTOK_API_KEY`
   - `INSTAGRAM_API_KEY`
   - `YOUTUBE_API_KEY`
5. 部署完成后，Vercel 会给一个 `vercel.app` 公网地址。

代码已兼容 Vercel：本地和 Render/Railway 会监听平台提供的端口，Vercel 环境下会导出 Express app。

### 本地临时公网预览

如果只是临时给别人看，可以继续使用 Cloudflare Quick Tunnel：

```bash
npx --yes cloudflared tunnel --url http://localhost:4173 --no-autoupdate
```

这种地址依赖本机 `npm start` 服务和隧道进程持续运行。电脑关机、断网或进程停止后地址会失效。

## 后续可增强

- 接入 X、Instagram、TikTok、YouTube Data API 等需要授权的平台
- 添加数据库保存历史热度曲线
- 部署到公网时增加反向代理、访问日志和 API 速率限制
