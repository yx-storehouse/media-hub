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
- 互动类接口（点赞、收藏、关注）请求体是 `{ on }`（想要的最终状态），返回 `{ active: boolean }` 表示最新状态。
- 只为计数的写操作（帖子阅读数 `viewPost`）不等结果、失败直接吞掉（返回 `null`），不提示也不退回 mock。
- 演示数据的 id 不一定是数字（如视频 `rec0:3`），拼进路径时用 `encodeURIComponent`。

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
