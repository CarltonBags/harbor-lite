import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { thesisId, content } = body

    if (!thesisId || !content) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServerClient()
    
    // Get current version number
    const { data: versions, error: versionError } = await supabase
      .from('thesis_versions')
      .select('version_number')
      .eq('thesis_id', thesisId)
      .order('version_number', { ascending: false })
      .limit(1)
    
    const nextVersionNumber = versions && versions.length > 0 
      ? versions[0].version_number + 1 
      : 1

    // Create new version
    const { error: versionInsertError } = await supabase
      .from('thesis_versions')
      .insert({
        thesis_id: thesisId,
        version_number: nextVersionNumber,
        latex_content: content,
        change_description: `Version ${nextVersionNumber} - Gespeichert am ${new Date().toLocaleString('de-DE')}`,
      })

    if (versionInsertError) {
      console.error('Error creating version:', versionInsertError)
      return NextResponse.json(
        { error: 'Failed to create version', details: versionInsertError.message },
        { status: 500 }
      )
    }

    // Update thesis content
    const { error } = await supabase
      .from('theses')
      .update({ 
        latex_content: content,
        updated_at: new Date().toISOString(),
      })
      .eq('id', thesisId)

    if (error) {
      console.error('Error saving thesis:', error)
      return NextResponse.json(
        { error: 'Failed to save thesis', details: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({ 
      success: true,
      versionNumber: nextVersionNumber,
    })
  } catch (error) {
    console.error('Error in save-thesis API:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

