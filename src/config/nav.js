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
