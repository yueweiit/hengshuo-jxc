<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import { useUserStore } from '@/stores/user'

const user = useUserStore()
const mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const books = ref<Record<string, any>[]>([])
async function load() { books.value = await http.get('/fin/books') }
const intent = createCommandIntent(), editIntent = createCommandIntent(), activateIntent = createCommandIntent()
const fiscalYear = ref(new Date().getFullYear())
const firstMonth = ref(1)
const busy = ref(false)
const dialog = ref(false), editing = ref<number>()
const form = reactive({ name: '', version: 0 })
function edit(row: Record<string, any>) {
  if (mockMode || !user.hasPerm('fin:book:config') || busy.value) return
  editing.value = row.id; form.name = row.name; form.version = row.version
  editIntent.reset(); dialog.value = true
}
async function save() {
  if (mockMode || !user.hasPerm('fin:book:config') || busy.value || !editing.value) return
  busy.value = true
  try {
    await http.putIdem('/fin/books/' + editing.value, { name: form.name, version: form.version }, editIntent)
    dialog.value = false; await load(); ElMessage.success('账套名称已保存')
  } finally { busy.value = false }
}
async function activate(row: Record<string, any>) {
  if (mockMode || !user.hasPerm('fin:book:config') || busy.value || row.status !== 'DRAFT') return
  const bookId = row.id, version = row.version
  busy.value = true
  try {
    await ElMessageBox.confirm('启用后可为该账套录入业务单据；本操作不录入期初、不生成期间或凭证，也不代表完成财务启用。确认已核对经营主体和本位币？', '启用账套', { type: 'warning' })
    await http.postIdem('/fin/books/' + bookId + '/activate', { version }, activateIntent)
    await load(); ElMessage.success('账套已启用，期间和财务配置仍须独立完成')
  } finally { busy.value = false }
}
async function gen(bookId: number) {
  if (busy.value || !user.hasPerm('fin:book:config')) return
  busy.value = true
  try {
  const res = await http.postIdem<{ created: number }>('/fin/periods?bookId=' + bookId, { fiscalYear: fiscalYear.value, firstMonth: firstMonth.value }, intent)
  ElMessage.success(`补齐 ${res.created} 个期间`)
  await load()
  } finally { busy.value = false }
}
onMounted(load)
</script>

<template>
  <div>
    <el-card v-for="b in books" :key="b.id" style="margin-bottom: 12px">
      <template #header><div class="book-header"><span>{{ b.name }} · 本位币 {{ b.baseCurrency }} <StatusTag :status="b.status" /></span><span v-if="!mockMode && user.hasPerm('fin:book:config')"><el-button link :disabled="busy" @click="edit(b)">修改名称</el-button><el-button v-if="b.status === 'DRAFT'" type="primary" :loading="busy" @click="activate(b)">启用账套</el-button></span></div></template>
      <p v-if="b.status === 'DRAFT'" class="muted">账套尚未启用。启用仅开放业务归属，不补填未知期初金额；会计期间、计价方法和财务启用须分别配置。</p>
      <span>会计年度 </span><el-input-number v-model="fiscalYear" :min="1900" :max="9999" :precision="0" />
      <span> 首个月份 </span><el-input-number v-model="firstMonth" :min="1" :max="12" :precision="0" />
      <el-button v-if="user.hasPerm('fin:book:config')" :loading="busy" :disabled="b.status !== 'ACTIVE'" @click="gen(b.id)">补齐至年末期间</el-button>
      <p class="muted">年中启用时，选择首个会计期间的月份；期初截止日应为该月开始的前一天。仅补齐所选月份至12月，不修改已有期间。</p>
      <el-table :data="b.periods" size="small">
        <el-table-column prop="name" label="期间" />
        <el-table-column prop="startDate" label="开始" />
        <el-table-column prop="endDate" label="结束" />
        <el-table-column label="状态"><template #default="{ row }"><StatusTag :status="row.status" domain="period" /></template></el-table-column>
      </el-table>
    </el-card>
    <el-dialog v-model="dialog" title="修改账套名称" width="480px"><el-form label-width="80px"><el-form-item label="名称"><el-input v-model="form.name" maxlength="100" /></el-form-item><p class="muted">经营主体和本位币由初始化配置确定，不能通过名称编辑修改。</p></el-form><template #footer><el-button :disabled="busy" @click="dialog = false">取消</el-button><el-button type="primary" :loading="busy" @click="save">保存</el-button></template></el-dialog>
  </div>
</template>
<style scoped>.book-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap }</style>
