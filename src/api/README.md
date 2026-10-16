# 数据接口层

```
http.js           通用 HTTP 客户端（超时、取消、keepalive、错误包装）
index.js          接口定义：页面只从这里导入
mock-fallback.js  演示数据：mock 模式，以及开发时某次列表读取连不上接口时使用
```

## 三种运行模式

`VITE_API_MODE`：本地开发在 `.env.local` 里设（默认 `auto`）；打包上线由 `.env.production`
（以及 Dockerfile 构建阶段的 `ENV`）固定为 `http`。

| 值 | 行为 |
|---|---|
| `http`（线上） | 只用接口，失败直接报错，页面显示「加载失败 + 重试」。线上永远不出现演示数据 |
| `auto`（开发默认） | 每次读取都**先请求接口**。只有**列表类**读取（路径里不带具体 id）这一次连不上（网络失败、超时、5xx、回话的不是接口服务）时，这一次退回 `mock-fallback.js`；第一次退回时提示「接口未连接，当前展示演示数据」。之后的请求照样先打接口：任何一次请求成功（或浏览器发出 `online` 事件）就提示「已重新连接」。断开期间读取的超时缩短到 5 秒 |
| `mock` | 只用本地演示数据，完全不发请求（切页面、离线演示、写样式时用）；「我的」相关接口返回空列表 |

`auto` 模式下**不会**退回演示数据的情况：

- 接口正常给出的 4xx（视频不存在、未登录…）照常抛给页面。
- 带具体 id 的读取（`getVideo(48)`、`getPost(5)`、`getCreator(2)`、`getTopic(1)`、`getVideos(sectionId)`…）：连不上就报错，不拿一条假内容冒充这个 id。
- 「我的」相关读取（`getProfile`、`getHistory`、`getMyFavs`、`getMyFollows`、`getSearchHistory`、社区「关注 / 收藏」tab）：演示数据冒充个人数据会误导人。
- 所有写操作（点赞、收藏、关注、观看记录、删除历史…）：失败就报错，页面回滚并提示。

连接状态变化时 `window` 上会发 `reel:api` 事件（`detail: { offline }`）；`apiStatus()` 返回 `{ mode, usingHttp, offline }`。

## 演示数据的 id

演示数据里所有 id 都是 `demo:` 开头的字符串，和接口的数字 id 永远撞不上，用 `isDemoId(id)` 判断：

| 内容 | id 例子 |
|---|---|
| 视频 | `demo:rec0:3`（种子前缀:序号） |
| 短视频 | `demo:s12` |
| 帖子 / 创作者 | `demo:p3` / `demo:aijc`、`demo:c1` |
| 专题 / 推荐分区 | `demo:2`（路由 `#/topic/:id` 认 `\d+` 和 `demo:\d+`） |
| 直播 / 同城 | `demo:l0` / `demo:n0` |

- 带演示 id 的读取直接取演示数据，不发请求。
- 带演示 id 的**写操作从不发出去**：直接抛 `ApiError('演示内容，无法操作', { code: 'demo' })`（`viewPost` 照旧吞掉）。
- 页面别把演示 id 存进本地记录（如短视频的 `reel:short:seen`）；接口会忽略 `exclude` 里不是数字的 id。
- 列表翻页时拿到演示数据（第一页是真的、翻页时接口断了）当作这一页失败，不把演示卡片接在真实列表后面（见 `components/home/list.js`）。

## 接口地址

开发环境留空 `VITE_API_BASE`，走 `vite.config.js` 里的代理 `/api -> http://127.0.0.1:3000`，
所以前端代码里不需要写域名，也不会有跨域问题。

打包上线时设置真实地址：

```
VITE_API_BASE=https://api.example.com
```

## 加一个新接口

在 `index.js` 里加一个函数即可，注意同时给 HTTP 和 mock 两条路径：

```js
export const getSomething = (id) =>
  call(`/api/something/${id}`, {
    query: { limit: 20 },
    mock: () => mockApi().then(m => m.getSomething(id))
  })
```

`call()` 负责模式判断和降级，页面只管 await 结果。路径里用到的 id 要放进 `ids: [id]`（演示 id 的读取 / 写入靠它拦下，
带 id 的读取也靠它不退回演示数据）；个人数据的读取加 `personal: true`；页面关闭时的上报加 `keepalive: true`。

## 约定

- 所有函数返回 Promise，失败时抛 `ApiError`（`message` 可直接展示给用户）。
- 后端统一返回 `{ code: 0, data }` / `{ code: 1, message }`，`code !== 0` 会被当成错误抛出。
- 列表统一支持 `limit` / `offset`，暂不支持游标分页。
- 互动类接口（点赞、收藏、关注）请求体是 `{ on }`（想要的最终状态），返回 `{ active: boolean }` 表示最新状态（关注另外带 `followers` 最新粉丝数，演示数据里可能没有）。
- 只为计数的写操作（帖子阅读数 `viewPost`）不等结果、失败直接吞掉（返回 `null`），不提示也不退回 mock。
- 演示数据的 id 是字符串（如视频 `demo:rec0:3`），拼进路径时用 `encodeURIComponent`。
- 分页列表新接口统一返回 `{ total, list }`，`limit` 1～50（默认 20）。

## 我的：收藏 / 关注 / 观看历史

都要登录（未登录 401，会弹登录框），只在 `auth.loggedIn` 时调用；不退回演示数据。

```js
getProfile()        // { id, name, uid, avatar, stats, counts }，未登录 null
                    //   stats: [{ key: 'history'|'favs'|'follows', label, value, to: '/history'|'/favorites'|'/follows' }]
                    //   counts: { history, favVideos, favPosts, favTopics, follows }（实时统计，和下面各列表的 total 一致）
getMyFavs(type, { limit, offset })   // type 'video' | 'post' | 'topic' → { total, list }，最近收藏的在前，每条带 favedAt
                                     //   video: Video；post: 和社区列表同结构；topic: 片库卡片 { id, name, count, cover }
getMyFollows({ limit, offset })      // → { total, list: [{ id, name, handle, avatar, verified, bio, followers, followedAt, following }] }
getHistory({ limit, offset })        // → { total, list }，每条 Video + { progressSec, watchedAt }；进度 = progressSec / len
removeHistory(videoId)               // 删一条 → { removed, total }（total 是剩下的条数）
clearHistory()                       // 清空 → { removed, total: 0 }
addHistory(videoId, sec, { progressOnly, keepalive })
                                     // 开始播放时调一次（计播放数，进度 0 不覆盖上次的位置）；离开 / 切后台带 progressOnly
```

`getVideo(id)` 登录时多带 `progressSec` / `watchedAt`（上次看到的位置，没看过为 `0` / `null`），App 重开也能续播；
是否「接近结尾就从头播」由播放器决定。取消收藏 / 关注用原来的 `toggle*({ on: false })`。

## 搜索

```js
searchVideos(q, { limit, offset })   // → { total, list: Video[] }
searchPosts(q, { limit, offset })    // 搜帖子标题和话题标签 → { total, list: Post[] }，和社区列表同结构
getSearchHistory({ limit = 10 })     // 要登录 → { list: [{ keyword, searchedAt }] }，新的在前、已去重（每人最多 50 条）
clearSearchHistory(keyword?)         // 不传 = 清空，传了只删这一个词 → { removed }
```

登录时两个搜索的第一页（`offset` 0）会把关键词记进搜索记录，**没有结果也记**；未登录时页面自己存 `localStorage`。
`getRecentSearches()`（旧版：每次搜索第一条结果的视频卡片）已弃用。

## 其他变化

- `getPosts(tab)`：tab 2 关注 / 3 收藏没登录时接口返回 `[]`（不是全部帖子），页面按 `auth.loggedIn` 给登录提示。
- `getLatestFilters({ date })`：`regions[0]` 是「全部」（默认选它），每个地区带 `counts[7]`（按天），`count = counts[date]`；
  `dates[d].count === regions[0].counts[d]`。`getLatestVideos({ date, region })` 的 `region` 是 `regions` 的下标（0 = 全部）。
- `getTopic(id)`：`plays` / `playCount` 取后台填的播放数和专题内视频播放数之和的较大值，`favs` 含专题内视频的收藏，`faved` 是当前用户收藏过没有。

## 短视频推荐流

`getShorts({ seed, limit = 10, offset = 0, exclude = [] })` → `GET /api/shorts`，返回 `{ seed, list, hasMore }`：

- 同一个 `seed` 顺序固定，翻页（`offset += limit`）稳定不重复；换一个 seed 就重新洗牌。不传 seed 时服务端随机生成并在结果里带回。
- 一直翻不到底（`hasMore` 恒为 `true`）：翻过整个视频库后重新洗牌接着给，所以同一个视频之后还会再出现，列表的 key 不能只用视频 id。
- `exclude`：最近刷到过的视频 id（最多 100 个），它们会排到后面。短视频页把本机最近刷到的 100 条存在 `localStorage`（`reel:short:seen`），打开 / 刷新时带上。
- 每条是 `Video` + `{ src, likes, favs, creator: { id, name, handle, avatar } }`；`src` 为空 = 没有视频文件，短视频页只能给封面。
- 排序分档：有视频文件的精选在最前，接着是精选 / 有文件的短片（5 分钟以内），再是有文件的长视频，没有文件的排在后面。
- 登录用户点过「不喜欢」（`toggleVideoDislike`）的视频不再出现（马上生效，同一个 seed 往下翻也不会再刷到），同一创作者的其他视频往后排一点；
  未登录时把这条的 id 放进 `exclude`。这一页里被跳过的条目会让 `list` 比 `limit` 短，下一页照样从 `offset + limit` 开始。
- mock 模式：40 条演示短视频，按 seed 洗牌，同样翻不到底。

## 帖子详情

`getPost(id)` → `GET /api/community/posts/:id`，返回：

```js
{ id, title, content, kind,                 // title 即列表里的 text；content 纯文本，空行分段
  author: { id, name, handle, verified, avatar },
  following,                                // 当前用户是否关注作者（未登录为 false）
  tags,                                     // 不带 #
  images,                                   // Cover[]；视频帖有关联视频时主图当视频封面，这里只放配图
  video,                                    // { id, title, cover, dur, len, frames } | null（只有已上架的关联视频）
                                            //   frames：1～2 张图 [帖子主图, 视频封面]，2 张时视频块显示成左右拼图
  read, fav, faved, publishedAt, time,
  next }                                    // 社区「最新」顺序里的下一篇 { id, title, thumb } | null
```

帖子不存在或已下架时回 400「帖子不存在或已下架」（页面显示提示，不给重试）。详情页每次打开调一次
`viewPost(id)`（`POST …/view` → `{ read }`），关注用 `toggleFollow(creatorId, { on })`（`POST /api/creators/:id/follow`）。

## 创作者主页

`#/creator/:id`（`views/CreatorView.vue`）用四个接口：

```js
getCreator(id)                 // { id, name, handle, avatar, verified, official, bio, followers, videoCount, postCount,
                               //   mediaCount, lastActiveAt, lastActive, following, banner: Cover[] }
getCreatorVideos(id, sort, { limit, offset })   // sort 0 最新 / 1 最热 → { total, list: Video[] }
getCreatorPosts(id, { limit, offset })          // → { total, list: Post[] }，和 getPosts() 每条结构一样
getCreatorMedia(id, { limit, offset })          // → { total, list: MediaItem[] }：「媒体」照片墙，新的在前
                               // MediaItem = { id: 'v12' | 'i34', kind: 'image' | 'video', cover, title, postId, videoId, dur, publishedAt }
```

- 「媒体」：视频格是已发布视频的封面（点了进播放页），图片格是已发布帖子的主图 / 配图（文档帖的文档页不算，点了全屏看大图）；`mediaCount` 和它的 `total` 一致。
- 计数只算已发布的内容；`banner` 是最近作品的图（最多 3 张，可能为空，页面用按 id 生成的灰色渐变代替）。
- 创作者不存在或已停用：接口回 400「创作者不存在」，页面显示提示和「返回」，不给重试；网络问题显示「重试」。
- 帖子列表的每条有 `creatorId`，帖子卡片（`PostCard`）的头像和名字据此链到主页；创作者主页里的卡片传 `author-link="false"`。
- 演示数据：社区帖子的作者 id 是 `demo:账号`（如 `demo:aijc`，和帖子详情的 `author.id` 一致），热门创作者是 `demo:c1`…`demo:c8`，`demo:数字` 生成一个占位创作者，其他 id 当作不存在。
