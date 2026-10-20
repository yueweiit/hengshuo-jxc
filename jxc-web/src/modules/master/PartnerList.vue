<script setup lang="ts">
import { computed } from 'vue'
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { useUserStore } from '@/stores/user'
import { CURRENCY_SOURCE, LOCATED_COUNTRIES, PARTNER_TYPES, STATUS_OPTIONS } from './options'

const user = useUserStore()
const canSeeBank = computed(() => user.hasPerm('md:partner:bank-view') && user.fieldAccess('BANK_INFO') !== 'HIDDEN')

const columns: ColumnDef[] = [
  { prop: 'code', label: '编码', width: 100, fixed: 'left' },
  { prop: 'name', label: '名称', minWidth: 200 },
  { prop: 'partnerType', label: '类型', type: 'option', options: PARTNER_TYPES, width: 90 },
  { prop: 'locatedCountry', label: '所在国家', type: 'option', options: LOCATED_COUNTRIES, width: 90 },
  { prop: 'contact', label: '联系人', width: 110 },
  { prop: 'phone', label: '电话', width: 160 },
  { prop: 'settleCurrency', label: '结算币种', width: 90 },
  { prop: 'paymentTerms', label: '付款条件', minWidth: 160 },
  { prop: 'bank', label: '银行信息', minWidth: 180 },
  { prop: 'status', label: '状态', type: 'status', width: 80 },
]

const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '关键字', placeholder: '编码 / 名称 / 联系人' },
  { prop: 'partnerType', label: '类型', type: 'select', options: PARTNER_TYPES },
  { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS },
]

const formFields = computed<FieldDef[]>(() => [
  { prop: 'code', label: '编码', required: true, editDisabled: true },
  { prop: 'name', label: '名称', required: true },
  { prop: 'partnerType', label: '类型', type: 'select', options: PARTNER_TYPES, required: true, default: 'SUPPLIER' },
  { prop: 'locatedCountry', label: '所在国家', type: 'select', options: LOCATED_COUNTRIES, default: 'CN' },
  { prop: 'contact', label: '联系人' },
  { prop: 'phone', label: '电话' },
  { prop: 'settleCurrency', label: '结算币种', type: 'select', options: CURRENCY_SOURCE, required: true, default: 'CNY' },
  { prop: 'paymentTerms', label: '付款条件' },
  ...(canSeeBank.value
    ? ([
        { prop: 'bankName', label: '开户行' },
        { prop: 'accountName', label: '户名' },
        { prop: 'accountNo', label: '银行账号', placeholder: '留空表示不修改', tip: '加密保存，列表只显示后四位' },
      ] as FieldDef[])
    : []),
])
</script>

<template>
  <CrudPage
    title="供应商与物流商"
    resource="/md/partners"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    edit-perm="md:partner:edit"
    audit-type="partner"
    form-width="720px"
  >
    <template #col-bank="{ row }">
      <span v-if="row.bankHidden" class="muted">无权查看</span>
      <span v-else-if="row.bankName">{{ row.bankName }} <span class="mono">{{ row.accountNoMasked }}</span></span>
      <span v-else class="muted">未登记</span>
    </template>
  </CrudPage>
</template>
