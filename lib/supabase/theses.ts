import { createSupabaseClient } from './client'
import type { Thesis } from './types'

/**
 * Create a new thesis in the database
 */
export async function createThesis(
  userId: string,
  thesisData: {
    topic: string
    field: string
    thesis_type: string
    research_question: string
    citation_style: string
    target_length: number
    length_unit: string
    outline?: any
  }
): Promise<Thesis> {
  const supabase = createSupabaseClient()

  const { data, error } = await supabase
    .from('theses')
    .insert({
      user_id: userId,
      topic: thesisData.topic,
      field: thesisData.field,
      thesis_type: thesisData.thesis_type,
      research_question: thesisData.research_question,
      citation_style: thesisData.citation_style,
      target_length: thesisData.target_length,
      length_unit: thesisData.length_unit,
      outline: thesisData.outline || null,
      status: 'draft',
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to create thesis: ${error.message}`)
  }

  return data
}

/**
 * Update an existing thesis
 */
export async function updateThesis(
  thesisId: string,
  updates: Partial<{
    topic: string
    field: string
    thesis_type: string
    research_question: string
    citation_style: string
    target_length: number
    length_unit: string
    outline: any
    file_search_store_id: string
    uploaded_sources: any
    status: string
  }>
): Promise<Thesis> {
  const supabase = createSupabaseClient()

  const { data, error } = await supabase
    .from('theses')
    .update(updates)
    .eq('id', thesisId)
    .select()

  if (error) {
    throw new Error(`Failed to update thesis: ${error.message}`)
  }

  if (!data || data.length === 0) {
    throw new Error(`Thesis not found or not accessible for update (ID: ${thesisId})`)
  }

  return data[0]
}

/**
 * Get a thesis by ID
 */
export async function getThesisById(thesisId: string): Promise<Thesis | null> {
  const supabase = createSupabaseClient()

  const { data, error } = await supabase
    .from('theses')
    .select('*')
    .eq('id', thesisId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      return null // Not found
    }
    throw new Error(`Failed to fetch thesis: ${error.message}`)
  }

  return data
}

/**
 * Get all theses for the current user
 */
export async function getUserTheses(userId: string): Promise<Thesis[]> {
  const supabase = createSupabaseClient()

  const { data, error } = await supabase
    .from('theses')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to fetch theses: ${error.message}`)
  }

  return data || []
}

/**
 * Delete a thesis
 */
export async function deleteThesis(thesisId: string): Promise<void> {
  const supabase = createSupabaseClient()

  const { error } = await supabase
    .from('theses')
    .delete()
    .eq('id', thesisId)

  if (error) {
    throw new Error(`Failed to delete thesis: ${error.message}`)
  }
}

