import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { thesisId, versionNumber } = body

    if (!thesisId || !versionNumber) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServerClient()
    
    // Get the version content
    const { data: version, error: versionError } = await supabase
      .from('thesis_versions')
      .select('latex_content')
      .eq('thesis_id', thesisId)
      .eq('version_number', versionNumber)
      .single()

    if (versionError || !version) {
      console.error('Error fetching version:', versionError)
      return NextResponse.json(
        { error: 'Version not found', details: versionError?.message },
        { status: 404 }
      )
    }

    // Update thesis content to the rolled back version
    const { error } = await supabase
      .from('theses')
      .update({ 
        latex_content: version.latex_content,
        updated_at: new Date().toISOString(),
      })
      .eq('id', thesisId)

    if (error) {
      console.error('Error rolling back thesis:', error)
      return NextResponse.json(
        { error: 'Failed to rollback thesis', details: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({ 
      success: true,
      content: version.latex_content,
    })
  } catch (error) {
    console.error('Error in rollback-thesis API:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

