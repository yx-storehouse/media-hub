# Reel 管理后台（src/admin）

桌面端的内容管理后台，独立入口 `admin.html`，hash 路由（`admin.html#/videos`）。和移动端应用（`src/main.js`）互不引用：
后台不加载应用的页面、组件、样式和演示数据，只共用 `src/api/http.js`。

- 开发：`npm run dev` 后打开 `http://localhost:5173/admin.html`（或 `/admin`）。Vite 会把 `/api` 和 `/media` 转发到接口服务。
- 打包：`npm run build` 生成 `dist/admin.html`；`node server/index.mjs` 托管 dist 时访问 `http://<服务器>:3000/admin`。
- 只有管理员账号能登录。第一次部署：`node server/create-admin.mjs <登录名> <密码>`。
- 组件示例：开发环境打开 `admin.html#/_kit`（`pages/_KitPage.vue`，只在 `import.meta.env.DEV` 时注册路由，打包时不包含），可以看到所有控件和 v-model 的值。
- 接口说明见 `server/README.md`「管理后台接口」。

```
src/admin/
  main.js / App.vue / router.js / nav.js   入口、外壳（侧边栏）、路由、导航
  api.js        每个 /api/admin/* 接口一个函数（含 XHR 上传 uploadFile）
  auth.js       登录态 session、登录守卫、401 处理（令牌存 localStorage 的 reel.admin.token）
  styles/admin.css    设计变量 + 基础样式 + 工具类
  components/   组件库（见下）
  composables/  useListPage / useEditor / useBatch / useExport / useMeta / useSchema /
                useLeaveGuard / useUploader / useVideoProbe / useReorder
  utils/        csv.js / xlsx.js（手写的 .xlsx 读取） / format.js / download.js / probe.js / roving.js
  pages/        页面；KeywordsPage.vue 是列表页的参考实现
```

## 约定

- 所有界面文字、错误提示用简体中文；注释简短，说明「为什么」。
- 只用 `<script setup>` + 纯 JS + scoped CSS（用 admin.css 里的变量），不加任何 npm 依赖。
- 时间一律是 **unix 秒**；接口字段是 camelCase（账号接口例外，沿用原来的下划线字段）。
- 不用浏览器的 `alert / confirm / prompt`：确认用 `confirmDialog`，提示用 `toast`。
- 接口错误：`toastError(e)`（会忽略被取消的请求）。带 `e.field` 的错误要显示到对应表单项下（`useEditor` 已处理）。
- 状态要全：加载中、空、出错（带「重试」）、请求进行中按钮禁用（防重复提交）。
- 浏览器存储（localStorage）一律包在 try/catch 里。
- 列表一律服务端分页；地址栏保存筛选条件（`useListPage`）；`?edit=<id>` / `?edit=new` 打开编辑抽屉（`useEditor`）。

### 界面统一写法

- 页头主按钮「新建<实体>」（新建视频 / 新建帖子 / 新建专题 / 新建创作者 / 新建热词 / 新建账号 / 新建分区）；
  抽屉底部主按钮新建时「创建」、编辑时「保存」；批量状态操作叫「上架 / 下架 / 设为草稿 / 删除」。
- 「在前台查看」= 打开移动端里的这一条（新标签页，带 `external` 图标）；「打开前台」只用于侧边栏；原始文件用「在新标签页打开」。
  后台内部的路由跳转不用 `external` 图标（用 `chevron-right` 或该实体的图标）。
- 筛选栏的重置链接、空状态里的按钮都叫「清除筛选」。
- 排序只靠表头（`DataTable` 的 sortable 列），不再另放排序下拉 / 升降序按钮。每个列表第一列是浅色、可排序的 ID（宽约 64）。
  导入 / 扫描结果里的链接跳到 `#/videos?sort=id&order=desc`（其他类型同理）。
- 表格里的日期用 `fmtShortDate`（今年「10-10 14:03」，其他年份「2025-12-31」），完整时间放 `title`：
  `<span :title="fmtDate(v)">{{ fmtShortDate(v) }}</span>`。
- 表格要放得进 1280×800（内容区约 1010px）：列宽合计别超出，关键列不能被吸在右边的操作列盖住。
- 字数计数只用 `TextInput` / `TextArea` 的 `show-count`（「1,234 / 5,000」），不要自己写计数。
- 单选按钮组、标签页：用 `utils/roving.js`（方向键 + 只有一项可 Tab 进入）。
- 加载失败 / 空：一律用 `EmptyState`（失败用 `variant="error"`，自带「重试」），放在页面的卡片 / 表格里。
- 筛选栏 `.filters` 里的输入框、下拉一律 32px 高，和搜索框对齐（写了 `size="sm"` 也会被拉成 32px）；
  没有可见标签的下拉 `SelectInput` 会用 placeholder 当无障碍名称，也可以写 `aria-label`。
- 离开确认用 `useLeaveGuard`；上传用 `useUploader`；读视频时长 + 截封面用 `useVideoProbe`；调整顺序用 `useReorder`；
  批量改一个字段的对话框用 `components/BatchValueModal.vue`。不要在页面里再各写一份。

### 设计变量（admin.css）

`--bg --panel --panel-2 --hover --line --line-2`（由深到浅的底色和分隔线）、`--t1 --t2 --t3`（文字主 / 次 / 弱）、
`--accent --on-accent`（白底黑字的主按钮）、`--danger --warn --ok`（只用在徽标、校验和结果计数上）、`--radius`、`--font`、`--mono`。

常用工具类：`.list-page`（列表页骨架）、`.table-area`、`.filters`（筛选栏，`.reset` 「清除筛选」链接，`.grow` 占位）、`.page-body`、
`.card / .card-hd / .card-bd`、`.form-grid`（两列表单，`.full` 占整行）、`.form-section`、`.kv`（只读信息 dl）、
`.muted / .dim / .small / .num / .mono / .nowrap / .ellipsis / .clamp-2 / .row / .col / .grow / .sr-only`、
`.chip`（`.solid / .outline / .ok / .warn / .danger`）、`.title-link`、`.link`、`.spinner`、`.progress > i`、`.state`、`.kbd`。
键盘焦点：所有控件（含复选框、单选框）都有 `:focus-visible` 白色焦点环；文字输入框用自己的边框光晕代替。

## 组件（components/）

| 组件 | 用法 / Props | 插槽 / 事件 |
| --- | --- | --- |
| `AIcon` | `name`（见 `icons.js`）、`size`=16、`stroke`=1.6 | — |
| `PageHeader` | `title`、`subtitle`（列表页写 `loaded ? '共 N 个' : ''`） | `#actions`，默认插槽（标题旁）；高度固定（按钮按步骤出现 / 消失时标题不跳） |
| `ABtn` | `variant`=primary/default/ghost/danger、`size`=sm/md、`icon`、`iconRight`、`loading`、`disabled`、`to`（RouterLink）、`href`、`type` | 默认插槽 = 文字；只有图标时请加 `aria-label` |
| `DataTable` | `columns`=[{ key, label, width?, minWidth?, align?, sortable?, sortKey?, firstOrder?, class? }]、`rows`、`rowKey`='id'、`loading`、`error`、`selectable`、`v-model:selected`（id 数组）、`v-model:sort`（{ key, order }）、`emptyText`、`actionsLabel`、`actionsWidth`、`rowClass` | `#cell-<key>="{ row, value }"`、`#actions="{ row }"`、`#empty`；`@row-click`、`@retry`；首次加载的骨架行每列一格，加载完列宽不跳 |
| `APager` | `v-model:page`、`v-model:page-size`、`total`、`disabled` | total 为 0（首次加载、出错、无数据）时整个不显示 |
| `BatchBar` | `count`、`busy` | 默认插槽放按钮；`@clear`。会把自己的实际高度登记给提示条（两排按钮也不会被 toast 挡住） |
| `ADrawer` | `v-model:open`、`title`、`width`=560、`dirty`、`loading`、`busy`（保存中，传 `editor.saving`：期间关不掉） | 默认（可滚动）、`#footer`、`#header`；`@save`（Ctrl/⌘+S）；ref 方法 `requestClose()`；里面有 `useUploader` 的上传没传完时，关闭会先确认 |
| `AModal` | `v-model:open`、`title`、`width`=480、`persistent`（点遮罩不关）、`closable`（false 时 Esc / × 也不关，请求进行中用）、`flush` | 默认、`#footer`、`#header` |
| `BatchValueModal` | `v-model:open`、`title`、`label`、`mode`=select/tags、`options`、`searchable`、`nullLabel`（多一个提交 null 的选项）、`hash`、`hint`、`count`、`unit`、`busy`、`placeholder`、`confirmText`='确定'、`width`=440 | `@submit(value)`：页面调批量接口，成功后把 open 关掉 |
| `confirm.js` + `ConfirmHost` | `await confirmDialog({ title, message, confirmText, cancelText, danger })` → boolean | message 支持换行 |
| `toast.js` + `ToastHost` | `toast(msg, { type: 'info'/'ok'/'error', duration })`、`toastError(e, fallback)`；`setBottomInset(key, px)` 登记贴底的固定条高度 | — |
| `FormField` | `label`、`required`、`hint`、`error`、`field`（接口字段名，用于聚焦错误）、`inline` | 默认插槽放控件；`#extra`（标签右侧） |
| `TextInput` | `v-model`、`type`、`placeholder`、`maxlength`、`showCount`（框内右侧「12 / 200」）、`mono`、`size`、`disabled`、`readonly` | `@enter`；ref 方法 `focus()` |
| `TextArea` | `v-model`、`rows`=3、`maxRows`=14、`maxlength`、`showCount`（框下右侧「1,234 / 5,000」） | 自动增高 |
| `NumberInput` | `v-model`（整数或 null）、`min`、`max`、`step`、`required`、`suffix` | ↑↓ 加减，支持 `1,200` |
| `SelectInput` | `v-model`、`options`=[{ value, label }]、`placeholder`、`clearable`、`searchable`、`size`、`popWidth`、`limit`=200、`ariaLabel` | `@change(value, option)`；值按字符串比较，null 与 '' 都算未选；列表打开时 Tab 关闭并移到下一个控件（不会跳出抽屉）；没有 label 时用 placeholder 当无障碍名称 |
| `SwitchInput` | `v-model`（bool）、`label`、`size`=sm/md、`disabled` | `@change` |
| `DateTimeInput` | `v-model`（unix 秒或 null）、`clearable`、`nowButton` | 本地时区 |
| `TagsInput` | `v-model`（字符串数组）、`hash`（视频标签带 #）、`max`=20、`maxLength`=20 | 回车 / 逗号 / 空格分词，粘贴自动拆分 |
| `UrlListInput` | `v-model`（字符串数组）、`max`=9、`uploadDir`='images'、`addText` | 每行：缩略图、上传、素材库、上下移、删除；删掉上传中的行 / 组件卸载会取消上传 |
| `MediaUrlInput` | `v-model`（字符串或 null）、`kind`=image/video、`uploadDir`（默认 covers / videos） | `@uploaded({ path, url, size, file })`；上传可取消，卸载时自动取消 |
| `Thumb` | `src`、`ratio`=16/10、`width`、`round`、`icon`、`fit` | 只加载 `http(s)://`、站内 `/…`、`blob:` 地址，其他（ftp://、C:\…）和加载失败都显示占位；被覆盖上传过的地址自动加版本号刷新 |
| `StatusBadge` | `status`、`kind`=content/creator、`label` | content：1 已发布 / 0 草稿 / 2 已下架；creator：1 正常 / 0 停用 |
| `SearchBox` | `v-model`（防抖 300ms）、`placeholder`、`width`=240、`delay`、`autoKey`（按 / 聚焦） | `@search` |
| `VideoPicker` | `v-model:open`、`multiple`、`excludeIds`、`title` | `@select([{ id, publicId, title, coverUrl, status, durationSec, topicName }])` |
| `MediaPicker` | `v-model:open`、`accept`=image/video/any、`startDir` | `@select({ path, url, entry })`；连续点文件夹只认最后一次；关闭 = 取消上传 |
| `EmptyState` | `variant`=empty/error、`icon`、`title`、`text`、`retry`=true、`retrying`、`compact` | 默认插槽放引导按钮；`variant="error"` 时自带「重试」按钮（`@retry`） |

## 组合函数（composables/）

### useListPage(fetcher, { defaults })

```js
const { query, rows, total, loading, loaded, error, selected, reload, sortModel,
        hasFilters, resetFilters, setFilter, clearSelection, params, whenLoaded, patchRow, selectedRows } =
  useListPage(listVideos, { defaults: { q: '', status: '', topicId: '', sort: 'publishedAt', order: 'desc' } })
```

- `defaults` 里的键 + `page / pageSize / sort / order` 会同步到地址栏（replace，不产生历史记录）；等于默认值的不写进地址栏。
- 直接改 `query.xxx`（如 `v-model="query.status"`）即可：筛选变了自动回到第 1 页并清空勾选；排序 / 每页条数变了回到第 1 页。
- 新请求会取消上一个；`fetcher(params, { signal })` 返回 `{ total, list }` 或数组。加载失败时 `rows`、`total` 清空、`loaded` 变回 false：页头写 `loaded ? '共 N 个' : ''`，首次加载、出错、重试中都不显示旧数字。
- `params()`：当前接口参数（导出用）。`patchRow(id, changes)`：只改当前页的一行（行内开关）。`whenLoaded()`：等当前加载结束。
- 地址栏里的其他参数（比如 `edit`）保留不动，变化时不触发请求。

### useEditor(opts) → reactive

`blank / fromRow / findRow / fetchRow / create / update / toBody / validate / onSaved / whenReady / fieldAlias`，见文件头注释。
返回 `{ open, isNew, id, row, form, errors, saving, loadingRow, dirty, openNew(preset), openEdit(rowOrId), close(), submit(), showFieldError(field, msg, { focus }) }`。

- 新建时去掉空值让服务端用默认值，编辑时只 PATCH 改动的字段。
- 字段错误（本地校验 / 服务端 `field`）显示在 `<FormField field="…">` 下；校验失败时只聚焦并提示表单里最靠前的那个；
  该字段一改就清掉错误（服务端字段名和表单键不同时写 `fieldAlias: { durationSec: 'durationText' }`）。
- 保存进行中：`<ADrawer :busy="editor.saving">` 关不掉；万一期间换了一条（浏览器后退 / 深链），旧结果只提示 + 刷新列表，不动新打开的表单。
- 有未保存的修改时：关抽屉（ADrawer 负责）、点侧边栏离开页面都会先确认，刷新 / 关标签页由浏览器提示（内部用 `useLeaveGuard`）。

### useLeaveGuard(isDirty, { title, message, confirmText }) → { bypass() }

有未保存的修改时拦住离开：去别的路由先 `confirmDialog`（默认「放弃修改？」/「离开」），刷新、关标签页由浏览器提示（只在 dirty 时挂 beforeunload）。
`isDirty` 可以是 ref / computed / getter。保存成功后马上要程序跳转：`bypass(); router.push(…)`（只放行下一次离开）。
同一路由内只改查询参数不会触发；要在换筛选前确认，页面自己在改 query 前判断。

```js
const { bypass } = useLeaveGuard(() => order.dirty, { message: '调整后的顺序还没有保存，确定离开？' })
```

### useUploader() → reactive

上传到素材目录：带进度、可取消；组件卸载（关抽屉、关对话框、离开页面）时自动取消没传完的。页面里要自己做上传时也用它，不要直接调 `api.uploadFile`。

```js
const up = useUploader()
try {
  const { path, url, size } = await up.upload('covers/a.jpg', file, { overwrite: false, key: row.k, onProgress: p => … })
} catch (e) {
  if (up.isCancel(e)) { if (!up.disposed) toast('已取消上传') } else toastError(e, '上传失败')
}
// up.busy / up.count / up.percent（最近发起的那个，0-100，没有上传时 null）/ up.cancel(key?)（不传 = 全部取消）
```

同一个 `key` 再次上传会先取消上一个。在 `ADrawer` 里时，有上传进行中关抽屉会先确认（`UPLOAD_GUARD`）。

### useVideoProbe() → reactive

「读时长 + 截封面」的唯一实现（视频表单「从视频读取」、视频列表批量「提取时长和封面」、扫描导入后的自动提取都用它）。组件卸载时自动停止。
一个实例同一时间只做一件事：新的 `read()` / `runAll()` 会先停掉上一个。

```js
const vp = useVideoProbe()
// ① 表单里读取（不保存）：新的一次 read / cancel / 卸载 / isCurrent() 为 false 之后旧结果作废（reject AbortError，不再上传截图）
const { durationSec, coverUrl, coverNote } = await vp.read(url, { cover: true, coverPath: 'covers/v12.jpg', overwrite: false, isCurrent: () => editor.open && editor.id === 12 })
// ② 处理一个已保存的视频：读时长 → 截一帧上传为 covers/v<id>.jpg（覆盖）→ PATCH { durationSec, coverUrl }
const { state, msg, patch } = await vp.apply(video, { overwriteCover: false, onlyDuration: false })   // state: ok | skip | fail
// ③ 批量，一次一个：list 是视频对象 { id, title, playbackUrl, coverUrl } 或 id（会先 getVideo）
const { ok, fail, skip, stopped } = await vp.runAll(list, { overwriteCover, onlyDuration, onItem: (entry, result) => …, onProgress: p => … })
vp.cancel()   // 停止：正在读的立即放弃，已处理的不回滚；没轮到的不回调 onItem
// vp.running、vp.progress = { total, done, ok, fail, skip, current }
```

已有封面且没勾 `overwriteCover` 时只更新时长；覆盖上传后 `api.mediaVersions` 会登记，后台里的 `Thumb` 自动加载新图。

### useReorder(source, { key = 'id', axis = 'y', onReset }) → reactive

调整顺序（专题列表、首页分区列表、分区里每一批的视频）：上移 / 下移 + HTML5 拖动，本地调好再由页面提交。

```js
const r = useReorder(() => rows.value, { onReset: had => had && toast('列表已变化，未保存的排序已还原') })
// r.list（当前顺序）/ r.dirty / r.move(from, to) / r.moveBy(rowOrKey, ±1) / r.indexOf(rowOrKey) / r.keys() / r.reset()
// 原列表成员变了（删了一行、换了页）：未保存的顺序自动作废并调用 onReset(有没有未保存的改动)
// 拖动：把手 draggable="true" @dragstart="r.drag.start(i, $event)" @dragend="r.drag.end"
//       每项 @dragover="r.drag.over($event, i)" @drop="r.drag.drop" :class="r.drag.itemClass(i)"；容器 @dragleave="r.drag.leave"
//       表格：容器上 @dragover="r.drag.over" @drop="r.drag.drop"（按鼠标下的 <tr> 算落点），rowClass: row => r.drag.itemClass(r.indexOf(row))
```

数据由调用方自己管、只要拖动交互时用 `useDragSort({ axis, onMove(from, to) })`（返回 `{ dragIndex, dropAt, dragging, start, over, drop, end, leave, itemClass }`）。
`itemClass(i)` → `{ dragging, 'drop-before', 'drop-after' }`，样式由页面写。

### 其他

- `useBatch(batchFn, { selected, reload, clearSelection })` → `{ busy, run(action, value, { confirm, done, keepSelection }) }`
- `useExport(type, () => params())` → `{ busy, run() }`，导出 `<类型名>-YYYYMMDD-HHmm.csv`，表头 = 字段中文名（可直接再导入）。也可直接用 `exportToCSV(type, query)`。
- `useMeta()` → `meta`、`topicOptions / creatorOptions / categoryOptions / regionOptions / qualityOptions / statusOptions / postKindOptions / topicKindOptions / enableOptions`、
  `labelOf(listName, value)`、`refreshMeta()`（改了专题 / 创作者后调用）。加载失败时 App 顶部出现带「重试」的提示条（`metaStatus`），
  之后再调用 `useMeta()` 也会自动重试（间隔至少 5 秒）。
- `useSchema()` → `schema`、`loadSchema()`、`fieldsOf(type)`、`labelOf(type, key)`。

## 工具（utils/）

- `csv.js`：`parseDelimited(text, { delimiter: 'auto' })` → `{ headers, rows }`（RFC 4180）；`toCSV(headers, rows)`（BOM + CRLF + 公式注入防护）；`decodeFile(buffer)`（UTF-8 → GB18030，认 UTF-16 BOM）。
- `xlsx.js`：手写的 .xlsx 读取（批量导入用，不依赖第三方库）。
- `format.js`：`fmtDate / fmtShortDate / fmtDay / fmtDuration / parseDuration / fmtSize / fmtCount / fmtNum / relTime / fileStamp`。
- `download.js`：`downloadText / downloadBlob / downloadCSV`。
- `probe.js`：`probeVideo(url, { at, maxWidth, timeout, signal })` → `{ durationSec, blob }`（浏览器里读时长、截封面；页面请用 `useVideoProbe`）。
- `roving.js`：单选组 / 标签页的键盘操作，普通 `<button>` 就能用：

```html
<div role="radiogroup" aria-label="角色" @keydown="rovingKeydown">
  <button v-for="(o, i) in OPTS" type="button" role="radio" :aria-checked="String(v === o.value)"
          :tabindex="rovingTabindex(i, OPTS.findIndex(x => x.value === v))" @click="v = o.value">{{ o.label }}</button>
</div>
```

  `rovingKeydown(e, { selector, orientation: 'both' | 'horizontal' | 'vertical', activate = true, loop = true })`：← → ↑ ↓ 移动（首尾循环）、Home / End；
  默认移到哪项就点哪项（手动激活的标签页传 `activate: false`）。`rovingTabindex(i, activeIndex)` → 0 / -1（都没选时第一项为 0）。

## 新增一个列表页

照 `pages/KeywordsPage.vue` 的 ①～⑥ 写：`useListPage` → `columns` + `DataTable` + `APager` → `useEditor` + `ADrawer` →
`useBatch` + `BatchBar` → `useExport` + 「导入」按钮（`{ path: '/import', query: { type } }`）。
外层用 `.list-page`，筛选栏 `.filters`，表格和分页包在 `.table-area` 里；BatchBar 放在 `.table-area` 后面。
