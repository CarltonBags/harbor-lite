import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { checkFileInStore } from '@/lib/supabase/sources'

export async function POST(request: Request) {
  try {
    const { thesisId, doi, fileName } = await request.json()

    if (!thesisId) {
      return NextResponse.json(
        { error: 'Thesis ID is required' },
        { status: 400 }
      )
    }

    if (!env.GEMINI_KEY) {
      return NextResponse.json(
        { error: 'GEMINI_KEY is not configured' },
        { status: 500 }
      )
    }

    // Check if file exists in our database (which tracks FileSearchStore uploads)
    const { exists, source } = await checkFileInStore(thesisId, doi, fileName)

    return NextResponse.json({
      exists,
      source: source || undefined,
      message: exists 
        ? 'File already exists in FileSearchStore (tracked in database)'
        : 'File not found in FileSearchStore',
    })
  } catch (error) {
    console.error('Error checking file in store:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
