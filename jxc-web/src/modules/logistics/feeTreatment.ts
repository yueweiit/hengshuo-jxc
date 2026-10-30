import { COST_TREATMENTS } from '../master/options.ts'

/** EXPENSE is the historical spelling of period expense, never capitalization. */
export function feeTreatment(value: unknown) {
  return value === 'EXPENSE' ? 'PERIOD_EXPENSE' : value
}

export function feeTreatmentLabel(value: unknown) {
  return COST_TREATMENTS.find(item => item.value === feeTreatment(value))?.label ?? '不支持的费用类型'
}

export function supportsLogisticsFee(value: unknown) {
  return ['CAPITALIZE', 'PERIOD_EXPENSE'].includes(String(feeTreatment(value)))
}
