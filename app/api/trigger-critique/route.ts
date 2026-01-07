import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'
import { thesisQueue, type ThesisGenerationJob } from '@/lib/queue'

/**
 * API endpoint to trigger manual critique and repair on an EXISTING thesis (Skip Generation)
 */
export async function POST(request: Request) {
    try {
        const { thesisId } = await request.json()

        if (!thesisId) {
            return NextResponse.json(
                { error: 'Thesis ID is required' },
                { status: 400 }
            )
        }

        // Get thesis data using server-side client
        const supabase = createSupabaseServerClient()
        const { data: thesis, error: thesisError } = await supabase
            .from('theses')
            .select('*')
            .eq('id', thesisId)
            .single()

        if (thesisError || !thesis) {
            return NextResponse.json(
                { error: 'Thesis not found' },
                { status: 404 }
            )
        }

        if (!thesis.content || thesis.content.length < 100) {
            return NextResponse.json(
                { error: 'Thesis has no content to critique. Generate it first.' },
                { status: 400 }
            )
        }

        // Update thesis status to 'generating' (or 'critiquing' if we had that status, but generating is safer for UI)
        const { error: statusUpdateError } = await supabase
            .from('theses')
            .update({ status: 'generating' }) // Use generating to show spinner in UI
            .eq('id', thesisId)

        if (statusUpdateError) {
            console.error('Error updating thesis status:', statusUpdateError)
        }

        const jobData: any = {
            thesisId,
            thesisData: {
                title: thesis.title || thesis.topic,
                topic: thesis.topic,
                field: thesis.field,
                thesisType: thesis.thesis_type,
                researchQuestion: thesis.research_question,
                citationStyle: thesis.citation_style,
                targetLength: thesis.target_length,
                lengthUnit: thesis.length_unit,
                outline: thesis.outline,
                fileSearchStoreId: thesis.file_search_store_id, // Important for citation check
                language: thesis.metadata?.language || 'german',
                mandatorySources: [], // Not needed for critique only
            },
            critiqueOnly: true // <--- THE KEY FLAG
        }

        const job = await thesisQueue.add('generate-thesis', jobData, {
            jobId: `critique-${thesisId}-${Date.now()}`, // Unique ID for this run
            removeOnComplete: true,
            removeOnFail: false,
        })

        console.log('Added manual critique job:', { jobId: job.id, thesisId })

        return NextResponse.json({
            success: true,
            jobId: job.id,
            message: 'Critique job queued',
        })

    } catch (error) {
        console.error('Error triggering critique:', error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        )
    }
}
