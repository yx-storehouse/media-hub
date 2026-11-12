/*
 * 图集的种子数据（只给开发 / 测试库用：线上库不跑 seed，永远不会出现演示图集）。
 *
 *   seed.mjs 建库时调用 seedAlbums(db)；测试工具也可以用它给一个已有的库补上图集（按账号找创作者，找不到的跳过）。
 *
 * 图片是 picsum.photos 的固定种子地址（中性的风景 / 街景 / 静物照片），请求的尺寸就是图片的真实宽高，
 * 比例有竖图、横图、方图、长图几种。同一份种子每次生成的图集完全一样（标题、张数、比例、发布时间的相对位置）。
 */
import { rng } from '../lib/random.mjs'

const DAY = 86400

/* 常见的手机 / 相机照片比例（宽 × 高） */
export const ALBUM_SIZES = [[1080, 1440], [1080, 1350], [1440, 1080], [1080, 1080], [1080, 1920], [1600, 900], [1200, 1600], [1350, 1080]]

const TITLES = [
  '雨后的老街', '海边的清晨', '山间小路', '城市夜色', '窗边的午后', '一杯咖啡的时间', '秋天的公园', '旅途随拍',
  '晨雾', '街角的花店', '周末的集市', '湖面倒影', '黄昏的天台', '冬日暖阳', '书店一角', '小巷光影', '列车窗外', '岛屿日记'
]
const DESCRIPTIONS = [
  '',
  '随手拍下的几张，留个记录。',
  '那天的光线很好，走走停停拍了一路。',
  '下了一夜的雨，早上出门空气特别干净。\n\n地面还是湿的，倒影比平时多。',
  '用手机拍的，没怎么调色。',
  ''
]
const TAGS = ['随拍', '风景', '街拍', '旅行', '日常', '城市', '自然', '光影', '胶片感', '手机摄影']

/*
 * 每个创作者几个图集：[账号, 图集张数…]。张数为 1 的是单张图片（一部分不写标题）。
 * 「每日大赛」「云舒」故意没有图集，App 的「图片」标签有空状态可看。
 */
const PLAN = [
  ['aijc', 6, 1, 9],
  ['trip', 12, 4, 1, 7],
  ['craft', 5, 1],
  ['qingchuan', 1, 3],
  ['xingye', 8, 1, 1],
  ['linxia', 4, 10],
  ['sumu', 9, 1, 6, 2],
  ['nanqiao', 3],
  ['xuzhi', 1, 5, 12],
  ['luyao', 7, 2, 1]
]

/** picsum 的固定种子图：同一个种子永远是同一张照片 */
export const picsumUrl = (seed, w, h) => `https://picsum.photos/seed/${seed}/${w}/${h}`

/**
 * 给库里写入种子图集，返回 { albums, images }（写了多少个图集、多少张图）。
 *   now       「现在」（秒），发布时间按它往前排（0～60 天前）
 *   seed      随机种子（默认和 seed.mjs 一样），换一个就是另一批图集
 *   prefix    picsum 种子前缀，换前缀就换一批照片
 * 不开事务：seed.mjs 在自己的事务里调用；单独用时调用方自己包事务。
 */
export function seedAlbums(db, { now = Math.floor(Date.now() / 1000), seed = 20261009, prefix = 'reel-album' } = {}) {
  const r = rng('albums' + seed)
  const pickOf = arr => arr[Math.floor(r() * arr.length)]
  const creatorIds = new Map(db.prepare('SELECT id, handle FROM creators').all().map(c => [c.handle, c.id]))
  const insAlbum = db.prepare(`INSERT INTO albums(creator_id, title, description, tags, image_count, view_count, status, published_at, created_at, updated_at)
                               VALUES(?,?,?,?,?,?,?,?,?,?)`)
  const insImage = db.prepare('INSERT INTO album_images(album_id, url, width, height, sort, created_at) VALUES(?,?,?,?,?,?)')
  let albums = 0, images = 0, n = 0
  for (const [handle, ...counts] of PLAN) {
    const creatorId = creatorIds.get(handle)
    for (const count of counts) {
      n += 1
      if (!creatorId) continue
      // 单张图片一半不写标题；多张的都有标题
      const title = count === 1 && r() < 0.5 ? '' : TITLES[(n * 7) % TITLES.length]
      const description = count === 1 ? '' : pickOf(DESCRIPTIONS)
      const tags = [...new Set([pickOf(TAGS), pickOf(TAGS)])].slice(0, 1 + Math.floor(r() * 2))
      // 发布时间：0～60 天前，和视频 / 帖子交错（「媒体」照片墙里能看到混排）
      const published = now - Math.floor(r() * 60 * DAY) - 600
      const albumId = Number(insAlbum.run(creatorId, title, description, JSON.stringify(tags), count, Math.floor(r() * 3000), 1,
        published, now, now).lastInsertRowid)
      // 同一个图集里的比例大致统一（多数是同一部手机拍的），偶尔混一张别的比例
      const main = pickOf(ALBUM_SIZES)
      for (let k = 0; k < count; k++) {
        const [w, h] = r() < 0.8 ? main : pickOf(ALBUM_SIZES)
        insImage.run(albumId, picsumUrl(`${prefix}-${n}-${k}`, w, h), w, h, k, now)
        images += 1
      }
      albums += 1
    }
  }
  return { albums, images }
}
