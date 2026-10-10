<script setup>
import { ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import ABtn from '../components/ABtn.vue'
import AModal from '../components/AModal.vue'
import FormField from '../components/FormField.vue'
import TextInput from '../components/TextInput.vue'
import TextArea from '../components/TextArea.vue'
import NumberInput from '../components/NumberInput.vue'
import SelectInput from '../components/SelectInput.vue'
import SwitchInput from '../components/SwitchInput.vue'
import DateTimeInput from '../components/DateTimeInput.vue'
import TagsInput from '../components/TagsInput.vue'
import UrlListInput from '../components/UrlListInput.vue'
import MediaUrlInput from '../components/MediaUrlInput.vue'
import VideoPicker from '../components/VideoPicker.vue'
import MediaPicker from '../components/MediaPicker.vue'
import StatusBadge from '../components/StatusBadge.vue'
import Thumb from '../components/Thumb.vue'
import EmptyState from '../components/EmptyState.vue'
import { confirmDialog } from '../components/confirm'
import { toast } from '../components/toast'
import { useMeta } from '../composables/useMeta'
import { probeVideo } from '../utils/probe'
import { parseDelimited, toCSV, decodeFile } from '../utils/csv'

defineOptions({ name: 'KitPage' })

/*
 * 组件示例（只在开发环境注册路由：admin.html#/_kit，打包时不会包含）。
 * 写新页面前可以在这里看看各个控件的样子和 v-model 的值。
 */
const { topicOptions, creatorOptions, statusOptions } = useMeta()
const big = Array.from({ length: 5000 }, (_, i) => ({ value: i + 1, label: `选项 ${i + 1} 号` }))

const v = ref({
  status: null,
  topicId: null,
  big: null,
  creatorId: null,
  tags: ['#日落'],
  postTags: [],
  num: 12,
  ts: Math.floor(Date.now() / 1000),
  on: false,
  text: '',
  title: '',
  cover: null,
  video: null,
  images: []
})
const modal = ref(false)
const vp = ref(false)
const mp = ref(false)
const picked = ref(null)
const probeUrl = ref('')
const probeOut = ref('')
const probeImg = ref('')

async function ask() {
  const ok = await confirmDialog({ title: '确认示例', message: '第一行\n第二行', danger: true, confirmText: '删除' })
  toast(ok ? '点了确定' : '点了取消', { type: ok ? 'ok' : 'info' })
}
async function probe() {
  probeOut.value = '读取中…'
  try {
    const r = await probeVideo(probeUrl.value)
    probeOut.value = JSON.stringify({ durationSec: r.durationSec, blob: r.blob ? r.blob.size : null })
    if (r.blob) probeImg.value = URL.createObjectURL(r.blob)
  } catch (e) {
    probeOut.value = '错误：' + e.message
  }
}
/* CSV 往返自检：结果放在 window 上给自动化测试读 */
function csvSelfTest() {
  const rows = [['=1+1', '-5', '@a', 'a,"b"\nc', '+86 10', ' 空格 ']]
  const csv = toCSV(['公式', '负数', '艾特', '引号换行', '加号', '空格'], rows)
  const back = parseDelimited(csv)
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x61]) // 「中文,a」的 GBK 编码
  const tsv = parseDelimited('标题\t标签\n"a\tb"\tc\n\n\t\n', { delimiter: 'auto' })
  window.__csv = { csv, back, gbk: decodeFile(gbk.buffer), tsv }
  toast('CSV 自检完成')
}
</script>

<template>
  <div>
    <PageHeader title="组件示例" subtitle="仅开发环境可见">
      <template #actions>
        <ABtn @click="toast('普通提示')">提示</ABtn>
        <ABtn @click="toast('出错了', { type: 'error' })">错误提示</ABtn>
        <ABtn variant="danger" @click="ask">确认框</ABtn>
        <ABtn variant="ghost" @click="modal = true">对话框</ABtn>
        <ABtn variant="primary" icon="plus" loading>加载中</ABtn>
      </template>
    </PageHeader>
    <div class="page-body kit">
      <section class="card card-bd form-grid">
        <FormField label="状态（可清空）" field="status">
          <SelectInput id="k-status" v-model="v.status" :options="statusOptions" clearable placeholder="全部状态" />
        </FormField>
        <FormField label="专题（可搜索）" field="topicId">
          <SelectInput id="k-topic" v-model="v.topicId" :options="topicOptions" searchable clearable placeholder="选择专题" />
        </FormField>
        <FormField label="5000 个选项" field="big">
          <SelectInput id="k-big" v-model="v.big" :options="big" searchable placeholder="搜索" />
        </FormField>
        <FormField label="创作者" field="creatorId">
          <SelectInput id="k-creator" v-model="v.creatorId" :options="creatorOptions" searchable clearable />
        </FormField>
        <FormField label="视频标签（带 #）" field="tags">
          <TagsInput id="k-tags" v-model="v.tags" hash />
        </FormField>
        <FormField label="帖子标签" field="postTags">
          <TagsInput id="k-ptags" v-model="v.postTags" />
        </FormField>
        <FormField label="数字" field="num" hint="1 ~ 100">
          <NumberInput id="k-num" v-model="v.num" :min="1" :max="100" suffix="个" />
        </FormField>
        <FormField label="时间" field="ts">
          <DateTimeInput id="k-ts" v-model="v.ts" clearable />
        </FormField>
        <FormField label="标题" field="title" required error="示例错误信息">
          <TextInput v-model="v.title" :maxlength="20" show-count />
        </FormField>
        <FormField label="开关" field="on" inline hint="说明文字">
          <SwitchInput id="k-on" v-model="v.on" />
        </FormField>
        <FormField class="full" label="正文" field="text">
          <TextArea v-model="v.text" :maxlength="200" show-count />
        </FormField>
        <FormField class="full" label="封面" field="cover">
          <MediaUrlInput id="k-cover" v-model="v.cover" kind="image" />
        </FormField>
        <FormField class="full" label="播放地址" field="video">
          <MediaUrlInput id="k-video" v-model="v.video" kind="video" />
        </FormField>
        <FormField class="full" label="配图" field="images">
          <UrlListInput v-model="v.images" :max="4" />
        </FormField>
      </section>

      <section class="card card-bd row wrap">
        <ABtn icon="video" @click="vp = true">选视频</ABtn>
        <ABtn icon="folder" @click="mp = true">素材库</ABtn>
        <ABtn id="k-csv" @click="csvSelfTest">CSV 自检</ABtn>
        <StatusBadge :status="1" /><StatusBadge :status="0" /><StatusBadge :status="2" /><StatusBadge kind="creator" :status="0" />
        <Thumb src="" :width="80" /><Thumb src="/media/none.jpg" :width="40" round :ratio="1" />
      </section>

      <section class="card card-bd row wrap">
        <TextInput v-model="probeUrl" class="grow" placeholder="视频地址（probeVideo 测试）" mono />
        <ABtn id="k-probe" @click="probe">读取时长 / 截图</ABtn>
        <span id="k-probe-out" class="mono">{{ probeOut }}</span>
        <img v-if="probeImg" :src="probeImg" alt="" class="probe-img">
      </section>

      <pre id="k-model" class="card card-bd mono">{{ JSON.stringify({ ...v, picked }, null, 1) }}</pre>
      <EmptyState icon="info" title="空状态" text="说明文字"><ABtn size="sm">按钮</ABtn></EmptyState>
    </div>

    <AModal v-model:open="modal" title="对话框示例">
      <FormField label="对话框里的下拉"><SelectInput v-model="v.status" :options="statusOptions" clearable /></FormField>
      <template #footer><ABtn @click="modal = false">关闭</ABtn></template>
    </AModal>
    <VideoPicker v-model:open="vp" multiple :exclude-ids="[1, 2]" @select="l => (picked = l.map(x => x.id))" />
    <MediaPicker v-model:open="mp" accept="image" @select="f => (picked = f.url)" />
  </div>
</template>

<style scoped>
.kit { display: flex; flex-direction: column; gap: 12px; }
pre { max-height: 300px; overflow: auto; white-space: pre-wrap; }
.probe-img { max-width: 200px; border-radius: 6px; }
</style>
