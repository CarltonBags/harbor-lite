import { NextResponse } from 'next/server'
import { getThesisById } from '@/lib/supabase/theses'
import type { UploadedSource } from '@/lib/supabase/types'

/**
 * API route to update the database after a file upload operation completes
 * This is called from the frontend after polling confirms the upload is done
 */
export async function POST(request: Request) {
  try {
    const { thesisId, source } = await request.json()

    if (!thesisId || !source) {
      return NextResponse.json(
        { error: 'Thesis ID and source data are required' },
        { status: 400 }
      )
    }

    // Get current thesis data
    const thesis = await getThesisById(thesisId)
    if (!thesis) {
      return NextResponse.json(
        { error: 'Thesis not found' },
        { status: 404 }
      )
    }

    const existingSources: UploadedSource[] = thesis.uploaded_sources || []
    
    // Check if source already exists (by DOI or fileName)
    const duplicateSource = existingSources.find(
      (s) => 
        (source.doi && s.doi && s.doi.toLowerCase() === source.doi.toLowerCase()) ||
        (s.fileName && s.fileName.toLowerCase() === source.fileName.toLowerCase())
    )

    if (duplicateSource) {
      // Source already exists, return success without adding duplicate
      return NextResponse.json({ 
        success: true, 
        message: 'Source already exists',
        duplicate: true 
      })
    }

    // Add new source to the array
    const newSource: UploadedSource = {
      doi: source.doi,
      title: source.title,
      fileName: source.fileName,
      uploadedAt: source.uploadedAt || new Date().toISOString(),
      metadata: source.metadata,
      sourceType: source.sourceType || 'file',
      sourceUrl: source.sourceUrl,
    }

    const updatedSources = [...existingSources, newSource]

    // Update thesis with new source - use direct Supabase call
    const { createSupabaseClient } = await import('@/lib/supabase/client')
    const supabase = createSupabaseClient()
    
    const { error: updateError } = await supabase
      .from('theses')
      .update({ 
        uploaded_sources: updatedSources as any,
        updated_at: new Date().toISOString(),
      })
      .eq('id', thesisId)

    if (updateError) {
      console.error('Error updating thesis with uploaded source:', updateError)
      return NextResponse.json(
        { error: `Failed to update database: ${updateError.message}` },
        { status: 500 }
      )
    }

    return NextResponse.json({ 
      success: true,
      source: newSource,
    })
  } catch (error) {
    console.error('Error completing file upload:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

