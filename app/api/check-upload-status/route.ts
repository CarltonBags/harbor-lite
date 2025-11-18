import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'

export async function POST(request: Request) {
  let operationName: string | undefined
  try {
    const requestData = await request.json()
    operationName = requestData.operationName

    if (!operationName) {
      return NextResponse.json(
        { error: 'Operation name is required' },
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

    // Check operation status using SDK
    // We need to reconstruct the operation object with just the name property
    // The SDK will handle fetching the full operation details
    // Based on the SDK pattern: operations.get({ operation }) where operation has a name
    // We create a minimal operation-like object with just the name
    const operation = await ai.operations.get({ 
      operation: { name: operationName } as any
    })

    return NextResponse.json({
      done: operation.done || false,
      error: operation.error || null,
      response: operation.response || null,
    })
  } catch (error) {
    console.error('Error checking upload status:', error)
    console.error('Operation name received:', operationName)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorDetails = error instanceof Error ? error.stack : String(error)
    console.error('Error details:', errorDetails)
    
    // Try to extract more details from the error if it's an SDK error
    let detailedError = errorMessage
    if (error && typeof error === 'object' && 'message' in error) {
      detailedError = String(error.message)
    }
    
    return NextResponse.json(
      { 
        error: detailedError,
        details: process.env.NODE_ENV === 'development' ? errorDetails : undefined
      },
      { status: 500 }
    )
  }
}

