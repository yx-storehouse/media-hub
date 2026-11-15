/*
 * 懒加载的页面（首页随入口一起加载，不在这里）和它们的地址：
 *   view    页面组件的文件名（src/views/<view>.vue）
 *   match   地址（#/ 后面的 path + query）的正则，直接打开这个地址（分享链接、书签、刷新、App 打开）时，
 *           index.html 里的一小段脚本在入口代码跑起来之前就开始下载这个页面的 JS / CSS（vite.config.js 的 viewChunks 插件）
 *   admin   只有管理员才进得去：普通用户不预取
 * 顺序就是空闲时预取的先后（router/index.js 的 prefetchRoutes）：最常去的在前面。
 * 新增懒加载页面时在 router/index.js 加路由，同时在这里登记一行（开发环境下漏登记会在控制台提示）。
 * 这个文件不能 import 任何东西：vite.config.js（Node）也直接读它。
 */
export const LAZY_VIEWS = [
  { view: 'ShortView', match: '^/short(?:[/?]|$)' },
  { view: 'VideoView', match: '^/video/' },
  { view: 'CommunityView', match: '^/community(?:[/?]|$)' },
  { view: 'CreatorView', match: '^/creator/' },
  { view: 'PostView', match: '^/post/' },
  { view: 'SearchView', match: '^/search(?:[/?]|$)' },
  { view: 'MeView', match: '^/me(?:[/?]|$)' },
  { view: 'TopicView', match: '^/topic/' },
  { view: 'LiveView', match: '^/live(?:[/?]|$)' },
  { view: 'NearbyView', match: '^/nearby(?:[/?]|$)' },
  { view: 'HistoryView', match: '^/history(?:[/?]|$)' },
  { view: 'FavoritesView', match: '^/favorites(?:[/?]|$)' },
  { view: 'FollowsView', match: '^/follows(?:[/?]|$)' },
  { view: 'LibraryView', match: '^/library(?:[/?]|$)' },
  { view: 'AdminUsersView', match: '^/admin/users(?:[/?]|$)', admin: true }
]
