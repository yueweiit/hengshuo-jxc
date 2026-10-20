<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import StatusTag from '@/components/StatusTag.vue'
import { useUserStore } from '@/stores/user'
const mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const user = useUserStore(), intent = createCommandIntent()
const rows = ref<Record<string, any>[]>([]), accounts = ref<Record<string, any>[]>([]), categories = ref<Record<string, any>[]>([]), books = ref<Record<string, any>[]>([])
const bookId = ref<number>(), resource = ref('accounts'), dialog = ref(false), saving = ref(false), editing = ref<number>()
const resources = [{ value: 'accounts', label: '会计科目' }, { value: 'cashflow-items', label: '现金流项目' }, { value: 'voucher-words', label: '凭证字' }, { value: 'category-account-maps', label: '商品分类科目映射' }]
const auxTypes = [{ value: 'customerId', label: '客户' }, { value: 'supplierId', label: '供应商 / 物流商' }, { value: 'fundAccountId', label: '资金账户' }, { value: 'productId', label: '商品' }, { value: 'warehouseId', label: '仓库' }, { value: 'storeId', label: '门店' }, { value: 'expenseItemId', label: '费用项目' }, { value: 'employeeId', label: '员工' }]
const form = reactive<Record<string, any>>({})
async function load() {
  if (!bookId.value) return
  rows.value = (await allRecords<Record<string, any>>('/fin/' + resource.value, { bookId: bookId.value }))
  accounts.value = (await allRecords<Record<string, any>>('/fin/accounts', { bookId: bookId.value }))
}
async function edit(row?: Record<string, any>) {
  Object.keys(form).forEach(k => delete form[k]); Object.assign(form, row ? JSON.parse(JSON.stringify(row)) : { code: '', name: '', category: resource.value === 'cashflow-items' ? 'OPERATING' : 'ASSET', direction: resource.value === 'cashflow-items' ? 'BOTH' : 'DEBIT', isLeaf: true, fxEnabled: false, isCash: false, isBank: false, auxTypes: [], status: 'ENABLED', numberRule: 'DATE_SEQUENCE', purpose: 'INVENTORY', reconcileType: null })
  editing.value = row?.id; intent.reset(); dialog.value = true
  if (resource.value === 'category-account-maps') categories.value = (await allRecords<Record<string, any>>('/md/categories', { }))
}
async function save() {
  saving.value = true
  try { const path = '/fin/' + resource.value + (editing.value ? '/' + editing.value : '') + '?bookId=' + bookId.value; if (editing.value) await http.putIdem(path, form, intent); else await http.postIdem(path, form, intent); dialog.value = false; await load(); ElMessage.success('配置已保存') } finally { saving.value = false }
}
onMounted(async () => { books.value = await http.get('/fin/books'); if (books.value.length === 1) bookId.value = books.value[0]!.id; await load() })
</script>
<template>
  <el-card>
    <template #header>会计科目与核算配置</template><el-alert v-if="mockMode" title="演示模式保留科目查询；核算配置使用真实服务维护。" :closable="false" />
    <el-form inline><el-form-item label="账套"><el-select v-model="bookId" placeholder="请选择账套" style="width: 260px; max-width: 100%" @change="load"><el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" /></el-select></el-form-item><el-form-item v-if="!mockMode" label="配置"><el-select v-model="resource" style="width: 200px" @change="load"><el-option v-for="r in resources" :key="r.value" :label="r.label" :value="r.value" /></el-select></el-form-item><el-button v-if="!mockMode && user.hasPerm('fin:account:edit')" :disabled="!bookId" type="primary" @click="edit()">新增</el-button></el-form>
    <el-table :data="rows" size="small">
      <el-table-column prop="code" label="编码" width="100" /><el-table-column prop="name" label="名称" /><el-table-column prop="category" label="类别" /><el-table-column prop="direction" label="方向" /><el-table-column v-if="resource === 'accounts'" label="辅助核算"><template #default="{ row }">{{ (row.auxTypes || []).map((t: string) => auxTypes.find(a => a.value === t)?.label || t).join('、') }}</template></el-table-column>
      <el-table-column v-if="resource === 'category-account-maps'" prop="categoryId" label="商品分类 ID" /><el-table-column v-if="resource === 'category-account-maps'" prop="purpose" label="用途" /><el-table-column v-if="resource === 'category-account-maps'" prop="accountId" label="科目 ID" /><el-table-column label="状态"><template #default="{ row }"><StatusTag v-if="row.status" :status="row.status" /></template></el-table-column><el-table-column v-if="!mockMode && user.hasPerm('fin:account:edit')" label="操作"><template #default="{ row }"><el-button link @click="edit(row)">编辑</el-button></template></el-table-column>
    </el-table>
    <el-dialog v-model="dialog" title="核算配置" width="650px"><el-form label-width="110px">
      <template v-if="resource !== 'category-account-maps'"><el-form-item label="编码"><el-input v-model="form.code" /></el-form-item><el-form-item label="名称"><el-input v-model="form.name" /></el-form-item><el-form-item label="状态"><el-select v-model="form.status"><el-option label="启用" value="ENABLED" /><el-option label="停用" value="DISABLED" /></el-select></el-form-item></template>
      <template v-if="resource === 'accounts'"><el-form-item label="上级科目"><el-select v-model="form.parentId" clearable><el-option v-for="a in accounts.filter(a => !a.isLeaf && a.id !== editing)" :key="a.id" :value="a.id" :label="a.code + ' ' + a.name" /></el-select></el-form-item><el-form-item label="类别"><el-select v-model="form.category"><el-option v-for="v in ['ASSET','LIABILITY','EQUITY','COST','EXPENSE','INCOME','PROFIT_LOSS']" :key="v" :value="v" :label="v" /></el-select></el-form-item><el-form-item label="余额方向"><el-select v-model="form.direction"><el-option label="借" value="DEBIT" /><el-option label="贷" value="CREDIT" /></el-select></el-form-item><el-form-item label="核算属性"><el-checkbox v-model="form.isLeaf">末级</el-checkbox><el-checkbox v-model="form.fxEnabled">外币</el-checkbox><el-checkbox v-model="form.isCash">现金</el-checkbox><el-checkbox v-model="form.isBank">银行</el-checkbox></el-form-item><el-form-item label="辅助核算"><el-select v-model="form.auxTypes" multiple><el-option v-for="a in auxTypes" :key="a.value" :value="a.value" :label="a.label" /></el-select></el-form-item><el-form-item label="核对用途"><el-select v-model="form.reconcileType" clearable><el-option v-for="v in ['AR','AP','INVENTORY','CASH']" :key="v" :value="v" :label="v" /></el-select></el-form-item></template>
      <template v-if="resource === 'cashflow-items'"><el-form-item label="类别"><el-select v-model="form.category"><el-option v-for="v in ['OPERATING','INVESTING','FINANCING']" :key="v" :value="v" :label="v" /></el-select></el-form-item><el-form-item label="方向"><el-select v-model="form.direction"><el-option label="流入" value="IN" /><el-option label="流出" value="OUT" /><el-option label="双向" value="BOTH" /></el-select></el-form-item></template>
      <template v-if="resource === 'voucher-words'"><el-alert title="凭证号按凭证字、日期和唯一序号生成" :closable="false" /><el-form-item label="编号规则"><el-input v-model="form.numberRule" readonly /></el-form-item></template>
      <template v-if="resource === 'category-account-maps'"><el-form-item label="商品分类"><el-select v-model="form.categoryId" filterable><el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" /></el-select></el-form-item><el-form-item label="用途"><el-select v-model="form.purpose"><el-option v-for="p in ['INVENTORY','REVENUE','COGS']" :key="p" :label="p" :value="p" /></el-select></el-form-item><el-form-item label="会计科目"><el-select v-model="form.accountId" filterable><el-option v-for="a in accounts.filter(a => a.isLeaf)" :key="a.id" :label="a.code + ' ' + a.name" :value="a.id" /></el-select></el-form-item></template>
    </el-form><template #footer><el-button @click="dialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template></el-dialog>
  </el-card>
</template>
