
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'

const WINSTON_API_KEY = process.env.WINSTON_API_KEY

export async function POST(request: NextRequest) {
    try {
        const { thesisId } = await request.json()

        if (!thesisId) {
            return NextResponse.json(
                { error: 'Thesis ID is required' },
                { status: 400 }
            )
        }

        if (!WINSTON_API_KEY) {
            console.error('WINSTON_API_KEY environment variable is not set')
            return NextResponse.json(
                { error: 'Winston API key not configured. Please set WINSTON_API_KEY environment variable.' },
                { status: 500 }
            )
        }

        console.log(`Winston check starting for thesis ${thesisId}, API key present: ${WINSTON_API_KEY.substring(0, 8)}...`)

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

        console.log(`Checking text (${plainText.length} characters) with Winston API`)

        // Winston supports up to 100k chars for basic, more for enterprise. 
        // Assuming text fits or we might need to chunk if very large. 
        // Docs said "Maximum 150 000 characters per request." - typically enough for a thesis or at least a large chunk.
        // If > 150k, we might need to truncate or chunk. For now, let's truncate to 150k to be safe.

        const maxChars = 150000
        if (plainText.length > maxChars) {
            console.warn(`Text length (${plainText.length}) exceeds Winston limit. Truncating to ${maxChars}.`)
            plainText = plainText.substring(0, maxChars)
        }

        try {
            const response = await fetch('https://api.gowinston.ai/v2/ai-content-detection', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${WINSTON_API_KEY}`,
                },
                body: JSON.stringify({
                    text: plainText,
                    version: 'latest',
                    sentences: true,
                    language: 'auto'
                }),
            })

            if (!response.ok) {
                const errorText = await response.text()
                console.error(`Winston API error: ${response.status} ${response.statusText}`, errorText)
                throw new Error(`Winston API error: ${response.status} ${response.statusText}`)
            }

            const data = await response.json()
            console.log(`Winston response score: ${data.score}`)

            const result = {
                score: data.score, // 0-100 human score
                isHumanWritten: data.score,
                isGptGenerated: 100 - data.score,
                feedbackMessage: `Human Score: ${data.score}%`,
                wordsCount: plainText.length / 5, // Rough estimate or use actual count
                sentences: data.sentences,
                checkedAt: new Date().toISOString(),
            }

            // Update thesis metadata
            const existingMetadata = (thesis.metadata as any) || {}
            const updatedMetadata = {
                ...existingMetadata,
                winstonResult: result,
            }

            const { error: updateError } = await supabase
                .from('theses')
                .update({ metadata: updatedMetadata })
                .eq('id', thesisId)

            if (updateError) {
                console.error('Error updating thesis metadata:', updateError)
                return NextResponse.json(
                    { error: 'Failed to save Winston result' },
                    { status: 500 }
                )
            }

            return NextResponse.json({ success: true, result })

        } catch (error: any) {
            console.error('Error checking Winston:', error)
            return NextResponse.json(
                { error: error.message || 'Error communicating with Winston API' },
                { status: 500 }
            )
        }

    } catch (error) {
        console.error('Error in check-winston route:', error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        )
    }
}
