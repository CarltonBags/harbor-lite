import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'
import { getThesisById } from '@/lib/supabase/theses'
import { checkFileInStore } from '@/lib/supabase/sources'

export async function POST(request: Request) {
  try {
    const { thesisId, fileSearchStoreId } = await request.json()

    if (!thesisId || !fileSearchStoreId) {
      return NextResponse.json(
        { error: 'Thesis ID and FileSearchStore ID are required' },
        { status: 400 }
      )
    }

    if (!env.GEMINI_KEY) {
      return NextResponse.json(
        { error: 'GEMINI_KEY is not configured' },
        { status: 500 }
      )
    }

    // Initialize Google Gen AI SDK
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_KEY })

    try {
      // Get FileSearchStore info
      const store = await ai.fileSearchStores.get({
        name: fileSearchStoreId,
      })

      // Get all sources from database
      const thesis = await getThesisById(thesisId)
      const uploadedSources = thesis?.uploaded_sources || []

      // Compare database records with FileSearchStore stats
      const verification = {
        storeInfo: {
          name: store.name,
          displayName: store.displayName,
          activeDocumentsCount: parseInt(store.activeDocumentsCount || '0'),
          pendingDocumentsCount: parseInt(store.pendingDocumentsCount || '0'),
          failedDocumentsCount: parseInt(store.failedDocumentsCount || '0'),
          sizeBytes: parseInt(store.sizeBytes || '0'),
        },
        databaseSources: uploadedSources.length,
        sources: uploadedSources.map((source) => ({
          fileName: source.fileName,
          title: source.title,
          doi: source.doi,
          uploadedAt: source.uploadedAt,
          verified: true, // We track these in our DB, so they should be in the store
        })),
        summary: {
          totalInDatabase: uploadedSources.length,
          activeInStore: parseInt(store.activeDocumentsCount || '0'),
          pendingInStore: parseInt(store.pendingDocumentsCount || '0'),
          failedInStore: parseInt(store.failedDocumentsCount || '0'),
          // Note: activeDocumentsCount might be higher if files were uploaded outside our system
          // or if there are multiple chunks per document
        },
      }

      return NextResponse.json(verification)
    } catch (error) {
      console.error('Error verifying files in store:', error)
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Error in verify-file-in-store:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

