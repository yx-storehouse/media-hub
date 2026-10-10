<script setup>
import { ref, shallowRef, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getStats } from '../api'
import { session } from '../auth'
import { toastError } from '../components/toast'
import PageHeader from '../components/PageHeader.vue'
import ABtn from '../components/ABtn.vue'
import AIcon from '../components/AIcon.vue'
import Thumb from '../components/Thumb.vue'
import EmptyState from '../components/EmptyState.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { fmtNum, fmtSize, fmtDuration, relTime } from '../utils/format'

defineOptions({ name: 'DashboardPage' })

/*
 * 概览：各类数据总数、待完善的数据（缺播放地址 / 封面 / 时长）、快捷入口、最近添加的视频和帖子。
 * 卡片和提示都可以点，直接跳到带好筛选条件的列表。
 */
const router = useRouter()
const stats = shallowRef(null)
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    stats.value = await getStats()
  } catch (e) {
    error.value = e.message || '加载失败'
    // 已经有数据时（点「刷新」失败）保留旧数据，只提示
    if (stats.value) toastError(e, '刷新失败')
  } finally {
    loading.value = false
  }
}
onMounted(load)

const hello = computed(() => {
  const h = new Date().getHours()
  return h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好'
})

const cards = computed(() => {
  const s = stats.value
  if (!s) return []
  return [
    { key: 'videos', label: '视频', icon: 'video', to: '/videos', value: s.videos?.total, sub: `已发布 ${fmtNum(s.videos?.published)} · 草稿 ${fmtNum(s.videos?.draft)} · 下架 ${fmtNum(s.videos?.offline)}` },
    { key: 'posts', label: '帖子', icon: 'post', to: '/posts', value: s.posts?.total, sub: `已发布 ${fmtNum(s.posts?.published)} · 热门 ${fmtNum(s.posts?.hot)}` },
    { key: 'topics', label: '专题', icon: 'topic', to: '/topics', value: s.topics?.total, sub: '专题页与片库分类' },
    { key: 'creators', label: '创作者', icon: 'creator', to: '/creators', value: s.creators?.total, sub: '视频与帖子的发布者' },
    { key: 'sections', label: '首页推荐分区', icon: 'home', to: '/sections', value: s.sections?.total, sub: '首页「推荐」里的分区' },
    { key: 'keywords', label: '搜索热词', icon: 'search', to: '/keywords', value: s.keywords?.total, sub: '搜索页的热门词' },
    { key: 'users', label: '账号', icon: 'users', to: '/users', value: s.users?.total, sub: `管理员 ${fmtNum(s.users?.admins)} 个` },
    {
      key: 'media',
      label: '素材文件',
      icon: 'folder',
      to: '/media',
      value: s.media?.files,
      sub: s.media?.dirExists === false ? '素材文件夹不存在' : `共 ${fmtSize(s.media?.bytes || 0)}`
    }
  ]
})

/* 待完善：数量为 0 的不显示 */
const todos = computed(() => {
  const v = stats.value?.videos
  if (!v) return []
  return [
    { label: '个视频没有播放地址', n: v.missingPlayback, to: { path: '/videos', query: { missing: 'playback' } }, hint: '前台无法播放，只显示封面' },
    { label: '个视频没有封面', n: v.missingCover, to: { path: '/videos', query: { missing: 'cover' } }, hint: '前台显示自动生成的占位图' },
    { label: '个视频没有时长', n: v.missingDuration, to: { path: '/videos', query: { missing: 'duration' } }, hint: '可在视频列表里批量「提取时长和封面」' }
  ].filter(t => t.n > 0)
})

const quick = [
  { label: '批量导入数据', icon: 'import', to: '/import', primary: true, text: 'CSV / Excel / 粘贴表格' },
  { label: '上传素材文件', icon: 'upload', to: '/media', text: '视频、封面图片' },
  { label: '新建视频', icon: 'video', to: { path: '/videos', query: { edit: 'new' } }, text: '逐条录入' },
  { label: '新建帖子', icon: 'post', to: { path: '/posts', query: { edit: 'new' } }, text: '社区内容' },
  { label: '编排首页推荐', icon: 'home', to: '/sections', text: '分区与换一批' },
  { label: '管理搜索热词', icon: 'search', to: '/keywords', text: '热门搜索' }
]

const openVideo = v => router.push({ path: '/videos', query: { edit: v.id } })
const openPost = p => router.push({ path: '/posts', query: { edit: p.id } })
</script>

<template>
  <div class="dash">
    <PageHeader :title="`${hello}，${session.user?.name || '管理员'}`" subtitle="数据概览">
      <template #actions>
        <ABtn icon="refresh" :loading="loading" @click="load">刷新</ABtn>
        <ABtn variant="primary" icon="import" to="/import">批量导入</ABtn>
      </template>
    </PageHeader>

    <div class="page-body">
      <div v-if="error && !stats" class="card">
        <EmptyState variant="error" title="概览数据加载失败" :text="error" :retrying="loading" @retry="load" />
      </div>

      <template v-else>
        <!-- 总数 -->
        <section class="cards" aria-label="数据总数">
          <template v-if="!stats">
            <div v-for="n in 8" :key="n" class="stat sk" />
          </template>
          <template v-else>
            <RouterLink v-for="c in cards" :key="c.key" :to="c.to" class="stat">
              <span class="stat-hd"><AIcon :name="c.icon" :size="15" />{{ c.label }}</span>
              <span class="stat-v num">{{ fmtNum(c.value) }}</span>
              <span class="stat-sub">{{ c.sub }}</span>
            </RouterLink>
          </template>
        </section>

        <div class="cols">
          <!-- 待完善 -->
          <section class="card">
            <h2 class="card-hd"><AIcon name="warning" :size="15" />待完善的数据</h2>
            <div class="card-bd">
              <div v-if="!stats" class="state"><span class="spinner" /></div>
              <p v-else-if="!todos.length" class="all-good"><AIcon name="check-circle" :size="16" />视频数据都很完整</p>
              <ul v-else class="todos">
                <li v-for="t in todos" :key="t.label">
                  <RouterLink :to="t.to" class="todo">
                    <b class="num warn-text">{{ fmtNum(t.n) }}</b>
                    <span class="grow">
                      <span class="todo-l">{{ t.label }}</span>
                      <span class="todo-h">{{ t.hint }}</span>
                    </span>
                    <AIcon name="chevron-right" :size="14" />
                  </RouterLink>
                </li>
              </ul>
              <p v-if="stats?.videos?.short" class="short muted small">
                另有 <RouterLink class="link" :to="{ path: '/videos', query: { short: '1' } }">{{ fmtNum(stats.videos.short) }} 个短视频</RouterLink>
              </p>
            </div>
          </section>

          <!-- 快捷操作 -->
          <section class="card">
            <h2 class="card-hd"><AIcon name="sparkle" :size="15" />快捷操作</h2>
            <div class="card-bd quick">
              <RouterLink v-for="q in quick" :key="q.label" :to="q.to" class="q" :class="{ primary: q.primary }">
                <AIcon :name="q.icon" :size="18" />
                <span class="q-t">{{ q.label }}</span>
                <span class="q-s">{{ q.text }}</span>
              </RouterLink>
            </div>
          </section>
        </div>

        <div class="cols">
          <!-- 最近视频 -->
          <section class="card">
            <h2 class="card-hd">
              <AIcon name="video" :size="15" />最近添加的视频
              <RouterLink class="more" :to="{ path: '/videos', query: { sort: 'id', order: 'desc' } }">全部<AIcon name="chevron-right" :size="13" /></RouterLink>
            </h2>
            <div v-if="!stats" class="state"><span class="spinner" /></div>
            <p v-else-if="!stats.recentVideos?.length" class="state">还没有视频</p>
            <ul v-else class="recent">
              <li v-for="v in stats.recentVideos" :key="v.id">
                <button type="button" class="rv" @click="openVideo(v)">
                  <Thumb :src="v.coverUrl || ''" :width="72" />
                  <span class="grow rv-txt">
                    <span class="rv-t ellipsis">{{ v.title }}</span>
                    <span class="rv-s ellipsis">
                      <span class="mono">{{ v.publicId }}</span>
                      <template v-if="v.topicName"> · {{ v.topicName }}</template>
                      · {{ fmtDuration(v.durationSec) }}
                    </span>
                  </span>
                  <span class="rv-r">
                    <StatusBadge :status="v.status" />
                    <span class="dim small">{{ relTime(v.createdAt) }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </section>

          <!-- 最近帖子 -->
          <section class="card">
            <h2 class="card-hd">
              <AIcon name="post" :size="15" />最近的帖子
              <RouterLink class="more" to="/posts">全部<AIcon name="chevron-right" :size="13" /></RouterLink>
            </h2>
            <div v-if="!stats" class="state"><span class="spinner" /></div>
            <p v-else-if="!stats.recentPosts?.length" class="state">还没有帖子</p>
            <ul v-else class="recent">
              <li v-for="p in stats.recentPosts" :key="p.id">
                <button type="button" class="rv" @click="openPost(p)">
                  <span class="grow rv-txt">
                    <span class="rv-t clamp-2">{{ p.text }}</span>
                    <span class="rv-s ellipsis">{{ p.creatorName || '—' }}<template v-if="p.creatorHandle"> @{{ p.creatorHandle }}</template></span>
                  </span>
                  <span class="rv-r">
                    <StatusBadge :status="p.status" />
                    <span class="dim small">{{ relTime(p.publishedAt || p.createdAt) }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </section>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 1100px) {
  .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 520px) {
  .cards { grid-template-columns: minmax(0, 1fr); }
}
.stat { display: flex; flex-direction: column; gap: 4px; min-height: 104px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); transition: border-color .12s, background .12s; }
a.stat:hover { border-color: var(--line-2); background: #151515; }
.stat-hd { display: flex; align-items: center; gap: 7px; color: var(--t2); font-size: 12.5px; }
.stat-v { font-size: 26px; font-weight: 650; line-height: 1.25; letter-spacing: -.01em; }
.stat-sub { color: var(--t3); font-size: 12px; }
.stat.sk { background: linear-gradient(90deg, #121212, #181818, #121212); background-size: 200% 100%; animation: sk 1.2s linear infinite; }
@keyframes sk { to { background-position: -200% 0; } }

.cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
@media (max-width: 1100px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
}
.card-hd { font-size: 13.5px; }
.card-hd .more { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; color: var(--t2); font-size: 12.5px; font-weight: 400; }
.card-hd .more:hover { color: var(--t1); }
.card .state { padding: 28px 16px; }

.all-good { display: flex; align-items: center; gap: 8px; padding: 6px 0; color: var(--ok); }
.todos { display: flex; flex-direction: column; gap: 6px; }
.todo { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 7px; color: var(--t2); }
.todo:hover { border-color: var(--line-2); background: #161616; color: var(--t1); }
.todo b { min-width: 44px; font-size: 18px; }
.todo-l { display: block; color: var(--t1); }
.todo-h { display: block; color: var(--t3); font-size: 12px; }
.short { margin-top: 12px; }

.quick { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.q { display: flex; flex-direction: column; gap: 3px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; color: var(--t2); transition: border-color .12s, background .12s; }
.q:hover { border-color: var(--line-2); background: #161616; }
.q svg { margin-bottom: 4px; color: var(--t1); }
.q-t { color: var(--t1); font-weight: 600; }
.q-s { font-size: 12px; }
.q.primary { border-color: var(--accent); background: var(--accent); color: #555; }
.q.primary svg, .q.primary .q-t { color: var(--on-accent); }
.q.primary:hover { background: #e2e2e2; }

.recent { padding: 4px 6px 6px; }
.rv { display: flex; align-items: center; gap: 12px; width: 100%; padding: 8px 10px; border-radius: 7px; text-align: left; }
.rv:hover { background: var(--hover); }
.rv-txt { display: flex; flex-direction: column; gap: 2px; }
.rv-t { color: var(--t1); font-weight: 500; }
.rv-s { color: var(--t3); font-size: 12px; }
.rv-r { display: flex; flex: none; flex-direction: column; align-items: flex-end; gap: 4px; }
</style>
