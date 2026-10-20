export interface TemplateItem {
  id: number
  itemType: string
  itemKey: string
  label: string
  requiresReview: boolean
  sensitive: boolean
}

export interface TemplateVersion {
  id: number
  sourceCountryId: number
  sourceCountryName: string
  versionNo: number
  status: string
  changeNote: string
  publishedAt: string | null
  itemCount: number
  items: TemplateItem[]
}
