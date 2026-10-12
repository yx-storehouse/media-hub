<script setup>
import { ref, watch } from 'vue'
import { listCreators, getCreator, createCreator, updateCreator, deleteCreator, batchCreators } from '../api'
import { useListPage } from '../composables/useListPage'
import { useEditor } from '../composables/useEditor'
import { useBatch } from '../composables/useBatch'
import { useExport } from '../composables/useExport'
import { useMeta } from '../composables/useMeta'
import { confirmDialog } from '../components/confirm'
import { toast, toastError } from '../components/toast'
import PageHeader from '../components/PageHeader.vue'
import ABtn from '../components/ABtn.vue'
import AIcon from '../components/AIcon.vue'
import SearchBox from '../components/SearchBox.vue'
import SelectInput from '../components/SelectInput.vue'
import DataTable from '../components/DataTable.vue'
import APager from '../components/APager.vue'
import BatchBar from '../components/BatchBar.vue'
import ADrawer from '../components/ADrawer.vue'
import EmptyState from '../components/EmptyState.vue'
import StatusBadge from '../components/StatusBadge.vue'
import Thumb from '../components/Thumb.vue'
import FormField from '../components/FormField.vue'
import TextInput from '../components/TextInput.vue'
import TextArea from '../components/TextArea.vue'
import SwitchInput from '../components/SwitchInput.vue'
import MediaUrlInput from '../components/MediaUrlInput.vue'
import { fmtDate, fmtShortDate, fmtNum, fmtCount } from '../utils/format'

defineOptions({ name: 'CreatorsPage' })

/*
 * 创作者：列表结构同 KeywordsPage。
 * 删除会连带删掉他的帖子（外键级联），视频只是变成「无创作者」—— 删除前用行里的 postCount / videoCount 提醒。
 * 改了名字 / 账号 / 状态后刷新元数据，其他页面的「创作者」下拉框跟着变。
 */

const { enableOptions, refreshMeta } = useMeta()
const verifiedOptions = [{ value: 1, label: '已认证' }, { value: 0, label: '未认证' }]

/* ① 列表 */
const { query, rows, total, loading, loaded, error, selected, reload, sortModel, hasFilters, resetFilters, clearSelection, params, whenLoaded } =
  useListPage(listCreators, { defaults: { q: '', status: '', verified: '', sort: 'id', order: 'desc' } })

/* 见过的行（批量删除时统计跨页勾选的帖子数 / 视频数） */
const seen = new Map()
watch(rows, list => { for (const r of list) seen.set(r.id, r) }, { immediate: true })

/* ② 表格列：合计要放得进 1280×800 的内容区（约 1010px）；视频数 / 帖子数可以点，跳到他的视频 / 帖子 */
const columns = [
  { key: 'id', label: 'ID', width: 64, sortable: true, class: 'dim' },
  { key: 'avatarUrl', label: '头像', width: 60 },
  { key: 'name', label: '名称', minWidth: 200, sortable: true, firstOrder: 'asc' },
  { key: 'isOfficial', label: '官方', width: 60, align: 'center' },
  { key: 'videoCount', label: '视频数', width: 84, align: 'right', sortable: true },
  { key: 'postCount', label: '帖子数', width: 72, align: 'right' },
  { key: 'followerCount', label: '粉丝', width: 76, align: 'right', sortable: true },
  { key: 'status', label: '状态', width: 88 },
  { key: 'createdAt', label: '创建时间', width: 104 }
]

/* ③ 编辑抽屉 */
const drawer = ref(null)
const HANDLE_RE = /^[A-Za-z0-9_.-]{2,32}$/
const cleanHandle = s => String(s || '').trim().replace(/^[@＠]+/, '')
const editor = useEditor({
  blank: () => ({ name: '', handle: '', avatarUrl: null, bio: '', isVerified: false, isOfficial: false, status: 1 }),
  fromRow: r => ({
    name: r.name, handle: r.handle || '', avatarUrl: r.avatarUrl || null, bio: r.bio || '',
    isVerified: !!r.isVerified, isOfficial: !!r.isOfficial, status: r.status ?? 1
  }),
  findRow: id => rows.value.find(r => r.id === id),
  fetchRow: getCreator,
  whenReady: whenLoaded,
  create: createCreator,
  update: updateCreator,
  toBody: f => ({ ...f, name: f.name.trim(), handle: cleanHandle(f.handle), bio: f.bio.trim() }),
  validate: f => {
    const name = f.name.trim()
    const handle = cleanHandle(f.handle)
    if (!name) return { name: '请输入名称' }
    if ([...name].length > 30) return { name: '名称最多 30 个字' }
    if (handle && !HANDLE_RE.test(handle)) return { handle: '账号需为 2-32 位字母、数字或 _ . -' }
    if (!handle && !editor.isNew) return { handle: '账号不能为空（只有新建时可以留空自动生成）' }
    if ([...f.bio.trim()].length > 200) return { bio: '简介最多 200 个字' }
    return null
  },
  onSaved: () => { refreshMeta(); return reload() }
})

const impactLines = (posts, videos) => [
  posts ? `· ${posts} 条帖子会被一起删除` : '',
  videos ? `· ${videos} 个视频会变成「无创作者」（视频本身不删）` : ''
].filter(Boolean).join('\n')

async function removeOne(row, { fromDrawer = false } = {}) {
  const impact = impactLines(row.postCount, row.videoCount)
  const ok = await confirmDialog({
    title: '删除创作者',
    message: `确定删除创作者「${row.name}」？\n${impact ? impact + '\n' : ''}删除后不可恢复。`,
    confirmText: '删除',
    danger: true
  })
  if (!ok) return
  try {
    const res = await deleteCreator(row.id)
    const extra = [res?.deletedPosts ? `删除了 ${res.deletedPosts} 条帖子` : '', res?.detachedVideos ? `${res.detachedVideos} 个视频已变为无创作者` : ''].filter(Boolean).join('，')
    toast(extra ? `已删除（${extra}）` : '已删除', { type: 'ok' })
    selected.value = selected.value.filter(id => id !== row.id)
    if (fromDrawer) editor.close()
    refreshMeta()
    reload()
  } catch (e) {
    toastError(e, '删除失败')
  }
}

/* ④ 批量操作 */
let lastBatch = null
const batch = useBatch((ids, action, value) => batchCreators(ids, action, value).then(res => { lastBatch = res; return res }), {
  selected,
  reload: async () => { refreshMeta(); await reload() },
  clearSelection
})
async function batchDelete() {
  const ids = selected.value
  let posts = 0
  let videos = 0
  for (const id of ids) { posts += seen.get(id)?.postCount || 0; videos += seen.get(id)?.videoCount || 0 }
  const impact = impactLines(posts, videos)
  lastBatch = null
  await batch.run('delete', undefined, {
    confirm: { title: '批量删除创作者', message: `确定删除选中的 ${ids.length} 个创作者？\n${impact ? impact + '\n' : ''}删除后不可恢复。`, confirmText: '删除', danger: true },
    done: '已删除'
  })
  if (lastBatch?.deletedPosts) toast(`同时删除了 ${lastBatch.deletedPosts} 条帖子`)
}

/* ⑤ 导出 */
const exporter = useExport('creators', params)

/* 在前台查看：移动端的创作者主页（已停用的创作者前台打不开，按钮置灰） */
const appLink = id => `./index.html#/creator/${id}`
</script>

<template>
  <div class="list-page">
    <PageHeader title="创作者" :subtitle="loaded ? `共 ${fmtNum(total)} 个` : ''">
      <template #actions>
        <ABtn icon="import" :to="{ path: '/import', query: { type: 'creators' } }">导入</ABtn>
        <ABtn icon="download" :loading="exporter.busy" @click="exporter.run()">导出</ABtn>
        <ABtn variant="primary" icon="plus" @click="editor.openNew()">新建创作者</ABtn>
      </template>
    </PageHeader>

    <div class="filters">
      <SearchBox v-model="query.q" placeholder="搜索名称 / 账号 / ID" />
      <label class="sr-only" for="cf-status">状态</label>
      <SelectInput id="cf-status" v-model="query.status" class="f-sel" :options="enableOptions" placeholder="全部状态" clearable />
      <label class="sr-only" for="cf-verified">认证</label>
      <SelectInput id="cf-verified" v-model="query.verified" class="f-sel" :options="verifiedOptions" placeholder="是否认证" clearable />
      <button v-if="hasFilters" type="button" class="reset" @click="resetFilters">清除筛选</button>
    </div>

    <div class="table-area">
      <DataTable
        v-model:selected="selected"
        v-model:sort="sortModel"
        :columns="columns"
        :rows="rows"
        :loading="loading"
        :error="error"
        selectable
        :actions-width="124"
        @retry="reload"
      >
        <template #cell-id="{ value }"><span class="dim num">{{ value }}</span></template>
        <template #cell-avatarUrl="{ row }">
          <Thumb :src="row.avatarUrl || ''" :width="32" :ratio="1" round icon="user" />
        </template>
        <template #cell-name="{ row }">
          <div class="name">
            <span class="nm">
              <button type="button" class="title-link" @click="editor.openEdit(row)">{{ row.name }}</button>
              <span v-if="row.isVerified" class="vf" title="已认证"><AIcon name="verified" :size="14" /><span class="sr-only">已认证</span></span>
            </span>
            <span class="dim small">@{{ row.handle }}</span>
          </div>
        </template>
        <template #cell-isOfficial="{ value }">
          <span v-if="value" class="chip solid">官方</span>
          <span v-else class="dim">—</span>
        </template>
        <template #cell-videoCount="{ row }">
          <RouterLink class="cnt-link" :class="{ dim: !row.videoCount }" :to="{ path: '/videos', query: { creatorId: row.id } }" :aria-label="`查看「${row.name}」的视频（${row.videoCount} 个）`" title="查看他的视频">{{ fmtNum(row.videoCount) }}</RouterLink>
        </template>
        <template #cell-postCount="{ row }">
          <RouterLink class="cnt-link" :class="{ dim: !row.postCount }" :to="{ path: '/posts', query: { creatorId: row.id } }" :aria-label="`查看「${row.name}」的帖子（${row.postCount} 条）`" title="查看他的帖子">{{ fmtNum(row.postCount) }}</RouterLink>
        </template>
        <template #cell-followerCount="{ value }"><span class="muted">{{ fmtCount(value) }}</span></template>
        <template #cell-status="{ value }"><StatusBadge kind="creator" :status="value" /></template>
        <template #cell-createdAt="{ value }"><span class="muted nowrap" :title="fmtDate(value)">{{ fmtShortDate(value) }}</span></template>

        <template #actions="{ row }">
          <ABtn size="sm" variant="ghost" icon="edit" @click="editor.openEdit(row)">编辑</ABtn>
          <ABtn size="sm" variant="ghost" icon="trash" title="删除" :aria-label="`删除「${row.name}」`" @click="removeOne(row)" />
        </template>

        <template #empty>
          <EmptyState v-if="hasFilters" icon="search" title="没有匹配的创作者" text="换个关键词或筛选条件试试">
            <ABtn @click="resetFilters">清除筛选</ABtn>
          </EmptyState>
          <EmptyState v-else icon="creator" title="还没有创作者" text="视频和帖子的发布者都在这里管理">
            <ABtn variant="primary" icon="plus" @click="editor.openNew()">新建创作者</ABtn>
            <ABtn icon="import" :to="{ path: '/import', query: { type: 'creators' } }">批量导入</ABtn>
          </EmptyState>
        </template>
      </DataTable>

      <APager v-model:page="query.page" v-model:page-size="query.pageSize" :total="total" :disabled="loading" />
    </div>

    <BatchBar :count="selected.length" :busy="batch.busy" @clear="clearSelection">
      <ABtn size="sm" icon="check" :disabled="batch.busy" @click="batch.run('enable', undefined, { done: '已启用' })">启用</ABtn>
      <ABtn size="sm" icon="ban" :disabled="batch.busy" @click="batch.run('disable', undefined, { done: '已停用' })">停用</ABtn>
      <ABtn size="sm" icon="verified" :disabled="batch.busy" @click="batch.run('verify', undefined, { done: '已认证' })">认证</ABtn>
      <ABtn size="sm" :disabled="batch.busy" @click="batch.run('unverify', undefined, { done: '已取消认证' })">取消认证</ABtn>
      <ABtn size="sm" variant="danger" icon="trash" :disabled="batch.busy" @click="batchDelete">删除</ABtn>
    </BatchBar>

    <ADrawer
      ref="drawer"
      v-model:open="editor.open"
      :title="editor.isNew ? '新建创作者' : '编辑创作者'"
      :width="580"
      :dirty="editor.dirty"
      :busy="editor.saving"
      :loading="editor.loadingRow"
      @save="editor.submit()"
    >
      <!-- 预览：前台个人页头部的样子 -->
      <div class="pv" aria-hidden="true">
        <Thumb :src="editor.form.avatarUrl || ''" :width="52" :ratio="1" round icon="user" />
        <div class="pv-txt">
          <p class="pv-name">
            <span class="ellipsis">{{ editor.form.name.trim() || '创作者名称' }}</span>
            <AIcon v-if="editor.form.isVerified" class="vf" name="verified" :size="15" />
            <span v-if="editor.form.isOfficial" class="chip solid">官方</span>
          </p>
          <p class="dim small ellipsis">@{{ cleanHandle(editor.form.handle) || (editor.isNew ? '自动生成' : '') }}</p>
          <p v-if="editor.form.bio.trim()" class="muted small clamp-2">{{ editor.form.bio }}</p>
        </div>
      </div>

      <div class="form-grid">
        <FormField label="名称" field="name" required :error="editor.errors.name">
          <TextInput v-model="editor.form.name" :maxlength="30" show-count placeholder="例如：陆遥" />
        </FormField>
        <FormField label="账号" field="handle" :error="editor.errors.handle" hint="字母、数字和 _ . -，留空自动生成">
          <TextInput v-model="editor.form.handle" mono :maxlength="33" :placeholder="editor.isNew ? '留空自动生成' : ''" />
        </FormField>
        <FormField class="full" label="头像" field="avatarUrl" :error="editor.errors.avatarUrl" hint="建议正方形图片；不填时前台显示名字首字的头像">
          <MediaUrlInput v-model="editor.form.avatarUrl" kind="image" upload-dir="images" />
        </FormField>
        <FormField class="full" label="简介" field="bio" :error="editor.errors.bio">
          <TextArea v-model="editor.form.bio" :rows="2" :maxlength="200" show-count placeholder="一句话介绍（可选）" />
        </FormField>
        <FormField inline label="认证" field="isVerified" :error="editor.errors.isVerified" hint="名字后显示认证标">
          <SwitchInput v-model="editor.form.isVerified" />
        </FormField>
        <FormField inline label="官方" field="isOfficial" :error="editor.errors.isOfficial" hint="官方账号">
          <SwitchInput v-model="editor.form.isOfficial" />
        </FormField>
        <FormField label="状态" field="status" :error="editor.errors.status">
          <SelectInput v-model="editor.form.status" :options="enableOptions" />
        </FormField>
      </div>

      <template v-if="!editor.isNew && editor.row">
        <h4 class="form-section">其他信息</h4>
        <dl class="kv">
          <div><dt>ID</dt><dd>{{ editor.row.id }}</dd></div>
          <div><dt>视频</dt><dd>{{ fmtNum(editor.row.videoCount) }}</dd></div>
          <div><dt>帖子</dt><dd>{{ fmtNum(editor.row.postCount) }}</dd></div>
          <div><dt>粉丝</dt><dd>{{ fmtNum(editor.row.followerCount) }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ fmtDate(editor.row.createdAt) }}</dd></div>
        </dl>
        <div class="links">
          <ABtn size="sm" icon="video" :to="{ path: '/videos', query: { creatorId: editor.row.id } }">查看视频</ABtn>
          <ABtn size="sm" icon="post" :to="{ path: '/posts', query: { creatorId: editor.row.id } }">查看帖子</ABtn>
          <ABtn
            size="sm"
            icon="external"
            :href="appLink(editor.row.id)"
            target="_blank"
            rel="noopener"
            :disabled="editor.row.status !== 1"
            :title="editor.row.status !== 1 ? '已停用的创作者在前台不显示' : '打开移动端的创作者主页'"
          >
            在前台查看
          </ABtn>
        </div>
      </template>

      <template #footer>
        <ABtn v-if="!editor.isNew && editor.row" variant="danger" icon="trash" :disabled="editor.saving" @click="removeOne(editor.row, { fromDrawer: true })">删除</ABtn>
        <ABtn :disabled="editor.saving" @click="drawer?.requestClose()">取消</ABtn>
        <ABtn variant="primary" :loading="editor.saving" @click="editor.submit()">{{ editor.isNew ? '创建' : '保存' }}</ABtn>
      </template>
    </ADrawer>
  </div>
</template>

<style scoped>
.f-sel { width: 120px; }
.name { display: flex; flex-direction: column; min-width: 0; }
.nm { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.vf { display: inline-flex; color: var(--t1); }
.cnt-link { color: var(--t1); }
.cnt-link.dim { color: var(--t3); }
.cnt-link:hover { text-decoration: underline; text-underline-offset: 3px; }

.pv { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); }
.pv-txt { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.pv-name { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 15px; font-weight: 600; }
.links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
</style>
