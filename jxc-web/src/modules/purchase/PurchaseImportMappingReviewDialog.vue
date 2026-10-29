<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { importColumns, type ImportTask, type PurchaseImportModel, type SupplierMapping } from './purchaseImportModel'
import { splitSupplierMapping } from './purchaseImportSourceMapping'
const props = defineProps<{ page:PurchaseImportModel; task:ImportTask; modelValue:boolean; correctionSourceId?:number; batchVersion?:number }>()
const emit = defineEmits<{ 'update:modelValue':[value:boolean]; corrected:[batchId:string] }>()
const mapping=ref<SupplierMapping|null>(null), labels=ref<Record<string,string>>({}), confirmed=ref(false)
const splitColumns=ref(''), splitError=ref('')
watch(() => [props.modelValue,props.task.id], () => {
  if(!props.modelValue)return
  mapping.value=props.task.result?.mapping ? JSON.parse(JSON.stringify(props.task.result.mapping)) : null
  labels.value={};confirmed.value=false;splitColumns.value='';splitError.value=''
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
  const input={mapping:mapping.value,specLabels,confirm:true}
  const saved=props.correctionSourceId !== undefined
    ? await props.page.correctSource(props.correctionSourceId,props.batchVersion!,input)
    : await props.page.retryTask(props.task,mapping.value.sheet,input)
  if(saved){emit('update:modelValue',false);if(props.correctionSourceId !== undefined)emit('corrected',props.page.state.batchId!)}
}
function split(){try{if(mapping.value)mapping.value=splitSupplierMapping(mapping.value,splitColumns.value);labels.value={};confirmed.value=false;splitError.value=''}catch(error){splitError.value=error instanceof Error?error.message:'数量列未能拆分'}}
</script>
<template>
  <el-dialog :model-value="modelValue" title="核对供应商原列与规格" width="94vw" append-to-body @update:model-value="emit('update:modelValue',$event)">
    <el-alert v-if="page.state.error" :title="page.state.error" type="error" :closable="false"/>
    <template v-if="mapping">
      <el-alert v-if="correctionSourceId !== undefined" title="确认后创建新的纠正批次，当前批次保留。这里只修改原格对应关系，不确认商品或图片归属。" type="info" :closable="false"/>
      <p>工作表 {{ mapping.sheet }}。下表显示识别建议的原单元格；请核对数量、单价和单号来源。修改对应关系后，系统仍从原文件读取数值。</p>
      <div class="quantity-split"><el-input v-model="splitColumns" aria-label="拆分数量列" placeholder="需要拆分时填写原数量列，例如 B,C,D"/><el-button :disabled="page.busy()" @click="split">按数量列拆分建议</el-button><p v-if="splitError" role="alert">{{ splitError }}</p></div>
      <p v-for="reason in mapping.reasons" :key="reason">{{ reason }}</p>
      <el-form inline><el-form-item v-for="column in columns" :key="column" :label="`${column}列规格`"><el-input v-model="labels[column]" :aria-label="`${column}列规格`" placeholder="原表未写名称时请明确填写" maxlength="200"/></el-form-item></el-form>
      <div class="mapping-scroll"><table><thead><tr><th>原行</th><th v-for="field in fields" :key="field.key">{{ field.label }}对应原格</th></tr></thead><tbody><tr v-for="(line,index) in mapping.lines" :key="index"><td>{{ line.sourceRow }}</td><td v-for="field in fields" :key="field.key"><el-input :model-value="Array.isArray(line.cells[field.key]) ? (line.cells[field.key] as string[]).join(',') : line.cells[field.key] as string" :aria-label="`原${line.sourceRow}行${field.label}来源${index}`" @update:model-value="(value: string) => setCell(line,field.key,String(value))"/></td></tr></tbody></table></div>
      <el-collapse><el-collapse-item title="查看原文件单元格及原值"><div class="raw-cells"><span v-for="cell in task.result?.sourceCells" :key="`${cell.sheet}:${cell.cell}`">{{ cell.sheet }}!{{ cell.cell }}：{{ cell.value }}</span></div></el-collapse-item></el-collapse>
      <p v-for="item in mapping.ignoredRows" :key="item.sourceRow">原第{{ item.sourceRow }}行排除原因：{{ item.reason }}</p>
      <el-checkbox v-model="confirmed" aria-label="确认原列与规格">我已核对原列对应、规格和排除行，按上述来源重新解析</el-checkbox>
    </template>
    <p v-else>当前任务没有可核对的字段建议，请先恢复字段识别服务，再重试原任务。</p>
    <template #footer><el-button @click="emit('update:modelValue',false)">返回</el-button><el-button type="primary" :disabled="!mapping || !confirmed || page.busy()" @click="save">{{ correctionSourceId !== undefined ? '确认字段并创建纠正批次' : '确认字段并重试原任务' }}</el-button></template>
  </el-dialog>
</template>
<style scoped>
.quantity-split{display:grid;gap:8px}.el-checkbox{display:flex;width:100%;height:auto;white-space:normal;align-items:flex-start}.el-checkbox :deep(.el-checkbox__label){min-width:0;white-space:normal;overflow-wrap:anywhere;line-height:1.5}
.mapping-scroll { overflow:auto;max-height:45vh; } table { border-collapse:collapse; } th,td { padding:6px;border-bottom:1px solid var(--el-border-color-light);min-width:130px;text-align:left; } .raw-cells { display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;max-height:300px;overflow:auto; }
</style>
