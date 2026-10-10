/*
 * 元数据（专题、创作者、分类、地区、状态…的选项列表）：整个后台只请求一次，各页面共享。
 *
 *   const { meta, topicOptions, creatorOptions, statusOptions, labelOf, refreshMeta } = useMeta()
 *   <SelectInput v-model="form.topicId" :options="topicOptions" searchable clearable />
 *   labelOf('categories', 'cn') → '国产'
 *
 * 新建 / 修改 / 删除了专题或创作者之后调用 refreshMeta()，其他页面的下拉框就会同步。
 * 元数据还没回来时，状态、类型、清晰度这些固定选项先用内置的一份，筛选栏不会是空的。
 * 加载失败：提示「基础数据加载失败：…」，App.vue 顶部显示带「重试」的提示条（metaStatus）；
 * 之后再进别的页面（再次调用 useMeta()）也会自动重试，两次之间至少隔 5 秒。
 */
import { shallowRef, ref, computed } from 'vue'
import { getMeta } from '../api'
import { toast } from '../components/toast'

const FALLBACK = {
  topics: [],
  creators: [],
  categories: [],
  regions: [],
  qualities: [{ key: 'sd', label: '标清' }, { key: 'hd', label: '高清' }, { key: 'fhd', label: '超清' }],
  statuses: [{ value: 1, label: '已发布' }, { value: 0, label: '草稿' }, { value: 2, label: '已下架' }],
  postKinds: [{ value: 1, label: '视频' }, { value: 0, label: '图文' }, { value: 2, label: '文档' }],
  topicKinds: [{ value: 0, label: '普通' }, { value: 1, label: '首页分区' }, { value: 2, label: '片库分类' }],
  mediaBase: '/media/'
}

const meta = shallowRef(null)
const loading = ref(false)
const error = ref('')
let pending = null
let failedAt = 0
const RETRY_GAP = 5000

export function refreshMeta() {
  if (pending) return pending
  loading.value = true
  pending = getMeta()
    .then(m => { meta.value = { ...FALLBACK, ...m }; error.value = ''; failedAt = 0 })
    .catch(e => {
      if (e?.name === 'AbortError') return
      failedAt = Date.now()
      error.value = e?.message || '加载失败'
      // 401 会跳回登录页，不用再提示
      if (e?.status !== 401) toast('基础数据加载失败：' + error.value, { type: 'error' })
    })
    .finally(() => { loading.value = false; pending = null })
  return pending
}

/** 给 App.vue 的提示条用（只读状态，不会触发请求） */
export const metaStatus = { error, loading, loaded: computed(() => !!meta.value) }

const m = computed(() => meta.value || FALLBACK)

/* 选项都是 [{ value, label }]，直接喂给 SelectInput */
const topicOptions = computed(() => m.value.topics.map(t => ({ value: t.id, label: t.status === 1 ? t.name : `${t.name}（${t.status === 0 ? '草稿' : '已下架'}）` })))
const creatorOptions = computed(() => m.value.creators.map(c => ({ value: c.id, label: c.handle ? `${c.name} @${c.handle}` : c.name })))
const categoryOptions = computed(() => m.value.categories.map(c => ({ value: c.key, label: c.label })))
const regionOptions = computed(() => m.value.regions.map(r => ({ value: r.code, label: r.label })))
const qualityOptions = computed(() => m.value.qualities.map(q => ({ value: q.key, label: q.label })))
const statusOptions = computed(() => m.value.statuses.map(s => ({ value: s.value, label: s.label })))
const postKindOptions = computed(() => m.value.postKinds.map(s => ({ value: s.value, label: s.label })))
const topicKindOptions = computed(() => m.value.topicKinds.map(s => ({ value: s.value, label: s.label })))
/** 创作者 / 分区的启停状态 */
const enableOptions = [{ value: 1, label: '正常' }, { value: 0, label: '停用' }]

/** 各列表里条目的「值」字段名 */
const VALUE_KEY = { topics: 'id', creators: 'id', categories: 'key', regions: 'code', qualities: 'key' }
const LABEL_KEY = { topics: 'name', creators: 'name' }

/** labelOf('regions', 'cn') → '国产'；找不到返回原值（空值返回「—」） */
function labelOf(listName, value) {
  if (value === null || value === undefined || value === '') return '—'
  const list = m.value[listName] || []
  const vk = VALUE_KEY[listName] || 'value'
  const item = list.find(x => String(x[vk]) === String(value))
  return item ? item[LABEL_KEY[listName] || 'label'] : String(value)
}

export function useMeta() {
  // 还没拿到：没在请求、且距上次失败超过 5 秒就（重新）请求
  if (!meta.value && !pending && Date.now() - failedAt >= RETRY_GAP) refreshMeta()
  return {
    meta: m,
    metaLoaded: computed(() => !!meta.value),
    metaLoading: loading,
    metaError: error,
    refreshMeta,
    topicOptions,
    creatorOptions,
    categoryOptions,
    regionOptions,
    qualityOptions,
    statusOptions,
    postKindOptions,
    topicKindOptions,
    enableOptions,
    labelOf
  }
}
