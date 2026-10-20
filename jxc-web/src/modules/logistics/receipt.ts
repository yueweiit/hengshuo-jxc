import type { Router } from 'vue-router'
import { BizError, createCommandIntent, http } from '@/api/http'
import { getCountryId, getToken } from '@/utils/session'

const receiptIntent = createCommandIntent()

/** 按派送单打开实收：已有实收单直接打开，没有则先建草稿（接口对同一派送单返回同一张） */
export async function openReceiptFor(router: Router, deliveryId: number) {
  const country = getCountryId(), token = getToken()
  const r = await http.postIdem<{ id: number }>('/lgs/receipts', { deliveryId }, receiptIntent)
  if (country !== getCountryId() || token !== getToken()) throw new BizError('CONTEXT_CHANGED', '国家或登录状态已切换，请重新打开实收')
  await router.push(`/logistics/receipts/${r.id}`)
}
