import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'

/**
 * Server-side polling endpoint that keeps the operation object in memory
 * and polls until completion, then returns the result
 */
export async function POST(request: Request) {
  try {
    const { operationName, maxWaitTime = 300000 } = await request.json() // Default 5 minutes

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

    const startTime = Date.now()
    const pollInterval = 2000 // Poll every 2 seconds
    let operation: any = null

    // Poll until operation is done or timeout
    while (true) {
      try {
        // Try to get the operation - we need to reconstruct it from the name
        // The SDK might accept just the name in a different format
        // Let's try using the operations API directly with just the name
        operation = await ai.operations.get({ 
          operation: { name: operationName } as any
        })

        if (operation.done) {
          break
        }

        // Check timeout
        if (Date.now() - startTime > maxWaitTime) {
          return NextResponse.json(
            { error: 'Operation timeout', done: false, operation },
            { status: 408 }
          )
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval))
      } catch (pollError) {
        // If we get an error, it might be because the operation object format is wrong
        // Let's try a different approach - maybe the SDK has a method that accepts just the name string
        console.error('Error polling operation:', pollError)
        
        // Try alternative: maybe operations.get accepts name directly
        try {
          operation = await (ai.operations as any).get(operationName)
          if (operation && operation.done) {
            break
          }
        } catch (altError) {
          // If that also fails, return the error
          return NextResponse.json(
            { 
              error: `Failed to poll operation: ${pollError instanceof Error ? pollError.message : String(pollError)}`,
              details: process.env.NODE_ENV === 'development' ? String(pollError) : undefined
            },
            { status: 500 }
          )
        }

        // Check timeout
        if (Date.now() - startTime > maxWaitTime) {
          return NextResponse.json(
            { error: 'Operation timeout', done: false },
            { status: 408 }
          )
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval))
      }
    }

    return NextResponse.json({
      done: operation.done || false,
      error: operation.error || null,
      response: operation.response || null,
    })
  } catch (error) {
    console.error('Error in poll-upload-status:', error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : 'Unknown error',
        details: process.env.NODE_ENV === 'development' ? String(error) : undefined
      },
      { status: 500 }
    )
  }
}

