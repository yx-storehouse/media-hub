<script setup>
import { ref, computed, watch } from 'vue'
import AModal from '../../components/AModal.vue'
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import { listMedia, moveMedia } from '../../api'
import { toast } from '../../components/toast'
import { fmtNum } from '../../utils/format'
import { refsText } from './files'

/*
 * 移动到另一个文件夹：在对话框里一层层点进目标文件夹，点「移到这里」。
 * 选中的文件夹自己和它里面的文件夹不能当目标（灰掉）；目标里已有同名的、本来就在目标里的，服务端跳过并说明原因。
 * 服务端会把库里引用这些文件的地址一起改掉（视频、图集、帖子、专题头图、头像），图片的小图跟着走。
 *   <MoveModal v-model:open="show" :entries="selectedEntries" :from-dir="dir" @moved="res => …" />
 *   res = { moved, failed, refs }
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /** 要移动的条目（listMedia 的 entry） */
  entries: { type: Array, default: () => [] },
  /** 它们现在所在的文件夹 */
  fromDir: { type: String, default: '' }
})
const emit = defineEmits(['update:open', 'moved'])

const browse = ref('')
const dirs = ref([])
const loading = ref(false)
const error = ref('')
const saving = ref(false)
let seq = 0
let ctrl = null

const crumbs = computed(() => {
  const parts = browse.value ? browse.value.split('/') : []
  return [{ name: 'media', path: '' }, ...parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join('/') }))]
})
const movingDirs = computed(() => props.entries.filter(e => e.type === 'dir').map(e => e.path))
/* 选中的文件夹本身和它下面的文件夹不能当目标 */
const blocked = p => movingDirs.value.some(d => p === d || p.startsWith(d + '/'))
const here = computed(() => browse.value === props.fromDir)
const canMove = computed(() => !loading.value && !error.value && !here.value && !blocked(browse.value) && props.entries.length > 0)
const label = computed(() => 'media' + (browse.value ? '/' + browse.value : ''))

async function load(d) {
  ctrl?.abort()
  ctrl = new AbortController()
  const my = ++seq
  browse.value = d
  loading.value = true
  error.value = ''
  try {
    const res = await listMedia(d, { signal: ctrl.signal })
    if (my !== seq) return
    dirs.value = (res?.entries || []).filter(e => e.type === 'dir')
  } catch (e) {
    if (my !== seq || e?.name === 'AbortError') return
    dirs.value = []
    error.value = e.message || '加载失败'
  } finally {
    if (my === seq) loading.value = false
  }
}

watch(() => props.open, v => {
  if (!v) { ctrl?.abort(); seq++; return }
  // 从上一级开始（多半是往上挪或挪到同级文件夹里）
  load(props.fromDir ? props.fromDir.split('/').slice(0, -1).join('/') : '')
})

async function submit() {
  if (!canMove.value || saving.value) return
  saving.value = true
  try {
    const res = await moveMedia(props.entries.map(e => e.path), browse.value)
    const n = res?.moved?.length || 0
    const failed = res?.failed || []
    const refs = refsText(res?.refs)
    if (n) toast(`已移动 ${fmtNum(n)} 项到「${label.value}」` + (refs ? `，${refs}里的地址已一起更新` : ''), { type: 'ok', duration: refs ? 5000 : undefined })
    if (failed.length) {
      const lines = failed.slice(0, 5).map(f => `${f.path.split('/').pop()}：${f.message}`)
      toast(`有 ${fmtNum(failed.length)} 项没有移动：\n${lines.join('\n')}${failed.length > 5 ? '\n…' : ''}`, { type: 'error', duration: 10000 })
    }
    emit('moved', res)
    emit('update:open', false)
  } catch (e) {
    // 目标文件夹刚被删了之类：留在对话框里，刷新目录
    error.value = e.message || '移动失败'
  } finally {
    saving.value = false
  }
}

const title = computed(() => {
  const n = props.entries.length
  return n === 1 ? `移动「${props.entries[0].name}」` : `移动 ${fmtNum(n)} 项`
})
</script>

<template>
  <AModal :open="open" :title="title" :width="520" flush persistent :closable="!saving" @update:open="v => emit('update:open', v)">
    <div class="mv">
      <nav class="crumbs" aria-label="目标文件夹">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <AIcon v-if="i" name="chevron-right" :size="12" class="sep" />
          <button type="button" class="crumb" :class="{ cur: i === crumbs.length - 1 }" :aria-current="i === crumbs.length - 1 ? 'location' : undefined" @click="load(c.path)">
            <AIcon v-if="!i" name="folder" :size="14" />{{ c.name }}
          </button>
        </template>
      </nav>
      <div class="body">
        <div v-if="loading && !dirs.length" class="state"><span class="spinner" /></div>
        <div v-else-if="error" class="state">
          <AIcon name="warning" :size="20" />
          <p>{{ error }}</p>
          <ABtn size="sm" icon="refresh" @click="load(browse)">重试</ABtn>
        </div>
        <p v-else-if="!dirs.length" class="state dim">这里没有子文件夹，可以直接移到这里</p>
        <ul v-else class="dirs" :class="{ busy: loading }">
          <li v-for="d in dirs" :key="d.path">
            <button type="button" class="dir" :disabled="blocked(d.path)" :title="blocked(d.path) ? '不能移到要移动的文件夹自己里面' : `打开「${d.name}」`" @click="load(d.path)">
              <AIcon name="folder" :size="16" />
              <span class="grow ellipsis">{{ d.name }}</span>
              <span class="dim small num">{{ d.items ? `${fmtNum(d.items)} 项` : '空' }}</span>
              <AIcon name="chevron-right" :size="14" />
            </button>
          </li>
        </ul>
      </div>
    </div>
    <template #footer>
      <span class="where small" :class="here || blocked(browse) ? 'warn-text' : 'muted'">
        {{ here ? '已经在这个文件夹里了' : blocked(browse) ? '不能移到要移动的文件夹自己里面' : `移到「${label}」` }}
      </span>
      <ABtn :disabled="saving" @click="emit('update:open', false)">取消</ABtn>
      <ABtn variant="primary" icon="folder-move" :loading="saving" :disabled="!canMove" @click="submit">移到这里</ABtn>
    </template>
  </AModal>
</template>

<style scoped>
.mv { display: flex; flex-direction: column; height: min(420px, calc(100vh - 220px)); }
.crumbs { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 2px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.crumb { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 6px; border-radius: 5px; color: var(--t2); }
.crumb:hover { background: var(--hover); color: var(--t1); }
.crumb.cur { color: var(--t1); font-weight: 600; }
.sep { color: var(--t3); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; }
.dirs { transition: opacity .15s; }
.dirs.busy { opacity: .5; }
.dir { display: flex; align-items: center; gap: 10px; width: 100%; height: 38px; padding: 0 10px; border-radius: 7px; color: var(--t1); text-align: left; }
.dir:hover:not(:disabled) { background: var(--hover); }
.dir:disabled { opacity: .4; cursor: not-allowed; }
.dir > svg:first-child { color: var(--t2); }
.state { padding: 36px 16px; }
.where { margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
