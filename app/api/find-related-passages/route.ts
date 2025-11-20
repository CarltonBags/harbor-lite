import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'
import { searchParagraphs } from '@/lib/supabase/thesis-paragraphs'
import { env } from '@/lib/env'

/**
 * Find related passages in the thesis using semantic search
 * This is called after an AI edit to highlight potentially affected passages
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { thesisId, queryText, excludeText } = body

    if (!thesisId || !queryText) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    if (!env.OPENAI_API_KEY) {
      console.warn('[FindRelatedPassages] OpenAI API key not available, skipping semantic search')
      return NextResponse.json({ 
        passages: []
      })
    }

    // Generate embedding for the new text
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-ada-002',
        input: queryText,
        dimensions: 1536,
      }),
    })

    if (!embeddingResponse.ok) {
      console.error('[FindRelatedPassages] Failed to generate embedding')
      return NextResponse.json({ passages: [] })
    }

    const embeddingData = await embeddingResponse.json()
    const queryEmbedding = embeddingData.data[0]?.embedding

    if (!queryEmbedding) {
      return NextResponse.json({ passages: [] })
    }

    // Search for similar paragraphs
    const similarParagraphs = await searchParagraphs(
      thesisId,
      queryEmbedding,
      10, // limit
      0.6 // similarity threshold (lower to catch more related passages)
    )

    // Filter out the original text if provided
    const filtered = excludeText
      ? similarParagraphs.filter(p => {
          // Don't include paragraphs that are too similar to the excluded text
          const similarity = p.similarity || 0
          return similarity < 0.95 // Exclude very high similarity (likely the same text)
        })
      : similarParagraphs

    // Return top 5 most relevant passages
    const passages = filtered
      .slice(0, 5)
      .map(p => ({
        text: p.text,
        paragraphId: p.id,
        similarity: p.similarity,
        chapterNumber: p.chapter_number,
        sectionNumber: p.section_number,
      }))

    console.log(`[FindRelatedPassages] Found ${passages.length} related passages`)

    return NextResponse.json({ 
      passages,
    })
  } catch (error) {
    console.error('[FindRelatedPassages] Error finding related passages:', error)
    return NextResponse.json(
      { 
        error: 'Failed to find related passages',
        message: error instanceof Error ? error.message : 'Unknown error',
        passages: []
      },
      { status: 500 }
    )
  }
}

