import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/* oldest engines we ship to: iOS 14 Safari / WKWebView and Android System WebView (Chrome) 87 */
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

export default defineConfig({
  // relative asset paths so the build works from any sub-path or inside a native WebView (Capacitor etc.)
  base: './',
  plugins: [vue(), adminRedirect],
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
            // 单独成块，免得后台为了它们去加载 data 块（含演示数据），或者移动端反过来加载 admin-kit
            { name: 'shared', test: /[\\/]src[\\/]api[\\/]http\.js$|plugin-vue:export-helper|vite\/preload-helper/, priority: 25 },
            { name: 'data', test: /[\\/]src[\\/](api|mock)[\\/]/, priority: 20 },
            // 管理后台的组件库 / 组合函数单独成块，只有 admin.html 会加载
            { name: 'admin-kit', test: /[\\/]src[\\/]admin[\\/](components|composables)[\\/]/, priority: 15 },
            { name: 'common', test: /[\\/]src[\\/](components|composables|directives|icons)[\\/]/, priority: 10 }
          ]
        }
      }
    }
  }
})
