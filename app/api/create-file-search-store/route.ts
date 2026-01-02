import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'
import { getThesisById, updateThesis } from '@/lib/supabase/theses'

export async function POST(request: Request) {
  try {
    const { thesisId, displayName } = await request.json()

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

    // Use server client to bypass RLS
    const { createSupabaseServerClient } = await import('@/lib/supabase/client')
    const supabase = createSupabaseServerClient()

    // Check if thesis already has a FileSearchStore
    const { data: existingThesis, error: fetchError } = await supabase
      .from('theses')
      .select('file_search_store_id')
      .eq('id', thesisId)
      .single()

    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError
    }

    if (existingThesis?.file_search_store_id) {
      return NextResponse.json({
        fileSearchStoreId: existingThesis.file_search_store_id,
        displayName: displayName || `Thesis ${thesisId}`,
        existing: true,
      })
    }

    // Initialize Google Gen AI SDK
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_KEY })

    // Create a new FileSearchStore using SDK
    const fileSearchStore = await ai.fileSearchStores.create({
      config: { displayName: displayName || `Thesis ${thesisId}` },
    })

    // Store the FileSearchStore ID in the database
    const { error: updateError } = await supabase
      .from('theses')
      .update({
        file_search_store_id: fileSearchStore.name,
      })
      .eq('id', thesisId)

    if (updateError) {
      throw createError(`Failed to update thesis: ${updateError.message}`)
    }

    return NextResponse.json({
      fileSearchStoreId: fileSearchStore.name,
      displayName: fileSearchStore.displayName,
      existing: false,
    })
  } catch (error) {
    console.error('Error creating FileSearchStore:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

function createError(message: string) {
  return new Error(message)
}

