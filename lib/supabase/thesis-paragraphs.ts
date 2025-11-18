import { createSupabaseClient } from './client'
import type { ThesisParagraph } from './types'

/**
 * Get all paragraphs for a thesis, ordered by structure
 */
export async function getThesisParagraphs(thesisId: string): Promise<ThesisParagraph[]> {
  const supabase = createSupabaseClient()
  
  const { data, error } = await supabase
    .from('thesis_paragraphs')
    .select('*')
    .eq('thesis_id', thesisId)
    .order('chapter_number', { ascending: true, nullsLast: true })
    .order('section_number', { ascending: true, nullsLast: true })
    .order('paragraph_number', { ascending: true })

  if (error) {
    throw new Error(`Failed to fetch thesis paragraphs: ${error.message}`)
  }

  return data || []
}

/**
 * Get paragraphs for a specific chapter
 */
export async function getChapterParagraphs(
  thesisId: string,
  chapterNumber: number
): Promise<ThesisParagraph[]> {
  const supabase = createSupabaseClient()
  
  const { data, error } = await supabase
    .from('thesis_paragraphs')
    .select('*')
    .eq('thesis_id', thesisId)
    .eq('chapter_number', chapterNumber)
    .order('section_number', { ascending: true, nullsLast: true })
    .order('paragraph_number', { ascending: true })

  if (error) {
    throw new Error(`Failed to fetch chapter paragraphs: ${error.message}`)
  }

  return data || []
}

/**
 * Insert a new paragraph
 */
export async function insertParagraph(
  paragraph: Omit<ThesisParagraph, 'id' | 'created_at' | 'updated_at' | 'version'>
): Promise<ThesisParagraph> {
  const supabase = createSupabaseClient()
  
  const { data, error } = await supabase
    .from('thesis_paragraphs')
    .insert({
      thesis_id: paragraph.thesis_id,
      chapter_number: paragraph.chapter_number,
      section_number: paragraph.section_number,
      paragraph_number: paragraph.paragraph_number,
      text: paragraph.text,
      embedding: paragraph.embedding,
      metadata: paragraph.metadata || {},
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to insert paragraph: ${error.message}`)
  }

  return data
}

/**
 * Insert multiple paragraphs in a transaction
 */
export async function insertParagraphs(
  paragraphs: Omit<ThesisParagraph, 'id' | 'created_at' | 'updated_at' | 'version'>[]
): Promise<ThesisParagraph[]> {
  const supabase = createSupabaseClient()
  
  const { data, error } = await supabase
    .from('thesis_paragraphs')
    .insert(
      paragraphs.map((p) => ({
        thesis_id: p.thesis_id,
        chapter_number: p.chapter_number,
        section_number: p.section_number,
        paragraph_number: p.paragraph_number,
        text: p.text,
        embedding: p.embedding,
        metadata: p.metadata || {},
      }))
    )
    .select()

  if (error) {
    throw new Error(`Failed to insert paragraphs: ${error.message}`)
  }

  return data || []
}

/**
 * Update a paragraph (will auto-increment version if text changes)
 */
export async function updateParagraph(
  paragraphId: string,
  updates: Partial<Pick<ThesisParagraph, 'text' | 'embedding' | 'metadata'>>
): Promise<ThesisParagraph> {
  const supabase = createSupabaseClient()
  
  const { data, error } = await supabase
    .from('thesis_paragraphs')
    .update(updates)
    .eq('id', paragraphId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to update paragraph: ${error.message}`)
  }

  return data
}

/**
 * Delete a paragraph
 */
export async function deleteParagraph(paragraphId: string): Promise<void> {
  const supabase = createSupabaseClient()
  
  const { error } = await supabase
    .from('thesis_paragraphs')
    .delete()
    .eq('id', paragraphId)

  if (error) {
    throw new Error(`Failed to delete paragraph: ${error.message}`)
  }
}

/**
 * Delete all paragraphs for a thesis
 */
export async function deleteThesisParagraphs(thesisId: string): Promise<void> {
  const supabase = createSupabaseClient()
  
  const { error } = await supabase
    .from('thesis_paragraphs')
    .delete()
    .eq('thesis_id', thesisId)

  if (error) {
    throw new Error(`Failed to delete thesis paragraphs: ${error.message}`)
  }
}

/**
 * Semantic search using embeddings
 * Note: This requires the query embedding to be generated first (e.g., using OpenAI embeddings API)
 */
export async function searchParagraphs(
  thesisId: string,
  queryEmbedding: number[],
  limit: number = 10,
  similarityThreshold: number = 0.7
): Promise<(ThesisParagraph & { similarity: number })[]> {
  const supabase = createSupabaseClient()
  
  // Use the database function for semantic search
  const { data, error } = await supabase.rpc('search_thesis_paragraphs', {
    p_thesis_id: thesisId,
    p_query_embedding: queryEmbedding,
    p_limit: limit,
    p_similarity_threshold: similarityThreshold,
  })

  if (error) {
    throw new Error(`Failed to search paragraphs: ${error.message}`)
  }

  return data || []
}

/**
 * Update embedding for a paragraph
 */
export async function updateParagraphEmbedding(
  paragraphId: string,
  embedding: number[]
): Promise<ThesisParagraph> {
  return updateParagraph(paragraphId, { embedding })
}

/**
 * Get paragraph by ID
 */
export async function getParagraphById(paragraphId: string): Promise<ThesisParagraph | null> {
  const supabase = createSupabaseClient()
  
  const { data, error } = await supabase
    .from('thesis_paragraphs')
    .select('*')
    .eq('id', paragraphId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      return null // Not found
    }
    throw new Error(`Failed to fetch paragraph: ${error.message}`)
  }

  return data
}

