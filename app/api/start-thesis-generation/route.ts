import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'
import { getThesisById, updateThesis } from '@/lib/supabase/theses'
import { env } from '@/lib/env'

/**
 * API endpoint to trigger background thesis generation job
 * This endpoint will be called from the frontend after file uploads are complete
 * It will trigger a background worker (deployed separately on Render) to:
 * 1. Generate search queries per chapter
 * 2. Query OpenAlex and Semantic Scholar
 * 3. Deduplicate and rank sources
 * 4. Download PDFs and upload to FileSearchStore
 * 5. Generate thesis content
 */
export async function POST(request: Request) {
  try {
    const { thesisId, testMode } = await request.json()

    if (!thesisId) {
      return NextResponse.json(
        { error: 'Thesis ID is required' },
        { status: 400 }
      )
    }

    // Get thesis data
    const supabase = createSupabaseServerClient()
    const thesis = await getThesisById(thesisId)

    if (!thesis) {
      return NextResponse.json(
        { error: 'Thesis not found' },
        { status: 404 }
      )
    }

    if (!thesis.outline || thesis.outline.length === 0) {
      return NextResponse.json(
        { error: 'Thesis outline is required' },
        { status: 400 }
      )
    }

    if (!thesis.file_search_store_id) {
      return NextResponse.json(
        { error: 'FileSearchStore ID is required' },
        { status: 400 }
      )
    }

    // Update thesis status to 'generating'
    await updateThesis(thesisId, {
      status: 'generating',
    })

    // Trigger background worker
    // The worker URL should be set in environment variables
    const workerUrl = env.THESIS_WORKER_URL || process.env.THESIS_WORKER_URL

    if (!workerUrl) {
      console.error('THESIS_WORKER_URL is not configured')
      return NextResponse.json(
        { error: 'Background worker is not configured' },
        { status: 500 }
      )
    }

    // Send job to background worker
    const workerResponse = await fetch(`${workerUrl}/jobs/thesis-generation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.THESIS_WORKER_API_KEY || process.env.THESIS_WORKER_API_KEY || ''}`,
      },
      body: JSON.stringify({
        thesisId,
        testMode: testMode === true, // Pass test mode flag to worker
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
          fileSearchStoreId: thesis.file_search_store_id,
          language: thesis.metadata?.language || 'german',
        },
      }),
    })

    if (!workerResponse.ok) {
      const errorText = await workerResponse.text()
      console.error('Worker error:', errorText)
      
      // Update thesis status back to draft on error
      await updateThesis(thesisId, {
        status: 'draft',
      })

      return NextResponse.json(
        { error: 'Failed to start background job', details: errorText },
        { status: 500 }
      )
    }

    const jobData = await workerResponse.json()

    // In test mode, the worker returns results synchronously
    // In production mode, it returns a job ID
    if (testMode && jobData.testMode) {
      return NextResponse.json(jobData)
    }

    return NextResponse.json({
      success: true,
      jobId: jobData.jobId,
      message: 'Thesis generation job started',
    })
  } catch (error) {
    console.error('Error starting thesis generation:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

