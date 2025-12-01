import { Worker, Job } from 'bullmq'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { GoogleGenAI } from '@google/genai'
import { PythonBridge } from './lib/python-bridge'
import { CitationBuilder } from './lib/citation-builder'
import { ThesisAssembler } from './lib/thesis-assembler'
import { runResearchPipeline, ThesisData as ResearchThesisData } from './lib/research-pipeline'
import IORedis from 'ioredis'
import http from 'http'

// Environment validation
const GEMINI_KEY = process.env.GEMINI_KEY
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!GEMINI_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required environment variables:')
    console.error(`  GEMINI_KEY: ${GEMINI_KEY ? 'SET' : 'MISSING'}`)
    console.error(`  SUPABASE_URL: ${SUPABASE_URL ? 'SET' : 'MISSING'}`)
    console.error(`  SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY ? 'SET' : 'MISSING'}`)
    process.exit(1)
}

// Initialize clients
const ai = new GoogleGenAI({ apiKey: GEMINI_KEY })
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Redis connection
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
})

// Job data interface - matches ThesisGenerationJob from lib/queue.ts
interface ThesisJob {
    thesisId: string
    thesisData: {
        title: string
        topic: string
        field: string
        thesisType: string
        researchQuestion: string
        citationStyle: string
        targetLength: number
        lengthUnit: string
        outline: any[]
        fileSearchStoreId: string
        language: string
        mandatorySources: string[]
    }
}

console.log('Starting DSPy Thesis Worker...')
console.log(`  Gemini API: ${GEMINI_KEY ? 'Configured' : 'Missing'}`)
console.log(`  Supabase: ${SUPABASE_URL ? 'Configured' : 'Missing'}`)

const worker = new Worker('thesis-generation', async (job: Job<ThesisJob>) => {
    const { data } = job
    const { thesisData } = data
    console.log(`Processing job ${job.id} for thesis ${data.thesisId}`)
    console.log(`  Title: ${thesisData.title}`)
    console.log(`  Field: ${thesisData.field}`)
    console.log(`  Type: ${thesisData.thesisType}`)
    console.log(`  Target: ${thesisData.targetLength} ${thesisData.lengthUnit}`)

    try {
        // ============================================
        // PHASE 0: Research Pipeline
        // ============================================
        // Search academic databases, rank sources, upload PDFs to FileSearchStore
        await job.updateProgress({ stage: 'research', progress: 0, message: 'Starting research pipeline...' })

        const researchData: ResearchThesisData = {
            title: thesisData.title,
            topic: thesisData.topic,
            field: thesisData.field,
            thesisType: thesisData.thesisType,
            researchQuestion: thesisData.researchQuestion,
            citationStyle: thesisData.citationStyle,
            targetLength: thesisData.targetLength,
            lengthUnit: thesisData.lengthUnit,
            outline: thesisData.outline,
            fileSearchStoreId: thesisData.fileSearchStoreId,
            language: (thesisData.language as 'german' | 'english') || 'german',
        }

        const researchResult = await runResearchPipeline(
            ai,
            supabase,
            data.thesisId,
            researchData,
            async (stage, progress, message) => {
                await job.updateProgress({ stage, progress, message })
            }
        )

        console.log(`[Research] Complete: ${researchResult.uploadedCount} sources uploaded to FileSearchStore`)
        await job.updateProgress({ stage: 'research', progress: 100, message: `Research complete: ${researchResult.uploadedCount} sources` })

        // ============================================
        // PHASE 1: Generation (DSPy)
        // ============================================
        await job.updateProgress({ stage: 'generation', progress: 0, message: 'Starting AI generation...' })
        const pythonBridge = new PythonBridge()

        // Build specifications object for Python pipeline
        const specifications = {
            targetLength: thesisData.targetLength,
            lengthUnit: thesisData.lengthUnit,
            citationStyle: thesisData.citationStyle,
            field: thesisData.field,
            thesisType: thesisData.thesisType,
            language: thesisData.language,
            title: thesisData.title,
        }

        console.log('Running generation pipeline...')
        const generationResult = await pythonBridge.runPipeline('generation', {
            outline: thesisData.outline,
            research_question: thesisData.researchQuestion,
            specifications,
            mandatory_sources: thesisData.mandatorySources,
            filesearch_store_id: thesisData.fileSearchStoreId
        })

        await job.updateProgress({ stage: 'generation', progress: 100, message: 'Generation complete' })

        // 2. Humanization Phase
        await job.updateProgress({ stage: 'humanization', progress: 0, message: 'Humanizing content...' })

        const humanizationResult = await pythonBridge.runPipeline('humanization', {
            thesis_text: generationResult.thesis_text,
            citations: generationResult.citations,
            max_iterations: 5,
            target_score: 70
        })

        await job.updateProgress({ stage: 'humanization', progress: 100, message: 'Humanization complete' })

        // 3. Citation Building
        await job.updateProgress({ stage: 'citations', progress: 0, message: 'Formatting citations...' })

        const citationBuilder = new CitationBuilder()
        const bibliography = citationBuilder.buildBibliography(
            generationResult.citations,
            thesisData.citationStyle
        )

        // TODO: Implement in-text citation formatting if needed
        // For now, we assume the AI output has placeholders or correct format
        // But we might need to post-process footnotes for Deutsche Zitierweise

        await job.updateProgress({ stage: 'citations', progress: 100, message: 'Citations formatted' })

        // 4. Assembly
        await job.updateProgress({ stage: 'assembly', progress: 0, message: 'Assembling final document...' })

        const assembler = new ThesisAssembler()
        const finalThesis = assembler.assemble({
            outline: thesisData.outline,
            mainText: humanizationResult.humanized_text,
            bibliography: bibliography,
            metadata: {
                title: thesisData.title,
                date: new Date().toISOString()
            }
        })

        await job.updateProgress({ stage: 'assembly', progress: 100, message: 'Assembly complete' })

        // ============================================
        // PHASE 5: Save to Database
        // ============================================
        await job.updateProgress({ stage: 'saving', progress: 0, message: 'Saving to database...' })

        await supabase
            .from('theses')
            .update({
                latex_content: finalThesis, // Markdown content (named latex_content for legacy reasons)
                status: 'completed',
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                metadata: {
                    word_count: generationResult.word_count,
                    zerogpt_score: humanizationResult.final_score?.human_percentage || 0,
                    validation: generationResult.validation,
                    humanization_iterations: humanizationResult.iterations,
                    citations: generationResult.citations,
                    research_stats: {
                        sources_found: researchResult.totalFound,
                        sources_uploaded: researchResult.uploadedCount,
                    }
                }
            })
            .eq('id', data.thesisId)

        console.log(`Thesis ${data.thesisId} saved to database`)
        await job.updateProgress({ stage: 'saving', progress: 100, message: 'Thesis saved successfully!' })

        return {
            thesisId: data.thesisId,
            wordCount: generationResult.word_count,
            zerogptScore: humanizationResult.final_score,
            validation: generationResult.validation
        }

    } catch (error) {
        console.error(`Job ${job.id} failed:`, error)

        // Update status to failed in DB
        await supabase
            .from('theses')
            .update({
                status: 'failed',
                updated_at: new Date().toISOString(),
                metadata: {
                    error_message: error instanceof Error ? error.message : 'Unknown error',
                    error_stack: error instanceof Error ? error.stack : undefined,
                    failed_at: new Date().toISOString()
                }
            })
            .eq('id', data.thesisId)

        throw error
    }
}, {
    connection,
    concurrency: 1,
    lockDuration: 1800000 // 30 minutes lock (thesis generation can take a while)
})

worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed!`)
})

worker.on('failed', (job, err) => {
    console.log(`Job ${job?.id} failed with ${err.message}`)
})

// ============================================
// HTTP Server for Render Health Checks
// ============================================
const PORT = parseInt(process.env.PORT || '10000', 10)

const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            status: 'healthy',
            service: 'thesis-worker',
            timestamp: new Date().toISOString(),
            worker: {
                running: worker.isRunning(),
                paused: worker.isPaused(),
            }
        }))
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
    }
})

server.listen(PORT, () => {
    console.log(`Health check server listening on port ${PORT}`)
})
