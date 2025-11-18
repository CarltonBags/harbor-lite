import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'

export async function POST(request: Request) {
  try {
    const { fileSearchStoreId } = await request.json()

    if (!fileSearchStoreId) {
      return NextResponse.json(
        { error: 'FileSearchStore ID is required' },
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
      // Get the FileSearchStore to see document count
      const store = await ai.fileSearchStores.get({
        name: fileSearchStoreId,
      })

      // Note: The FileSearchStore API doesn't provide a direct way to list individual documents
      // We can only get aggregate information like activeDocumentsCount, pendingDocumentsCount, etc.
      // For actual document listing, we need to rely on our database tracking (uploaded_sources)
      
      return NextResponse.json({
        store: {
          name: store.name,
          displayName: store.displayName,
          activeDocumentsCount: store.activeDocumentsCount,
          pendingDocumentsCount: store.pendingDocumentsCount,
          failedDocumentsCount: store.failedDocumentsCount,
          sizeBytes: store.sizeBytes,
          createTime: store.createTime,
          updateTime: store.updateTime,
        },
        message: 'Use uploaded_sources in database for detailed file listing',
      })
    } catch (error) {
      console.error('Error getting FileSearchStore:', error)
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Error in list-files-in-store:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

