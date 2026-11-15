import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { LAZY_VIEWS } from './src/config/views.js'

/* oldest engines we ship to: iOS 14.5 Safari / WKWebView (14.0–14.4 lack flex gap) and Android System WebView (Chrome) 87; 'safari14' stays as the esbuild syntax target */
const BROWSERS = ['chrome87', 'safari14', 'firefox78', 'edge88']
const API_TARGET = process.env.API_TARGET || 'http://127.0.0.1:3000'
const abs = p => fileURLToPath(new URL(p, import.meta.url))

/* 开发时 /admin 与 /admin/ 跳到管理后台入口，和接口服务托管 dist 时的行为一致 */
const adminRedirect = {
  name: 'admin-redirect',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === '/admin' || req.url === '/admin/') {
        res.statusCode = 302
        res.setHeader('Location', '/admin.html')
        return res.end()
      }
      next()
    })
  }
}

/*
 * 每个懒加载页面要下载哪些文件（打包时生成，写进 index.html 的一小段脚本里，只在打包后的版本里有）：
 *   window.__REEL_VIEWS__ = { VideoView: { m: 地址正则, f: [页面 JS, 它额外依赖的 JS 块…, CSS…], a?: 1 只有管理员 }, … }
 *   入口已经加载的块（vendor / common / data …）不列。
 * 用途：
 *   1. 直接打开深链（#/video/1、#/short、分享链接、刷新）：这段脚本在入口代码跑起来之前就按 location.hash
 *      给对应页面的 JS 加 modulepreload、CSS 加 preload，和入口并行下载，不用等入口跑完路由才发现要它；
 *   2. 空闲时预取别的页面（router/index.js 的 prefetchRoutes）：只把这些文件下载进 HTTP 缓存；
 *   3. 页面代码加载失败后的重试（router/index.js 的 lazyView）：给页面 JS 换一个带参数的地址再加载一次。
 * 页面和地址的对应在 src/config/views.js。
 */
const viewChunks = {
  name: 'reel-view-chunks',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      if (!ctx.bundle || !ctx.chunk || !/index\.html$/.test(ctx.filename)) return html
      const chunks = Object.values(ctx.bundle).filter(c => c.type === 'chunk')
      const byFile = new Map(chunks.map(c => [c.fileName, c]))
      const walk = (file, set) => {
        if (set.has(file)) return set
        set.add(file)
        for (const d of byFile.get(file)?.imports || []) walk(d, set)
        return set
      }
      const cssOf = files => [...new Set(files.flatMap(f => [...(byFile.get(f)?.viteMetadata?.importedCss || [])]))]
      const loaded = walk(ctx.chunk.fileName, new Set())
      const loadedCss = new Set(cssOf([...loaded]))
      const map = {}
      for (const v of LAZY_VIEWS) {
        const c = chunks.find(x => x.isDynamicEntry && (x.facadeModuleId || '').split('\\').join('/').endsWith(`/src/views/${v.view}.vue`))
        if (!c) throw new Error(`[view-chunks] 找不到页面 ${v.view} 的代码块（src/config/views.js 和路由对不上）`)
        const js = [...walk(c.fileName, new Set())].filter(f => !loaded.has(f))
        const css = cssOf(js).filter(f => !loadedCss.has(f))
        map[v.view] = { m: v.match, f: [...js, ...css].map(f => './' + f), ...(v.admin ? { a: 1 } : {}) }
      }
      // 只用老引擎（iOS 14、安卓 WebView 87）也认的写法
      const script = `(function(){var V=window.__REEL_VIEWS__=${JSON.stringify(map)};` +
        `var p=(location.hash||'').replace(/^#/,'')||'/';var d=document,mp;try{mp=d.createElement('link').relList.supports('modulepreload')}catch(e){}` +
        `for(var k in V){if(!V[k].a&&new RegExp(V[k].m).test(p)){var f=V[k].f;for(var i=0;i<f.length;i++){var l=d.createElement('link'),css=/\\.css$/.test(f[i]);` +
        `if(css){l.rel='preload';l.as='style'}else if(mp){l.rel='modulepreload'}else{l.rel='preload';l.as='script'}l.crossOrigin='';l.href=f[i];d.head.appendChild(l)}break}}})()`
      return { html, tags: [{ tag: 'script', children: script, injectTo: 'head' }] }
    }
  }
}

export default defineConfig({
  // relative asset paths so the build works from any sub-path or inside a native WebView (Capacitor etc.)
  base: './',
  plugins: [vue(), adminRedirect, viewChunks],
  resolve: {
    alias: { '@': abs('./src') }
  },
  server: {
    host: true,
    port: 5173,
    // 开发时把 /api 和 /media（素材文件）转发到本地接口服务（node server/index.mjs），前端代码里不写死域名
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/media': { target: API_TARGET, changeOrigin: true }
    }
  },
  preview: { host: true, port: 4173 },
  build: {
    target: ['es2020', ...BROWSERS],
    // CSS is lowered for the same engines (e.g. `inset`, which iOS 14.0–14.4 lacks)
    cssTarget: BROWSERS,
    rolldownOptions: {
      // 两个入口：移动端应用 index.html 与管理后台 admin.html（src/admin），两边互不引用对方的代码
      input: { main: abs('./index.html'), admin: abs('./admin.html') },
      output: {
        // framework, data layer and shared UI each get one long-cacheable chunk; pages are split by the router
        codeSplitting: {
          // 分组按 priority 从高到低认领模块，并会顺带认领它们依赖的模块：
          // 所以共享的 vendor / http 必须排在 admin-kit 前面，否则 vue 会被拉进 admin-kit，移动端也得加载它
          groups: [
            // vue / vue-router 等两边共用；pinia（及其依赖 nostics）只有移动端用，单独成块，后台不下载它。
            // vendor 必须比 pinia 先认领，否则 vue 会作为 pinia 的依赖被拉进 pinia 块
            { name: 'vendor', test: /[\\/]node_modules[\\/](?!pinia[\\/]|nostics[\\/])/, priority: 40 },
            { name: 'pinia', test: /[\\/]node_modules[\\/](pinia|nostics)[\\/]/, priority: 35 },
            // 两个入口都要用的小模块：http.js、SFC 导出辅助函数、动态 import 的预加载辅助函数。
            // 单独成块，免得后台为了它们去加载 data 块，或者移动端反过来加载 admin-kit
            { name: 'shared', test: /[\\/]src[\\/]api[\\/]http\.js$|plugin-vue:export-helper|vite\/preload-helper/, priority: 25 },
            // 数据层（src/api）。演示数据（api/mock-fallback.js、src/mock/）不进来：线上（VITE_API_MODE=http）根本不打包它们，
            // 开发 / auto 模式下它们是单独的懒加载块，接口连不上时才下载
            { name: 'data', test: /[\\/]src[\\/]api[\\/](?!mock-fallback\.js$)/, priority: 20 },
            // 管理后台的组件库 / 组合函数单独成块，只有 admin.html 会加载
            { name: 'admin-kit', test: /[\\/]src[\\/]admin[\\/](components|composables)[\\/]/, priority: 15 },
            // 首屏公共包：只收入口（main.js → App.vue / 首页 / 桌面外壳）静态引用得到的公共组件（$initial）。
            // 只有个别页面用的大组件（播放器、短视频条目、看大图、帖子卡片、创作者头部……）跟着自己的页面块走，
            // 几个页面共用的进下面的 kit；它们都在空闲时预取，直接打开深链时由 index.html 提前下载（见上面 viewChunks）
            { name: 'common', test: /[\\/]src[\\/](components|composables|directives|icons)[\\/]/, tags: ['$initial'], priority: 10 },
            // 两个以上页面共用、又不在首屏里的模块（看大图、帖子卡片、数字滚动、点赞特效、关注按钮、续播进度……）合成一块 kit：
            // 打包器默认会按「哪几个页面用」拆成好几个小文件，慢网（Fast 3G，一来一回 560ms）下直接打开社区 / 创作者 / 搜索
            // 要多等一两轮请求（实测首屏晚约 0.2 秒）；合成一块后每个页面只多一个 JS + 一个 CSS。
            // 只按组件本身挑，样式跟着组件走（样式模块本身大小算 0，单独认领会把别的组件的样式拉进来）
            { name: 'kit', test: /[\\/]src[\\/](components|composables|directives|utils|stores)[\\/][^?]*$/, minShareCount: 2, priority: 5 }
          ]
        }
      }
    }
  }
})
