/*
 * 批量导入：每种数据的说明、结果表里显示哪几列、导入后去哪儿看、模板里的示例行。
 * 字段本身（列名、别名、是否必填、示例）来自服务端 /api/admin/schema，这里只放界面上的东西。
 */

/* 导入 / 扫描结果的链接：按 ID 倒序，刚导入的排在最前面 */
const NEWEST = { sort: 'id', order: 'desc' }

export const TYPES = [
  {
    type: 'videos',
    label: '视频',
    icon: 'video',
    desc: '标题、播放地址、封面、专题、标签等',
    keyCols: ['title', 'publicId', 'playbackUrl'],
    hasStatus: true,
    autoCreate: '自动创建不存在的专题 / 创作者',
    list: { path: '/videos', query: NEWEST, text: '查看视频' }
  },
  {
    type: 'posts',
    label: '帖子',
    icon: 'post',
    desc: '社区帖子：发布者、正文、配图、关联视频',
    keyCols: ['text', 'creator'],
    hasStatus: true,
    autoCreate: '自动创建不存在的创作者',
    list: { path: '/posts', query: NEWEST, text: '查看帖子' }
  },
  {
    type: 'topics',
    label: '专题',
    icon: 'topic',
    desc: '专题 / 合集：名称、标识、头图、排序',
    keyCols: ['name', 'slug'],
    hasStatus: true,
    list: { path: '/topics', query: NEWEST, text: '查看专题' }
  },
  {
    type: 'creators',
    label: '创作者',
    icon: 'creator',
    desc: '账号、名称、头像、简介、认证',
    keyCols: ['name', 'handle'],
    hasStatus: false,
    list: { path: '/creators', query: NEWEST, text: '查看创作者' }
  },
  {
    type: 'keywords',
    label: '搜索热词',
    icon: 'search',
    desc: '搜索页「热门搜索」里的词',
    keyCols: ['word'],
    hasStatus: false,
    list: { path: '/keywords', query: NEWEST, text: '查看搜索热词' }
  }
]

export const typeInfo = type => TYPES.find(t => t.type === type) || TYPES[0]
export const isType = type => TYPES.some(t => t.type === type)

/** 结果状态 → 文字 / 样式 */
export const STATUS_TEXT = { created: '新增', updated: '更新', skipped: '跳过', error: '错误' }
export const STATUS_CHIP = { created: 'ok', updated: 'solid', skipped: '', error: 'danger' }

/*
 * 模板的示例行：服务端字段定义里的示例（如「城市漫游 / citywalk」「trip」「VID-2001」）正好是真实数据，
 * 用户留着示例行再选「更新已有」就会把真实记录改掉。所以模板里：ID / 编号留空；用来判断重复的列（名称、标识、账号、
 * 热词、播放地址）一律写成明显的示例值；主要那一列带上「示例行，导入前请删除」。导入时认出这一行会自动跳过。
 * 其他列（专题、创作者、分类这些引用）沿用服务端示例，只是演示写法。
 */
const MARK = '（示例行，导入前请删除）'
const TEMPLATE_EXAMPLES = {
  videos: { id: '', publicId: '', title: '示例视频' + MARK, playbackUrl: '/media/videos/example.mp4', coverUrl: '/media/covers/example.jpg' },
  posts: { id: '', text: '示例帖子正文' + MARK, creator: '@example_user', video: '', mainImage: '/media/images/example.jpg', images: '/media/images/example-1.jpg,/media/images/example-2.jpg' },
  topics: { id: '', name: '示例专题' + MARK, slug: 'example-topic', covers: '/media/covers/example.jpg' },
  creators: { id: '', handle: 'example_user', name: '示例创作者' + MARK, avatarUrl: '/media/images/example.jpg' },
  keywords: { word: '示例热词' + MARK }
}
/** 每种数据认示例行看哪一列 */
const EXAMPLE_KEY = { videos: 'title', posts: 'text', topics: 'name', creators: 'name', keywords: 'word' }

/** 模板第二行（与 fields 对齐） */
export function templateRow(type, fields) {
  const own = TEMPLATE_EXAMPLES[type] || {}
  return fields.map(f => (f.key in own ? own[f.key] : f.key === 'id' ? '' : f.example || ''))
}

/** 示例行的认法：{ key: 字段, value: 示例值 }（这一列的值等于它就是模板里没删的示例行） */
export function exampleMarker(type) {
  const key = EXAMPLE_KEY[type]
  const value = TEMPLATE_EXAMPLES[type]?.[key]
  return key && value ? { key, value } : null
}
