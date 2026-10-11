-- ============================================================================
--  视图 / 全文检索 / 计数触发器
--
--  视图的作用：把「接口要返回什么」直接固化成 SQL，
--  接入前端时 server/db/query.mjs 里基本就是 SELECT * FROM v_xxx，
--  字段名与 src/api/index.js 的 typedef 一一对应，不需要在 JS 里再拼装。
--
--  触发器的作用：点赞数、收藏数、播放数这类计数不再实时 COUNT(*)，
--  而是写互动表时顺带更新冗余字段，列表查询永远是单表扫描。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 视频列表（首页 / 分类 / 最新 / 专题 / 历史 都用它）
--    cover_src / cover_fallback 两列对应前端 Cover { src, fallback }
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_videos;
CREATE VIEW v_videos AS
SELECT
  v.id,
  v.public_id                                        AS code,
  v.title,
  v.description,
  printf('%02d:%02d:%02d', v.duration_sec / 3600,
         (v.duration_sec % 3600) / 60, v.duration_sec % 60) AS dur,
  v.duration_sec                                     AS len,
  v.cover_url                                        AS cover_src,
  v.cover_fallback                                   AS cover_fallback,
  v.playback_url,
  v.region,
  v.category_key,
  v.quality,
  v.tags,
  v.play_count,
  v.like_count,
  v.fav_count,
  v.is_series,
  v.episode_no,
  v.published_at,
  v.topic_id,
  t.name                                             AS topic_name,
  t.slug                                             AS topic_slug,
  v.creator_id,
  c.name                                             AS creator_name,
  c.handle                                           AS creator_handle,
  c.avatar_url                                       AS creator_avatar_url,
  c.avatar_fallback                                  AS creator_avatar_fallback
FROM videos v
LEFT JOIN topics   t ON t.id = v.topic_id
LEFT JOIN creators c ON c.id = v.creator_id
WHERE v.status = 1;

-- ---------------------------------------------------------------------------
-- 2. 专题（含片库需要的视频数、封面拼图）
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_topics;
CREATE VIEW v_topics AS
SELECT
  t.id,
  t.slug,
  t.name,
  t.description,
  t.kind,
  t.is_featured,
  t.sort_order,
  t.card_size,
  t.plays_count,
  t.fav_count,
  t.video_count,
  t.created_at
FROM topics t
WHERE t.status = 1;

DROP VIEW IF EXISTS v_topic_covers;
CREATE VIEW v_topic_covers AS
SELECT topic_id, url, fallback, sort_order
FROM topic_covers;

-- ---------------------------------------------------------------------------
-- 3. 首页分区（换一批时把 batch_key 往后挪一位）
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_home_sections;
CREATE VIEW v_home_sections AS
SELECT
  s.id,
  s.topic_id,
  s.title,
  s.subtitle,
  s.is_featured                               AS featured,
  s.card_size                                 AS size,
  s.sort_order,
  (SELECT COUNT(*) FROM home_section_items i WHERE i.section_id = s.id) AS total
FROM home_sections s
WHERE s.status = 1;

DROP VIEW IF EXISTS v_home_section_items;
CREATE VIEW v_home_section_items AS
SELECT
  i.section_id,
  i.batch_key,
  i.batch_no,
  i.sort_order AS item_rank,
  v.*
FROM home_section_items i
JOIN v_videos v ON v.id = i.video_id;

-- ---------------------------------------------------------------------------
-- 4. 社区
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_posts;
CREATE VIEW v_posts AS
SELECT
  p.id,
  p.text,
  p.media_kind,
  p.tags,
  p.read_count                                AS read,
  p.fav_count                                 AS fav,
  p.comment_count,
  p.thumb_count,
  p.more_count                                AS more,
  p.is_hot,
  p.published_at,
  p.creator_id,
  c.name                                      AS author_name,
  c.handle                                    AS author_handle,
  c.is_verified                               AS author_verified,
  c.avatar_url                                AS avatar_src,
  c.avatar_fallback                           AS avatar_fallback,
  v.id                                        AS video_id,
  v.public_id                                 AS video_code,
  printf('%02d:%02d', v.duration_sec / 60, v.duration_sec % 60) AS dur
FROM posts p
LEFT JOIN creators c ON c.id = p.creator_id
LEFT JOIN videos   v ON v.id = p.video_id
WHERE p.status = 1;

DROP VIEW IF EXISTS v_post_media;
CREATE VIEW v_post_media AS
SELECT
  m.post_id,
  m.media_type,
  m.role,
  m.url,
  m.fallback,
  m.thumb_url,
  m.duration_sec,
  m.sort_order
FROM post_media m
JOIN posts p ON p.id = m.post_id AND p.status = 1;

-- ---------------------------------------------------------------------------
-- 5. 直播 / 同城
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_lives;
CREATE VIEW v_lives AS
SELECT
  r.id,
  r.title,
  r.subtitle                                  AS sub,
  r.category,
  r.cover_url,
  r.cover_fallback,
  r.status,
  r.viewer_count                              AS viewers,
  -- 前端展示成 2.3w / 1.4w
  CASE WHEN r.viewer_count >= 10000
       THEN printf('%.1fw', r.viewer_count / 10000.0)
       WHEN r.viewer_count >= 1000
       THEN printf('%.1fk', r.viewer_count / 1000.0)
       ELSE CAST(r.viewer_count AS TEXT) END   AS viewers_text,
  r.started_at,
  r.creator_id,
  c.name                                      AS creator_name,
  c.handle                                    AS creator_handle,
  c.avatar_url                                AS creator_avatar_url,
  c.avatar_fallback                           AS creator_avatar_fallback
FROM live_rooms r
LEFT JOIN creators c ON c.id = r.creator_id;

DROP VIEW IF EXISTS v_places;
CREATE VIEW v_places AS
SELECT
  p.id,
  p.name,
  p.category,
  p.address,
  p.city,
  p.lat,
  p.lng,
  p.distance_km,
  p.rating,
  p.cover_url,
  p.cover_fallback,
  p.price_text                                AS price,
  p.status,
  p.created_at,
  CASE WHEN p.distance_km IS NULL THEN NULL
       ELSE printf('%.1fkm', p.distance_km) END AS distance
FROM places p
WHERE p.status = 1;

DROP VIEW IF EXISTS v_place_tags;
CREATE VIEW v_place_tags AS
SELECT place_id, tag, sort_order FROM place_tags;

-- ---------------------------------------------------------------------------
-- 6. 用户侧
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_users;
CREATE VIEW v_users AS
SELECT
  u.id,
  u.uid,
  u.nickname                                  AS name,
  u.bio,
  u.avatar_url,
  u.avatar_fallback,
  COALESCE(s.history_count, 0)                AS history_count,
  COALESCE(s.fav_count, 0)                    AS fav_count,
  COALESCE(s.download_count, 0)               AS download_count,
  COALESCE(s.follow_count, 0)                 AS follow_count
FROM users u
LEFT JOIN user_stats s ON s.user_id = u.id
WHERE u.status = 1;

DROP VIEW IF EXISTS v_watch_history;
CREATE VIEW v_watch_history AS
SELECT
  h.user_id,
  h.progress_sec,
  h.watched_at,
  h.position,
  v.*
FROM watch_history h
JOIN v_videos v ON v.id = h.video_id;

DROP VIEW IF EXISTS v_search_history;
CREATE VIEW v_search_history AS
SELECT
  h.id,
  h.user_id,
  h.keyword,
  h.created_at,
  v.*
FROM search_history h
LEFT JOIN v_videos v ON v.id = h.video_id;

-- ---------------------------------------------------------------------------
-- 7. 全文检索（FTS5 + trigram 分词，中文按 3 字滑窗切，支持子串匹配）
--    注意：trigram 至少 3 个字，1~2 个字的查询请在 query.mjs 里退回 LIKE
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
  title,
  description,
  tags,
  content = 'videos',
  content_rowid = 'id',
  tokenize = "trigram"
);

CREATE TRIGGER IF NOT EXISTS videos_fts_insert AFTER INSERT ON videos BEGIN
  INSERT INTO videos_fts(rowid, title, description, tags)
  VALUES (new.id, new.title, new.description, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS videos_fts_delete AFTER DELETE ON videos BEGIN
  INSERT INTO videos_fts(videos_fts, rowid, title, description, tags)
  VALUES ('delete', old.id, old.title, old.description, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS videos_fts_update AFTER UPDATE OF title, description, tags ON videos BEGIN
  INSERT INTO videos_fts(videos_fts, rowid, title, description, tags)
  VALUES ('delete', old.id, old.title, old.description, old.tags);
  INSERT INTO videos_fts(rowid, title, description, tags)
  VALUES (new.id, new.title, new.description, new.tags);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  text,
  tags,
  content = 'posts',
  content_rowid = 'id',
  tokenize = "trigram"
);

CREATE TRIGGER IF NOT EXISTS posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
END;

-- 管理后台会改帖子标题 / 标签，索引要同步（老库由 db/index.mjs 启动时补建）
CREATE TRIGGER IF NOT EXISTS posts_fts_update AFTER UPDATE OF text, tags ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
  INSERT INTO posts_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
END;

-- ---------------------------------------------------------------------------
-- 8. 计数触发器：互动表写入时同步冗余计数
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_video_like_ins AFTER INSERT ON video_likes BEGIN
  UPDATE videos SET like_count = like_count + 1 WHERE id = new.video_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_video_like_del AFTER DELETE ON video_likes BEGIN
  UPDATE videos SET like_count = MAX(like_count - 1, 0) WHERE id = old.video_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_video_fav_ins AFTER INSERT ON video_favs BEGIN
  UPDATE videos SET fav_count = fav_count + 1 WHERE id = new.video_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_video_fav_del AFTER DELETE ON video_favs BEGIN
  UPDATE videos SET fav_count = MAX(fav_count - 1, 0) WHERE id = old.video_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_topic_fav_ins AFTER INSERT ON topic_favs BEGIN
  UPDATE topics SET fav_count = fav_count + 1 WHERE id = new.topic_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_topic_fav_del AFTER DELETE ON topic_favs BEGIN
  UPDATE topics SET fav_count = MAX(fav_count - 1, 0) WHERE id = old.topic_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_post_fav_ins AFTER INSERT ON post_favs BEGIN
  UPDATE posts SET fav_count = fav_count + 1 WHERE id = new.post_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_post_fav_del AFTER DELETE ON post_favs BEGIN
  UPDATE posts SET fav_count = MAX(fav_count - 1, 0) WHERE id = old.post_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_comment_ins AFTER INSERT ON comments BEGIN
  UPDATE posts SET comment_count = comment_count + 1 WHERE id = new.post_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_comment_del AFTER DELETE ON comments BEGIN
  UPDATE posts SET comment_count = MAX(comment_count - 1, 0) WHERE id = old.post_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_danmaku_ins AFTER INSERT ON danmaku BEGIN
  UPDATE videos SET danmaku_count = danmaku_count + 1 WHERE id = new.video_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_danmaku_del AFTER DELETE ON danmaku BEGIN
  UPDATE videos SET danmaku_count = MAX(danmaku_count - 1, 0) WHERE id = old.video_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_follow_ins AFTER INSERT ON user_follows BEGIN
  UPDATE creators SET follower_count = follower_count + 1 WHERE id = new.creator_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_follow_del AFTER DELETE ON user_follows BEGIN
  UPDATE creators SET follower_count = MAX(follower_count - 1, 0) WHERE id = old.creator_id;
END;

-- 专题视频数：新增 / 删除 / 换专题时同步
CREATE TRIGGER IF NOT EXISTS trg_video_topic_ins AFTER INSERT ON videos BEGIN
  UPDATE topics SET video_count = video_count + 1 WHERE id = new.topic_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_video_topic_del AFTER DELETE ON videos BEGIN
  UPDATE topics SET video_count = MAX(video_count - 1, 0) WHERE id = old.topic_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_video_topic_move AFTER UPDATE OF topic_id ON videos
WHEN old.topic_id IS NOT new.topic_id BEGIN
  UPDATE topics SET video_count = MAX(video_count - 1, 0) WHERE id = old.topic_id;
  UPDATE topics SET video_count = video_count + 1 WHERE id = new.topic_id;
END;

-- 观看历史写入时同步「我的」页的统计数字
CREATE TRIGGER IF NOT EXISTS trg_history_sync AFTER INSERT ON watch_history BEGIN
  INSERT INTO user_stats(user_id, history_count, updated_at)
  VALUES (new.user_id,
          (SELECT COUNT(*) FROM watch_history WHERE user_id = new.user_id),
          CAST(strftime('%s','now') AS INTEGER))
  ON CONFLICT(user_id) DO UPDATE SET
    history_count = (SELECT COUNT(*) FROM watch_history WHERE user_id = new.user_id),
    updated_at = CAST(strftime('%s','now') AS INTEGER);
END;
