import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY

export async function POST(request: NextRequest) {
  try {
    const { thesisId } = await request.json()

    if (!thesisId) {
      return NextResponse.json(
        { error: 'Thesis ID is required' },
        { status: 400 }
      )
    }

    if (!RAPIDAPI_KEY) {
      return NextResponse.json(
        { error: 'ZeroGPT API key not configured' },
        { status: 500 }
      )
    }

    // Get thesis content
    const supabase = createSupabaseServerClient()
    const { data: thesis, error: thesisError } = await supabase
      .from('theses')
      .select('latex_content, metadata')
      .eq('id', thesisId)
      .single()

    if (thesisError || !thesis) {
      return NextResponse.json(
        { error: 'Thesis not found' },
        { status: 404 }
      )
    }

    if (!thesis.latex_content) {
      return NextResponse.json(
        { error: 'Thesis content is empty' },
        { status: 400 }
      )
    }

    // Extract plain text from markdown
    let plainText = thesis.latex_content
      .replace(/^#+\s+/gm, '') // Remove headings
      .replace(/\*\*(.+?)\*\*/g, '$1') // Remove bold
      .replace(/\*(.+?)\*/g, '$1') // Remove italic
      .replace(/\[(.+?)\]\(.+?\)/g, '$1') // Remove links
      .replace(/`(.+?)`/g, '$1') // Remove code
      .replace(/\^\d+/g, '') // Remove footnote markers
      .replace(/\n{3,}/g, '\n\n') // Normalize multiple newlines
      .trim()

    if (plainText.length < 50) {
      return NextResponse.json(
        { error: 'Text too short for detection' },
        { status: 400 }
      )
    }

    // ZeroGPT API has a limit, truncate to ~50k characters if needed
    const MAX_TEXT_LENGTH = 50000
    if (plainText.length > MAX_TEXT_LENGTH) {
      console.warn(`Text too long (${plainText.length} chars), truncating to ${MAX_TEXT_LENGTH}`)
      plainText = plainText.substring(0, MAX_TEXT_LENGTH)
    }

    // Call ZeroGPT API
    const response = await fetch('https://zerogpt.p.rapidapi.com/api/v1/detectText', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-RapidAPI-Key': RAPIDAPI_KEY!,
        'X-RapidAPI-Host': 'zerogpt.p.rapidapi.com',
      },
      body: JSON.stringify({
        input_text: plainText,
      }),
    })

    if (!response.ok) {
      let errorData: any = {}
      let errorText = ''
      try {
        // Try to parse as JSON first
        const contentType = response.headers.get('content-type')
        if (contentType && contentType.includes('application/json')) {
          errorData = await response.json()
          errorText = JSON.stringify(errorData, null, 2)
        } else {
          errorText = await response.text()
        }
      } catch (e) {
        errorText = 'Could not read error response'
      }
      
      console.error('ZeroGPT API error:', {
        status: response.status,
        statusText: response.statusText,
        errorText,
        errorData,
        textLength: plainText.length,
        textPreview: plainText.substring(0, 200),
      })
      
      // Return more detailed error
      return NextResponse.json(
        { 
          error: `ZeroGPT API error: ${response.status} ${response.statusText}`,
          details: errorData.message || errorData.error || errorText,
          fullError: errorData,
          textLength: plainText.length,
        },
        { status: response.status }
      )
    }

    let data: any
    try {
      data = await response.json()
    } catch (e) {
      console.error('Failed to parse ZeroGPT response as JSON:', e)
      return NextResponse.json(
        { error: 'Invalid JSON response from ZeroGPT API' },
        { status: 500 }
      )
    }

    console.log('ZeroGPT API response:', JSON.stringify(data, null, 2))

    // Check if response indicates an error
    if (data.error || data.message) {
      return NextResponse.json(
        { 
          error: data.error || data.message || 'ZeroGPT API returned an error',
          details: data,
        },
        { status: 400 }
      )
    }

    if (data.success && data.data) {
      const result = {
        isHumanWritten: data.data.is_human_written || 0,
        isGptGenerated: data.data.is_gpt_generated || 0,
        feedbackMessage: data.data.feedback_message || '',
        wordsCount: data.data.words_count || 0,
        checkedAt: new Date().toISOString(),
      }

      // Update thesis metadata with ZeroGPT result
      const existingMetadata = (thesis.metadata as any) || {}
      const updatedMetadata = {
        ...existingMetadata,
        zeroGptResult: result,
      }

      const { error: updateError } = await supabase
        .from('theses')
        .update({ metadata: updatedMetadata })
        .eq('id', thesisId)

      if (updateError) {
        console.error('Error updating thesis metadata:', updateError)
        return NextResponse.json(
          { error: 'Failed to save ZeroGPT result' },
          { status: 500 }
        )
      }

      return NextResponse.json({ success: true, result })
    } else {
      console.error('Invalid ZeroGPT response format:', data)
      return NextResponse.json(
        { 
          error: 'Invalid response from ZeroGPT API',
          details: data,
        },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Error checking ZeroGPT:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

