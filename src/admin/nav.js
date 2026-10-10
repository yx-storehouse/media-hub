/*
 * 侧边栏导航（顺序即显示顺序）。name 对应 router.js 里的路由名，icon 见 components/icons.js。
 */
export const NAV = [
  { name: 'dashboard', label: '概览', icon: 'dashboard', to: '/' },
  { name: 'videos', label: '视频', icon: 'video', to: '/videos' },
  { name: 'posts', label: '帖子', icon: 'post', to: '/posts' },
  { name: 'topics', label: '专题', icon: 'topic', to: '/topics' },
  { name: 'creators', label: '创作者', icon: 'creator', to: '/creators' },
  { name: 'sections', label: '首页推荐', icon: 'home', to: '/sections' },
  { name: 'keywords', label: '搜索热词', icon: 'search', to: '/keywords' },
  { name: 'media', label: '素材文件', icon: 'folder', to: '/media' },
  { name: 'import', label: '批量导入', icon: 'import', to: '/import' },
  { name: 'users', label: '账号', icon: 'users', to: '/users' }
]
