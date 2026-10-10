<script setup>
import { ref, computed, watch } from 'vue'
import AModal from './AModal.vue'
import ABtn from './ABtn.vue'
import AIcon from './AIcon.vue'
import Thumb from './Thumb.vue'
import SearchBox from './SearchBox.vue'
import SelectInput from './SelectInput.vue'
import StatusBadge from './StatusBadge.vue'
import { listVideos } from '../api'
import { fmtDuration } from '../utils/format'

/*
 * 选视频：
 *   <VideoPicker v-model:open="show" multiple :exclude-ids="已有的id" @select="list => …" />
 * 单选：点一行就选中并关闭；多选：勾选（翻页、换关键词都保留），点「确定」。
 * select 事件参数是数组：[{ id, publicId, title, coverUrl, status, durationSec, topicName }]
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  multiple: { type: Boolean, default: false },
  excludeIds: { type: Array, default: () => [] },
  title: { type: String, default: '' }
})
const emit = defineEmits(['update:open', 'select'])

const PAGE_SIZE = 20
const q = ref('')
const status = ref(null)
const page = ref(1)
const rows = ref([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
const picked = ref(new Map()) // id → brief
let ctrl = null

const excluded = computed(() => new Set(props.excludeIds.map(Number)))
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const statusOptions = [{ value: 1, label: '已发布' }, { value: 0, label: '草稿' }, { value: 2, label: '已下架' }]

const brief = v => ({ id: v.id, publicId: v.publicId, title: v.title, coverUrl: v.coverUrl, status: v.status, durationSec: v.durationSec, topicName: v.topicName })

async function load() {
  ctrl?.abort()
  ctrl = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const res = await listVideos({ q: q.value, status: status.value, page: page.value, pageSize: PAGE_SIZE }, { signal: ctrl.signal })
    rows.value = res?.list || []
    total.value = res?.total || 0
  } catch (e) {
    if (e.name === 'AbortError') return
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

/* 每次打开都从头开始：清空上次的关键词、筛选和勾选 */
watch(() => props.open, v => {
  if (!v) return
  picked.value = new Map()
  page.value = 1
  if (q.value || status.value !== null) { q.value = ''; status.value = null } // 交给下面的 watch 去加载
  else load()
}, { immediate: true })
watch([q, status], () => { page.value = 1; if (props.open) load() })
watch(page, () => { if (props.open) load() })

function toggle(v) {
  if (excluded.value.has(v.id)) return
  if (!props.multiple) {
    emit('select', [brief(v)])
    emit('update:open', false)
    return
  }
  const m = new Map(picked.value)
  m.has(v.id) ? m.delete(v.id) : m.set(v.id, brief(v))
  picked.value = m
}
function confirmPick() {
  emit('select', [...picked.value.values()])
  emit('update:open', false)
}
</script>

<template>
  <AModal :open="open" :title="title || (multiple ? '选择视频（可多选）' : '选择视频')" :width="720" flush @update:open="v => emit('update:open', v)">
    <div class="vp">
      <div class="bar">
        <SearchBox v-model="q" placeholder="搜索标题 / 编号 / 标签 / ID" :auto-key="false" :width="260" />
        <SelectInput v-model="status" :options="statusOptions" placeholder="全部状态" clearable size="sm" class="st" />
        <span class="grow" />
        <span class="muted small num">共 {{ total }} 条</span>
      </div>

      <div class="body">
        <div v-if="loading && !rows.length" class="state"><span class="spinner lg" /></div>
        <div v-else-if="error" class="state">
          <AIcon name="warning" :size="22" />
          <p>{{ error }}</p>
          <ABtn size="sm" icon="refresh" @click="load">重试</ABtn>
        </div>
        <div v-else-if="!rows.length" class="state">
          <AIcon name="video" :size="22" />
          <p>没有找到视频</p>
        </div>
        <ul v-else class="list" :class="{ busy: loading }" role="listbox" :aria-multiselectable="multiple || undefined">
          <li
            v-for="v in rows"
            :key="v.id"
            role="option"
            class="it"
            :class="{ on: picked.has(v.id), off: excluded.has(v.id) }"
            :aria-selected="picked.has(v.id) ? 'true' : 'false'"
            :aria-disabled="excluded.has(v.id) || undefined"
            tabindex="0"
            @click="toggle(v)"
            @keydown.enter.prevent="toggle(v)"
            @keydown.space.prevent="toggle(v)"
          >
            <input v-if="multiple" type="checkbox" :checked="picked.has(v.id)" :disabled="excluded.has(v.id)" tabindex="-1" aria-hidden="true" @click.stop="toggle(v)">
            <Thumb :src="v.coverUrl || ''" :width="88" />
            <div class="txt">
              <p class="t ellipsis">{{ v.title }}</p>
              <p class="s ellipsis">
                <span class="mono">{{ v.publicId }}</span>
                <span v-if="v.topicName"> · {{ v.topicName }}</span>
                <span> · {{ fmtDuration(v.durationSec) }}</span>
              </p>
            </div>
            <span v-if="excluded.has(v.id)" class="chip outline">已添加</span>
            <StatusBadge v-else-if="v.status !== 1" :status="v.status" />
          </li>
        </ul>
      </div>

      <div class="pg">
        <ABtn size="sm" variant="ghost" icon="chevron-left" :disabled="page <= 1 || loading" @click="page--">上一页</ABtn>
        <span class="muted small num">{{ page }} / {{ pages }}</span>
        <ABtn size="sm" variant="ghost" icon-right="chevron-right" :disabled="page >= pages || loading" @click="page++">下一页</ABtn>
      </div>
    </div>
    <template v-if="multiple" #footer>
      <span class="muted picked">已选 <b class="num">{{ picked.size }}</b> 个</span>
      <ABtn @click="emit('update:open', false)">取消</ABtn>
      <ABtn variant="primary" :disabled="!picked.size" @click="confirmPick">确定添加</ABtn>
    </template>
  </AModal>
</template>

<style scoped>
.vp { display: flex; flex-direction: column; height: min(600px, calc(100vh - 200px)); }
.bar { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.st { width: 130px; }
.body { flex: 1; min-height: 0; overflow-y: auto; }
.list { padding: 6px; transition: opacity .15s; }
.list.busy { opacity: .5; }
.it { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.it:hover { background: var(--hover); }
.it.on { background: #1f1f1f; box-shadow: inset 2px 0 0 var(--accent); }
.it.off { opacity: .45; cursor: default; }
.txt { flex: 1; min-width: 0; }
.t { color: var(--t1); font-weight: 500; }
.s { margin-top: 2px; color: var(--t3); font-size: 12px; }
.pg { display: flex; flex: none; align-items: center; justify-content: center; gap: 10px; padding: 8px; border-top: 1px solid var(--line); }
.picked { margin-right: auto; }
.picked b { color: var(--t1); }
</style>
