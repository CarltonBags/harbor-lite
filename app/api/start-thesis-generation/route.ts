import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'
import { env } from '@/lib/env'
import { GoogleGenAI } from '@google/genai'
import { thesisQueue, type ThesisGenerationJob } from '@/lib/queue'

/**
 * API endpoint to trigger background thesis generation job
 * This endpoint adds a job to the BullMQ queue which is processed by the worker
 * The worker will:
 * 1. Generate search queries per chapter
 * 2. Query OpenAlex and Semantic Scholar
 * 3. Deduplicate and rank sources
 * 4. Download PDFs and upload to FileSearchStore
 * 5. Generate thesis content
 */
export async function POST(request: Request) {
  try {
    const { thesisId } = await request.json()

    if (!thesisId) {
      return NextResponse.json(
        { error: 'Thesis ID is required' },
        { status: 400 }
      )
    }

    // Get thesis data using server-side client (bypasses RLS)
    const supabase = createSupabaseServerClient()
    const { data: thesis, error: thesisError } = await supabase
      .from('theses')
      .select('*')
      .eq('id', thesisId)
      .single()

    if (thesisError || !thesis) {
      console.error('Thesis not found:', { thesisId, error: thesisError })
      return NextResponse.json(
        { error: 'Thesis not found. Please make sure the thesis is saved before starting generation.' },
        { status: 404 }
      )
    }



    if (!thesis.outline || thesis.outline.length === 0) {
      return NextResponse.json(
        { error: 'Thesis outline is required' },
        { status: 400 }
      )
    }

    // Create FileSearchStore if it doesn't exist (needed for worker to upload PDFs)
    let fileSearchStoreId = thesis.file_search_store_id
    if (!fileSearchStoreId) {
      try {
        if (!env.GEMINI_KEY) {
          console.error('GEMINI_KEY is not configured')
          return NextResponse.json(
            { error: 'GEMINI_KEY is not configured' },
            { status: 500 }
          )
        }

        console.log('Creating FileSearchStore for thesis:', thesisId)

        // Initialize Google Gen AI SDK
        const ai = new GoogleGenAI({ apiKey: env.GEMINI_KEY })

        // Create a new FileSearchStore
        const fileSearchStore = await ai.fileSearchStores.create({
          config: { displayName: `Thesis: ${thesis.topic || 'Unbenannt'}` },
        })

        console.log('FileSearchStore created:', fileSearchStore.name)
        fileSearchStoreId = fileSearchStore.name

        // Update thesis with the new FileSearchStore ID using server-side client
        const { data: updatedThesis, error: updateError } = await supabase
          .from('theses')
          .update({ file_search_store_id: fileSearchStoreId })
          .eq('id', thesisId)
          .select()

        if (updateError) {
          console.error('Error updating thesis with FileSearchStore ID:', updateError)
          throw new Error(`Failed to update thesis: ${updateError.message}`)
        }

        if (!updatedThesis || updatedThesis.length === 0) {
          throw new Error('Thesis not found when trying to update FileSearchStore ID')
        }

        console.log('Thesis updated with FileSearchStore ID:', fileSearchStoreId)
      } catch (error) {
        console.error('Error creating FileSearchStore:', error)
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        const errorStack = error instanceof Error ? error.stack : undefined
        console.error('Error details:', { errorMessage, errorStack })
        return NextResponse.json(
          { error: 'Failed to create FileSearchStore', details: errorMessage },
          { status: 500 }
        )
      }
    }

    // Update thesis status to 'generating' using server-side client
    const { error: statusUpdateError } = await supabase
      .from('theses')
      .update({ status: 'generating' })
      .eq('id', thesisId)

    if (statusUpdateError) {
      console.error('Error updating thesis status:', statusUpdateError)
      // Don't fail the whole request, just log it
    }

    // Add job to BullMQ queue
    console.log('Adding thesis generation job to queue:', thesisId)

    // Extract mandatory sources from uploaded_sources where mandatory=true
    // These are sources the user has explicitly marked as required to cite
    const mandatorySources: string[] = (thesis.uploaded_sources || [])
      .filter((source: { mandatory?: boolean }) => source.mandatory === true)
      .map((source: { title?: string; doi?: string }) => source.title || source.doi || '')
      .filter((s: string) => s.length > 0)

    // Also update the mandatory_sources column in the database for reference
    if (mandatorySources.length > 0) {
      await supabase
        .from('theses')
        .update({ mandatory_sources: mandatorySources })
        .eq('id', thesisId)
    }


    const targetLength = thesis.target_length || 0
    const lengthUnit = thesis.length_unit || 'pages' // Default to pages if not set

    // Validate length limit (80 pages or 20,000 words)
    // Note: Frontend uses 250 words/page (80 pages = 20,000 words).
    if (lengthUnit === 'pages') {
      if (targetLength > 21000) { // 20000 + buffer
        return NextResponse.json(
          { error: 'Thesis is too long. Maximum allowed is 80 pages.' },
          { status: 400 } // buffer: 1000, 21000 total
        )
      }
    } else {
      // Words: limit is 20,000. Allow small buffer (e.g., 5% is added in frontend calc)
      if (targetLength > 21000) {
        return NextResponse.json(
          { error: 'Thesis is too long. Maximum allowed is 20,000 words.' },
          { status: 400 }
        )
      }
    }

    const jobData: ThesisGenerationJob = {
      thesisId,
      thesisData: {
        title: thesis.title || thesis.topic,
        topic: thesis.topic,
        field: thesis.field,
        thesisType: thesis.thesis_type,
        researchQuestion: thesis.research_question,
        citationStyle: thesis.citation_style,
        targetLength: thesis.target_length,
        lengthUnit: thesis.length_unit,
        outline: thesis.outline,
        fileSearchStoreId: fileSearchStoreId,
        language: thesis.language || thesis.metadata?.language || 'german',
        mandatorySources,
      },
    }



    const job = await thesisQueue.add('generate-thesis', jobData, {
      jobId: thesisId, // Use thesisId as jobId to prevent duplicates
      removeOnComplete: true,
      removeOnFail: false,
    })

    console.log('Job added to queue:', { jobId: job.id, thesisId })

    return NextResponse.json({
      success: true,
      jobId: job.id,
      message: 'Thesis generation job queued successfully',
    })
  } catch (error) {
    console.error('Error starting thesis generation:', error)

    // Try to revert thesis status on error
    try {
      const supabase = createSupabaseServerClient()
      await supabase
        .from('theses')
        .update({ status: 'draft' })
        .eq('id', (error as any).thesisId)
    } catch (revertError) {
      console.error('Error reverting thesis status:', revertError)
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

