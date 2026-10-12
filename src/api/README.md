# 数据接口层

```
http.js           通用 HTTP 客户端（超时、取消、错误包装）
index.js          接口定义：页面只从这里导入
mock-fallback.js  兜底数据：接口连不上时自动使用，保证页面不空
```

## 三种运行模式

`.env.local` 里设置 `VITE_API_MODE`：

| 值 | 行为 |
|---|---|
| `auto`（默认） | 优先请求接口。接口服务**连不上**（网络失败、超时、5xx、回话的不是接口服务）时，读取退回 `mock-fallback.js`，并提示一次「接口未连接，当前展示演示数据」。接口正常返回的 4xx（如视频不存在）照常报错；写操作（点赞、收藏、观看记录）从不退回 mock |
| `http` | 只用接口，失败直接报错（上线用这个，能暴露问题） |
| `mock` | 只用本地模拟数据，完全不发请求（切页面、离线演示、写样式时用） |

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

`call()` 负责模式判断和降级，页面只管 await 结果。

## 约定

- 所有函数返回 Promise，失败时抛 `ApiError`（`message` 可直接展示给用户）。
- 后端统一返回 `{ code: 0, data }` / `{ code: 1, message }`，`code !== 0` 会被当成错误抛出。
- 列表统一支持 `limit` / `offset`，暂不支持游标分页。
- 互动类接口（点赞、收藏、关注）请求体是 `{ on }`（想要的最终状态），返回 `{ active: boolean }` 表示最新状态（关注另外带 `followers` 最新粉丝数，演示数据里可能没有）。
- 只为计数的写操作（帖子阅读数 `viewPost`）不等结果、失败直接吞掉（返回 `null`），不提示也不退回 mock。
- 演示数据的 id 不一定是数字（如视频 `rec0:3`），拼进路径时用 `encodeURIComponent`。

## 短视频推荐流

`getShorts({ seed, limit = 10, offset = 0, exclude = [] })` → `GET /api/shorts`，返回 `{ seed, list, hasMore }`：

- 同一个 `seed` 顺序固定，翻页（`offset += limit`）稳定不重复；换一个 seed 就重新洗牌。不传 seed 时服务端随机生成并在结果里带回。
- 一直翻不到底（`hasMore` 恒为 `true`）：翻过整个视频库后重新洗牌接着给，所以同一个视频之后还会再出现，列表的 key 不能只用视频 id。
- `exclude`：最近刷到过的视频 id（最多 100 个），它们会排到后面。短视频页把本机最近刷到的 100 条存在 `localStorage`（`reel:short:seen`），打开 / 刷新时带上。
- 每条是 `Video` + `{ src, likes, favs, creator: { id, name, handle, avatar } }`；`src` 为空时短视频页用封面 + 模拟进度。
- mock 模式：40 条演示短视频，按 seed 洗牌，同样翻不到底。

## 帖子详情

`getPost(id)` → `GET /api/community/posts/:id`，返回：

```js
{ id, title, content, kind,                 // title 即列表里的 text；content 纯文本，空行分段
  author: { id, name, handle, verified, avatar },
  following,                                // 当前用户是否关注作者（未登录为 false）
  tags,                                     // 不带 #
  images,                                   // Cover[]；视频帖有关联视频时主图当视频封面，这里只放配图
  video,                                    // { id, title, cover, dur, len } | null（只有已上架的关联视频）
  read, fav, faved, publishedAt, time,
  next }                                    // 社区「最新」顺序里的下一篇 { id, title, thumb } | null
```

帖子不存在或已下架时回 400「帖子不存在或已下架」（页面显示提示，不给重试）。详情页每次打开调一次
`viewPost(id)`（`POST …/view` → `{ read }`），关注用 `toggleFollow(creatorId, { on })`（`POST /api/creators/:id/follow`）。

## 创作者主页

`#/creator/:id`（`views/CreatorView.vue`）用三个接口：

```js
getCreator(id)                 // { id, name, handle, avatar, verified, official, bio, followers, videoCount, postCount,
                               //   lastActiveAt, lastActive, following, banner: Cover[] }
getCreatorVideos(id, sort, { limit, offset })   // sort 0 最新 / 1 最热 → { total, list: Video[] }
getCreatorPosts(id, { limit, offset })          // → { total, list: Post[] }，和 getPosts() 每条结构一样
```

- 计数只算已发布的内容；`banner` 是最近作品的图（最多 3 张，可能为空，页面用按 id 生成的灰色渐变代替）。
- 创作者不存在或已停用：接口回 400「创作者不存在」，页面显示提示和「返回」，不给重试；网络问题显示「重试」。
- 帖子列表的每条有 `creatorId`，帖子卡片（`PostCard`）的头像和名字据此链到主页；创作者主页里的卡片传 `author-link="false"`。
- 演示数据：社区帖子的作者 id 是账号（如 `aijc`，和帖子详情的 `author.id` 一致），热门创作者是 `c1`…`c8`，纯数字 id 生成一个占位创作者，其他 id 当作不存在。
