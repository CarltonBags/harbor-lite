import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const thesisId = searchParams.get('id')

    if (!thesisId) {
      return NextResponse.json(
        { error: 'Thesis ID is required' },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServerClient()
    const { data: thesis, error } = await supabase
      .from('theses')
      .select('id, status, created_at, updated_at, completed_at')
      .eq('id', thesisId)
      .single()

    if (error || !thesis) {
      return NextResponse.json(
        { error: 'Thesis not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      thesisId: thesis.id,
      status: thesis.status,
      createdAt: thesis.created_at,
      updatedAt: thesis.updated_at,
      completedAt: thesis.completed_at,
    })
  } catch (error) {
    console.error('Error fetching thesis status:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

