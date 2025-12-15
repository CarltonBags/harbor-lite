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
      console.error('RAPIDAPI_KEY environment variable is not set')
      return NextResponse.json(
        { error: 'ZeroGPT API key not configured. Please set RAPIDAPI_KEY environment variable.' },
        { status: 500 }
      )
    }
    
    console.log(`ZeroGPT check starting for thesis ${thesisId}, API key present: ${RAPIDAPI_KEY.substring(0, 8)}...`)

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

    // ZeroGPT API has a limit of ~50k characters per request
    // Split text into chunks if it's too long
    const MAX_TEXT_LENGTH = 45000 // Use 45k to leave buffer
    const chunks: string[] = []
    
    if (plainText.length > MAX_TEXT_LENGTH) {
      console.log(`Text too long (${plainText.length} chars), splitting into chunks...`)
      
      // Split text intelligently: paragraphs -> sentences -> words
      let currentChunk = ''
      
      // First, try splitting by paragraphs (double newlines)
      const paragraphs = plainText.split(/\n\n+/)
      
      for (const paragraph of paragraphs) {
        // If adding this paragraph would exceed limit
        if ((currentChunk + '\n\n' + paragraph).length > MAX_TEXT_LENGTH) {
          // If current chunk has content, save it
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trim())
            currentChunk = ''
          }
          
          // If paragraph itself is too long, split by sentences
          if (paragraph.length > MAX_TEXT_LENGTH) {
            const sentences = paragraph.split(/([.!?]\s+)/)
            for (const sentence of sentences) {
              if ((currentChunk + sentence).length <= MAX_TEXT_LENGTH) {
                currentChunk += sentence
              } else {
                if (currentChunk.trim()) {
                  chunks.push(currentChunk.trim())
                }
                // If sentence is still too long, split by words
                if (sentence.length > MAX_TEXT_LENGTH) {
                  const words = sentence.split(/\s+/)
                  let wordChunk = ''
                  for (const word of words) {
                    if ((wordChunk + ' ' + word).length <= MAX_TEXT_LENGTH) {
                      wordChunk += (wordChunk ? ' ' : '') + word
                    } else {
                      if (wordChunk.trim()) chunks.push(wordChunk.trim())
                      wordChunk = word
                    }
                  }
                  currentChunk = wordChunk
                } else {
                  currentChunk = sentence
                }
              }
            }
          } else {
            currentChunk = paragraph
          }
        } else {
          currentChunk += (currentChunk ? '\n\n' : '') + paragraph
        }
      }
      
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim())
      }
      
      console.log(`Split into ${chunks.length} chunks (sizes: ${chunks.map(c => c.length).join(', ')})`)
    } else {
      chunks.push(plainText)
    }

    // Check each chunk and combine results
    const chunkResults: Array<{
      isHumanWritten: number
      isGptGenerated: number
      wordsCount: number
      feedbackMessage?: string
    }> = []
    const chunkErrors: Array<{ index: number; status?: number; statusText?: string; errorText?: string }> = []

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      console.log(`Checking chunk ${i + 1}/${chunks.length} (${chunk.length} chars)...`)

      try {
        console.log(`Making API request to ZeroGPT...`)
        const response = await fetch('https://zerogpt.p.rapidapi.com/api/v1/detectText', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-RapidAPI-Key': RAPIDAPI_KEY!,
            'X-RapidAPI-Host': 'zerogpt.p.rapidapi.com',
          },
          body: JSON.stringify({
            input_text: chunk,
          }),
        })

        console.log(`ZeroGPT response status: ${response.status}`)

        if (!response.ok) {
          let errorData: any = {}
          let errorText = ''
          try {
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
          
          console.error(`ZeroGPT API error for chunk ${i + 1}:`, {
            status: response.status,
            statusText: response.statusText,
            errorText,
            errorData,
            chunkLength: chunk.length,
          })

          chunkErrors.push({
            index: i + 1,
            status: response.status,
            statusText: response.statusText,
            errorText,
          })
          
          // Continue with other chunks even if one fails
          continue
        }

        let data: any
        try {
          data = await response.json()
          console.log(`ZeroGPT response data:`, JSON.stringify(data).substring(0, 200))
        } catch (e) {
          console.error(`Failed to parse ZeroGPT response for chunk ${i + 1}:`, e)
          continue
        }

        // Check for error in response body (not just HTTP status)
        if (data.error) {
          console.error(`ZeroGPT API returned error for chunk ${i + 1}:`, data.error)
          chunkErrors.push({
            index: i + 1,
            errorText: typeof data.error === 'string' ? data.error : JSON.stringify(data.error),
          })
          continue
        }

        if (data.success && data.data) {
          console.log(`Chunk ${i + 1} result: ${data.data.is_human_written}% human`)
          chunkResults.push({
            isHumanWritten: data.data.is_human_written || 0,
            isGptGenerated: data.data.is_gpt_generated || 0,
            wordsCount: data.data.words_count || 0,
            feedbackMessage: data.data.feedback_message || '',
          })
        } else {
          console.error(`Unexpected response format for chunk ${i + 1}:`, data)
        }
      } catch (error) {
        console.error(`Error checking chunk ${i + 1}:`, error)
        // Continue with other chunks
      }
    }

    if (chunkResults.length === 0) {
      console.error('All ZeroGPT chunks failed. Possible causes: invalid API key, rate limit, or API down.')
      console.error(`RAPIDAPI_KEY present: ${!!RAPIDAPI_KEY}`)
      console.error(`RAPIDAPI_KEY prefix: ${RAPIDAPI_KEY?.substring(0, 10)}...`)
      if (chunkErrors.length) {
        console.error('Chunk errors:', chunkErrors)
      }

      // Provide more helpful error message
      return NextResponse.json(
        { 
          error: 'Failed to check any chunks with ZeroGPT API',
          details: 'Check server logs for details. Common causes: invalid RAPIDAPI_KEY, rate limit exceeded, or API service down.',
          apiKeyPresent: !!RAPIDAPI_KEY,
          chunkErrors,
        },
        { status: 500 }
      )
    }

    // Combine results: average percentages, sum word counts
    const totalWords = chunkResults.reduce((sum, r) => sum + r.wordsCount, 0)
    const weightedHuman = chunkResults.reduce((sum, r) => sum + (r.isHumanWritten * r.wordsCount), 0) / totalWords
    const weightedGpt = chunkResults.reduce((sum, r) => sum + (r.isGptGenerated * r.wordsCount), 0) / totalWords

    // Combine feedback messages if available
    const feedbackMessages = chunkResults
      .map(r => r.feedbackMessage)
      .filter(msg => msg && msg.trim())
      .filter((msg, index, arr) => arr.indexOf(msg) === index) // Remove duplicates
    
    const result = {
      isHumanWritten: Math.round(weightedHuman),
      isGptGenerated: Math.round(weightedGpt),
      feedbackMessage: chunks.length > 1 
        ? `Text wurde in ${chunks.length} Teile aufgeteilt und geprüft.${feedbackMessages.length > 0 ? ' ' + feedbackMessages[0] : ''}`
        : (chunkResults[0]?.feedbackMessage || ''),
      wordsCount: totalWords,
      checkedAt: new Date().toISOString(),
    }

    console.log(`ZeroGPT check completed: ${chunks.length} chunk(s), ${result.isHumanWritten}% human, ${result.isGptGenerated}% AI`)

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
  } catch (error) {
    console.error('Error checking ZeroGPT:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

