/*
 * 初始化数据库：建表 → 写入种子数据。
 *
 *   node server/db/seed.mjs            # 若已存在则跳过建表，只补种子
 *   node server/db/seed.mjs --reset    # 删库重建，全部重来
 *
 * 数据来源与前端 src/mock/data.js 保持一致（标题池、专题名、帖子文案等），
 * 随机数用同一套种子算法（server/lib/random.mjs），所以同一条内容在前后端拿到的是同一张图。
 */
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { rng } from '../lib/random.mjs'
import { cover, avatar, brandAvatar, docThumb } from '../lib/art.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || join(here, 'reel.db')
const reset = process.argv.includes('--reset')

if (reset && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH)
  console.log('已删除旧库：', DB_PATH)
}
mkdirSync(dirname(DB_PATH), { recursive: true })

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'))
db.exec(readFileSync(join(here, 'views.sql'), 'utf8'))
console.log('表结构已就绪')

/* ---------------- 种子数据（与 src/mock/data.js 对齐） ---------------- */

const TITLES = [
  '午后咖啡馆的慢时光', '城市夜景延时摄影合集', '海边日落治愈系Vlog', '山间徒步第三天，云海太美了', '老街巷里的烟火气',
  '周末一起做舒芙蕾蛋糕', '深夜食堂·今日特供', '雨天窗边的爵士乐现场', '旅行日记：古镇的清晨', '露营地的银河延时',
  '一人食的治愈晚餐', '热门动漫 山海奇谭 第11-20集', '悬疑短剧 消失的第七天 第3集', '古风短剧 长安风月 全集', '高分纪录片 地球脉动 第5集',
  '街头美食探店 夜市篇', '治愈系猫咪日常合集', '城市骑行：沿江一路向东', '手冲咖啡入门教程', '夏日海岛旅拍花絮',
  '跟着导航去一座陌生小城', '冬日暖阳下的读书角', '雪山脚下的民宿体验', '三分钟看完一部悬疑片', '独居女孩的周末早午餐',
  '高铁沿线最美的十个瞬间', '胶片感街拍：黄昏的老城', '木屋里的一周慢生活', '深山古寺的晨钟暮鼓', '夜跑日记：和城市一起醒来',
  '国风舞蹈《霓裳》完整版', '纪录短片：最后的手艺人', '日式庭院的四季变换', '极光之旅：北纬70度', '公路电影感的一天',
  '宝藏小店逛不停', '黑胶唱片店里的一下午', '跟拍：凌晨四点的菜市场', '怀旧港风MV混剪', '电影级运镜练习合集'
]

const TOPIC_NAMES = ['热门推荐', '治愈日常', '悬疑短剧', '城市漫游', '动漫新番', '高分纪录片', '美食探店', '旅行日记', '国风舞蹈', '手作教程', '音乐现场']
const TOPIC_SLUGS = ['featured', 'healing', 'suspense', 'citywalk', 'anime', 'documentary', 'food', 'travel', 'guofeng', 'handmade', 'live-music']
/* 片库展示除「热门推荐」外的全部专题 */
const LIBRARY_TOPIC_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
/* 顶部分类 Tab：key 与前端路由一致 */
const CATEGORY_TABS = [
  ['ai', 'AI短剧'], ['cn', '国产'], ['jk', '日韩'], ['anime', '动漫'], ['show', '综艺'], ['doc', '纪录片']
]
const REGIONS = [['cn', '国产'], ['jk', '日韩'], ['other', '其他']]

const CREATORS = [
  ['aijc', 'AI剧场', 1, 1, 'AI短剧 · 每天更新'],
  ['mrds', '每日大赛', 1, 1, '每日精选 · 同人专区'],
  ['trip', '旅行日记', 0, 0, '记录路上的风景'],
  ['craft', '手作研究所', 0, 0, '羊毛毡 / 陶艺 / 木工'],
  ['qingchuan', '晴川', 1, 0, '深夜电台主播'],
  ['xingye', '星野', 0, 0, '弹唱 / 民谣'],
  ['linxia', '林夏', 0, 0, '烘焙日记'],
  ['sumu', '苏木', 1, 0, '旅拍 / 云游'],
  ['nanqiao', '南乔', 0, 0, '手作课堂'],
  ['yunshu', '云舒', 0, 0, '读书 / 自习'],
  ['xuzhi', '许知', 0, 0, '水彩风景'],
  ['luyao', '陆遥', 1, 0, '探店 / 美食']
]

const SHORTS = [
  { tags: ['#日落', '#海边', '#治愈', '#旅拍', '#慢生活'], title: '傍晚六点的海边，风很轻，云把天空染成了橘子汽水的颜色', like: 100, fav: 197, len: 46 },
  { tags: ['#夜景', '#延时摄影', '#城市', '#灯光'], title: '凌晨三点的城市不会睡，只是换了一种安静的方式发光', like: 238, fav: 412, len: 62 },
  { tags: ['#露营', '#星空', '#山野', '#银河'], title: '把帐篷搭在山顶，抬头就是整条银河，今晚不想回家了', like: 86, fav: 150, len: 38 },
  { tags: ['#咖啡', '#手冲', '#日常', '#午后'], title: '手冲一杯耶加雪菲，慢慢等水滴落下，也等一个晴天', like: 320, fav: 505, len: 75 },
  { tags: ['#森林', '#徒步', '#山间', '#自然'], title: '雨后的山林有一种特别的味道，苔藓和泥土被打开了', like: 64, fav: 98, len: 54 }
]

const POSTS = [
  { handle: 'aijc', text: 'AI短剧《暮色长安》第28集 重逢的那一夜，灯火与风雪同时落下', tags: ['AI', '剧情', '暮色长安', '每日大赛', 'AI短剧'], media: 'video', more: 5, read: 175, fav: 0 },
  { handle: 'mrds', text: '同人小说 山海录系列 少年游同人文 听雨篇 三部曲附带番外篇', tags: ['同人', '山海录', '每日大赛', '小说'], media: 'doc', more: 1, read: 98, fav: 3 },
  { handle: 'trip', text: '川西环线十日自驾攻略，附详细路线、住宿和避坑清单，收藏起来慢慢看', tags: ['旅行', '川西', '自驾攻略'], media: 'video', more: 8, read: 642, fav: 51 },
  { handle: 'craft', text: '周末给自己做了一只羊毛毡小猫，全程无声教程，治愈到不行', tags: ['手作', '羊毛毡', '治愈'], media: 'video', more: 3, read: 321, fav: 27 }
]

const LIVES = [
  ['qingchuan', '晴川的深夜电台', '夜聊·音乐·陪伴', 23000], ['nanqiao', '南乔手作课堂', '羊毛毡新手教学', 11000],
  ['luyao', '老陆探店', '今天去吃一碗面', 8000], ['xingye', '星野吉他弹唱', '点歌·民谣', 46000],
  ['yunshu', '云舒的书房', '共读·自习室', 32000], ['linxia', '林夏烘焙日记', '舒芙蕾挑战', 17000],
  ['sumu', '苏木旅拍', '云游大理古城', 51000], ['xuzhi', '许知画画', '水彩风景速写', 9000]
]
const LIVE_CATEGORIES = ['推荐', '附近', '才艺', '聊天', '户外']

const PLACES = [
  ['人气小酒馆·民谣夜场，每周五六不见不散', '酒吧', ['酒吧', '民谣', '夜场'], 0.8, '人均 ¥68'],
  ['江边露营地·周末亲子营位限时预订', '户外', ['露营', '亲子', '周末'], 2.3, '¥158起'],
  ['独立书店·咖啡共读，安静的角落任你挑', '书店', ['书店', '咖啡', '自习'], 1.2, '人均 ¥35'],
  ['老城区手作工坊·陶艺体验课，两小时成品带走', '手作', ['手作', '陶艺', '体验'], 3.5, '¥128'],
  ['城市天台观景餐厅·落日档位热门预约', '美食', ['景观', '西餐', '约会'], 4.1, '人均 ¥220'],
  ['胶片冲洗店·复古相机租赁与街拍路线推荐', '摄影', ['胶片', '摄影', '拍摄'], 1.9, '¥60起']
]

const HOT_WORDS = [
  ['山海奇谭', 0], ['悬疑短剧', 1], ['延时摄影', 1], ['治愈日常', 0], ['古风舞蹈', 0], ['露营', 1], ['城市夜景', 0], ['纪录片', 1],
  ['手冲咖啡', 0], ['民谣现场', 0], ['旅拍', 1], ['国风MV', 0], ['猫咪日常', 1], ['胶片街拍', 0], ['自驾川西', 0], ['烘焙教程', 1]
]

const now = Math.floor(Date.now() / 1000)
const DAY = 86400

/*
 * 发布时间按服务器本地日期分天，与「最新」页的日期筛选一致（server/db/index.mjs 的 localDayStart）：
 * ageDays = 0 落在今天 0 点到现在之间，其余落在 ageDays 天前的那一天里。
 * 这样「今天」任何时刻都有内容，测试结果也不随运行时间变化。
 */
const dayStart = n => {
  const d = new Date(now * 1000)
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime() / 1000)
}
const publishTime = (ageDays, r) => {
  const start = dayStart(ageDays)
  const end = ageDays === 0 ? now + 1 : dayStart(ageDays - 1)
  return start + Math.floor(r() * (end - start))
}

/* 专题头图的场景：每个专题错开一位，片库卡片（取第一张头图）就不会全是同一种画面；与 src/api/mock-fallback.js 一致 */
const HERO_KINDS = [0, 2, 1, 5, 4, 3]
const heroKinds = i => [0, 1, 2, 3].map(k => HERO_KINDS[(i + k) % HERO_KINDS.length])
/* 稳定种子：同一份数据无论重建多少次，随机结果都一致 */
const baseSeed = 20261009

/* ---------------- 写入 ---------------- */

const tx = fn => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } }

const insCreator = db.prepare(`INSERT INTO creators(handle,name,is_verified,is_official,bio,avatar_url,avatar_fallback,created_at)
                               VALUES(?,?,?,?,?,?,?,?)`)
const creatorIdByHandle = new Map()

const insUser = db.prepare(`INSERT INTO users(uid,nickname,avatar_url,avatar_fallback,created_at) VALUES(?,?,?,?,?)`)
const insTopic = db.prepare(`INSERT INTO topics(slug,name,kind,is_featured,sort_order,card_size,plays_count,fav_count,created_at)
                             VALUES(?,?,?,?,?,?,?,?,?)`)
const insTopicCover = db.prepare(`INSERT INTO topic_covers(topic_id,url,fallback,sort_order) VALUES(?,?,?,?)`)
const insVideo = db.prepare(`INSERT INTO videos(public_id,title,creator_id,topic_id,kind,is_series,episode_no,duration_sec,
                             cover_url,cover_fallback,region,category_key,tags,play_count,like_count,fav_count,
                             status,published_at,created_at)
                             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const insSection = db.prepare(`INSERT INTO home_sections(topic_id,title,is_featured,card_size,sort_order,updated_at) VALUES(?,?,?,?,?,?)`)
const insSectionItem = db.prepare(`INSERT INTO home_section_items(section_id,video_id,sort_order,batch_key,batch_no) VALUES(?,?,?,?,?)`)
const insPost = db.prepare(`INSERT INTO posts(creator_id,text,media_kind,video_id,tags,thumb_count,more_count,read_count,fav_count,
                            is_hot,status,published_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const insPostMedia = db.prepare(`INSERT INTO post_media(post_id,media_type,role,url,fallback,duration_sec,sort_order) VALUES(?,?,?,?,?,?,?)`)
const insLive = db.prepare(`INSERT INTO live_rooms(creator_id,title,subtitle,category,cover_url,cover_fallback,status,viewer_count,started_at,created_at)
                            VALUES(?,?,?,?,?,?,?,?,?,?)`)
const insPlace = db.prepare(`INSERT INTO places(name,category,distance_km,price_text,cover_url,cover_fallback,rating,city,status,created_at)
                             VALUES(?,?,?,?,?,?,?,?,?,?)`)
const insPlaceTag = db.prepare(`INSERT INTO place_tags(place_id,tag,sort_order) VALUES(?,?,?)`)
const insKeyword = db.prepare(`INSERT OR IGNORE INTO search_keywords(word,is_hot,weight,sort_order,updated_at) VALUES(?,?,?,?,?)`)
const insRegion = db.prepare(`INSERT OR IGNORE INTO regions(code,label,sort_order) VALUES(?,?,?)`)
const insCatFilter = db.prepare(`INSERT INTO category_filters(tab,label,sort_key,sort_order) VALUES(?,?,?,?)`)
const insNearbyFilter = db.prepare(`INSERT INTO nearby_filters(label,category,sort_key,sort_order) VALUES(?,?,?,?)`)
const insTab = db.prepare(`INSERT OR IGNORE INTO client_tabs(nav,key,label,icon,show_flame,sort_order,status) VALUES(?,?,?,?,?,?,1)`)

const coverCols = c => [c.src, c.fallback]

tx(() => {
  /* 用户 */
  const uid = insUser.run('10086', '游客_10086', ...coverCols(avatar('游', 'guest')), now).lastInsertRowid
  db.prepare('INSERT INTO user_stats(user_id, updated_at) VALUES(?,?)').run(uid, now)
  const userId = Number(uid)

  /* 创作者 */
  CREATORS.forEach(([handle, name, verified, official, bio], i) => {
    const id = Number(insCreator.run(handle, name, verified, official, bio, ...coverCols(avatar(name, handle)), now).lastInsertRowid)
    creatorIdByHandle.set(handle, id)
  })

  /* 专题 */
  const topicIds = TOPIC_NAMES.map((name, i) => {
    const kind = i === 0 ? 1 : 2          // 0-5 中 0 号作为首页分区来源，1..10 同时也是片库分类
    const featured = i === 0 ? 1 : 0
    const size = i === 0 ? 5 : 4
    const plays = i === 0 ? 0 : 5000 + i * 900
    const id = Number(insTopic.run(TOPIC_SLUGS[i], name, kind, featured, i, size, plays, 0, now).lastInsertRowid)
    // 头图 4 张（专题页 hero 拼图）
    heroKinds(i).forEach((kindCode, k) => {
      const c = cover(`hero${i}${k}`, { kind: kindCode, vignette: false, w: 300, h: 600 })
      insTopicCover.run(id, ...coverCols(c), k)
    })
    return id
  })

  /* 视频：每个专题各来一批，覆盖首页 / 分类 / 最新 / 剧集 / 搜索 */
  let vidSeq = 0
  const videoIdsByTopic = new Map()
  const addVideo = (topicIdx, { categoryKey, region, series = 0, episode = null, ageDays = 0 } = {}) => {
    const seed = `v${topicIdx}:${vidSeq}`
    const r = rng(seed + baseSeed)
    const title = TITLES[vidSeq % TITLES.length]
    const dur = 300 + Math.floor(r() * 2400)
    const c = cover(seed, { dark: false })
    const tags = JSON.stringify([`#${TOPIC_NAMES[topicIdx]}`, '#精选'].filter(Boolean))
    const published = publishTime(ageDays, r)
    vidSeq += 1
    const id = Number(insVideo.run(
      'VID-' + (1000 + vidSeq), title, creatorIdByHandle.get(CREATORS[vidSeq % CREATORS.length][0]), topicIds[topicIdx],
      1, series, episode, dur,
      ...coverCols(c), region || REGIONS[vidSeq % 3][0], categoryKey || CATEGORY_TABS[vidSeq % 6][0], tags,
      1000 + Math.floor(r() * 90000), 10 + Math.floor(r() * 900), 5 + Math.floor(r() * 400),
      1, published, published
    ).lastInsertRowid)
    if (!videoIdsByTopic.has(topicIdx)) videoIdsByTopic.set(topicIdx, [])
    videoIdsByTopic.get(topicIdx).push(id)
    return id
  }

  // 每个专题 40 条，其中前 8 条是近 7 天发布（供「最新」页按日期分组）
  TOPIC_NAMES.forEach((_, ti) => {
    for (let n = 0; n < 40; n++) addVideo(ti, { ageDays: n < 8 ? n : 8 + Math.floor(n * 1.5) })
  })

  // 剧集：动漫专题下的《山海奇谭》，12 集
  const seriesHolder = addVideo(4, { ageDays: 2 })
  const seriesId = Number(db.prepare('INSERT INTO series(video_id,title,total_episodes,is_completed,updated_at) VALUES(?,?,?,?,?)')
    .run(seriesHolder, '山海奇谭', 12, 0, now).lastInsertRowid)
  for (let ep = 1; ep <= 12; ep++) {
    const seed = `ep${ep}`
    const c = cover(seed, { kind: 5, w: 640, h: 400 })
    const id = Number(insVideo.run('EP-' + (100 + ep), `山海奇谭 第${ep}集`, creatorIdByHandle.get('aijc'), topicIds[4],
      2, 1, ep, 1200 + ep * 15, ...coverCols(c), 'cn', 'anime', JSON.stringify(['#动漫', '#山海奇谭']),
      20000 + ep * 300, 200 + ep * 5, 90 + ep, 1, now - (13 - ep) * DAY, now - (13 - ep) * DAY).lastInsertRowid)
    db.prepare('INSERT INTO series_episodes(series_id,video_id,episode_no,title,duration_sec,cover_url,status,published_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(seriesId, id, ep, `第${ep}集`, 1200 + ep * 15, c.src, 1, now - (13 - ep) * DAY)
  }

  /* 首页分区 + 换一批 */
  const sectionTitles = ['热门推荐', '治愈日常', '悬疑短剧', '城市漫游', '动漫新番', '高分纪录片']
  const insSectionItemBatch = []
  sectionTitles.forEach((title, i) => {
    const secId = Number(insSection.run(topicIds[i], title, i === 0 ? 1 : 0, i === 0 ? 5 : 4, i, now).lastInsertRowid)
    const pool = videoIdsByTopic.get(i) || []
    // 第一个批次是默认展示，之后每换一批用新的 batch_key（与前端种子的 'x' 规则一致）
    for (let batch = 0; batch < 4; batch++) {
      const key = 'rec' + i + 'x'.repeat(batch)
      pool.forEach((vid, k) => {
        const rotated = pool[(k + batch * (i === 0 ? 5 : 4)) % pool.length]
        insSectionItem.run(secId, rotated, k, key, batch)
      })
    }
  })

  /* 短视频 */
  SHORTS.forEach((s, i) => {
    const c = cover('short' + i, { vignette: false, w: 720, h: 1280 })
    const published = Math.max(dayStart(0), now - i * 3600)   // 一小时一条，但不早于今天 0 点
    const id = Number(insVideo.run('SHORT-' + (101 + i), s.title, creatorIdByHandle.get(CREATORS[i % CREATORS.length][0]), topicIds[0],
      1, 0, null, s.len, ...coverCols(c), 'cn', 'ai', JSON.stringify(s.tags),
      5000 + s.like * 40, s.like, s.fav, 1, published, published).lastInsertRowid)
    db.prepare("INSERT INTO short_clips(video_id,sort_order,added_at) VALUES(?,?,?)").run(id, i, now)
  })

  /* 社区 */
  POSTS.forEach((p, i) => {
    const creatorId = creatorIdByHandle.get(p.handle)
    const videoId = i === 0 ? videoIdsByTopic.get(0)[0] : (i >= 2 ? videoIdsByTopic.get(7)[i] : null)
    const postId = Number(insPost.run(creatorId, p.text, p.media === 'video' ? 1 : 2, videoId,
      JSON.stringify(p.tags), 3, p.more, p.read, p.fav, i === 0 ? 1 : 0, 1, now - (i + 1) * 600, now - (i + 1) * 600).lastInsertRowid)
    if (p.media === 'video') {
      const main = cover('post' + i, { vignette: false, w: 800, h: 450 })
      insPostMedia.run(postId, 1, 0, ...coverCols(main), videoId ? 441 : null, 0)
    }
    for (let k = 0; k < 3; k++) {
      const c = p.media === 'video'
        ? cover(`post${i}t${k}`, { kind: (i + k + 1) % 6, w: 360, h: 320 })
        : docThumb('doc' + k, k === 2)
      insPostMedia.run(postId, p.media === 'video' ? 0 : 2, 1, ...coverCols(c), null, k)
    }
  })

  /* 直播 */
  LIVES.forEach(([handle, title, sub, viewers], i) => {
    const c = cover('live' + i, { w: 480, h: 640 })
    insLive.run(creatorIdByHandle.get(handle), title, sub, LIVE_CATEGORIES[i % LIVE_CATEGORIES.length],
      ...coverCols(c), i % 4 === 3 ? 0 : 1, viewers, i % 4 === 3 ? null : now - i * 600, now)
  })

  /* 同城 */
  PLACES.forEach(([name, category, tags, distance, price], i) => {
    const c = cover('nb' + i, { w: 400, h: 400 })
    const id = Number(insPlace.run(name, category, distance, price, ...coverCols(c), 4.2 + (i % 6) / 10, '上海', 1, now).lastInsertRowid)
    tags.forEach((t, k) => insPlaceTag.run(id, t, k))
  })

  /* 搜索词、地区、筛选、导航配置 */
  HOT_WORDS.forEach(([word, hot], i) => insKeyword.run(word, hot, 100 - i, i, now))
  REGIONS.forEach(([code, label], i) => insRegion.run(code, label, i))
  CATEGORY_TABS.forEach(([tab]) => {
    ;['全部', '最热', '最新', '高分'].forEach((label, i) => {
      const sortKey = ['default', 'play_count', 'published_at', 'like_count'][i]
      insCatFilter.run(tab, label, sortKey, i)
    })
  })
  ;[['全部', null], ['附近', null], ['最新', null], ['热门', null], ['美食', '美食'], ['户外', '户外']]
    .forEach(([label, category], i) => insNearbyFilter.run(label, category, label === '最新' ? 'published_at' : 'default', i))
  ;[['latest', '最新'], ['recommend', '推荐'], ['ai', 'AI短剧'], ['cn', '国产'], ['jk', '日韩'], ['anime', '动漫'], ['show', '综艺'], ['doc', '纪录片']]
    .forEach(([key, label], i) => insTab.run('home', key, label, null, key === 'ai' ? 1 : 0, i))
  ;[['home', '首页', 'tHome'], ['short', '短视频', 'tShort'], ['live', '直播', 'tLive'], ['community', '社区', 'tCommunity'], ['nearby', '同城', 'tNearby'], ['me', '我的', 'tMe']]
    .forEach(([key, label, icon], i) => insTab.run('main', key, label, icon, 0, i))
})

/* 各表条数，方便一眼确认 */
const counts = ['users', 'creators', 'topics', 'videos', 'home_sections', 'home_section_items', 'series', 'series_episodes',
  'posts', 'post_media', 'live_rooms', 'places', 'place_tags', 'search_keywords', 'client_tabs']
  .map(t => `${t}=${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`)
console.log('种子数据写入完成 →', DB_PATH)
console.log(counts.join('  '))
db.close()
