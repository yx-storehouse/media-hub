/** Top tabs on the home page. `hot` shows the small flame next to the label. */
export const HOME_TABS = [
  { id: 'latest', name: '最新' },
  { id: 'recommend', name: '推荐' },
  { id: 'ai', name: 'AI短剧', hot: true },
  { id: 'cn', name: '国产' },
  { id: 'jk', name: '日韩' },
  { id: 'anime', name: '动漫' },
  { id: 'show', name: '综艺' },
  { id: 'doc', name: '纪录片' }
]

export const DEFAULT_HOME_TAB = 'recommend'

/** 是不是首页的地址（/home/xxx）；history.state.back 可能是 null */
export const isHomePath = path => typeof path === 'string' && /^\/home(\/|$)/.test(path)

/**
 * Bottom tab bar. `icon` is the outline icon name; the active state uses `${icon}On`.
 * `view` is the page component's name: these pages are kept alive (App.vue). The router warns in
 * development if a tab-bar page's component name is missing here.
 */
export const MAIN_TABS = [
  { id: 'home', label: '首页', icon: 'tHome', view: 'HomeView' },
  { id: 'short', label: '短视频', icon: 'tShort', path: '/short', view: 'ShortView' },
  { id: 'live', label: '直播', icon: 'tLive', path: '/live', view: 'LiveView' },
  { id: 'community', label: '社区', icon: 'tCommunity', path: '/community', view: 'CommunityView' },
  { id: 'nearby', label: '同城', icon: 'tNearby', path: '/nearby', view: 'NearbyView' },
  { id: 'me', label: '我的', icon: 'tMe', path: '/me', view: 'MeView' }
]

export const KEEP_ALIVE_VIEWS = MAIN_TABS.map(t => t.view)

/*
 * 桌面布局（≥ 1024px）的左侧导航（components/desk/DeskSidebar.vue），三组之间有分隔线：
 *   主导航：首页 短视频 直播 社区 同城（和底部导航同一套图标，选中时实心），收成图标栏时也显示
 *   我的：我的（也在图标栏里） 观看历史 我的收藏 我的关注（后三个要登录：没登录先弹登录框，登录后直接进去）
 *   更多：片库
 * tab：是底部导航的那个 Tab（MAIN_TABS 的 id），点它和点底部导航一样（历史记录规则、再点一次回顶 / 刷新）。
 */
export const DESK_NAV = [
  MAIN_TABS.filter(t => t.id !== 'me').map(t => ({ id: t.id, label: t.label, icon: t.icon, iconOn: t.icon + 'On', tab: t.id, rail: true })),
  [
    { id: 'me', label: '我的', icon: 'tMe', iconOn: 'tMeOn', tab: 'me', rail: true },
    { id: 'history', label: '观看历史', icon: 'history', path: '/history', login: true },
    { id: 'favorites', label: '我的收藏', icon: 'bookmark', path: '/favorites', login: true },
    { id: 'follows', label: '我的关注', icon: 'userCheck', path: '/follows', login: true }
  ],
  [
    { id: 'library', label: '片库', icon: 'library', path: '/library' }
  ]
]

/**
 * 左侧导航里哪一项算「当前」：底部 Tab 页看 meta.tab；子页面看路由名，属于哪一块很明显的才高亮
 * （帖子详情 → 社区、账号管理 → 我的）；播放页、搜索、专题、创作者主页都不高亮。
 */
export const DESK_SECTION = {
  post: 'community',
  'admin-users': 'me',
  history: 'history',
  favorites: 'favorites',
  follows: 'follows',
  library: 'library'
}
