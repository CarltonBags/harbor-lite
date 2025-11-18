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

    // Check if thesis already has a FileSearchStore
    const existingThesis = await getThesisById(thesisId)
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
    await updateThesis(thesisId, {
      file_search_store_id: fileSearchStore.name,
    } as any)

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

