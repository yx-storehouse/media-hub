# Reel — 移动端视频应用（Vue 3 + Vite）

黑白主题的移动端视频应用：首页（推荐 / 最新 / 分类）、搜索、专题、播放页、短视频、直播、社区、同城、我的。

仓库里有三部分：

- **手机端**（`index.html` + `src/`）：给用户看的应用。
- **管理后台**（`admin.html` + `src/admin/`）：桌面端网页，管理视频、帖子、专题等，支持批量导入。
- **接口服务**（`server/`）：零依赖的 Node + SQLite 后端，同时托管打包好的前端和素材文件夹 `media/`。详见 [server/README.md](server/README.md)。

## 快速开始

```bash
npm install
node server/db/seed.mjs                      # 第一次：建库 + 示例数据
node server/create-admin.mjs admin 你的密码   # 第一次：建管理员
node server/index.mjs                        # 接口服务 http://localhost:3000
npm run dev                                  # 另开一个终端：前端开发服务（/api、/media 自动转发到 3000）
```

- 手机端：`http://localhost:5173/`（局域网内手机也能直接访问）
- 管理后台：`http://localhost:5173/admin.html`

部署时只需要一个进程：`npm run build` 打包到 `dist/`，再运行 `node server/index.mjs`，
手机端是 `http://服务器:3000/`，管理后台是 `http://服务器:3000/admin`。

## Docker 部署

仓库自带 `Dockerfile` 和 `docker-compose.yml`，把整个项目目录拷到服务器（NAS）上，在目录里运行：

```bash
docker compose up -d --build
```

- 访问 `http://服务器:27381/`（手机端）和 `http://服务器:27381/admin`（管理后台）。默认用冷门端口 27381，避免和服务器上别的服务抢 3000；要换端口用环境变量：`REEL_PORT=8088 docker compose up -d`。
- 数据都在目录里的两个文件夹：`data/`（数据库 `reel.db`）、`media/`（视频、封面）。重建镜像、升级都不会丢，备份这两个文件夹即可。
- 第一次启动时 `data/` 里没有数据库，会自动建库并写入示例数据。建管理员：

  ```bash
  docker compose exec reel node server/create-admin.mjs 登录名 密码
  ```

- 容器以 uid 1000 运行，`data/`、`media/` 要让 uid 1000 可写（NAS 上一般就是第一个用户），否则用 `chown -R 1000:1000 data media`。
- 更新代码：在本机运行部署脚本，它会上传代码、先备份数据库、再重建容器并等到健康检查通过（不会碰服务器上的 `data/` 和 `media/`）：

  ```bash
  DEPLOY_HOST=root@服务器 DEPLOY_DIR=/服务器上的/reel 目录 bash scripts/deploy.sh
  ```

  需要能用 SSH 密钥免密登录服务器。也可以手动把代码拷过去覆盖，再 `docker compose up -d --build`。
- 数据库备份：每次用脚本部署前自动备份到 `data/backups/`（默认保留最近 10 份）；随时手动备份：`docker compose exec reel node server/backup-db.mjs /data/backups`。恢复时停掉容器，把备份文件改名覆盖 `data/reel.db` 再启动。
- 国内拉 npm 依赖慢时：`NPM_REGISTRY=https://registry.npmmirror.com docker compose build`。
- 没有 HTTPS，`/media/` 下的文件也不需要登录就能访问，适合内网使用；要放到公网，请在前面加一层带 HTTPS 的反向代理。

需要 Node.js 20.19+ 或 22.12+（推荐 22 LTS，见 `.nvmrc`）。

打包产物兼容 iOS 14+ 的 Safari / WKWebView、Android System WebView（Chrome）87+。

## 技术栈

| | |
|---|---|
| 框架 | Vue 3（`<script setup>` 单文件组件） |
| 构建 | Vite |
| 路由 | Vue Router（hash 模式，任何静态服务器 / App WebView 都能直接用） |
| 状态 | Pinia |
| 样式 | 原生 CSS + CSS 变量（设计令牌），组件内 scoped 样式 |

没有引入任何 UI 组件库，图标是内置的 SVG，体积很小。

## 性能设计

- **按页面拆包**：首页随入口加载，其余每个页面单独一个 JS 文件，空闲时预取，之后切换无等待。框架（`vendor`）、数据层（`data`）、公共组件（`common`）各自独立成包，可长期缓存。
- **主 Tab 常驻**：底部 6 个主页面切换时不销毁（KeepAlive），保留滚动位置和状态，切回来是瞬间的；首页每个分类 Tab 也各自保留状态。
- **图片懒加载**：封面用原生 `loading="lazy"` + 异步解码，只加载屏幕附近的图；加载前先显示生成的占位图，加载失败也不会破图。
- **后台不耗电**：短视频页切到其他 Tab 时自动暂停计时和动画。

## 目录结构

```
index.html              手机端入口 HTML
admin.html              管理后台入口 HTML（独立打包，不会进手机端的包）
vite.config.js          构建配置（@ 指向 src、目标浏览器、两个入口、拆包）
server/                 接口服务与数据库（见 server/README.md）
media/                  素材文件夹（视频、封面，运行时生成，不入库）
public/                 静态资源（favicon、PNG 应用图标、PWA manifest）
src/
  main.js               应用入口（插件、全局指令、全局错误提示）
  App.vue               根组件：路由出口 + 底部导航 + Toast
  router/               路由表
  stores/app.js         全局状态（Pinia）：上次的首页 Tab、静音、播放设置、点赞/收藏
  stores/posts.js       帖子的收藏 / 阅读数最新值：详情页和社区列表共用，返回列表时一致
  api/index.js          数据接口层：请求 server/ 的接口，连不上时读取类自动退回 mock
  mock/                 模拟数据和占位图生成（接口不可用时的演示数据）
  admin/                管理后台源码（说明见 src/admin/README.md）
  config/nav.js         首页分类 Tab、底部导航配置（含需要常驻的页面名单）
  icons/                SVG 图标数据
  components/           公共组件：Icon、Cover（图片）、VideoCard、TabBar、BottomSheet、BackHeader、AppToast、AppLogo
  composables/          组合式函数：toast、返回、分享、KeepAlive 页面的滚动位置保持
  directives/           全局指令：v-press（卡片支持键盘操作）、v-fade-in（新列表淡入一次）
  styles/               设计令牌、基础样式、公共样式
  views/                页面
    home/               首页及其「推荐 / 最新 / 分类」子页
    ShortView.vue       短视频
    SearchView.vue      搜索
    TopicView.vue       专题详情
    CommunityView.vue   社区
    PostView.vue        帖子详情
    CreatorView.vue     创作者主页（头部 / 关注在 components/creator/）
    LiveView.vue        直播
    NearbyView.vue      同城
    MeView.vue          我的
    HistoryView.vue     观看历史
    LibraryView.vue     片库
```

## 路由

| 路径 | 页面 |
|---|---|
| `#/home/:tab` | 首页（tab：`latest` `recommend` `ai` `cn` `jk` `anime` `show` `doc`） |
| `#/short` | 短视频（推荐流，见下面「短视频」） |
| `#/live` | 直播 |
| `#/community` | 社区 |
| `#/nearby` | 同城 |
| `#/me` | 我的 |
| `#/search?q=` | 搜索 |
| `#/topic/:id` | 专题详情（数字 id，与片库分类、首页分区共用一套专题表） |
| `#/post/:id` | 帖子详情（点社区卡片进来；作者栏可关注，正文、配图、关联视频、话题，底部阅读数 / 分享 / 收藏；「下一篇」替换当前记录，返回键直接回到进来之前的页面） |
| `#/creator/:id?tab=videos\|posts` | 创作者主页（社区卡片 / 帖子详情的头像和名字、搜索页的热门创作者点进来）：头图、头像、关注、粉丝 / 视频 / 帖子数，下面「视频 / 帖子」两个吸顶标签，视频可按最新 / 最热排，两个列表都滚到底自动加载；标签记在地址栏，点进视频 / 帖子再返回时列表和滚动位置原样恢复 |
| `#/video/:id` | 播放页（视频卡片点进来就是它；数据库 `videos.playback_url` 有地址时播放真实视频，没有时用封面模拟） |
| `#/history` | 观看历史 |
| `#/library` | 片库 |

不认识的地址会自动回到首页。底部导航和首页顶部分类切换时**替换**历史记录（和原生 App 一样，返回键不会在 Tab 之间来回跳），进入搜索、专题等子页面时正常压栈，返回键回到上一页。

新增底部导航页面时，在 `src/config/nav.js` 的 `MAIN_TABS` 里登记它的组件名（`view`），它才会常驻；漏登记时开发环境会在控制台提示。

## 短视频

- **推荐流**：从全部已上架视频里推荐，后台「加入短视频」的优先；每次打开 App、或者已经在短视频页时再点一次底部的「短视频」，都会换一批并回到第一条；切到别的 Tab 再回来不会变。一直往下刷不会到底（整个视频库刷完会重新洗牌接着给）。最近刷到过的 100 条记在本机，下次打开时排到后面；登录后最近看过的也会往后排。
- **进度条**：点一下跳过去；按住横着拖时屏幕中间显示「当前 / 总时长」，松手才跳，拖的时候不会翻页（从进度条上往上滑照常翻页，不跳进度）。键盘聚焦后左右方向键 ±5 秒。
- **长按快进**：按住屏幕左右两侧边缘（各约 1/5 宽）2 倍速播放，顶部显示「2X 快进中」，松手恢复原来的倍速（不改播放设置）。点一下仍是播放 / 暂停，从边缘上下滑照样翻页。
- **作者**：点左下角的名字或右侧头像进创作者主页。

## 数据与接口

所有页面只通过 `src/api/index.js` 取数据，它请求 `server/` 提供的接口（说明见 `src/api/README.md`）：

- 默认 `auto` 模式：接口连不上（断网、超时、5xx）时，读取类请求自动退回本地 mock 数据并提示一次；点赞、收藏这类写操作从不退回 mock，失败就回滚并提示。
- `.env.local` 里写 `VITE_API_MODE=http` 只用接口，写 `mock` 只用演示数据。
- 图片统一用 `{ src, fallback }` 结构：`src` 是图片地址，`fallback` 是加载前 / 加载失败时显示的占位图。
- 视频、封面上传到 `media/` 后地址是 `/media/...` 这样的站内路径，所以手机端要和接口服务同源访问（Node 直接托管 `dist/`，或者开发时走 Vite 转发）。

## 登录与账号

后端自带鉴权（`server/README.md` 有完整说明）：

```bash
node server/create-admin.mjs admin 你的密码
```

- 未登录也能正常浏览，只有点赞、收藏、关注、观看历史需要登录 —— 点这些按钮会弹出登录框，不会跳走页面。
- 登录状态存在 `localStorage`，刷新和关掉重开都还在。
- 管理员在「我的 → 账号管理」或管理后台的「账号」页里建账号、重置密码、停用账号。

## 管理后台

用管理员账号登录 `admin.html`（手机端「我的 → 管理后台」也能打开）。桌面浏览器使用，1280 宽以上效果最好。

| 页面 | 能做什么 |
|---|---|
| 概览 | 各类数据总数、待完善的数据（缺播放地址 / 封面 / 时长）、最近添加的内容 |
| 视频 / 帖子 / 专题 / 创作者 / 搜索热词 | 搜索筛选、分页排序、新建编辑、批量上架下架 / 改专题 / 加标签 / 删除、导出 CSV |
| 首页推荐 | 编排首页「推荐」的分区和每一批（换一批）的视频，可按专题 / 最热 / 最新自动生成 |
| 素材文件 | 浏览 `media/` 文件夹、拖拽批量上传、复制地址、预览；「扫描导入视频」把文件夹里的视频一次建成视频记录，并在浏览器里自动读取时长、截取封面 |
| 批量导入 | 上传 CSV / Excel（.xlsx）/ JSON，或直接粘贴 Excel 里复制的单元格；自动对应列名，预检后再导入，重复数据可跳过或更新，错误行可下载报告 |
| 账号 | 建账号、重置密码、停用、设管理员 |

常用做法：

- **批量加视频文件**：把视频放进 `media/videos/`（或在「素材文件」里拖进去上传）→「扫描导入视频」→ 勾选、统一设置专题和分类 → 导入。
- **用表格批量改数据**：在列表页「导出」→ 用 Excel 改 → 在「批量导入」里选「更新已有」导回去。导出的表头就是导入模板的表头，不用手动对应。
- 每种数据都可以在「批量导入」里下载模板；中文 Excel 默认保存的 GBK 编码 CSV 也能直接导入。

## 主题与配色

设计令牌在 `src/styles/tokens.css`：

- `--accent`：强调色（当前白色）。换成别的颜色就是彩色主题。
- `--t2` 等：中性灰文字色。
- `--media`：照片滤镜。默认 `none`（照片保留原色），改成 `grayscale(1)` 就是照片也全黑白。

## 无障碍与交互细节

- 所有按钮、链接、卡片都能用键盘 Tab 聚焦，回车 / 空格触发，键盘聚焦时显示白色焦点框（鼠标和触屏不显示）。
- 底部弹层打开时焦点移入，Esc 可关闭，关闭后焦点回到原来的按钮。
- 小图标按钮扩大了可点击区域，视觉上不变。
- 分享在手机上调用系统分享面板，其他环境复制链接。

## 打包成 iOS / Android App

项目已经适配了刘海屏安全区、`viewport-fit=cover`、hash 路由和相对路径（`base: './'`），可以直接用 [Capacitor](https://capacitorjs.com/) 包成原生 App：

```bash
npm install @capacitor/core @capacitor/cli
npx cap init Reel com.example.reel --web-dir dist
npm run build
npx cap add android   # 或 ios
npx cap open android
```

原生 App 的启动图和图标需要用 Capacitor 的工具单独生成（`public/` 里的 PNG 图标用于网页添加到主屏幕）。

## 说明

- 文案、封面都是占位内容：封面来自 picsum.photos 免费图库（按 id 固定），加载失败时显示代码生成的占位图。
- 桌面浏览器里会显示为居中的手机宽度栏（最大 480px），手机上全屏。
- `模板/`（参考截图）不属于应用源码，已在 `.gitignore` 中排除，可以移走或删除。
