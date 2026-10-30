export const DEFAULT_PRODUCT_RATIO = 58
export const MIN_PRODUCT_RATIO = 35
export const MAX_PRODUCT_RATIO = 72

export type DetailPane = 'products' | 'records'
export type FocusedPane = DetailPane | null

export function workspaceContentBounds(rectTop: number, borderTop: number, clientHeight: number, paddingTop: number, paddingBottom: number) {
  return {
    top: rectTop + borderTop + paddingTop,
    height: Math.max(1, clientHeight - paddingTop - paddingBottom),
  }
}

export function ratioAtPosition(clientY: number, top: number, height: number, dividerHeight: number): number {
  const availableHeight = Math.max(1, height - dividerHeight)
  const ratio = ((clientY - top - dividerHeight / 2) / availableHeight) * 100
  return Math.max(MIN_PRODUCT_RATIO, Math.min(MAX_PRODUCT_RATIO, Math.round(ratio)))
}

export function stepProductRatio(ratio: number, key: string): number | null {
  if (key === 'ArrowUp') return Math.min(MAX_PRODUCT_RATIO, ratio + 3)
  if (key === 'ArrowDown') return Math.max(MIN_PRODUCT_RATIO, ratio - 3)
  if (key === 'Home') return MIN_PRODUCT_RATIO
  if (key === 'End') return MAX_PRODUCT_RATIO
  return null
}

export function toggleFocusedPane(current: FocusedPane, target: DetailPane): FocusedPane {
  return current === target ? null : target
}

export function shouldUseNaturalFlow(width: number, height: number): boolean {
  return width <= 900 || height <= 700
}
