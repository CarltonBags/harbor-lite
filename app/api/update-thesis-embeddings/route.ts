import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'
import { getThesisParagraphs, updateParagraph, getParagraphById } from '@/lib/supabase/thesis-paragraphs'
import { env } from '@/lib/env'

/**
 * Update embeddings for changed paragraphs in the thesis
 * This is called when text is edited to keep the vector store in sync
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { thesisId, oldContent, newContent } = body

    if (!thesisId || !newContent) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    if (!env.OPENAI_API_KEY) {
      console.warn('[UpdateEmbeddings] OpenAI API key not available, skipping embedding updates')
      return NextResponse.json({ 
        success: true,
        message: 'Embeddings not updated (OpenAI API key not configured)'
      })
    }

    const supabase = createSupabaseServerClient()
    
    // Get existing paragraphs
    const existingParagraphs = await getThesisParagraphs(thesisId)
    
    // Simple diff: split both contents into paragraphs and compare
    const oldParagraphs = oldContent 
      ? oldContent.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 50)
      : []
    const newParagraphs = newContent
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(p => p.length > 50 && !p.match(/^#{1,6}\s/)) // Filter out headers
    
    // Find changed paragraphs by comparing text
    const changedParagraphs: Array<{ index: number; newText: string; oldParagraphId?: string }> = []
    
    for (let i = 0; i < newParagraphs.length; i++) {
      const newText = newParagraphs[i]
      const oldText = oldParagraphs[i]
      
      // If paragraph doesn't exist in old content or text changed significantly
      if (!oldText || newText !== oldText) {
        // Try to find matching paragraph in existing database paragraphs
        const matchingParagraph = existingParagraphs.find(p => 
          p.text.includes(newText.substring(0, 100)) || 
          newText.includes(p.text.substring(0, 100))
        )
        
        changedParagraphs.push({
          index: i,
          newText,
          oldParagraphId: matchingParagraph?.id,
        })
      }
    }
    
    console.log(`[UpdateEmbeddings] Found ${changedParagraphs.length} changed paragraphs out of ${newParagraphs.length} total`)
    
    // Update embeddings for changed paragraphs
    let updatedCount = 0
    for (const changed of changedParagraphs) {
      try {
        // Generate new embedding
        const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-ada-002',
            input: changed.newText,
            dimensions: 1536, // Match database schema
          }),
        })
        
        if (!embeddingResponse.ok) {
          console.error(`[UpdateEmbeddings] Failed to generate embedding for paragraph ${changed.index}`)
          continue
        }
        
        const embeddingData = await embeddingResponse.json()
        const embedding = embeddingData.data[0]?.embedding
        
        if (!embedding) {
          console.error(`[UpdateEmbeddings] No embedding returned for paragraph ${changed.index}`)
          continue
        }
        
        // Update existing paragraph or create new one
        if (changed.oldParagraphId) {
          await updateParagraph(changed.oldParagraphId, {
            text: changed.newText,
            embedding,
          })
          updatedCount++
        } else {
          // New paragraph - would need to determine chapter/section/paragraph number
          // For now, just log it - full re-chunking would be needed for new paragraphs
          console.log(`[UpdateEmbeddings] New paragraph detected at index ${changed.index}, would need full re-chunking`)
        }
      } catch (error) {
        console.error(`[UpdateEmbeddings] Error updating paragraph ${changed.index}:`, error)
      }
    }
    
    console.log(`[UpdateEmbeddings] Updated ${updatedCount} paragraph embeddings`)
    
    return NextResponse.json({ 
      success: true,
      updatedCount,
      totalChanged: changedParagraphs.length,
    })
  } catch (error) {
    console.error('[UpdateEmbeddings] Error updating embeddings:', error)
    return NextResponse.json(
      { 
        error: 'Failed to update embeddings',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

