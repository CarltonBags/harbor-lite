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
    const { error } = await supabase
      .from('theses')
      .update({ latex_content: content })
      .eq('id', thesisId)

    if (error) {
      console.error('Error saving thesis:', error)
      return NextResponse.json(
        { error: 'Failed to save thesis', details: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in save-thesis API:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

