-- ============================================================================
--  Reel 数据库结构（SQLite）
--
--  设计原则
--   1. 前端所有字段都有归宿：src/api/index.js 里每个函数的返回结构，都能由这里的表查出来。
--   2. 内容与互动分开：user / creator 产生内容，*_like / *_fav / history 记录用户行为，
--      计数（点赞数、播放数）用触发器自动维护，避免每次列表都去 COUNT(*)。
--   3. 图片统一存 URL + 占位图两层，对应前端的 Cover 结构 { src, fallback }。
--   4. 时间统一用 Unix 秒（INTEGER），展示层的「44分钟前」由接口计算。
--
--  约定
--   - 主键统一 id INTEGER PRIMARY KEY（SQLite 里就是 rowid 别名，索引最省）。
--   - 需要对外暴露、又不想暴露自增 id 的表，另加一个公开编号（如 videos.public_id）。
--   - status: 0=草稿 1=已发布 2=已下架。
--   - 所有外键都带 ON DELETE，删内容不会留下孤儿行。
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 用户与创作者
-- ---------------------------------------------------------------------------

-- 普通用户（登录用户）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  uid           TEXT    NOT NULL UNIQUE,        -- 登录名，也是对外展示的 ID，例如 '10086'
  nickname      TEXT    NOT NULL,
  password_hash TEXT,                           -- scrypt$salt$hash；为空表示还没设置口令（不能登录）
  role          TEXT    NOT NULL DEFAULT 'user',-- admin=可管理账号，user=普通用户
  avatar_url    TEXT,                           -- 为空时前端用 Cover.fallback 显示首字
  avatar_fallback TEXT,
  bio           TEXT    NOT NULL DEFAULT '',
  status        INTEGER NOT NULL DEFAULT 1,     -- 0=禁用 1=正常（停用后已登录的会话立即失效）
  last_login_at INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, status);
CREATE INDEX IF NOT EXISTS idx_users_uid ON users(uid);

-- 创作者（可发布视频 / 直播 / 社区内容，也作为「热门创作者」的数据源）
CREATE TABLE IF NOT EXISTS creators (
  id            INTEGER PRIMARY KEY,
  handle        TEXT    NOT NULL UNIQUE,        -- @aijc
  name          TEXT    NOT NULL,               -- AI剧场
  avatar_url    TEXT,
  avatar_fallback TEXT,
  is_verified   INTEGER NOT NULL DEFAULT 0,     -- 社区里的黄色认证徽章
  is_official   INTEGER NOT NULL DEFAULT 0,     -- 官方账号（社区 tab 里排在前面）
  bio           TEXT    NOT NULL DEFAULT '',
  follower_count INTEGER NOT NULL DEFAULT 0,    -- 冗余计数，由 user_follows 触发器维护
  status        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creators_official ON creators(is_official, follower_count DESC);

-- 用户关注创作者
CREATE TABLE IF NOT EXISTS user_follows (
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  creator_id  INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, creator_id)
);
CREATE INDEX IF NOT EXISTS idx_user_follows_creator ON user_follows(creator_id);

-- ---------------------------------------------------------------------------
-- 分类 / 专题
-- ---------------------------------------------------------------------------

-- 一个分类 = 一个专题页（前端 TOPIC_NAMES，首页分区与片库共用一套 id）
CREATE TABLE IF NOT EXISTS topics (
  id            INTEGER PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,        -- 'healing'，做稳定的对外标识
  name          TEXT    NOT NULL,               -- 治愈日常
  description   TEXT    NOT NULL DEFAULT '',
  kind          INTEGER NOT NULL DEFAULT 0,     -- 0=普通分类 1=首页推荐分区 2=片库分类
  is_featured   INTEGER NOT NULL DEFAULT 0,     -- 首页「热门推荐」全宽大卡
  sort_order    INTEGER NOT NULL DEFAULT 0,     -- 首页分区 / 片库的展示顺序
  card_size     INTEGER NOT NULL DEFAULT 4,     -- 首页分区首屏取多少条
  plays_count   INTEGER NOT NULL DEFAULT 0,     -- 「8.1k 次播放」
  fav_count     INTEGER NOT NULL DEFAULT 0,     -- 「2 收藏」
  video_count   INTEGER NOT NULL DEFAULT 0,     -- 「视频 (45)」，触发器维护
  status        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_kind ON topics(kind, sort_order);

-- 专题头图（前端 hero 的 4 张拼图）
CREATE TABLE IF NOT EXISTS topic_covers (
  id         INTEGER PRIMARY KEY,
  topic_id   INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  url        TEXT,
  fallback   TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_topic_covers_topic ON topic_covers(topic_id, sort_order);

-- ---------------------------------------------------------------------------
-- 视频（普通视频 / 短视频 / 动漫剧集都用这一张表）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS videos (
  id             INTEGER PRIMARY KEY,
  public_id      TEXT    NOT NULL UNIQUE,       -- 'VID-149'，前端近期搜索卡片上的角标
  title          TEXT    NOT NULL,
  description    TEXT    NOT NULL DEFAULT '',
  creator_id     INTEGER REFERENCES creators(id) ON DELETE SET NULL,
  topic_id       INTEGER REFERENCES topics(id)   ON DELETE SET NULL,
  kind           INTEGER NOT NULL DEFAULT 0,    -- 0=普通 1=短视频 2=剧集
  is_series      INTEGER NOT NULL DEFAULT 0,    -- 剧集：山海奇谭 第11-20集
  episode_no     INTEGER,
  duration_sec   INTEGER NOT NULL DEFAULT 0,    -- 展示为 00:12:34
  cover_url      TEXT,
  cover_fallback TEXT,
  playback_url   TEXT,                          -- 实际播放地址（mock 阶段为空）
  region         TEXT,                          -- '国产' / '日韩' / '其他'，对应「最新」的地区胶囊
  category_key   TEXT,                          -- 顶部分类 Tab：ai / cn / jk / anime / show / doc
  quality        TEXT    NOT NULL DEFAULT 'hd', -- sd / hd / fhd
  tags           TEXT    NOT NULL DEFAULT '[]', -- JSON 数组，如 ["#日落","#旅拍"]
  play_count     INTEGER NOT NULL DEFAULT 0,
  like_count     INTEGER NOT NULL DEFAULT 0,
  fav_count      INTEGER NOT NULL DEFAULT 0,
  danmaku_count  INTEGER NOT NULL DEFAULT 0,
  status         INTEGER NOT NULL DEFAULT 1,
  published_at   INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_topic_pub   ON videos(status, topic_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_pub         ON videos(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_creator     ON videos(creator_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_play        ON videos(status, play_count DESC);
CREATE INDEX IF NOT EXISTS idx_videos_hot         ON videos(status, like_count DESC);
CREATE INDEX IF NOT EXISTS idx_videos_category    ON videos(status, category_key, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_related     ON videos(status, topic_id, category_key, play_count DESC); -- 播放页相似推荐

-- 首页「推荐」分区（分区 → 视频，手工排布，支持换一批）
CREATE TABLE IF NOT EXISTS home_sections (
  id            INTEGER PRIMARY KEY,
  topic_id      INTEGER REFERENCES topics(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,               -- 热门推荐
  subtitle      TEXT    NOT NULL DEFAULT '',
  is_featured   INTEGER NOT NULL DEFAULT 0,     -- 首条全宽大卡
  card_size     INTEGER NOT NULL DEFAULT 4,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  status        INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_home_sections_order ON home_sections(status, sort_order);

-- 分区内的视频（cursor 是「换一批」用的游标，也是排序键）
CREATE TABLE IF NOT EXISTS home_section_items (
  id         INTEGER PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES home_sections(id) ON DELETE CASCADE,
  video_id   INTEGER NOT NULL REFERENCES videos(id)        ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- 「换一批」的游标：第一批是 'rec0'，之后每换一次多一个 x（与前端 mock 的种子规则一致）
  -- 同一条视频可以出现在不同批次里，所以唯一键要把批次算进去
  batch_key  TEXT    NOT NULL DEFAULT '',
  batch_no   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (section_id, batch_key, video_id)
);
CREATE INDEX IF NOT EXISTS idx_section_items_video ON home_section_items(video_id);
CREATE INDEX IF NOT EXISTS idx_section_items_batch ON home_section_items(section_id, batch_key, sort_order);

-- ---------------------------------------------------------------------------
-- 短视频信息流（顺序由运营排布，不是按时间倒序）
CREATE TABLE IF NOT EXISTS short_clips (
  video_id   INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  weight     INTEGER NOT NULL DEFAULT 0,     -- 推荐权重，0 = 按 sort_order
  added_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_short_order ON short_clips(sort_order, weight DESC);

-- 剧集
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS series (
  id             INTEGER PRIMARY KEY,
  video_id       INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  title          TEXT    NOT NULL,
  total_episodes INTEGER NOT NULL DEFAULT 0,
  is_completed   INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_series_video ON series(video_id);

CREATE TABLE IF NOT EXISTS series_episodes (
  id            INTEGER PRIMARY KEY,
  series_id     INTEGER NOT NULL REFERENCES series(id)  ON DELETE CASCADE,
  video_id      INTEGER NOT NULL REFERENCES videos(id)  ON DELETE CASCADE,
  episode_no    INTEGER NOT NULL,
  title         TEXT    NOT NULL DEFAULT '',
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  cover_url     TEXT,
  status        INTEGER NOT NULL DEFAULT 1,
  published_at  INTEGER NOT NULL,
  UNIQUE (series_id, episode_no)
);
CREATE INDEX IF NOT EXISTS idx_episodes_series ON series_episodes(series_id, episode_no);

-- ---------------------------------------------------------------------------
-- 社区
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY,
  creator_id    INTEGER REFERENCES creators(id) ON DELETE CASCADE,
  text          TEXT    NOT NULL,               -- 标题：社区卡片和详情页顶部显示的这一句
  content       TEXT    NOT NULL DEFAULT '',    -- 详情正文（纯文本，保留换行）；老库由 db/index.mjs 启动时补列
  media_kind    INTEGER NOT NULL DEFAULT 0,     -- 0=图文 1=视频 2=文档/长文
  video_id      INTEGER REFERENCES videos(id) ON DELETE SET NULL,  -- 视频帖关联的视频
  tags          TEXT    NOT NULL DEFAULT '[]',  -- JSON 数组 ["AI","剧情"]，展示为 #AI #剧情
  thumb_count   INTEGER NOT NULL DEFAULT 3,     -- 缩略图数量，第 3 张盖 +N
  more_count    INTEGER NOT NULL DEFAULT 0,     -- 被折叠的媒体数量（+5）
  read_count    INTEGER NOT NULL DEFAULT 0,
  fav_count     INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  is_hot        INTEGER NOT NULL DEFAULT 0,
  status        INTEGER NOT NULL DEFAULT 1,
  published_at  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_pub      ON posts(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_creator  ON posts(creator_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_hot      ON posts(status, is_hot, read_count DESC);

-- 帖子媒体（视频帖：1 张大图 + 3 张缩略图；图文帖：文档页缩略图）
CREATE TABLE IF NOT EXISTS post_media (
  id           INTEGER PRIMARY KEY,
  post_id      INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_type   INTEGER NOT NULL DEFAULT 0,      -- 0=图片 1=视频 2=文档
  role         INTEGER NOT NULL DEFAULT 0,      -- 0=主图 1=缩略图
  url          TEXT,
  fallback     TEXT,
  thumb_url    TEXT,
  duration_sec INTEGER,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_post_media_post ON post_media(post_id, role, sort_order);

CREATE TABLE IF NOT EXISTS post_media_blobs (
  id        INTEGER PRIMARY KEY,
  post_id   INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  content   TEXT NOT NULL,                      -- 长文正文 / 文档页内容（媒体表只存元信息）
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY,
  post_id       INTEGER REFERENCES posts(id)        ON DELETE CASCADE,
  video_id      INTEGER REFERENCES videos(id)       ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id)        ON DELETE SET NULL,
  parent_id     INTEGER REFERENCES comments(id)     ON DELETE CASCADE,
  content       TEXT    NOT NULL,
  like_count    INTEGER NOT NULL DEFAULT 0,
  status        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  CHECK (post_id IS NOT NULL OR video_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_comments_post  ON comments(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 直播
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS live_rooms (
  id            INTEGER PRIMARY KEY,
  creator_id    INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  subtitle      TEXT    NOT NULL DEFAULT '',    -- 「夜聊·音乐·陪伴」
  category      TEXT,                           -- 推荐 / 附近 / 才艺 / 聊天 / 户外
  cover_url     TEXT,
  cover_fallback TEXT,
  stream_url    TEXT,
  status        INTEGER NOT NULL DEFAULT 0,     -- 0=未开播 1=直播中 2=已结束
  viewer_count  INTEGER NOT NULL DEFAULT 0,     -- 展示为 2.3w
  peak_viewers  INTEGER NOT NULL DEFAULT 0,
  started_at    INTEGER,
  ended_at      INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_status ON live_rooms(status, viewer_count DESC);
CREATE INDEX IF NOT EXISTS idx_live_creator ON live_rooms(creator_id, status);

-- ---------------------------------------------------------------------------
-- 同城
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS places (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  category      TEXT,                           -- 美食 / 户外 / 酒吧 …
  address       TEXT    NOT NULL DEFAULT '',
  city          TEXT    NOT NULL DEFAULT '',
  lat           REAL,
  lng           REAL,
  distance_km   REAL,                           -- 「0.8km」，真实实现按用户位置实时算
  price_text    TEXT,                           -- 「人均 ¥68」「¥158起」
  cover_url     TEXT,
  cover_fallback TEXT,
  rating        REAL,
  status        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_places_city ON places(city, status);

CREATE TABLE IF NOT EXISTS place_tags (
  place_id  INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  tag       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (place_id, tag)
);

-- ---------------------------------------------------------------------------
-- 搜索与筛选
-- ---------------------------------------------------------------------------

-- 热门搜索词（swap 一轮 = 换一批）
CREATE TABLE IF NOT EXISTS search_keywords (
  id          INTEGER PRIMARY KEY,
  word        TEXT    NOT NULL UNIQUE,
  is_hot      INTEGER NOT NULL DEFAULT 0,       -- 词尾的小火焰
  is_banned   INTEGER NOT NULL DEFAULT 0,
  weight      INTEGER NOT NULL DEFAULT 0,       -- 排序权重
  search_count INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keywords_hot ON search_keywords(is_banned, weight DESC, sort_order);

-- 地区胶囊（「最新」页：国产 18 / 日韩 19 / 其他 192）
CREATE TABLE IF NOT EXISTS regions (
  id         INTEGER PRIMARY KEY,
  code       TEXT    NOT NULL UNIQUE,
  label      TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 分类页的筛选条件（全部 / 最热 / 最新 / 高分）
CREATE TABLE IF NOT EXISTS category_filters (
  id          INTEGER PRIMARY KEY,
  tab         TEXT    NOT NULL,                 -- ai / cn / jk / anime / show / doc
  label       TEXT    NOT NULL,
  sort_key    TEXT    NOT NULL DEFAULT 'default', -- 接口据此转成 ORDER BY
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS nearby_filters (
  id          INTEGER PRIMARY KEY,
  label       TEXT    NOT NULL,                 -- 全部 / 附近 / 最新 / 热门 / 美食 / 户外
  category    TEXT,                             -- 非空时按 places.category 过滤
  sort_key    TEXT    NOT NULL DEFAULT 'default',
  sort_order  INTEGER NOT NULL DEFAULT 0
);
-- 底部导航 / 首页顶部 Tab 的配置（前端 src/config/nav.js 的服务端版本）
CREATE TABLE IF NOT EXISTS client_tabs (
  id          INTEGER PRIMARY KEY,
  nav         TEXT    NOT NULL,                 -- 'home' | 'main'
  key         TEXT    NOT NULL,                 -- recommend / latest / short / live …
  label       TEXT    NOT NULL,
  icon        TEXT,
  show_flame  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  status      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (nav, key)
);

-- 用户搜索历史（「近期搜索」横向卡片）
CREATE TABLE IF NOT EXISTS search_history (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keyword    TEXT    NOT NULL,
  video_id   INTEGER REFERENCES videos(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_history_keyword ON search_history(keyword);

-- 用户观看历史
CREATE TABLE IF NOT EXISTS watch_history (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  video_id    INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  progress_sec INTEGER NOT NULL DEFAULT 0,      -- 看到第几秒
  position    INTEGER NOT NULL DEFAULT 0,       -- 列表顺序
  watched_at  INTEGER NOT NULL,
  UNIQUE (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_watch_history_user ON watch_history(user_id, watched_at DESC);

-- 「我的」页里没有下级的入口（离线缓存等，目前是占位数字）
CREATE TABLE IF NOT EXISTS user_stats (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  history_count INTEGER NOT NULL DEFAULT 0,
  fav_count     INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  follow_count  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 互动：点赞 / 收藏 / 弹幕 / 上传
-- ---------------------------------------------------------------------------

-- 短视频的「不喜欢」（点赞用 video_likes）
CREATE TABLE IF NOT EXISTS video_dislikes (
  user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE TABLE IF NOT EXISTS video_likes (
  user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_video_likes_video ON video_likes(video_id);

CREATE TABLE IF NOT EXISTS video_favs (
  user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_video_favs_video ON video_favs(video_id);

-- 专题收藏（前端「收藏」按钮 + 「2 收藏」文案）
CREATE TABLE IF NOT EXISTS topic_favs (
  user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  topic_id   INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_topic_favs_topic ON topic_favs(topic_id);

CREATE TABLE IF NOT EXISTS post_favs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_post_favs_post ON post_favs(post_id);

CREATE TABLE IF NOT EXISTS comments_likes (
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, comment_id)
);

CREATE TABLE IF NOT EXISTS danmaku (
  id         INTEGER PRIMARY KEY,
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content    TEXT    NOT NULL,
  time_sec   REAL    NOT NULL,
  color      TEXT    NOT NULL DEFAULT '#ffffff',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_danmaku_video ON danmaku(video_id, time_sec);

-- 用户上传（审核通过后写入 videos）
CREATE TABLE IF NOT EXISTS video_uploads (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  file_path    TEXT,
  status       INTEGER NOT NULL DEFAULT 0,      -- 0=待审 1=通过 2=驳回
  video_id     INTEGER REFERENCES videos(id) ON DELETE SET NULL,
  reject_reason TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON video_uploads(user_id, created_at DESC);

-- 会话与统计
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device     TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS daily_stats (
  day          TEXT PRIMARY KEY,                -- '2026-10-09'
  new_users    INTEGER NOT NULL DEFAULT 0,
  new_videos   INTEGER NOT NULL DEFAULT 0,
  play_count   INTEGER NOT NULL DEFAULT 0,
  active_users INTEGER NOT NULL DEFAULT 0
);
