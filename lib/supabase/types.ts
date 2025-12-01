export type PlanType = 'free' | 'starter' | 'topup' | 'pro' | 'premium'

export interface UserProfile {
  id: string
  email: string | null
  full_name: string | null
  created_at: string
  updated_at: string
  current_plan: PlanType
  plan_started_at: string | null
  plan_expires_at: string | null
  total_thesis_drafts: number
  total_ai_rewrite_prompts_used: number
  total_ai_rewrite_prompts_available: number
  total_pdf_uploads: number
  total_pdf_uploads_available: number
  total_exa_research_queries: number
  total_ai_figures_generated: number
  top_up_packs_purchased: number
  top_up_prompts_available: number
  metadata: Record<string, any>
}

export interface OutlineSubsection {
  number: string
  title: string
}

export interface OutlineSection {
  number: string
  title: string
  subsections: OutlineSubsection[]
}

export interface OutlineChapter {
  number: string
  title: string
  sections: OutlineSection[]
}

export interface UploadedSource {
  doi?: string
  title: string
  fileName: string
  fileUri?: string
  uploadedAt: string
  metadata?: FileMetadata
  sourceType: 'file' | 'url'
  sourceUrl?: string
  mandatory?: boolean // Flag to indicate this source must be cited in the thesis
}

export interface Thesis {
  id: string
  user_id: string
  title: string | null
  topic: string
  field: string
  thesis_type: string
  research_question: string
  citation_style: string
  target_length: number
  length_unit: string
  outline: OutlineChapter[] | null
  latex_content: string | null
  pdf_url: string | null
  word_url: string | null
  file_search_store_id: string | null
  uploaded_sources: UploadedSource[] | null
  mandatory_sources: string[] | null // Array of source titles/DOIs that must be cited
  status: 'draft' | 'generating' | 'completed' | 'archived'
  created_at: string
  updated_at: string
  completed_at: string | null
  metadata: Record<string, any>
}

export interface FileMetadata {
  title: string
  authors: string[]
  year: string | null
  journal?: string
  publisher?: string
  doi?: string
  isbn?: string
  url?: string
  pageStart?: string
  pageEnd?: string
  pages?: string // Keep for backward compatibility, will be constructed from pageStart/pageEnd
  volume?: string
  issue?: string
  abstract?: string
  keywords?: string[]
  citation?: string
}

export interface ThesisParagraph {
  id: string
  thesis_id: string
  chapter_number: number
  section_number: number | null
  paragraph_number: number
  text: string
  embedding: number[] | null // Vector embedding
  version: number
  created_at: string
  updated_at: string
  metadata: Record<string, any>
}

export interface Subscription {
  id: string
  user_id: string
  plan_type: 'starter' | 'topup' | 'pro' | 'premium'
  amount_paid: number
  currency: string
  ai_rewrite_prompts: number
  pdf_uploads: number
  exa_research_queries: number
  ai_figures: number
  unlimited_drafts: boolean
  unlimited_rewrites: boolean
  unlimited_pdfs: boolean
  priority_support: boolean
  multi_thesis: boolean
  export_formats: string[]
  status: 'active' | 'expired' | 'cancelled'
  purchased_at: string
  expires_at: string | null
  payment_provider: string | null
  payment_id: string | null
  metadata: Record<string, any>
}

