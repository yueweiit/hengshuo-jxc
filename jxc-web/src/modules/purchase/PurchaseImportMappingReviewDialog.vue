<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { importColumns, type ImportTask, type PurchaseImportModel, type SupplierMapping } from './purchaseImportModel'
const props = defineProps<{ page:PurchaseImportModel; task:ImportTask; modelValue:boolean }>()
const emit = defineEmits<{ 'update:modelValue':[value:boolean] }>()
const mapping=ref<SupplierMapping|null>(null), labels=ref<Record<string,string>>({}), confirmed=ref(false)
watch(() => [props.modelValue,props.task.id], () => {
  if(!props.modelValue)return
  mapping.value=props.task.result?.mapping ? JSON.parse(JSON.stringify(props.task.result.mapping)) : null
  labels.value={};confirmed.value=false
}, {immediate:true})
const columns=computed(() => [...new Set(mapping.value?.lines.map(l => String(l.cells.purchaseQty ?? '').replace(/[0-9]/g,'')) ?? [])].filter(c => /^[A-Z]{1,3}$/.test(c)))
const fields=importColumns.filter(c => c.key !== 'photo')
function setCell(line:SupplierMapping['lines'][number],key:string,value:string){
  const refs=value.trim().split(/[,，\s]+/).filter(Boolean)
  line.cells[key]=refs.length===0?null:key==='productSpec'&&refs.length>1?refs:refs[0]!
}
async function save(){
  if(!mapping.value||!confirmed.value)return
  const specLabels=Object.fromEntries(Object.entries(labels.value).filter(([,v])=>v.trim()))
  if(await props.page.retryTask(props.task,mapping.value.sheet,{mapping:mapping.value,specLabels,confirm:true}))emit('update:modelValue',false)
}
</script>
<template>
  <el-dialog :model-value="modelValue" title="核对供应商原列与规格" width="94vw" append-to-body @update:model-value="emit('update:modelValue',$event)">
    <el-alert v-if="page.state.error" :title="page.state.error" type="error" :closable="false"/>
    <template v-if="mapping">
      <p>工作表 {{ mapping.sheet }}。下表显示识别建议的原单元格；请核对数量、单价和单号来源。修改对应关系后，系统仍从原文件读取数值。</p>
      <p v-for="reason in mapping.reasons" :key="reason">{{ reason }}</p>
      <el-form inline><el-form-item v-for="column in columns" :key="column" :label="`${column}列规格`"><el-input v-model="labels[column]" :aria-label="`${column}列规格`" placeholder="原表未写名称时请明确填写" maxlength="200"/></el-form-item></el-form>
      <div class="mapping-scroll"><table><thead><tr><th>原行</th><th v-for="field in fields" :key="field.key">{{ field.label }}对应原格</th></tr></thead><tbody><tr v-for="(line,index) in mapping.lines" :key="index"><td>{{ line.sourceRow }}</td><td v-for="field in fields" :key="field.key"><el-input :model-value="Array.isArray(line.cells[field.key]) ? (line.cells[field.key] as string[]).join(',') : line.cells[field.key] as string" :aria-label="`原${line.sourceRow}行${field.label}来源${index}`" @update:model-value="(value: string) => setCell(line,field.key,String(value))"/></td></tr></tbody></table></div>
      <el-collapse><el-collapse-item title="查看原文件单元格及原值"><div class="raw-cells"><span v-for="cell in task.result?.sourceCells" :key="`${cell.sheet}:${cell.cell}`">{{ cell.sheet }}!{{ cell.cell }}：{{ cell.value }}</span></div></el-collapse-item></el-collapse>
      <p v-for="item in mapping.ignoredRows" :key="item.sourceRow">原第{{ item.sourceRow }}行排除原因：{{ item.reason }}</p>
      <el-checkbox v-model="confirmed" aria-label="确认原列与规格">我已核对原列对应、规格和排除行，按上述来源重新解析</el-checkbox>
    </template>
    <p v-else>当前任务没有可核对的字段建议，请先恢复字段识别服务，再重试原任务。</p>
    <template #footer><el-button @click="emit('update:modelValue',false)">返回</el-button><el-button type="primary" :disabled="!mapping || !confirmed || page.busy()" @click="save">确认字段并重试原任务</el-button></template>
  </el-dialog>
</template>
<style scoped>
.mapping-scroll { overflow:auto;max-height:45vh; } table { border-collapse:collapse; } th,td { padding:6px;border-bottom:1px solid var(--el-border-color-light);min-width:130px;text-align:left; } .raw-cells { display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;max-height:300px;overflow:auto; }
</style>
