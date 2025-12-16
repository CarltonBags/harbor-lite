import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'

const GRAMMARLY_ACCESS_TOKEN = process.env.GRAMMARLY_ACCESS_TOKEN
const GRAMMARLY_API_BASE = 'https://api.grammarly.com/ecosystem/api/v1/plagiarism'

interface PlagiarismScoreRequest {
  filename: string
}

interface PlagiarismScoreResponse {
  score_request_id: string
  file_upload_url: string
}

interface PlagiarismStatusResponse {
  score_request_id: string
  status: 'PENDING' | 'FAILED' | 'COMPLETED'
  updated_at: string
  score?: {
    originality: number
  }
}

export async function POST(request: NextRequest) {
  try {
    const { thesisId } = await request.json()

    if (!thesisId) {
      return NextResponse.json(
        { error: 'Thesis ID is required' },
        { status: 400 }
      )
    }

    if (!GRAMMARLY_ACCESS_TOKEN) {
      console.error('GRAMMARLY_ACCESS_TOKEN environment variable is not set')
      return NextResponse.json(
        { error: 'Grammarly API key not configured. Please set GRAMMARLY_ACCESS_TOKEN environment variable.' },
        { status: 500 }
      )
    }

    console.log(`Plagiarism check starting for thesis ${thesisId}`)

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

    // Extract plain text from markdown (similar to ZeroGPT)
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
        { error: 'Text too short for plagiarism detection (minimum 30 words)' },
        { status: 400 }
      )
    }

    // Check constraints
    const MAX_TEXT_LENGTH = 100000 // 100k characters
    const MAX_FILE_SIZE = 4 * 1024 * 1024 // 4 MB

    if (plainText.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `Text too long (${plainText.length} chars). Maximum is 100,000 characters.` },
        { status: 400 }
      )
    }

    // Convert text to buffer for size check
    const textBuffer = Buffer.from(plainText, 'utf-8')
    if (textBuffer.length > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `Text too large (${textBuffer.length} bytes). Maximum is 4 MB.` },
        { status: 400 }
      )
    }

    // Step 1: Create score request
    console.log('Creating plagiarism score request...')
    const scoreRequest: PlagiarismScoreRequest = {
      filename: `thesis-${thesisId}.txt`,
    }

    const createResponse = await fetch(GRAMMARLY_API_BASE, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GRAMMARLY_ACCESS_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'user-agent': 'StudyFucker API client',
      },
      body: JSON.stringify(scoreRequest),
    })

    if (!createResponse.ok) {
      const errorText = await createResponse.text()
      console.error('Grammarly API error creating score request:', {
        status: createResponse.status,
        statusText: createResponse.statusText,
        errorText,
      })
      return NextResponse.json(
        { 
          error: 'Failed to create plagiarism check request',
          details: errorText,
        },
        { status: createResponse.status }
      )
    }

    const scoreRequestData: PlagiarismScoreResponse = await createResponse.json()
    console.log('Score request created:', scoreRequestData.score_request_id)

    // Step 2: Upload file to pre-signed URL (must be within 120 seconds)
    console.log('Uploading document to Grammarly...')
    const uploadResponse = await fetch(scoreRequestData.file_upload_url, {
      method: 'PUT',
      body: textBuffer,
      headers: {
        'Content-Type': 'text/plain',
      },
    })

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text()
      console.error('Grammarly upload error:', {
        status: uploadResponse.status,
        statusText: uploadResponse.statusText,
        errorText,
      })
      return NextResponse.json(
        { 
          error: 'Failed to upload document for plagiarism check',
          details: errorText,
        },
        { status: uploadResponse.status }
      )
    }

    console.log('Document uploaded successfully')

    // Step 3: Poll for results (with exponential backoff)
    const MAX_POLL_ATTEMPTS = 30 // Max 30 attempts
    const INITIAL_POLL_DELAY = 2000 // Start with 2 seconds
    let pollAttempt = 0
    let statusResponse: PlagiarismStatusResponse | null = null

    while (pollAttempt < MAX_POLL_ATTEMPTS) {
      // Exponential backoff: 2s, 4s, 8s, 16s, then cap at 10s
      const pollDelay = Math.min(INITIAL_POLL_DELAY * Math.pow(2, pollAttempt), 10000)
      
      if (pollAttempt > 0) {
        console.log(`Polling attempt ${pollAttempt + 1}/${MAX_POLL_ATTEMPTS} after ${pollDelay}ms...`)
        await new Promise(resolve => setTimeout(resolve, pollDelay))
      }

      const statusResponse_fetch = await fetch(
        `${GRAMMARLY_API_BASE}/${scoreRequestData.score_request_id}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${GRAMMARLY_ACCESS_TOKEN}`,
            'Accept': 'application/json',
            'user-agent': 'StudyFucker API client',
          },
        }
      )

      if (!statusResponse_fetch.ok) {
        const errorText = await statusResponse_fetch.text()
        console.error('Grammarly status check error:', {
          status: statusResponse_fetch.status,
          statusText: statusResponse_fetch.statusText,
          errorText,
        })
        pollAttempt++
        continue
      }

      statusResponse = await statusResponse_fetch.json() as PlagiarismStatusResponse
      console.log(`Status: ${statusResponse.status}`)

      if (statusResponse.status === 'COMPLETED') {
        break
      } else if (statusResponse.status === 'FAILED') {
        return NextResponse.json(
          { 
            error: 'Plagiarism check failed',
            details: 'The Grammarly API reported a FAILED status. This may be due to file size, text length, or format issues.',
            scoreRequestId: scoreRequestData.score_request_id,
          },
          { status: 500 }
        )
      }

      // Still PENDING, continue polling
      pollAttempt++
    }

    if (!statusResponse || statusResponse.status !== 'COMPLETED') {
      return NextResponse.json(
        { 
          error: 'Plagiarism check timed out',
          details: `Status check did not complete within ${MAX_POLL_ATTEMPTS} attempts. The check may still be processing.`,
          scoreRequestId: scoreRequestData.score_request_id,
          lastStatus: statusResponse?.status,
        },
        { status: 504 }
      )
    }

    if (!statusResponse.score || statusResponse.score.originality === undefined) {
      return NextResponse.json(
        { 
          error: 'Plagiarism check completed but no score available',
          details: 'The document may be too short (minimum 30 words) or there was an issue processing it.',
          scoreRequestId: scoreRequestData.score_request_id,
        },
        { status: 500 }
      )
    }

    const originalityScore = statusResponse.score.originality
    const plagiarismPercentage = Math.round((1 - originalityScore) * 100)
    const originalityPercentage = Math.round(originalityScore * 100)

    console.log(`Plagiarism check completed: ${originalityPercentage}% original, ${plagiarismPercentage}% potentially plagiarized`)

    const result = {
      originality: originalityScore,
      originalityPercentage,
      plagiarismPercentage,
      scoreRequestId: scoreRequestData.score_request_id,
      checkedAt: new Date().toISOString(),
    }

    // Update thesis metadata with plagiarism result
    const existingMetadata = (thesis.metadata as any) || {}
    const updatedMetadata = {
      ...existingMetadata,
      plagiarismResult: result,
    }

    const { error: updateError } = await supabase
      .from('theses')
      .update({ metadata: updatedMetadata })
      .eq('id', thesisId)

    if (updateError) {
      console.error('Error updating thesis metadata:', updateError)
      return NextResponse.json(
        { error: 'Failed to save plagiarism result' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, result })
  } catch (error) {
    console.error('Error checking plagiarism:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

