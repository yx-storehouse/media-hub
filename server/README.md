# 数据库与接口服务

独立运行，**不影响现有前端**：数据库和服务端都在 `server/` 目录下，前端一行代码都没改。

零依赖，只用 Node 内置模块（`node:sqlite` + `node:http`），不需要 `npm install`。

## 快速开始

```bash
node server/db/seed.mjs                      # 建库 + 写入种子数据（约 460 条视频）
node server/create-admin.mjs admin 你的密码   # 建管理员（登录用，内网部署跑一次）
node server/index.mjs                        # 启动接口服务，默认 http://localhost:3000
```

测试：

```bash
node server/test-api.mjs     # 100 项接口测试（含帖子详情、创作者主页、短视频推荐流、我的收藏 / 关注 / 历史、搜索记录、压缩与缓存、老库补列）
node server/test-auth.mjs    # 37 项鉴权测试
node server/test-admin.mjs   # 95 项管理后台测试（导入 / 导出 / 素材文件 / 首页分区 / 超时…）
```

三套测试各用自己的库（`server/db/*-test.db`）和端口（3178 / 3179 / 3180；管理后台测试另起一个短超时实例用 3181，接口测试另起一个「老库补列」实例用 3182，库建在系统临时目录），不会碰 `reel.db`。

换个位置放数据库：`DB_PATH=/path/to/reel.db node server/index.mjs`
换端口：`PORT=4000 node server/index.mjs`
换托管的前端打包目录（默认项目里的 `dist/`）：`DIST_DIR=/path/to/build node server/index.mjs`
素材目录 / 上传上限：`MEDIA_DIR=/data/reel-media MAX_UPLOAD_MB=4096 node server/index.mjs`（见「管理后台接口」）

## 目录

```
server/
  index.mjs        HTTP 服务（路由表 + 静态托管 dist）
  api.mjs          接口层：函数名与 src/api/index.js 一一对应
  auth.mjs         鉴权：口令哈希（scrypt）、会话令牌、失败次数限制
  create-admin.mjs 建 / 重置管理员账号
  test-api.mjs     接口冒烟测试
  test-auth.mjs    鉴权测试
  test-admin.mjs   管理后台测试
  admin/
    routes.mjs     /api/admin/* 路由表
    service.mjs    校验、增删改、批量操作、导入引擎、导出
    fields.mjs     导入 / 导出字段定义 + 单元格取值规范化（唯一来源）
    media.mjs      素材文件夹：列目录、流式上传、Range 静态访问、扫描、删除
  db/
    schema.sql     表结构（35 张表 + 索引 + 外键）
    views.sql      视图 / 全文检索 / 计数触发器
    seed.mjs       建库与种子数据
    index.mjs      数据库连接与查询封装（前台 App 的查询）
    admin.mjs      管理后台的全部 SQL
    reel.db        SQLite 数据库文件（自动生成，已在 .gitignore）
  lib/             随机数与占位图（art.mjs 与 src/mock 同步，保证前后端图片一致；lite-art.mjs 是后台新建数据用的轻量占位图）、
                   地址比较（urls.mjs：编码 / 未编码算同一个文件）、InputError（errors.mjs）、响应压缩（compress.mjs）
```

## 设计要点

**1. 前端要什么，表里就有什么**

`src/api/index.js` 里每个函数的返回结构，都能在 SQL 里直接查出来。视图（`v_videos`、`v_posts`、`v_lives`…）已经把字段名对齐了前端 typedef，比如：

- `videos.duration_sec` → 视图里已经拼成 `dur = '00:12:34'`
- `videos.cover_url` + `cover_fallback` → 前端 `Cover { src, fallback }`
- `live_rooms.viewer_count` → 视图里已经是 `'5.1w'`

所以查询层基本就是 `SELECT * FROM v_xxx`，不用在 JS 里再拼数据。

**2. 内容和互动分开，计数用触发器维护**

`videos` 表上的 `like_count` / `fav_count` / `play_count` 是冗余字段，由 `video_likes`、`video_favs` 等表的触发器自动加减。列表查询永远是单表扫描，不会因为互动数据变多而变慢。

**3. 「换一批」是数据，不是随机数**

首页分区的换一批用 `home_section_items.batch_key` 实现（`rec0`、`rec0x`、`rec0xx`…），和前端 mock 的种子规则一致。同一条视频可以出现在不同批次里。

**4. 中文搜索用 FTS5 trigram**

`videos_fts` / `posts_fts` 用 trigram 分词，中文按 3 字滑窗切，支持子串匹配。**注意 trigram 至少要 3 个字**，"露营" 这种 2 字词会自动退回 `LIKE` 查询（`query` 层已经处理）。

## 表结构总览

| 分组 | 表 |
|---|---|
| 用户 | `users` `creators` `user_follows` `user_stats` `sessions` |
| 内容 | `videos` `series` `series_episodes` `short_clips` `topics` `topic_covers` `home_sections` `home_section_items` |
| 社区 | `posts` `post_media` `post_media_blobs` `comments` |
| 直播同城 | `live_rooms` `places` `place_tags` |
| 搜索筛选 | `search_keywords` `regions` `category_filters` `nearby_filters` `client_tabs` |
| 互动 | `video_likes` `video_dislikes` `video_favs` `topic_favs` `post_favs` `comments_likes` `danmaku` `watch_history` `search_history` |
| 其他 | `video_uploads` `daily_stats` |

关键索引：
- `videos(status, topic_id, published_at DESC)` — 专题页
- `videos(status, category_key, published_at DESC)` — 分类页
- `videos(status, play_count DESC)` — 最热排序
- `home_section_items(section_id, batch_key, sort_order)` — 换一批

## 接口一览

| 方法 | 路径 | 对应前端函数 |
|---|---|---|
| GET | `/api/home/tabs` | 首页分类 Tab |
| GET | `/api/home/recommend` | `getRecommendSections()` |
| GET | `/api/home/section/:id/videos?batch=` | `getVideos()` |
| GET | `/api/home/latest/filters?date=` | `getLatestFilters()`：地区第一项是「全部」，每个地区带 7 天的 `counts`（见下面「最新」） |
| GET | `/api/home/latest/videos?date=&region=` | `getLatestVideos()`：`region` 0 = 全部，也可以传地区 code |
| GET | `/api/category/:tab/filters` | `getCategoryFilters()` |
| GET | `/api/category/:tab/videos?filter=` | `getCategoryVideos()` |
| GET | `/api/search/hot?page=` | `getHotWords()`：只列搜得到东西的词（见下面「搜索」） |
| GET | `/api/search/creators` | `getCreators()` |
| GET | `/api/search/recent` | `getRecentSearches()`（旧版：每次搜索第一条结果的视频卡片，已弃用） |
| GET | `/api/search?q=` | `searchVideos()`：登录时顺便记搜索词（见下面「搜索」） |
| GET | `/api/search/posts?q=&limit=&offset=` | `searchPosts()`：搜帖子标题和话题 → `{ total, list }` |
| GET / DELETE | `/api/search/history[?keyword=]` | `getSearchHistory()` / `clearSearchHistory()`：近期搜索的关键词（要登录） |
| GET | `/api/topic/:id` | `getTopic()`：播放 / 收藏数由专题内视频汇总，登录时带 `faved` |
| GET | `/api/topic/:id/videos?sort=` | `getTopicVideos()` |
| GET | `/api/library` | `getLibrary()` |
| GET | `/api/videos/:id` | `getVideo()`：播放页详情（含 `src` 播放地址、标签、热榜名次；登录时带上次看到的 `progressSec` / `watchedAt`） |
| GET | `/api/videos/:id/related?batch=&limit=` | `getRelatedVideos()`：相似推荐，`batch` 递增 = 换一批 |
| GET | `/api/shorts?seed=&offset=&limit=&exclude=` | `getShorts()`：短视频推荐流（见下面「短视频推荐流」） |
| GET | `/api/community/posts?tab=` | `getPosts()`：`tab` 2 关注 / 3 收藏没登录时是 `[]` |
| GET | `/api/community/posts/:id` | `getPost()`：帖子详情（见下面「帖子详情」） |
| POST | `/api/community/posts/:id/view` | `viewPost()`：阅读数 +1，公开、无请求体 → `{ read }` |
| POST | `/api/community/posts/:id/fav` | `togglePostFav()` |
| POST | `/api/creators/:id/follow` | `toggleFollow()`：`{ on: true\|false }` → `{ active, followers }`（要登录；已停用 / 不存在的创作者不能关注） |
| GET | `/api/creators/:id` | `getCreator()`：创作者主页头部（见下面「创作者主页」） |
| GET | `/api/creators/:id/videos?sort=&limit=&offset=` | `getCreatorVideos()`：他的视频，`sort` 0 最新 / 1 最热 |
| GET | `/api/creators/:id/posts?limit=&offset=` | `getCreatorPosts()`：他的帖子，结构同社区列表 |
| GET | `/api/creators/:id/media?limit=&offset=` | `getCreatorMedia()`：「媒体」照片墙，视频封面 + 帖子的图（见下面「创作者主页」） |
| POST | `/api/videos/:id/fav` `/like` `/dislike` | 对应 toggle |
| POST | `/api/topics/:id/fav` | `toggleTopicFav()` |
| GET | `/api/live?tab=` | `getLives()` |
| GET | `/api/nearby?filter=` | `getNearby()` |
| GET | `/api/me` | `getProfile()`：计数实时统计（见下面「我的」） |
| GET | `/api/me/history?limit=&offset=` | `getHistory()` → `{ total, list }`，每条带 `progressSec` / `watchedAt`（要登录） |
| POST | `/api/me/history` | `addHistory()` |
| DELETE | `/api/me/history[/:videoId]` | `clearHistory()` / `removeHistory()` → `{ removed, total }`（要登录） |
| GET | `/api/me/favs?type=video\|post\|topic&limit=&offset=` | `getMyFavs()` → `{ total, list }`（要登录） |
| GET | `/api/me/follows?limit=&offset=` | `getMyFollows()` → `{ total, list }`（要登录） |

响应统一：

```json
{ "code": 0, "data": ... }
{ "code": 1, "message": "缺少 q 参数" }
```

400 = 参数问题，404 = 路由不存在，405 = 方法不对，500 = 服务端异常。

### 帖子详情

`GET /api/community/posts/:id`：公开接口；带了登录令牌时按当前用户回填 `following` / `faved`（未登录都是 `false`）。

```js
{
  id, title,            // title = posts.text：社区卡片和详情页顶部的那一句
  content,              // 详情正文，纯文本，段落之间用换行（前端按 pre-line 显示）；没有时是 ''
  kind,                 // 'image' | 'video' | 'doc'
  author: { id, name, handle, verified, avatar: Cover },
  following,            // 当前用户是否关注了作者
  tags,                 // ['旅行', '川西']，不带 #
  images,               // Cover[]，规则见下
  video,                // { id, title, cover: Cover, dur: '07:42' | '1:02:05', len: 秒, frames: Cover[] } | null（只认已上架的关联视频）
  read, fav, faved,
  publishedAt, time,    // time 是「21分钟前」这类相对时间，和列表一致
  next                  // { id, title, thumb: Cover | null } | null
}
```

- **图片**：视频帖（`kind === 'video'`）有已上架的关联视频、并且有主图时，主图就是视频封面（`video.cover`），`images` 只放配图；
  其余情况 `images = [主图（有的话）, ...配图]`，`video.cover` 用关联视频自己的封面。
- **视频块拼图**：`video.frames` 是 1～2 张图 = [帖子主图（有的话）, 关联视频自己的封面]，同一张（同一个地址，没有地址时同一张占位图）只留一张；
  有 2 张时详情页把视频块显示成左右两半的拼图，只有 1 张时照旧显示 `video.cover`。
- **下一篇**：社区「最新」顺序（`published_at DESC, id DESC`）里比它更早的那一篇，只算已发布的；缩略图取它的主图，没有主图取第一张配图，都没有为 `null`。
- 帖子不存在、草稿或已下架：`400 { code: 1, message: '帖子不存在或已下架' }`（不会 500）。

`POST /api/community/posts/:id/view`：阅读数 +1 并返回 `{ read }`（新的阅读数）。公开、不需要请求体；App 每打开一次详情页调一次。帖子不存在 / 未发布同样回 400。

关注作者用已有的 `POST /api/creators/:id/follow { on }`，收藏用 `POST /api/community/posts/:id/fav { on }`，都要登录。

### 创作者主页

`GET /api/creators/:id`：公开接口；带了登录令牌时按当前用户回填 `following`（未登录为 `false`）。

```js
{
  id, name, handle, avatar,   // avatar: Cover
  verified, official, bio,
  followers,                  // 粉丝数（creators.follower_count，关注 / 取消关注由触发器维护）
  videoCount, postCount,      // 只算已发布的视频 / 帖子
  mediaCount,                 // 「媒体」的条数，和 /media 的 total 同一个口径
  lastActiveAt, lastActive,   // 最近一条已发布视频 / 帖子的时间（秒）和「1小时前」这类相对时间；什么都没发过时为 null / ''
  following,
  banner                      // Cover[]，最多 3 张，新的在前；可能为空
}
```

- **头图**：取他最近的作品图——视频封面、帖子主图（没有主图的图文 / 视频帖取第一张配图，文档帖的配图是文档页、不要），草稿 / 下架的不算。
  视频、帖子两边各先按发布时间取 3 条再合并，作品很多时也不用整表排序。
- `GET /api/creators/:id/videos?sort=0|1&limit=&offset=` → `{ total, list }`：只含已发布的视频，`sort` 0 = 发布时间倒序（默认，其他值也按它）、1 = 播放数倒序；
  同值再按发布时间、id 排，翻页不重复不遗漏。列表带当前用户的 `liked` / `faved`。
- `GET /api/creators/:id/posts?limit=&offset=` → `{ total, list }`：和社区列表（`/api/community/posts`）每条的结构完全一样（含 `media`、`time`、`faved`），按发布时间倒序。
- `GET /api/creators/:id/media?limit=&offset=` → `{ total, list }`：「媒体」照片墙，新的在前。每条
  `{ id, kind: 'image' | 'video', cover: Cover, title, postId, videoId, dur, publishedAt }`，`id` 是这一格的唯一键（`v<视频 id>` / `i<图片 id>`）：
  - `video`：已发布视频的封面（没有封面地址时用占位图），`videoId` 是点进去播放的视频，`dur` 是「01:15」「1:02:05」（没有时长为 `null`）；
  - `image`：已发布帖子的主图和配图，只算有地址的；文档帖的文档页不算，和他某个已发布视频封面同一张的图也不重复算；`postId` 是所属帖子。
  - 排序：发布时间倒序，同一时间视频在前，再按所属内容、图的顺序排（全序，翻页不重复不遗漏）。
- 分页：`limit` 1～50（默认 20），`offset` 从 0 起，非法值按默认处理。
- 创作者不存在、已停用，或 id 不是正整数（如演示数据的账号 `aijc`）：三个接口都回 `400 { code: 1, message: '创作者不存在' }`（不会 500）。
- 社区列表 / 搜索帖子的每条多了 `creatorId`（发布者 id，创作者被删除时为 `null`），App 的帖子卡片据此把头像和名字链到主页。
- 关注接口现在多返回一个 `followers`（最新粉丝数），主页关注 / 取消后直接用它刷新；关注已停用或不存在的创作者回 400「创作者不存在」（取消关注总是可以）。

### 短视频推荐流

`GET /api/shorts?seed=&offset=&limit=&exclude=` → `{ seed, list, hasMore }`，公开接口，带了登录令牌时按当前用户。

- 候选是**全部已上架视频**，分档加权：后台「加入短视频」的（`short_clips`，+3.5）、有视频文件的（`playback_url` 不为空，+3）、时长 5 分钟以内的（+1，10 分钟以内 +0.4）。
  结果大致是：有文件的精选在最前，接着是精选 / 有文件的短片，再是有文件的长视频、没有文件的短片，没有文件的长视频垫底（没有文件的只能看封面）。
- 每条的分数 = 热度（log 播放数，按全库最大值归一）+ 新鲜度（发布时间，半衰期 14 天）+ 上面的分档加权 + 互动率（(赞 + 藏) / 播放，封顶）+ 按 `seed` 的随机扰动，
  再减去：登录用户 3 天内看过的（重罚）/ 30 天内看过的（轻罚，按 `watch_history`），以及 `exclude` 里的 id（重罚）。排好后再去一遍同质：同一创作者 / 同一专题尽量不挨着（后面几条里分差不大的换上来）。
- **不喜欢**：登录用户点过「不喜欢」（`video_dislikes`）的视频罚到最后，而且出页时直接跳过——排序缓存着的这一轮里它还在原位，刚点完往下翻也不会再刷到；
  同一创作者的其他视频小幅降分（每条被不喜欢的 −0.4，最多 −1.2）。未登录时 App 把这条的 id 放进 `exclude`。
- `seed`：同一个 seed 顺序固定（翻页稳定、不重复），不同 seed 顺序不同；不传时服务端随机生成并在结果里返回，翻页时带回来。App 每次打开、再点一次「短视频」Tab 都换一个 seed。
- `exclude`：逗号分隔的视频 id，最多 100 个，非法的忽略。App 把本机最近刷到过的 id 带上，未登录也能每次打开都不一样。
- `limit` 1～50（默认 10），`offset` 从 0 起。翻过整个候选池后用派生 seed（`seed:r1`、`seed:r2`…）再排一轮接着给，所以 `hasMore` 恒为 `true`（库里一条已上架视频都没有时是 `false`、`list` 为空）；新一轮的开头会避开上一轮末尾的几条。
- 每条是 `Video` + `{ src, like, fav, likes, favs }`，`creator` 是 `{ id, name, handle, avatar }`（没有创作者时为 `null`）。这一页里刚被下架 / 删除的视频直接跳过，`list` 可能比 `limit` 短，下一页照样从 `offset + limit` 开始。
- 性能：整个排序按「用户 + seed + 轮次」只算一次，放在内存里（最多 64 份，5 分钟没人翻就丢），翻页只是切片。排序只读 `videos` 的几个数字列 + 短视频 id + 当前用户 30 天内的观看记录，2 万条视频约 70 ms。
  缓存期间 `exclude`、观看记录的变化不影响这一份顺序（「不喜欢」例外，出页时实时跳过）；后台加入短视频后，新打开的 App（新 seed）马上能看到。

### 最新

- `GET /api/home/latest/filters?date=0` → `{ dates, regions }`：
  - `dates`：最近 7 天 `[{ label: '今天' | '昨天' | '10/9', count }]`，`count` 是这一天全部地区的视频数（按服务器本地日期分天）。
  - `regions`：**第一项是「全部」**（`code: 'all'`，默认选它），后面是 `regions` 表里的地区。每项 `{ code, label, count, counts }`，
    `counts[d]` 是这个地区第 `d` 天的视频数，`count = counts[date]`（`date` 是当前选中的日期），所以地区上的数字和列表的条数对得上；
    `regions[0].counts[d] === dates[d].count`。没填地区、或地区不在表里的视频算「其他」。一条 `GROUP BY` 查完，不按地区逐个 COUNT。
- `GET /api/home/latest/videos?date=0&region=0&limit=&offset=`：`region` 是上面 `regions` 的下标（0 = 全部），也可以直接传地区 code（`all` / `cn` / `jk` / `other`），认不出的按全部。
  按发布时间倒序（同一秒按 id），翻页稳定。

### 搜索

- **热门搜索** `GET /api/search/hot?page=` → `[{ word, hot }]`，每批 8 个：只列没屏蔽、而且**搜得到东西**的词（已发布的视频或帖子至少命中一条，和下面的搜索同一套匹配），App 里点热词不会是 0 条结果；后台加了搜不到内容的词，前台不显示。`page` 是「换一批」的次数，翻到末尾接回开头，每批都是满的；能显示的词不到 8 个时全部返回。
- `GET /api/search?q=`（视频）、`GET /api/search/posts?q=`（帖子标题 + 话题标签）→ `{ total, list }`，公开；`q` 为空或全是空白回 400「缺少 q 参数」。
  帖子搜索 3 个字以上走 FTS5 trigram（按相关度，同分新的在前），1～2 个字退回 LIKE（新的在前），只算已发布的；每条和社区列表结构一样（含 `media`、`time`、`faved`）。
- **搜索记录**：登录用户搜第一页（`offset` 0）时记一次关键词，**没有结果也记**；同一个词只留最新一条，每人最多 50 条，关键词最长 100 字。翻页不重复记。
  - `GET /api/search/history?limit=10`（要登录）→ `{ list: [{ keyword, searchedAt }] }`，新的在前。
  - `DELETE /api/search/history`（要登录）清空；带 `?keyword=` 只删这一个词 → `{ removed }`。
  - 旧的 `GET /api/search/recent`（每次搜索第一条结果的视频卡片）已弃用，没有结果的记录在这里跳过；App 改用关键词列表后删除。

### 我的

`GET /api/me`（未登录 `null`）：

```js
{ id, name, uid, avatar,
  stats: [{ key: 'history', label: '观看历史', value, to: '/history' },
          { key: 'favs',    label: '我的收藏', value, to: '/favorites' },   // 视频 + 帖子 + 专题
          { key: 'follows', label: '我的关注', value, to: '/follows' }],
  counts: { history, favVideos, favPosts, favTopics, follows } }
```

- 计数由 `v_users` **实时统计**（子查询，只算已上架的视频 / 帖子 / 专题、正常状态的创作者），和下面各列表的 `total` 一致；
  不再读 `user_stats` 里没人维护的 `fav_count` / `follow_count`（收藏、关注以前恒为 0）。「离线缓存」功能没做，不再返回这一格。
  老库启动时按 `views.sql` 里的定义自动重建 `v_users`（见「启动时的自动补建」）。
- 下面几个都要登录（未登录 401），分页 `limit` 1～50（默认 20）、`offset` 从 0 起，返回 `{ total, list }`，新的在前：

| 接口 | 每条 |
|---|---|
| `GET /api/me/favs?type=video` | `Video`（带 `liked` / `faved`）+ `favedAt` |
| `GET /api/me/favs?type=post` | 和社区列表同结构的帖子 + `favedAt` |
| `GET /api/me/favs?type=topic` | 片库卡片 `{ id, name, count, cover }` + `favedAt` |
| `GET /api/me/follows` | `{ id, name, handle, avatar, verified, bio, followers, followedAt, following: true }` |
| `GET /api/me/history` | `Video` + `{ progressSec, watchedAt }`（`len` 是总秒数，进度 = `progressSec / len`） |

`type` 认不出时按 `video`。取消收藏 / 关注用原来的 `POST …/fav`、`POST /api/creators/:id/follow`（`{ on: false }`）。

- `DELETE /api/me/history/:videoId` 删一条、`DELETE /api/me/history` 清空 → `{ removed, total }`（`total` 是剩下的条数）。
- `GET /api/videos/:id` 登录时多带 `progressSec` / `watchedAt`（没看过为 `0` / `null`），App 重开也能续播。
- `POST /api/me/history { videoId, progressSec, progressOnly }`：开始播放那次上报（计播放数、进度 0）**不覆盖**已存的进度，
  否则重新打开视频、还没来得及上报就被杀掉时，上次看到的位置就丢了；`progressOnly` 的上报照常覆盖（传 0 就是清零）。
- 社区 `GET /api/community/posts?tab=2|3`（关注 / 收藏）没登录时返回 `[]`，不再退成全部帖子。

### 专题

`GET /api/topic/:id`：`plays`（显示用字符串，满 1 万写成 `1.2w`）/ `playCount` = max(后台填的播放数, 专题内已上架视频的播放数之和)；
`favs` = 专题被收藏的次数 + 专题内已上架视频的收藏数之和；`faved` 是当前用户收藏过这个专题（未登录 `false`）。

### 压缩与缓存

- 文本类响应（JSON、HTML、JS、CSS、SVG、manifest、map、txt）满 1 KB 时按 `Accept-Encoding` 压缩：br 优先（接口现压用 4 档，几十 KB 约 1 ms，在 zlib 线程池里），
  其次 gzip；带 `vary: accept-encoding`。20 条视频的列表 235 KB → br 约 26 KB。打包好的前端文件压一次就记在内存里（按路径 + 大小 + 修改时间区分版本，总量 64 MB 封顶）。
- 接口响应 `cache-control: no-store`。
- 托管的 `dist/`（或 `DIST_DIR`）：`assets/` 下带 hash 的文件 `public, max-age=31536000, immutable`；`index.html`、`admin.html`、图标、manifest 等
  不带 hash 的用 `no-cache` + `ETag`（每次向服务器确认，没变回 304），重新部署后马上用上新版本。
  `assets/` 下找不到的文件回 404（重新部署后旧页面还在要旧分包时，不能拿 index.html 冒充脚本）。

## 接入前端

现在前端读的是 `src/api/index.js`（返回 mock 数据）。切换有两种方式，都只动一个文件：

**方式一：改 `src/api/index.js`，把函数体换成 fetch**

```js
const BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000'

async function req(path, options) {
  const res = await fetch(BASE + path, options)
  const json = await res.json()
  if (json.code !== 0) throw new Error(json.message)
  return json.data
}

export const getRecommendSections = () => req('/api/home/recommend')
export const getVideos = (sectionId, size, batch) => req(`/api/home/section/${sectionId}/videos?size=${size}&batch=${batch}`)
export const getPosts = (tab = 0) => req('/api/community/posts?tab=' + tab)
// …其余同理，函数名和参数都不用改
```

`server/api.mjs` 里的函数名跟前端一一对应，照抄即可。

**方式二：直接复用 `server/api.mjs`**

它已经是「和前端同名同结构」的接口层。加一个 Vite 代理就不用管跨域：

```js
// vite.config.js
server: {
  proxy: { '/api': 'http://localhost:3000' }
}
```

然后把 `src/api/index.js` 改成 `export * from '../../server/api.mjs'`（或复制 `server/api.mjs` 过去），前提是前端跑在 Node 环境——纯浏览器不行，所以**推荐方式一**。

**CORS**：接口服务已经带了 `access-control-allow-origin: *`，本地联调可以直接跨域访问。

## 和前端不一致的地方

切换后有几处行为会变化，都是设计如此：

| 项 | 现在（mock） | 切换后 |
|---|---|---|
| 列表长度 | 固定条数 | 支持 `limit` / `offset` 分页 |
| 「换一批」 | 前端用 seed 拼字符串 | 服务端按 `batch` 返回预排好的批次 |
| 收藏 / 点赞 | 存在 Pinia 里，刷新就没了 | 写进数据库，持久化 |
| 观看历史 | 没有（mock 模式为空） | 真实记录，且播放数会累加 |
| 搜索 | 按关键词现编数据 | 真实 FTS 检索 |
| 社区「关注」「收藏」tab | 只有演示数据里关注 / 收藏过的 | 按真实关注 / 收藏关系过滤，未登录为空 |

## 后续可以补的

当前是**可运行的完整骨架**，以下是为真实业务预留、但还没实现的部分：

- **鉴权**：`sessions` 表已建好，接口目前固定用 `游客_10086`（uid `10086`）。加登录后把 `demoUserId()` 换成从 token 解析即可。
- **评论**：`comments` 表已建好、计数触发器已接，但没有对应的接口和前端页面。
- **上传**：`video_uploads` 表用于用户投稿审核流程，接口未实现。
- **弹幕**：`danmaku` 表 + 计数触发器已接，接口未实现。
- **推荐算法**：短视频流已经按热度、新鲜度、短视频 / 有文件 / 时长加权、互动率、看过的往后排、不喜欢来推荐（见「短视频推荐流」）；首页「推荐」分区仍是后台编排。`short_clips.sort_order` / `weight` 现在不参与排序。
- **分页游标**：目前用 `limit/offset`，数据量大后建议换成上一页最后一条的 id（keyset 分页）。
- **迁移工具**：现在靠 `schema.sql` 全量重建（`seed.mjs --reset`）。上线前建议接入迁移工具（如 `node-pg-migrate` 之于 Postgres，SQLite 可用简单的 `migrations/` 目录 + 版本表）。


## 鉴权

内网程序，用最省事的方案：账号由管理员创建，口令加盐哈希存在本地，会话令牌走 `Authorization: Bearer`。

### 角色

| 角色 | 能做什么 |
|---|---|
| 未登录 | 浏览首页、分类、搜索、专题、短视频、直播、同城、社区 |
| `user` | 上面全部 + 点赞、收藏、观看历史、改自己的密码和昵称 |
| `admin` | 上面全部 + 建账号、重置密码、停用、改角色、删除账号 |

### 首次部署

```bash
node server/create-admin.mjs admin 你的密码
```

之后在网页里用 `admin` 登录，「我的 → 账号管理」可以建其他账号。
忘了管理员密码就再跑一次（加 `--reset`）；`--list` 可以看现有账号。

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | `{ uid, password }` → `{ token, expiresAt, user }` |
| POST | `/api/auth/logout` | 失效当前令牌 |
| GET | `/api/auth/me` | 当前用户，未登录返回 `null` |
| POST | `/api/auth/password` | 改自己的密码（其他设备会被踢下线） |
| PATCH | `/api/auth/profile` | 改昵称 / 头像 |
| GET | `/api/admin/users` | 账号列表（管理员） |
| POST | `/api/admin/users` | 建账号（管理员） |
| POST | `/api/admin/users/:id/password` | 重置密码（管理员） |
| POST | `/api/admin/users/:id/status` | 停用 / 启用（管理员） |
| POST | `/api/admin/users/:id/role` | 改角色（管理员） |
| DELETE | `/api/admin/users/:id` | 删除账号（管理员） |

状态码：`401` 未登录、`403` 权限不够、`400` 参数或校验错误（`message` 可直接展示）、`500` 服务端异常。

### 安全上的取舍

内网环境，做了这些：

- 口令用 Node 内置 `scrypt` 加盐哈希，不存明文，也不引入 bcrypt 这类依赖。
- 登录失败连续 8 次锁定 10 分钟（内存计数，重启清零），防止内网里被猜密码。
- 「账号不存在」和「密码错误」返回同样的提示，避免探测账号。
- 令牌是 32 字节随机串，存 `sessions` 表，默认 30 天滑动过期。
- 停用账号、重置密码会立刻作废该账号的所有会话。
- 响应里永远不包含 `password_hash`。

**没做的**（内网够用，公网部署前需要补）：

- 没有 HTTPS —— 令牌是明文传输的，所以只能在内网用。要上公网请套一层 Nginx 配证书。
- 没有 CSRF 防护 —— 用的是 Bearer 令牌而不是 Cookie，天然不受 CSRF 影响。
- 没有登录验证码 / 双因素。
- 令牌存在 `localStorage`，如果站点有 XSS 风险，令牌会被偷。当前没有用户输入被当 HTML 渲染的地方。


## 管理后台接口

给「Reel 管理后台」（`admin.html`，源码在 `src/admin/`）用的接口：管理视频、帖子、专题、创作者、首页推荐分区、搜索热词，批量导入 / 导出，以及素材文件夹。打包后访问 `http://服务器:3000/admin` 会跳到 `/admin.html`。

- 所有 `/api/admin/*` 都要求**管理员**登录：未登录 `401`，普通用户 `403`。
- 出错时除了 `message` 还可能带 `field`（接口字段名，camelCase），前端据此把提示标到对应输入框下：

```json
{ "code": 1, "message": "编号已存在", "field": "publicId" }
```

- 状态码：`400` 校验错误，`401` 未登录，`403` 不是管理员，`404` 无此路由，`405` 方法不对，`408` 请求体 / 上传接收超时，`413` 请求体 / 上传文件过大，`500` 服务端异常。
- 先匹配路由、先鉴权，再读请求体：未登录 / 没权限 / 路径不对的请求直接回 401 / 403 / 404 / 405，请求体不会先被收进内存。
- 单值字段（标题、时间、ID、专题引用……）只收字符串 / 数字 / 布尔，传对象或数组返回 400（不会存成 `[object Object]`）；ID 列表只收数字或纯数字字符串。
- 时间一律是 Unix 秒；布尔是 `true` / `false`。
- 视频 / 帖子 / 专题的状态：`1` 已发布、`0` 草稿、`2` 已下架；创作者：`1` 正常、`0` 停用。

### 接口一览

`:type` 是 `videos` / `posts` / `topics` / `creators` / `keywords` 之一，五类数据的接口形状一致。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/meta` | 下拉选项：专题、创作者、分类、地区、清晰度、状态等 |
| GET | `/api/admin/stats` | 概览统计（各类数量、缺播放地址 / 封面 / 时长的视频数、素材文件数、最近新增）。结果缓存 5 秒，任何后台写操作后立即失效 |
| GET | `/api/admin/schema` | 导入 / 导出字段定义（列名、别名、类型、示例、说明） |
| GET | `/api/admin/:type` | 列表：`?page=1&pageSize=20&sort=&order=asc\|desc` + 各自的筛选，返回 `{ total, page, pageSize, list }` |
| GET | `/api/admin/:type/export` | 导出（筛选同列表，最多 5 万行）→ `{ fields, rows }` |
| GET | `/api/admin/:type/:id` | 单条 |
| POST | `/api/admin/:type` | 新建 |
| PATCH | `/api/admin/:type/:id` | 修改：只改传了的字段，`null` 清空可空字段 |
| DELETE | `/api/admin/:type/:id` | 删除（专题返回 `deletedSections / detachedVideos`，创作者返回 `deletedPosts / detachedVideos`） |
| POST | `/api/admin/:type/batch` | 批量操作 `{ ids, action, value? }` → `{ affected }` |
| POST | `/api/admin/:type/import` | 批量导入，见下 |
| PUT | `/api/admin/topics/order` | 专题排序 `{ ids }`（sort_order = 下标） |
| GET / POST | `/api/admin/sections` | 首页推荐分区列表 `{ list }` / 新建 |
| PATCH / DELETE | `/api/admin/sections/:id` | 修改 / 删除分区 |
| PUT | `/api/admin/sections/order` | 分区排序 `{ ids }` |
| GET / PUT | `/api/admin/sections/:id/items` | 分区内容 `{ batches: [[videoId…]…] }`（最多 20 批、每批 60 个） |
| POST | `/api/admin/sections/:id/rebuild` | 自动生成 `{ source: 'topic'\|'hot'\|'latest', batches = 4, size = 首屏数量 }` |
| GET | `/api/admin/media?dir=` | 列素材目录 |
| PUT | `/api/admin/media/upload?path=videos/a.mp4&overwrite=0\|1` | 上传：请求体就是文件字节（不是 JSON） |
| POST | `/api/admin/media/folder` | 新建文件夹 `{ path }` |
| DELETE | `/api/admin/media?path=&force=0\|1` | 删除文件或空文件夹；被视频引用的文件要 `force=1` |
| POST | `/api/admin/media/scan` | 扫描视频文件 `{ dir, recursive }`：带同名封面、是否已入库 |

账号管理（`/api/admin/users…`）见上面「鉴权」一节，行为不变。

各类的筛选与排序：

| 类型 | 筛选 | 排序 `sort=` |
|---|---|---|
| videos | `q` `status` `topicId`（`none` = 无专题）`creatorId` `category` `region` `missing=playback\|cover\|duration` `short=1\|0` | `publishedAt`（默认）`createdAt` `playCount` `likeCount` `favCount` `durationSec` `title` `id` |
| posts | `q` `status` `creatorId` `mediaKind` `isHot` | `publishedAt`（默认）`readCount` `favCount` `id` |
| topics | `q` `kind` `status` | `sortOrder`（默认升序）`videoCount` `name` `id` |
| creators | `q` `status` `verified` | `id`（默认）`name` `followerCount` `videoCount` |
| keywords | `q` `isHot` `isBanned` | `weight`（默认）`sortOrder` `word` `id` |

帖子（`AdminPost`）的两段文字：

- `text`：**标题**，必填、最多 5000 字，显示在社区卡片和详情页顶部（也是社区搜索的全文索引内容）。
- `content`：**详情正文**，选填、最多 20000 字（按字数算，emoji 算 1 个），只显示在 App 的帖子详情页。
  保存时换行统一成 `\n`、去掉每行行尾和整段首尾的空白（段落之间的空行保留）；`PATCH` 时 `null` 或空串 = 清空，不传 = 不改。
- 列表的 `q` 同时搜标题、详情正文、标签（纯数字时也按 ID）。

批量操作的 `action`：

| 类型 | action |
|---|---|
| videos | `publish` `unpublish` `draft` `delete` `setTopic` `setCreator` `setCategory` `setRegion` `setQuality` `addTags` `removeTags` `addShort` `removeShort` |
| posts | `publish` `unpublish` `draft` `delete` `setHot` `unsetHot` `setCreator` `addTags` `removeTags` |
| topics | `publish` `unpublish` `draft` `delete` |
| creators | `enable` `disable` `verify` `unverify` `delete` |
| keywords | `hot` `unhot` `ban` `unban` `delete` |

注意两处级联：**删专题会连带删掉用它的首页分区**，它下面的视频变成「无专题」；**删创作者会连带删掉他的帖子**，他的视频变成「无创作者」。删除接口会返回受影响的数量。

### 批量导入

`POST /api/admin/{videos|posts|topics|creators|keywords}/import`，一次最多 20000 行（JSON 请求体上限 32 MB、60 秒内要传完）。后台页面会把 CSV / Excel / 粘贴的表格解析好再分批调这个接口；脚本也可以直接调：

```bash
curl -X POST http://localhost:3000/api/admin/videos/import \
  -H "authorization: Bearer <管理员令牌>" -H "content-type: application/json" \
  -d '{ "rows": [ { "title": "海边日落", "topic": "治愈日常", "creator": "@trip", "duration": "00:12:34",
                    "playbackUrl": "/media/videos/sunset.mp4", "status": "已发布" } ],
        "options": { "onDuplicate": "skip" }, "dryRun": true }'
```

请求：

- `rows`：每行一个对象，键是字段 key（见 `GET /api/admin/schema`）；可选 `_row` 表示原文件里的行号，结果里原样带回。
- `options.onDuplicate`：已存在时 `skip`（默认，跳过）/ `update`（更新）/ `error`（报错）。
- `options.autoCreate`：视频 / 帖子引用的专题、创作者**按名称**找不到时自动创建（默认 `true`；按 id 引用找不到一律报错）。
- `options.defaultStatus`：「状态」列为空时新建行用的状态（默认 `1`）。
- `dryRun: true`：预检。照常执行每一行，最后整体回滚，返回的结果和真导入完全一致（含文件内重复、自动创建）。
- `options.importId` + `options.chunk`（可选，重发保护）：`importId` 是 1-64 位字母、数字、`_`、`-`，`chunk` 是不小于 0 的整数（分块序号）。真导入（非预检）两个都带时，服务端按「管理员 + 类型 + importId + chunk」记住这次的完整结果（内存里最多 500 份、1 小时）；同一块再发一次（比如网络断了重试），直接返回上次的结果并加上 `"replayed": true`，**不会再写库**。格式不对返回 400。

**请分块导入。** 导入请求是同步执行的，期间 App 的请求要排队：几万条视频的库里，1000 行约 0.2 秒、5000 行预检约 0.5 秒、2 万行约 5 秒。后台页面预检每块 5000 行、真导入每块 1000 行；脚本也建议每块不超过 1000～5000 行，并带上 `importId` + `chunk`，失败重试时不会重复建数据。

返回：

```json
{ "total": 4, "created": 1, "updated": 1, "skipped": 1, "failed": 1,
  "results": [ { "row": 2, "status": "created", "id": 501 },
               { "row": 3, "status": "skipped", "id": 12, "message": "已存在（按编号匹配到 ID 12），已跳过" },
               { "row": 4, "status": "updated", "id": 15, "message": "按播放地址匹配到 ID 15，已更新" },
               { "row": 5, "status": "error", "message": "时长格式不正确…", "field": "duration" } ],
  "autoCreated": { "topics": ["新专题"], "creators": [] } }
```

`results[].field` 是**导入字段 key**（如 `topic`、`duration`），方便标到对应的列。

规则：

- 整个请求一个事务、每行一个 SAVEPOINT：坏行回滚并报错，不影响其他行；同一个文件里的重复行也能识别（后一行能看到前一行的写入）。
- 判断「已存在」的顺序：视频 `id → 编号 → 播放地址`，帖子 `id`，专题 `id → 标识 → 名称`，创作者 `id → 账号`，热词 `热词`。填了 `id` 但库里没有 → 报「ID 不存在」（不会按指定 id 插入）。
- 视频只用**第一个非空的键**：填了编号但库里没有，就当新视频新建，不会再退到播放地址去匹配（否则几条共用同一个占位视频文件的新视频会互相覆盖）。只填了播放地址的行才按播放地址查重。
- 播放地址按「同一个文件」比较：`/media/a b.mp4` 和 `/media/a%20b.mp4`、`/media/已有/x.mp4` 和它的编码写法、站内地址后面带 `?v=123` 都算同一个；扫描导入的「已导入」、素材的「被 N 个视频使用」用的是同一套规则。外部 `http(s)` 地址的查询串保留比较。
- 「已更新」的结果带 `message` 写明按哪个键匹配到的（如「按播放地址匹配到 ID 15，已更新」），预检里就能看出来。
- **空单元格**：新建时用默认值；更新时表示「不改这一项」（帖子的「正文」列留空不会清空详情正文，要清空请在后台编辑）。
- 导入后统一重算一次专题视频数。
- 帖子不再有「折叠数」列：App 卡片上的 +N 按真实配图数算（最多 3 张缩略图，多出来的张数显示在第 3 张上）；旧表格里的「折叠数」列对应成「不导入」，接口请求里带了 `moreCount` 也忽略，导出不再有这一列。
- 帖子有「标题」（`text`，别名 title / 帖子标题 / 文案）和「正文」（`content`，别名 content / body / 详情 / 详情正文 / 帖子正文 / 正文内容 / 内容 / 帖子内容）两列，正文单元格可以多行。
  注意：加详情正文之前导出的帖子表格，表头「正文」那一列其实是**标题**；这种旧文件再导入时它会被自动对应到「正文」，请在「对应列」那一步把它改成「标题」。

单元格写法（服务端解析，所以脚本也能直接用中文）：

| 类型 | 接受的写法 |
|---|---|
| 是 / 否 | `是 / 否`、`1 / 0`、`true / false`、`y / n`、`yes / no`、`√ / ×` |
| 整数 | `1200`、`1,200`、`1.2w`、`1.2万`、`3.4k` |
| 时长 | 秒数（可带小数）、`mm:ss`、`hh:mm:ss`；最长 720 小时（30 天），超过报「时长过大」 |
| 时间 | `2026-10-10`、`2026/10/10 14:30`、`2026.10.10 14:30:05`、`2026年10月10日`、`2026年10月10日 14:30`（服务器本地时区）；带时区的 ISO 写法 `2026-10-10T14:30:00Z`、`…+08:00`（按给定时区换算）；Excel 日期序号、Unix 秒 / 毫秒 |
| 标签 | 逗号、分号、顿号、竖线、换行分隔；视频标签另外按空格分隔并存成 `#标签`，帖子标签存成不带 `#` 的 |
| 地址 | `http(s)://…` 或 `/` 开头的站内路径（如 `/media/videos/a.mp4`）；多个地址用逗号、空格或换行分隔 |
| 状态 | `已发布 / 发布 / 上架 / published`、`草稿 / draft`、`下架 / 已下架 / offline / hidden`，或 `1 / 0 / 2` |
| 专题 | 依次按 id → 名称（精确）→ 标识（不区分大小写）找：英文名称的专题（如 `Anime`）不会被别的专题的标识 `anime` 抢走 |
| 创作者 | id、账号（可带 `@`，带 `@` 时只按账号找）或名称 |
| 分类 / 地区 | key 或中文名（`cn` 或 `国产`） |
| 清晰度 | `标清 / 高清 / 超清`、`sd / hd / fhd`、`480p / 720p / 1080p / 4k` |

导出（`GET /api/admin/:type/export`）的值就是这些写法：专题 → 名称（按上面的规则读不回同一个专题时——重名、纯数字等——改用标识，标识也不行就用 id）、创作者 → 账号（纯数字账号加 `@`）、时长 `hh:mm:ss`、状态 → 中文、时间 `YYYY-MM-DD HH:mm:ss`、布尔 `是 / 否`、多个地址用换行。所以「导出 → Excel 里改 → 按『更新已有』再导入」不需要手动对应列，没改的数据保持不变。后台页面生成 CSV 时会给 `= + - @` 开头的单元格加 `'` 防公式注入，导入时服务端会去掉。

### 素材文件（media/）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MEDIA_DIR` | 项目根目录下的 `media/` | 素材文件夹，启动时自动创建（连同 `videos/ covers/ images/`），已加入 `.gitignore` |
| `MAX_UPLOAD_MB` | `8192` | 单个上传文件的上限（MB），超过返回 413 并删掉临时文件 |
| `UPLOAD_IDLE_SEC` | `60` | 上传时这么久收不到数据就中止（408）并删掉临时文件 |

- `GET / HEAD /media/<路径>` 直接访问素材，支持 `Range`（拖进度条、分段加载）。缓存：**图片** `Cache-Control: no-cache`（每次带 `ETag` / `Last-Modified` 向服务器确认，没变就是 304），所以重新截取的封面写回同一个地址（`covers/v<id>.jpg`）App 和后台马上能看到；**视频和其他文件** `public, max-age=300`。
- **`/media/*` 是公开的，不需要登录**：`<video>` / `<img>` 没法带 Bearer 令牌。内网可以接受；如果素材不能被内网其他人看到，请不要放进 media/，或在前面的 Nginx 上加访问控制。
- 只允许这些扩展名，上传和访问都卡住（避免上传网页 / 脚本被当成页面执行）：视频 `mp4 m4v webm mov mkv ogv m3u8 ts`，图片 `jpg jpeg png webp gif avif`，字幕 `vtt srt`，安卓安装包 `apk`（`application/vnd.android.package-archive`，按附件下载、`no-cache`；放在 `app/reel.apk` 时网页版「我的」在安卓浏览器里显示「下载安卓 App」，见 [mobile/README.md](../mobile/README.md)）。
- 上传是流式写入 `<文件名>.<随机串>.part`，收完再改名；同名文件默认自动改名为 `name (1).ext`，`overwrite=1` 时覆盖。
  - 「查重名 + 改名」在同一文件夹里串行执行：同时上传的同名文件各自得到不同的名字，不会互相覆盖。
  - 覆盖时先把旧文件挪到隐藏的临时名再换上新文件：旧文件正被播放（Windows 上有读句柄）时也能覆盖。
  - 客户端中途断开（包括刚连上就断开）、或 60 秒收不到数据，都会删掉临时文件。
  - 进程被杀等原因留下的旧临时文件（超过 10 分钟没动过的 `*.part`）在启动时清掉；删除「看起来是空的」文件夹时也会顺手清掉。
- 路径里有 `..`、反斜杠、控制字符的一律拒绝；解析后跑出 `MEDIA_DIR` 的访问返回 403。
- 站内地址形如 `/media/videos/%E6%97%A5%E8%90%BD.mp4`（每段 URL 编码）；视频的播放地址 / 封面写成编码、未编码、带 `?v=` 参数的形式都能被「被 N 个视频使用」统计到。
- 开发时 Vite 把 `/media` 和 `/api` 一起代理到接口服务。

### 连接超时

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `BODY_TIMEOUT_SEC` | `60` | JSON 请求体必须在这个时间内收完，否则回 408 并断开 |
| `IDLE_TIMEOUT_SEC` | `120` | 连接这么久既没收到也没发出数据就断开（卡住的请求体、暂停不读的 `/media` 播放连接） |

大文件上传可能要很久，所以没有「整个请求」的总时长限制；只要还在收发数据就不会断。请求头仍受 Node 默认的 60 秒限制。

### 占位图

后台新建的视频 / 帖子 / 专题会生成一张轻量占位图（`lib/lite-art.mjs`：渐变 + 柔光 + 山丘或光斑，按 id / 编号决定配色，每张约 1.1 KB），导入几万条也不会让库明显变大。种子数据仍用 `lib/art.mjs` 的风景图，已有的行不改。

### 启动时的自动补建

老库不用重建，接口服务启动时会自动补上：

- `posts.content` 列（帖子详情正文，`TEXT NOT NULL DEFAULT ''`）：老库没有这一列时 `ALTER TABLE` 补上，日志里提示一次；已有的帖子正文为空，可在后台补写或用导入批量填。
- `posts_fts_update` 触发器：帖子改了标题 / 标签，社区搜索的全文索引跟着更新（新库由 `views.sql` 建）。
- 索引：`idx_videos_playback` / `idx_videos_cover`（按地址查重、统计素材引用、统计缺播放地址 / 封面）、`idx_videos_pubtime` / `idx_videos_created`（列表按发布 / 创建时间排序，几万条视频时不用临时排序）、`idx_videos_nodur`（缺时长）、`idx_creators_name`（按名称找创作者）。
- 修复读不出来的时长：早期版本导入时可能写进超过 2^53 的整数或超大小数，读这一行会让列表、导出、App 详情页报错。启动时把这类时长清零（变成「缺时长」，可在后台重填），并在日志里提示条数。
- `v_users` 视图：老库的定义还读 `user_stats` 里没人维护的收藏 / 关注计数时，按 `views.sql` 里的新定义重建（「我的」页计数改为实时统计），日志里提示一次。
