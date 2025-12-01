/**
 * Research Pipeline Module
 * 
 * Handles the complete research phase:
 * 1. Generate search queries (2 per chapter, German + English)
 * 2. Query OpenAlex API
 * 3. Query Semantic Scholar API
 * 4. Query Unpaywall for missing PDFs
 * 5. Deduplicate and enrich sources
 * 6. Rank sources by relevance using Gemini
 * 7. Download PDFs and upload to FileSearchStore
 */

import { GoogleGenAI } from '@google/genai'
import { SupabaseClient } from '@supabase/supabase-js'

// Environment variables
const OPENALEX_EMAIL = process.env.OPENALEX_EMAIL || 'moontoolsinc@proton.me'
const SEMANTIC_SCHOLAR_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY

// Types
export interface Source {
    title: string
    authors: string[]
    year: number | null
    doi: string | null
    url: string | null
    pdfUrl: string | null
    abstract: string | null
    journal: string | null
    publisher: string | null
    citationCount: number | null
    relevanceScore?: number
    source: 'openalex' | 'semantic_scholar'
    chapterNumber?: string
    chapterTitle?: string
    mandatory?: boolean
}

export interface ThesisData {
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
    language: 'german' | 'english'
}

export interface ResearchResult {
    sources: Source[]
    uploadedCount: number
    totalFound: number
}

// Retry wrapper for API calls
async function retryApiCall<T>(
    fn: () => Promise<T>,
    operationName: string,
    maxRetries: number = 3,
    baseDelay: number = 1000
): Promise<T> {
    let lastError: Error | unknown

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn()
        } catch (error) {
            lastError = error
            const isLastAttempt = attempt === maxRetries

            if (isLastAttempt) {
                console.error(`${operationName} failed after ${maxRetries} attempts:`, error)
                throw error
            }

            const delay = baseDelay * Math.pow(2, attempt - 1)
            console.warn(`${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`)
            await new Promise(resolve => setTimeout(resolve, delay))
        }
    }

    throw lastError
}

/**
 * Step 1: Generate search queries (2 per chapter, German + English)
 */
async function generateSearchQueries(
    ai: GoogleGenAI,
    thesisData: ThesisData
): Promise<{ chapter: string; chapterTitle: string; queries: { german: string[]; english: string[] } }[]> {
    console.log('[Research] Step 1: Generating search queries...')

    const prompt = `Du bist ein Experte für wissenschaftliche Literaturrecherche. Erstelle für jedes Kapitel der folgenden Thesis-Gliederung genau 2 Suchanfragen auf Deutsch und 2 Suchanfragen auf Englisch.

**Thesis-Informationen:**
- Titel/Thema: ${thesisData.title}
- Fachbereich: ${thesisData.field}
- Forschungsfrage: ${thesisData.researchQuestion}
- Sprache: ${thesisData.language}

**Gliederung:**
${JSON.stringify(thesisData.outline, null, 2)}

**Aufgabe:**
Erstelle für JEDES Kapitel (nicht für Unterabschnitte) genau 2 Suchanfragen auf Deutsch und 2 auf Englisch. Die Suchanfragen sollten:
1. Spezifisch und präzise sein - verwende natürliche Sprache
2. Fachbegriffe und relevante Konzepte enthalten
3. Für wissenschaftliche Datenbanken (OpenAlex, Semantic Scholar) geeignet sein
4. Verschiedene Aspekte des Kapitels abdecken
5. Kurz und fokussiert sein (2-5 Wörter oder kurze Phrasen)

**Format:**
Antworte NUR mit einem JSON-Objekt im folgenden Format:
{
  "queries": [
    {
      "chapterNumber": "1",
      "chapterTitle": "Einleitung",
      "queries": {
        "german": ["Suchanfrage 1 DE", "Suchanfrage 2 DE"],
        "english": ["Query 1 EN", "Query 2 EN"]
      }
    }
  ]
}`

    const response = await retryApiCall(
        () => ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        }),
        'Generate search queries'
    )

    const content = response.text
    if (!content) {
        throw new Error('No content from Gemini API')
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
        throw new Error('Invalid JSON response from Gemini')
    }

    const parsed = JSON.parse(jsonMatch[0])
    const queries = parsed.queries || []
    console.log(`[Research] Generated queries for ${queries.length} chapters`)

    return queries.map((q: any) => ({
        chapter: q.chapterNumber || q.chapter || '',
        chapterTitle: q.chapterTitle || '',
        queries: q.queries || { german: [], english: [] }
    }))
}

/**
 * Step 2: Query OpenAlex API
 */
async function queryOpenAlex(query: string, language: 'german' | 'english'): Promise<Source[]> {
    console.log(`[OpenAlex] Querying: "${query}" (${language})`)
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=20&mailto=${encodeURIComponent(OPENALEX_EMAIL)}`

    try {
        const response = await retryApiCall(
            () => fetch(url),
            `Query OpenAlex: ${query}`
        )

        if (!response.ok) {
            console.error(`[OpenAlex] ERROR: ${response.status} ${response.statusText}`)
            return []
        }

        const data = await response.json() as any
        const works = data.results || []
        console.log(`[OpenAlex] Found ${works.length} results for "${query}"`)

        return works.map((work: any): Source => ({
            title: work.title || 'Untitled',
            authors: (work.authorships || []).map((a: any) => a.author?.display_name || '').filter(Boolean),
            year: work.publication_year || null,
            doi: work.doi ? work.doi.replace('https://doi.org/', '') : null,
            url: work.primary_location?.landing_page_url || work.doi || null,
            pdfUrl: work.primary_location?.pdf_url || null,
            abstract: work.abstract || null,
            journal: work.primary_location?.source?.display_name || null,
            publisher: null,
            citationCount: work.cited_by_count || null,
            source: 'openalex',
        }))
    } catch (error) {
        console.error(`[OpenAlex] ERROR querying "${query}":`, error)
        return []
    }
}

/**
 * Step 3: Query Semantic Scholar API
 */
async function querySemanticScholar(query: string): Promise<Source[]> {
    console.log(`[SemanticScholar] Querying: "${query}"`)
    const encodedQuery = encodeURIComponent(query)
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&limit=10&fields=title,authors,year,doi,url,openAccessPdf,abstract,venue,citationCount`

    try {
        const headers: Record<string, string> = {}
        if (SEMANTIC_SCHOLAR_API_KEY) {
            headers['x-api-key'] = SEMANTIC_SCHOLAR_API_KEY
        }

        const response = await retryApiCall(
            () => fetch(url, { headers }),
            `Query Semantic Scholar: ${query}`
        )

        if (!response.ok) {
            if (response.status === 429) {
                console.error(`[SemanticScholar] Rate limit exceeded`)
            } else {
                console.error(`[SemanticScholar] ERROR: ${response.status}`)
            }
            return []
        }

        const data = await response.json() as any
        const papers = data.data || []
        console.log(`[SemanticScholar] Found ${papers.length} results for "${query}"`)

        return papers.map((paper: any): Source => ({
            title: paper.title || 'Untitled',
            authors: (paper.authors || []).map((a: any) => a.name || '').filter(Boolean),
            year: paper.year || null,
            doi: paper.doi || null,
            url: paper.url || null,
            pdfUrl: paper.openAccessPdf?.url || null,
            abstract: paper.abstract || null,
            journal: paper.venue || null,
            publisher: null,
            citationCount: paper.citationCount || null,
            source: 'semantic_scholar',
        }))
    } catch (error) {
        console.error(`[SemanticScholar] ERROR querying "${query}":`, error)
        return []
    }
}

/**
 * Step 3.5: Query Unpaywall API for PDF URLs
 */
async function queryUnpaywall(doi: string): Promise<string | null> {
    if (!doi) return null

    try {
        const cleanDoi = doi.startsWith('https://doi.org/')
            ? doi.replace('https://doi.org/', '')
            : doi.startsWith('doi:')
                ? doi.replace('doi:', '')
                : doi

        const url = `https://api.unpaywall.org/v2/${encodeURIComponent(cleanDoi)}?email=${encodeURIComponent(OPENALEX_EMAIL)}`

        const response = await fetch(url, {
            headers: {
                'User-Agent': `ThesisWorker/1.0 (mailto:${OPENALEX_EMAIL})`,
            },
        })

        if (!response.ok) {
            return null
        }

        const data = await response.json() as any

        if (data.best_oa_location?.url_for_pdf) {
            return data.best_oa_location.url_for_pdf
        }

        return null
    } catch (error) {
        return null
    }
}

/**
 * Step 4: Deduplicate and enrich sources
 */
async function deduplicateAndEnrichSources(sources: Source[]): Promise<Source[]> {
    console.log(`[Research] Step 4: Deduplicating ${sources.length} sources...`)
    const seen = new Map<string, Source>()

    for (const source of sources) {
        const key = source.doi?.toLowerCase() || source.title.toLowerCase()

        if (!seen.has(key)) {
            seen.set(key, source)
        } else {
            const existing = seen.get(key)!
            // Prefer source with PDF URL
            if (source.pdfUrl && !existing.pdfUrl) {
                seen.set(key, source)
            } else if ((source.citationCount || 0) > (existing.citationCount || 0)) {
                seen.set(key, source)
            }
        }
    }

    const deduplicated = Array.from(seen.values())
    console.log(`[Research] After deduplication: ${deduplicated.length} unique sources`)

    // Enrich sources without PDF URLs using Unpaywall
    const sourcesToEnrich = deduplicated.filter(s => !s.pdfUrl && s.doi)
    console.log(`[Research] Enriching ${sourcesToEnrich.length} sources with Unpaywall...`)

    const enrichedSources = await Promise.all(
        deduplicated.map(async (source) => {
            if (source.pdfUrl || !source.doi) {
                return source
            }

            const pdfUrl = await queryUnpaywall(source.doi)
            if (pdfUrl) {
                console.log(`[Unpaywall] Found PDF for: ${source.title.substring(0, 50)}...`)
                return { ...source, pdfUrl }
            }

            await new Promise(resolve => setTimeout(resolve, 100)) // Rate limiting
            return source
        })
    )

    const withPdf = enrichedSources.filter(s => s.pdfUrl).length
    console.log(`[Research] After enrichment: ${withPdf} sources with PDF`)

    return enrichedSources
}

/**
 * Step 5: Rank sources by relevance using Gemini
 */
async function rankSourcesByRelevance(
    ai: GoogleGenAI,
    sources: Source[],
    thesisData: ThesisData
): Promise<Source[]> {
    console.log(`[Research] Step 5: Ranking ${sources.length} sources...`)

    // Limit to top 350 for ranking
    const MAX_SOURCES_TO_RANK = 350
    let sourcesToRank = sources

    if (sources.length > MAX_SOURCES_TO_RANK) {
        sourcesToRank = [...sources]
            .sort((a, b) => {
                if (a.pdfUrl && !b.pdfUrl) return -1
                if (!a.pdfUrl && b.pdfUrl) return 1
                return (b.citationCount || 0) - (a.citationCount || 0)
            })
            .slice(0, MAX_SOURCES_TO_RANK)
    }

    // Process in batches
    const BATCH_SIZE = 50
    const batches: Source[][] = []
    for (let i = 0; i < sourcesToRank.length; i += BATCH_SIZE) {
        batches.push(sourcesToRank.slice(i, i + BATCH_SIZE))
    }

    console.log(`[Research] Processing ${batches.length} batches...`)

    const allRankings: Array<{ index: number; relevanceScore: number }> = []
    let globalIndex = 0

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex]
        console.log(`[Research] Ranking batch ${batchIndex + 1}/${batches.length}...`)

        const prompt = `Du bist ein Experte für wissenschaftliche Literaturbewertung. Bewerte die Relevanz der folgenden Quellen für diese Thesis:

**Thesis-Informationen:**
- Titel/Thema: ${thesisData.title}
- Fachbereich: ${thesisData.field}
- Forschungsfrage: ${thesisData.researchQuestion}

**Quellen:**
${JSON.stringify(
            batch.map(s => ({
                title: s.title,
                authors: s.authors.slice(0, 3),
                year: s.year,
                abstract: s.abstract ? s.abstract.substring(0, 500) : null,
                journal: s.journal,
            })),
            null,
            2
        )}

**Aufgabe:**
Bewerte jede Quelle auf einer Skala von 0-100 basierend auf ihrer Relevanz.

**Format:**
Antworte NUR mit einem JSON-Array:
[
  { "index": 0, "relevanceScore": 85 },
  { "index": 1, "relevanceScore": 42 }
]`

        try {
            const response = await retryApiCall(
                () => ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: prompt,
                }),
                `Rank sources batch ${batchIndex + 1}`
            )

            const content = response.text
            if (!content) {
                batch.forEach((_, localIndex) => {
                    allRankings.push({ index: globalIndex + localIndex, relevanceScore: 50 })
                })
                globalIndex += batch.length
                continue
            }

            const jsonMatch = content.match(/\[[\s\S]*\]/)
            if (!jsonMatch) {
                batch.forEach((_, localIndex) => {
                    allRankings.push({ index: globalIndex + localIndex, relevanceScore: 50 })
                })
                globalIndex += batch.length
                continue
            }

            const rankings = JSON.parse(jsonMatch[0])
            for (const ranking of rankings) {
                allRankings.push({
                    index: globalIndex + ranking.index,
                    relevanceScore: ranking.relevanceScore || 50,
                })
            }
            globalIndex += batch.length

            // Small delay between batches
            await new Promise(resolve => setTimeout(resolve, 500))
        } catch (error) {
            console.error(`[Research] Error ranking batch ${batchIndex + 1}:`, error)
            batch.forEach((_, localIndex) => {
                allRankings.push({ index: globalIndex + localIndex, relevanceScore: 50 })
            })
            globalIndex += batch.length
        }
    }

    // Apply scores
    const rankedSources = sourcesToRank.map((source, index) => {
        const ranking = allRankings.find(r => r.index === index)
        return {
            ...source,
            relevanceScore: ranking?.relevanceScore || 50,
        }
    })

    // Add unranked sources with lower default score
    const unrankedSources = sources.slice(MAX_SOURCES_TO_RANK).map(source => ({
        ...source,
        relevanceScore: 30,
    }))

    const sorted = [...rankedSources, ...unrankedSources]
        .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))

    const highRelevance = sorted.filter(s => (s.relevanceScore || 0) >= 70).length
    console.log(`[Research] Ranking complete: ${highRelevance} high relevance sources`)

    return sorted
}

/**
 * Smart filtering: Select top sources with chapter guarantee
 */
function selectTopSourcesWithChapterGuarantee(
    rankedSources: Source[],
    maxSources: number = 50,
    minPerChapter: number = 2
): Source[] {
    console.log(`[Research] Selecting top ${maxSources} sources...`)

    // Group by chapter
    const sourcesByChapter = new Map<string, Source[]>()
    for (const source of rankedSources) {
        const chapterKey = source.chapterNumber || 'unknown'
        if (!sourcesByChapter.has(chapterKey)) {
            sourcesByChapter.set(chapterKey, [])
        }
        sourcesByChapter.get(chapterKey)!.push(source)
    }

    // Ensure minimum per chapter
    const guaranteedSources: Source[] = []
    const usedSources = new Set<string>()

    for (const [chapter, sources] of sourcesByChapter.entries()) {
        const chapterSources = sources
            .filter(s => s.relevanceScore && s.relevanceScore >= 40)
            .slice(0, minPerChapter)

        for (const source of chapterSources) {
            const key = source.doi || source.title || ''
            if (!usedSources.has(key)) {
                guaranteedSources.push(source)
                usedSources.add(key)
            }
        }
    }

    // Fill remaining slots
    const remainingSlots = maxSources - guaranteedSources.length
    if (remainingSlots > 0) {
        const topSources = rankedSources
            .filter(s => {
                const key = s.doi || s.title || ''
                return !usedSources.has(key) && s.relevanceScore && s.relevanceScore >= 40
            })
            .slice(0, remainingSlots)

        guaranteedSources.push(...topSources)
    }

    return guaranteedSources.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
}

/**
 * Detect file type from buffer
 */
function detectFileType(buffer: Buffer): { type: 'pdf' | 'doc' | 'docx' | 'unknown'; mimeType: string } {
    const header = buffer.subarray(0, 4)
    const headerHex = header.toString('hex').toUpperCase()
    const headerAscii = header.toString('ascii')

    if (headerAscii === '%PDF') {
        return { type: 'pdf', mimeType: 'application/pdf' }
    }
    if (headerHex === '504B0304') {
        return { type: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    }
    if (headerHex === 'D0CF11E0') {
        return { type: 'doc', mimeType: 'application/msword' }
    }

    return { type: 'unknown', mimeType: 'application/octet-stream' }
}

/**
 * Step 6: Download and upload PDF to FileSearchStore
 */
async function downloadAndUploadPDF(
    ai: GoogleGenAI,
    source: Source,
    fileSearchStoreId: string,
    thesisId: string,
    supabase: SupabaseClient
): Promise<boolean> {
    if (!source.pdfUrl) {
        return false
    }

    try {
        console.log(`[Upload] Downloading: ${source.title.substring(0, 50)}...`)

        const docResponse = await retryApiCall(
            () => fetch(source.pdfUrl!),
            `Download document: ${source.title}`
        )

        if (!docResponse.ok) {
            console.error(`[Upload] Failed to download: ${docResponse.status}`)
            return false
        }

        const arrayBuffer = await docResponse.arrayBuffer()
        const docBuffer = Buffer.from(arrayBuffer)
        const fileSizeMB = docBuffer.length / 1024 / 1024

        // Validate
        if (fileSizeMB > 20) {
            console.error(`[Upload] File too large: ${fileSizeMB.toFixed(2)} MB`)
            return false
        }

        const fileType = detectFileType(docBuffer)
        if (fileType.type === 'unknown') {
            console.error(`[Upload] Unsupported file format`)
            return false
        }

        // Create blob for upload
        const fileSource = new Blob([docBuffer], { type: fileType.mimeType })

        // Prepare metadata
        const customMetadata: any[] = []
        if (source.doi) customMetadata.push({ key: 'doi', stringValue: source.doi.substring(0, 256) })
        if (source.title) customMetadata.push({ key: 'title', stringValue: source.title.substring(0, 256) })
        if (source.authors.length > 0) customMetadata.push({ key: 'author', stringValue: source.authors[0].substring(0, 256) })
        if (source.year) customMetadata.push({ key: 'year', numericValue: source.year })
        if (source.journal) customMetadata.push({ key: 'journal', stringValue: source.journal.substring(0, 256) })
        if (source.chapterNumber) customMetadata.push({ key: 'chapterNumber', stringValue: source.chapterNumber })

        // Upload to FileSearchStore
        console.log(`[Upload] Uploading to FileSearchStore...`)
        
        // Cast to any to access fileSearchStores which may not be fully typed in the SDK
        const aiAny = ai as any
        
        const operation = await retryApiCall(
            () => aiAny.fileSearchStores.uploadToFileSearchStore({
                file: fileSource,
                fileSearchStoreName: fileSearchStoreId,
                config: {
                    displayName: source.title.substring(0, 100) || 'Untitled',
                    customMetadata,
                    chunkingConfig: {
                        whiteSpaceConfig: {
                            maxTokensPerChunk: 512,
                            maxOverlapTokens: 50,
                        },
                    },
                },
            }),
            `Upload to FileSearchStore: ${source.title}`,
            3,
            2000
        ) as { done?: boolean; error?: any }

        // Poll until complete
        const maxWaitTime = 300000 // 5 minutes
        const pollInterval = 2000
        const startTime = Date.now()

        while (!operation.done) {
            if (Date.now() - startTime > maxWaitTime) {
                console.error(`[Upload] Timeout`)
                return false
            }

            await new Promise(resolve => setTimeout(resolve, pollInterval))
            const updatedOperation = await aiAny.operations.get({ operation }) as { done?: boolean; error?: any }
            Object.assign(operation, updatedOperation)
        }

        if (operation.error) {
            console.error(`[Upload] Operation failed:`, operation.error)
            return false
        }

        // Update database
        const fileExtension = fileType.type === 'pdf' ? 'pdf' : fileType.type === 'docx' ? 'docx' : 'doc'

        const { data: thesis } = await supabase
            .from('theses')
            .select('uploaded_sources')
            .eq('id', thesisId)
            .single()

        const existingSources = (thesis?.uploaded_sources as any[]) || []
        existingSources.push({
            doi: source.doi,
            title: source.title,
            fileName: `${source.title.substring(0, 50)}.${fileExtension}`,
            uploadedAt: new Date().toISOString(),
            metadata: {
                title: source.title,
                authors: source.authors,
                year: source.year?.toString(),
                journal: source.journal,
                doi: source.doi,
                abstract: source.abstract,
            },
            sourceType: 'url' as const,
            sourceUrl: source.pdfUrl,
        })

        await supabase
            .from('theses')
            .update({ uploaded_sources: existingSources })
            .eq('id', thesisId)

        console.log(`[Upload] ✓ Uploaded: ${source.title.substring(0, 50)}...`)
        return true
    } catch (error) {
        console.error(`[Upload] Error:`, error)
        return false
    }
}

/**
 * Main research pipeline function
 */
export async function runResearchPipeline(
    ai: GoogleGenAI,
    supabase: SupabaseClient,
    thesisId: string,
    thesisData: ThesisData,
    onProgress?: (stage: string, progress: number, message: string) => void
): Promise<ResearchResult> {
    console.log('[Research] Starting research pipeline...')
    console.log(`[Research] Thesis: ${thesisData.title}`)
    console.log(`[Research] Field: ${thesisData.field}`)
    console.log(`[Research] FileSearchStore: ${thesisData.fileSearchStoreId}`)

    onProgress?.('research', 0, 'Generating search queries...')

    // Step 1: Generate search queries
    const searchQueries = await generateSearchQueries(ai, thesisData)

    onProgress?.('research', 10, 'Searching academic databases...')

    // Step 2 & 3: Query OpenAlex and Semantic Scholar
    const allSources: Source[] = []

    for (const chapterQueries of searchQueries) {
        const { chapter, chapterTitle, queries } = chapterQueries

        // German queries
        for (const query of queries.german || []) {
            const openAlexResults = await queryOpenAlex(query, 'german')
            const semanticResults = await querySemanticScholar(query)

            // Tag sources with chapter info
            for (const source of [...openAlexResults, ...semanticResults]) {
                source.chapterNumber = chapter
                source.chapterTitle = chapterTitle
            }

            allSources.push(...openAlexResults, ...semanticResults)

            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 200))
        }

        // English queries
        for (const query of queries.english || []) {
            const openAlexResults = await queryOpenAlex(query, 'english')
            const semanticResults = await querySemanticScholar(query)

            for (const source of [...openAlexResults, ...semanticResults]) {
                source.chapterNumber = chapter
                source.chapterTitle = chapterTitle
            }

            allSources.push(...openAlexResults, ...semanticResults)

            await new Promise(resolve => setTimeout(resolve, 200))
        }
    }

    console.log(`[Research] Total sources found: ${allSources.length}`)
    onProgress?.('research', 30, `Found ${allSources.length} sources, deduplicating...`)

    // Step 4: Deduplicate and enrich
    const enrichedSources = await deduplicateAndEnrichSources(allSources)

    onProgress?.('research', 50, 'Ranking sources by relevance...')

    // Step 5: Rank sources
    const rankedSources = await rankSourcesByRelevance(ai, enrichedSources, thesisData)

    // Select top sources
    const selectedSources = selectTopSourcesWithChapterGuarantee(rankedSources, 50, 2)
    console.log(`[Research] Selected ${selectedSources.length} sources for upload`)

    onProgress?.('research', 70, `Uploading ${selectedSources.length} sources to FileSearchStore...`)

    // Step 6: Download and upload PDFs
    let uploadedCount = 0
    const sourcesWithPdf = selectedSources.filter(s => s.pdfUrl)

    for (let i = 0; i < sourcesWithPdf.length; i++) {
        const source = sourcesWithPdf[i]
        const success = await downloadAndUploadPDF(
            ai,
            source,
            thesisData.fileSearchStoreId,
            thesisId,
            supabase
        )

        if (success) {
            uploadedCount++
        }

        // Progress update
        const uploadProgress = 70 + Math.round((i / sourcesWithPdf.length) * 30)
        onProgress?.('research', uploadProgress, `Uploaded ${uploadedCount}/${sourcesWithPdf.length} sources...`)

        // Small delay between uploads
        await new Promise(resolve => setTimeout(resolve, 500))
    }

    console.log(`[Research] Pipeline complete: ${uploadedCount} sources uploaded`)

    return {
        sources: selectedSources,
        uploadedCount,
        totalFound: allSources.length,
    }
}

