/**
 * Background Worker for Thesis Generation
 * 
 * This worker should be deployed separately on Render or similar platform
 * It handles the complete thesis generation pipeline:
 * 1. Generate search queries (2 per chapter, German + English)
 * 2. Query OpenAlex API
 * 3. Query Semantic Scholar API
 * 4. Deduplicate and prioritize sources with PDF URLs
 * 5. Rank sources by relevance using Gemini
 * 6. Download PDFs and upload to Google FileSearchStore
 * 7. Generate thesis content using Gemini Pro
 */

import express, { Request, Response, NextFunction } from 'express'
import { GoogleGenAI } from '@google/genai'
import { createClient } from '@supabase/supabase-js'
import fetch from 'node-fetch'

const app = express()
app.use(express.json())

// Environment variables
const PORT = process.env.PORT || 3001
const GEMINI_KEY = process.env.GEMINI_KEY
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const WORKER_API_KEY = process.env.THESIS_WORKER_API_KEY
const OPENALEX_EMAIL = process.env.OPENALEX_EMAIL || 'moontoolsinc@proton.me'

if (!GEMINI_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required environment variables')
  process.exit(1)
}

// Initialize clients
const ai = new GoogleGenAI({ apiKey: GEMINI_KEY })
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Types
interface ThesisData {
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

interface Source {
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
      
      // Exponential backoff: 1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, attempt - 1)
      console.warn(`${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  
  // This should never be reached, but TypeScript needs it
  throw lastError
}

// Middleware for API key authentication
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const token = authHeader.substring(7)
  if (token !== WORKER_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' })
  }
  next()
}

/**
 * Step 1: Generate search queries (2 per chapter, German + English)
 */
async function generateSearchQueries(thesisData: ThesisData): Promise<{ chapter: string; queries: { german: string[]; english: string[] } }[]> {
  console.log('[Step 1] Starting search query generation...')
  console.log('[Step 1] Thesis title:', thesisData.title)
  console.log('[Step 1] Field:', thesisData.field)
  console.log('[Step 1] Number of chapters in outline:', thesisData.outline?.length || 0)
  
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
1. Spezifisch und präzise sein - verwende natürliche Sprache (z.B. "machine learning in healthcare" statt "machine learning AND healthcare")
2. Fachbegriffe und relevante Konzepte enthalten
3. Für wissenschaftliche Datenbanken (OpenAlex, Semantic Scholar) geeignet sein - Semantic Scholar akzeptiert natürliche Sprachsuchanfragen
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
    },
    ...
  ]
}`

  console.log('[Step 1] Calling Gemini API to generate search queries...')
  const response = await retryApiCall(
    () => ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    }),
    'Generate search queries (Gemini)'
  )

  const content = response.text
  if (!content) {
    console.error('[Step 1] ERROR: No content from Gemini API')
    throw new Error('No content from Gemini API')
  }

  console.log('[Step 1] Received response from Gemini, length:', content.length)
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.error('[Step 1] ERROR: Invalid JSON response from Gemini')
    console.error('[Step 1] Response preview:', content.substring(0, 500))
    throw new Error('Invalid JSON response from Gemini')
  }

  const parsed = JSON.parse(jsonMatch[0])
  const queries = parsed.queries || []
  console.log('[Step 1] Successfully generated queries for', queries.length, 'chapters')
  queries.forEach((q: any, idx: number) => {
    console.log(`[Step 1] Chapter ${idx + 1}: ${q.chapterNumber || q.chapter || 'N/A'} - ${q.chapterTitle || 'N/A'}`)
    console.log(`[Step 1]   German queries: ${q.queries?.german?.length || 0}`)
    console.log(`[Step 1]   English queries: ${q.queries?.english?.length || 0}`)
  })
  
  return queries
}

/**
 * Step 2: Query OpenAlex API
 * Uses polite pool by including email parameter for better rate limits and response times
 * See: https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication
 */
async function queryOpenAlex(query: string, language: 'german' | 'english'): Promise<Source[]> {
  console.log(`[OpenAlex] Querying: "${query}" (${language})`)
  const searchQuery = language === 'english' ? query : query // OpenAlex works best with English
  // Add mailto parameter to get into polite pool (10 req/sec instead of 1 req/sec)
  // Note: We use per-page=20 to get the top 20 most relevant results (not random samples)
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(searchQuery)}&per-page=20&mailto=${encodeURIComponent(OPENALEX_EMAIL)}`
  
  try {
    const startTime = Date.now()
    const response = await retryApiCall(
      () => fetch(url),
      `Query OpenAlex: ${query}`
    )
    const duration = Date.now() - startTime
    
    if (!response.ok) {
      console.error(`[OpenAlex] ERROR: ${response.status} ${response.statusText} for query: "${query}"`)
      return []
    }

    const data = await retryApiCall(
      () => response.json() as Promise<any>,
      `Parse OpenAlex response: ${query}`
    )
    const works = data.results || []
    console.log(`[OpenAlex] Found ${works.length} results for "${query}" (took ${duration}ms)`)

    const sources = works.map((work: any): Source => ({
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
    
    const withPdf = sources.filter((s: Source) => s.pdfUrl).length
    const withDoi = sources.filter((s: Source) => s.doi).length
    console.log(`[OpenAlex] Results for "${query}": ${sources.length} total, ${withPdf} with PDF, ${withDoi} with DOI`)
    
    return sources
  } catch (error) {
    console.error(`[OpenAlex] ERROR querying "${query}":`, error)
    return []
  }
}

/**
 * Step 3: Query Semantic Scholar API
 * Uses natural language queries - Semantic Scholar accepts plain text search terms
 * Prioritizes results with open access PDFs
 * See: https://www.semanticscholar.org/product/api/tutorial
 */
async function querySemanticScholar(query: string): Promise<Source[]> {
  console.log(`[SemanticScholar] Querying: "${query}"`)
  // Semantic Scholar API accepts natural language queries
  // URL encode the query properly (spaces become + or %20)
  const encodedQuery = encodeURIComponent(query)
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&limit=10&fields=title,authors,year,doi,url,openAccessPdf,abstract,venue,citationCount`
  
  try {
    const headers: Record<string, string> = {}
    
    // Add API key if available (recommended for better rate limits)
    const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY
    if (apiKey) {
      headers['x-api-key'] = apiKey
      console.log(`[SemanticScholar] Using API key for query: "${query}"`)
    } else {
      console.log(`[SemanticScholar] No API key - using public rate limits for query: "${query}"`)
    }
    
    const startTime = Date.now()
    const response = await retryApiCall(
      () => fetch(url, { headers }),
      `Query Semantic Scholar: ${query}`
    )
    const duration = Date.now() - startTime

    if (!response.ok) {
      if (response.status === 429) {
        console.error(`[SemanticScholar] ERROR: Rate limit exceeded for query: "${query}"`)
      } else {
        console.error(`[SemanticScholar] ERROR: ${response.status} ${response.statusText} for query: "${query}"`)
      }
      return []
    }

    const data = await retryApiCall(
      () => response.json() as Promise<any>,
      `Parse Semantic Scholar response: ${query}`
    )
    const papers = data.data || []
    console.log(`[SemanticScholar] Found ${papers.length} results for "${query}" (took ${duration}ms)`)

    // Map papers to Source objects, prioritizing those with open access PDFs
    const sources = papers.map((paper: any): Source => ({
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

    // Sort to prioritize sources with PDF URLs (open access)
    const sorted = sources.sort((a: Source, b: Source) => {
      if (a.pdfUrl && !b.pdfUrl) return -1
      if (!a.pdfUrl && b.pdfUrl) return 1
      // If both have or don't have PDFs, sort by citation count
      return (b.citationCount || 0) - (a.citationCount || 0)
    })
    
    const withPdf = sorted.filter((s: Source) => s.pdfUrl).length
    const withDoi = sorted.filter((s: Source) => s.doi).length
    console.log(`[SemanticScholar] Results for "${query}": ${sorted.length} total, ${withPdf} with PDF, ${withDoi} with DOI`)
    
    return sorted
  } catch (error) {
    console.error(`[SemanticScholar] ERROR querying "${query}":`, error)
    return []
  }
}

/**
 * Step 3.5: Query Unpaywall API to find PDF URLs for sources with DOI but no PDF
 * Unpaywall helps find open access PDFs when we have a DOI
 * See: https://unpaywall.org/products/api
 */
async function queryUnpaywall(doi: string): Promise<string | null> {
  if (!doi) {
    return null
  }

  console.log(`[Unpaywall] Querying PDF URL for DOI: ${doi}`)
  try {
    // Unpaywall API format: https://api.unpaywall.org/v2/{doi}?email={email}
    const cleanDoi = doi.startsWith('https://doi.org/') 
      ? doi.replace('https://doi.org/', '') 
      : doi.startsWith('doi:') 
        ? doi.replace('doi:', '')
        : doi
    
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(cleanDoi)}?email=${encodeURIComponent(OPENALEX_EMAIL)}`
    
    const response = await retryApiCall(
      () => fetch(url, {
        headers: {
          'User-Agent': `ThesisGenerationWorker/1.0 (mailto:${OPENALEX_EMAIL})`,
        },
      }),
      `Query Unpaywall: ${doi}`
    )

    if (!response.ok) {
      if (response.status === 404) {
        // DOI not found in Unpaywall, that's okay
        return null
      }
      console.error(`Unpaywall API error: ${response.status} ${response.statusText}`)
      return null
    }

    const data = await retryApiCall(
      () => response.json() as Promise<any>,
      `Parse Unpaywall response: ${doi}`
    )
    
    // Check for best open access PDF URL
    if (data.best_oa_location?.url_for_pdf) {
      console.log(`[Unpaywall] Found PDF URL for DOI ${doi}: ${data.best_oa_location.url_for_pdf}`)
      return data.best_oa_location.url_for_pdf
    }
    
    // Fallback to other PDF locations
    if (data.best_oa_location?.url_for_landing_page) {
      // Sometimes the landing page has the PDF
      console.log(`[Unpaywall] Found landing page URL for DOI ${doi}: ${data.best_oa_location.url_for_landing_page}`)
      return data.best_oa_location.url_for_landing_page
    }

    console.log(`[Unpaywall] No PDF URL found for DOI: ${doi}`)
    return null
  } catch (error) {
    console.error(`[Unpaywall] ERROR querying DOI ${doi}:`, error)
    return null
  }
}

/**
 * Step 4: Deduplicate sources by DOI and prioritize PDF URLs
 * Also enrich sources without PDF URLs using Unpaywall
 */
async function deduplicateAndEnrichSources(sources: Source[]): Promise<Source[]> {
  console.log(`[Deduplication] Starting with ${sources.length} sources`)
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
      }
      // Prefer source with more metadata
      else if (!source.pdfUrl && existing.pdfUrl) {
        // Keep existing
      } else {
        // Prefer source with higher citation count
        if ((source.citationCount || 0) > (existing.citationCount || 0)) {
          seen.set(key, source)
        }
      }
    }
  }

  const deduplicated = Array.from(seen.values())
  console.log(`[Deduplication] After deduplication: ${deduplicated.length} unique sources`)
  const withPdfBefore = deduplicated.filter(s => s.pdfUrl).length
  const withDoiBefore = deduplicated.filter(s => s.doi).length
  console.log(`[Deduplication] Sources with PDF: ${withPdfBefore}, with DOI: ${withDoiBefore}`)

  // Second pass: enrich sources without PDF URLs using Unpaywall
  console.log('[Deduplication] Enriching sources with Unpaywall for missing PDF URLs...')
  const sourcesToEnrich = deduplicated.filter(s => !s.pdfUrl && s.doi)
  console.log(`[Deduplication] ${sourcesToEnrich.length} sources need PDF URL enrichment`)
  
  const enrichedSources = await Promise.all(
    deduplicated.map(async (source) => {
      // If source already has PDF URL, skip
      if (source.pdfUrl) {
        return source
      }

      // If source has DOI, try Unpaywall
      if (source.doi) {
        const pdfUrl = await queryUnpaywall(source.doi)
        if (pdfUrl) {
          console.log(`Found PDF via Unpaywall for: ${source.title}`)
          return { ...source, pdfUrl }
        }
        
        // Rate limiting for Unpaywall (be polite)
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      return source
    })
  )

  const withPdfAfter = enrichedSources.filter(s => s.pdfUrl).length
  const newlyEnriched = withPdfAfter - withPdfBefore
  console.log(`[Deduplication] After enrichment: ${enrichedSources.length} sources, ${withPdfAfter} with PDF (+${newlyEnriched} newly enriched)`)
  
  return enrichedSources
}

/**
 * Step 5: Rank sources by relevance using Gemini
 */
async function rankSourcesByRelevance(sources: Source[], thesisData: ThesisData): Promise<Source[]> {
  console.log(`[Ranking] Starting relevance ranking for ${sources.length} sources`)
  console.log(`[Ranking] Thesis: "${thesisData.title}"`)
  console.log(`[Ranking] Field: ${thesisData.field}`)
  
  const prompt = `Du bist ein Experte für wissenschaftliche Literaturbewertung. Bewerte die Relevanz der folgenden Quellen für diese Thesis:

**Thesis-Informationen:**
- Titel/Thema: ${thesisData.title}
- Fachbereich: ${thesisData.field}
- Forschungsfrage: ${thesisData.researchQuestion}
- Gliederung: ${JSON.stringify(thesisData.outline, null, 2)}

**Quellen:**
${JSON.stringify(
  sources.map(s => ({
    title: s.title,
    authors: s.authors,
    year: s.year,
    abstract: s.abstract,
    journal: s.journal,
  })),
  null,
  2
)}

**Aufgabe:**
Bewerte jede Quelle auf einer Skala von 0-100 basierend auf ihrer Relevanz für die Thesis. Berücksichtige:
- Übereinstimmung mit dem Thema
- Relevanz für die Forschungsfrage
- Passung zu den Kapiteln der Gliederung
- Wissenschaftliche Qualität (basierend auf verfügbaren Informationen)

**WICHTIG:** Quellen mit einem Relevanz-Score unter 40 sollten ausgeschlossen werden, da sie nicht relevant genug sind.

**Format:**
Antworte NUR mit einem JSON-Array im folgenden Format:
[
  { "index": 0, "relevanceScore": 85, "reason": "Kurze Begründung" },
  { "index": 1, "relevanceScore": 42, "reason": "Kurze Begründung" },
  ...
]

Die Indizes entsprechen der Reihenfolge der Quellen im Input.`

  try {
    console.log('[Ranking] Calling Gemini API to rank sources...')
    const response = await retryApiCall(
      () => ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      }),
      'Rank sources by relevance (Gemini)'
    )

    const content = response.text
    if (!content) {
      console.warn('[Ranking] WARNING: No content from Gemini, returning unranked sources')
      return sources // Return unranked if ranking fails
    }

    console.log('[Ranking] Received ranking response from Gemini, length:', content.length)
    const jsonMatch = content.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      console.warn('[Ranking] WARNING: Invalid JSON response, returning unranked sources')
      return sources
    }

    const rankings = JSON.parse(jsonMatch[0]) as Array<{ index: number; relevanceScore: number; reason?: string }>
    console.log(`[Ranking] Received ${rankings.length} rankings from Gemini`)
    
    // Apply relevance scores
    const rankedSources = sources.map((source, index) => {
      const ranking = rankings.find(r => r.index === index)
      return {
        ...source,
        relevanceScore: ranking?.relevanceScore || 50,
      }
    })

    // Sort by relevance score (descending)
    const sorted = rankedSources.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
    
    // Log statistics
    const highRelevance = sorted.filter((s: Source) => (s.relevanceScore || 0) >= 70).length
    const mediumRelevance = sorted.filter((s: Source) => (s.relevanceScore || 0) >= 40 && (s.relevanceScore || 0) < 70).length
    const lowRelevance = sorted.filter((s: Source) => (s.relevanceScore || 0) < 40).length
    const topScore = sorted[0]?.relevanceScore || 0
    const avgScore = sorted.reduce((sum, s) => sum + (s.relevanceScore || 0), 0) / sorted.length
    
    console.log(`[Ranking] Ranking complete:`)
    console.log(`[Ranking]   Total sources: ${sorted.length}`)
    console.log(`[Ranking]   High relevance (>=70): ${highRelevance}`)
    console.log(`[Ranking]   Medium relevance (40-69): ${mediumRelevance}`)
    console.log(`[Ranking]   Low relevance (<40): ${lowRelevance}`)
    console.log(`[Ranking]   Top score: ${topScore}, Average score: ${avgScore.toFixed(1)}`)
    
    return sorted
  } catch (error) {
    console.error('[Ranking] ERROR ranking sources:', error)
    return sources // Return unranked if ranking fails
  }
}

/**
 * Extract page numbers from PDF using Gemini 2.5 Flash
 */
async function extractPageNumbers(pdfBuffer: Buffer): Promise<{ pageStart: string | null; pageEnd: string | null }> {
  console.log(`[PageExtraction] Starting page number extraction, PDF size: ${(pdfBuffer.length / 1024).toFixed(2)} KB`)
  try {
    // Upload PDF to Gemini Files API
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' })
    console.log('[PageExtraction] Uploading PDF to Gemini Files API...')
    const uploadedFile = await retryApiCall(
      () => ai.files.upload({
        file: blob,
      }),
      'Upload PDF to Gemini Files API'
    )
    console.log('[PageExtraction] PDF uploaded, URI:', uploadedFile.uri)

    // Wait a bit for file to be processed
    console.log('[PageExtraction] Waiting for file processing...')
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Use Gemini 2.5 Flash to extract page numbers
    const prompt = `Analyze this PDF document and extract the total number of pages. Look for:
1. The first page number (usually 1, but could be different if there's a cover page)
2. The last page number (total number of pages)

Respond ONLY with a JSON object in this format:
{
  "pageStart": "1",
  "pageEnd": "25"
}

If you cannot determine the page numbers, return:
{
  "pageStart": null,
  "pageEnd": null
}`

    console.log('[PageExtraction] Calling Gemini 2.5 Flash to extract page numbers...')
    const response = await retryApiCall(
      () => ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            parts: [
              {
                fileData: {
                  mimeType: 'application/pdf',
                  fileUri: uploadedFile.uri,
                },
              },
              {
                text: prompt,
              },
            ],
          },
        ],
      }),
      'Extract page numbers (Gemini 2.5 Flash)'
    )

    const content = response.text
    if (!content) {
      console.warn('[PageExtraction] WARNING: No content from Gemini')
      return { pageStart: null, pageEnd: null }
    }

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn('[PageExtraction] WARNING: Invalid JSON response')
      return { pageStart: null, pageEnd: null }
    }

    const parsed = JSON.parse(jsonMatch[0])
    const result = {
      pageStart: parsed.pageStart || null,
      pageEnd: parsed.pageEnd || null,
    }
    console.log(`[PageExtraction] Extracted page numbers: ${result.pageStart || 'N/A'} - ${result.pageEnd || 'N/A'}`)
    return result
  } catch (error) {
    console.error('[PageExtraction] ERROR extracting page numbers:', error)
    return { pageStart: null, pageEnd: null }
  }
}

/**
 * Step 6: Download PDF and upload to FileSearchStore
 */
async function downloadAndUploadPDF(source: Source, fileSearchStoreId: string, thesisId: string): Promise<boolean> {
  if (!source.pdfUrl) {
    console.log(`[PDFUpload] Skipping ${source.title} - no PDF URL`)
    return false
  }

  try {
    console.log(`[PDFUpload] Starting upload for: "${source.title}"`)
    console.log(`[PDFUpload]   DOI: ${source.doi || 'N/A'}`)
    console.log(`[PDFUpload]   PDF URL: ${source.pdfUrl}`)
    console.log(`[PDFUpload]   FileSearchStore: ${fileSearchStoreId}`)
    
    // Always download the PDF first to extract page numbers
    console.log(`[PDFUpload] Downloading PDF...`)
    if (!source.pdfUrl) {
      console.error(`[PDFUpload] ERROR: No PDF URL for source: ${source.title}`)
      return false
    }
    
    const downloadStart = Date.now()
    const pdfResponse = await retryApiCall(
      () => fetch(source.pdfUrl!),
      `Download PDF: ${source.title}`
    )
    const downloadDuration = Date.now() - downloadStart
    
    if (!pdfResponse.ok) {
      console.error(`[PDFUpload] ERROR: Failed to download PDF: ${pdfResponse.status} ${pdfResponse.statusText}`)
      return false
    }
    
    const contentLength = pdfResponse.headers.get('content-length')
    console.log(`[PDFUpload] PDF downloaded (${downloadDuration}ms, ${contentLength ? `${(parseInt(contentLength) / 1024).toFixed(2)} KB` : 'size unknown'})`)

    // Use arrayBuffer() instead of deprecated buffer() method
    const arrayBuffer = await pdfResponse.arrayBuffer()
    const pdfBuffer = Buffer.from(arrayBuffer)
    console.log(`[PDFUpload] PDF buffer created: ${(pdfBuffer.length / 1024).toFixed(2)} KB`)
    
    // Extract page numbers using Gemini 2.5 Flash
    console.log(`[PDFUpload] Extracting page numbers...`)
    const pageExtractStart = Date.now()
    const { pageStart, pageEnd } = await extractPageNumbers(pdfBuffer)
    const pageExtractDuration = Date.now() - pageExtractStart
    console.log(`[PDFUpload] Page extraction completed (${pageExtractDuration}ms)`)
    
    // Create a Blob from Buffer for SDK compatibility
    const fileSource = new Blob([pdfBuffer], { type: 'application/pdf' })

    // Prepare metadata for FileSearchStore
    const customMetadata: any[] = []
    
    if (source.doi) {
      customMetadata.push({ key: 'doi', stringValue: source.doi.substring(0, 256) })
    }
    if (source.title) {
      customMetadata.push({ key: 'title', stringValue: source.title.substring(0, 256) })
    }
    if (source.authors.length > 0) {
      customMetadata.push({ key: 'author', stringValue: source.authors[0].substring(0, 256) })
    }
    if (source.year) {
      customMetadata.push({ key: 'year', numericValue: source.year })
    }
    if (source.journal) {
      customMetadata.push({ key: 'journal', stringValue: source.journal.substring(0, 256) })
    }
    // Add page numbers if extracted
    if (pageStart) {
      customMetadata.push({ key: 'pageStart', stringValue: pageStart.substring(0, 256) })
    }
    if (pageEnd) {
      customMetadata.push({ key: 'pageEnd', stringValue: pageEnd.substring(0, 256) })
    }
    if (pageStart && pageEnd) {
      customMetadata.push({ key: 'pages', stringValue: `${pageStart}-${pageEnd}`.substring(0, 256) })
    }

    // Upload to FileSearchStore
    console.log(`[PDFUpload] Uploading to FileSearchStore...`)
    console.log(`[PDFUpload]   Metadata fields: ${customMetadata.length}`)
    const uploadStart = Date.now()
    const operation = await retryApiCall(
      () => ai.fileSearchStores.uploadToFileSearchStore({
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
      `Upload to FileSearchStore: ${source.title}`
    )
    console.log(`[PDFUpload] Upload operation started, polling for completion...`)

    // Poll until complete
    const maxWaitTime = 300000 // 5 minutes
    const pollInterval = 2000 // 2 seconds
    const startTime = Date.now()
    let pollCount = 0

    while (!operation.done) {
      if (Date.now() - startTime > maxWaitTime) {
        console.error(`[PDFUpload] ERROR: Upload operation timeout after ${maxWaitTime}ms`)
        return false
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval))
      pollCount++
      const updatedOperation = await retryApiCall(
        () => ai.operations.get({ operation }),
        `Poll upload operation: ${source.title}`
      )
      Object.assign(operation, updatedOperation)
      
      if (pollCount % 5 === 0) {
        console.log(`[PDFUpload] Still processing... (poll ${pollCount}, ${Math.round((Date.now() - startTime) / 1000)}s elapsed)`)
      }
    }

    const uploadDuration = Date.now() - uploadStart
    console.log(`[PDFUpload] Upload completed (${uploadDuration}ms, ${pollCount} polls)`)

    if (operation.error) {
      console.error(`[PDFUpload] ERROR: Upload operation failed:`, operation.error)
      return false
    }

    // Update database
    const { data: thesis } = await retryApiCall(
      async () => {
        const result = await supabase
          .from('theses')
          .select('uploaded_sources')
          .eq('id', thesisId)
          .single()
        if (result.error) throw result.error
        return result
      },
      `Fetch thesis from database: ${thesisId}`
    )

    const existingSources = (thesis?.uploaded_sources as any[]) || []
    const newSource = {
      doi: source.doi,
      title: source.title,
      fileName: `${source.title.substring(0, 50)}.pdf`,
      uploadedAt: new Date().toISOString(),
      metadata: {
        title: source.title,
        authors: source.authors,
        year: source.year?.toString(),
        journal: source.journal,
        doi: source.doi,
        abstract: source.abstract,
        pageStart: pageStart,
        pageEnd: pageEnd,
        pages: pageStart && pageEnd ? `${pageStart}-${pageEnd}` : null,
      },
      sourceType: 'url' as const,
      sourceUrl: source.pdfUrl,
    }

    existingSources.push(newSource)

    console.log(`[PDFUpload] Updating database with uploaded source...`)
    await retryApiCall(
      async () => {
        const result = await supabase
          .from('theses')
          .update({ uploaded_sources: existingSources })
          .eq('id', thesisId)
        if (result.error) throw result.error
        return result
      },
      `Update thesis in database: ${thesisId}`
    )

    console.log(`[PDFUpload] ✓ Successfully uploaded and indexed: "${source.title}"`)
    return true
  } catch (error) {
    console.error(`[PDFUpload] ERROR downloading/uploading PDF for "${source.title}":`, error)
    return false
  }
}

/**
 * Step 7: Generate thesis content using Gemini Pro
 */
async function generateThesisContent(thesisData: ThesisData, rankedSources: Source[]): Promise<string> {
  console.log('[ThesisGeneration] Starting thesis content generation...')
  console.log(`[ThesisGeneration] Thesis: "${thesisData.title}"`)
  console.log(`[ThesisGeneration] Target length: ${thesisData.targetLength} ${thesisData.lengthUnit}`)
  console.log(`[ThesisGeneration] Language: ${thesisData.language}`)
  console.log(`[ThesisGeneration] Available sources: ${rankedSources.length}`)
  console.log(`[ThesisGeneration] FileSearchStore: ${thesisData.fileSearchStoreId}`)
  
  // Map citation style to readable label
  const citationStyleLabels: Record<string, string> = {
    apa: 'APA',
    mla: 'MLA',
    harvard: 'Harvard',
    'deutsche-zitierweise': 'Deutsche Zitierweise',
  }
  
  const citationStyleLabel = citationStyleLabels[thesisData.citationStyle] || thesisData.citationStyle
  console.log(`[ThesisGeneration] Citation style: ${citationStyleLabel}`)

  const prompt = `Du bist ein Experte für wissenschaftliches Schreiben. Erstelle den vollständigen Text für diese Thesis.

**Thesis-Informationen:**
- Titel/Thema: ${thesisData.title}
- Fachbereich: ${thesisData.field}
- Art: ${thesisData.thesisType}
- Forschungsfrage: ${thesisData.researchQuestion}
- Zitationsstil: ${citationStyleLabel}
- Ziel-Länge: ${thesisData.targetLength} ${thesisData.lengthUnit}
- Sprache: ${thesisData.language}

**Gliederung:**
${JSON.stringify(thesisData.outline, null, 2)}

**Verfügbare Quellen:**
${JSON.stringify(
  rankedSources.slice(0, 50).map(s => ({
    title: s.title,
    authors: s.authors,
    year: s.year,
    doi: s.doi,
    abstract: s.abstract,
    journal: s.journal,
  })),
  null,
  2
)}

**Aufgabe:**
Erstelle den vollständigen Thesis-Text entsprechend der Gliederung. Der Text sollte:
1. Wissenschaftlich präzise und gut strukturiert sein
2. Alle Kapitel und Abschnitte der Gliederung abdecken
3. Die Forschungsfrage beantworten
4. Quellen korrekt zitieren (${citationStyleLabel} Stil)
5. Die Ziel-Länge erreichen
6. In ${thesisData.language === 'german' ? 'Deutsch' : 'Englisch'} verfasst sein

**Format:**
Erstelle den Text direkt, ohne zusätzliche Formatierung. Verwende die korrekte Nummerierung für Kapitel und Abschnitte.`

  console.log('[ThesisGeneration] Calling Gemini Pro to generate thesis content...')
  console.log('[ThesisGeneration] Using FileSearchStore for RAG context')
  const generationStart = Date.now()
  
  const response = await retryApiCall(
    () => ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
      config: {
        tools: [{
          fileSearch: {
            fileSearchStoreNames: [thesisData.fileSearchStoreId],
          },
        }],
      },
    }),
    'Generate thesis content (Gemini Pro)'
  )

  const generationDuration = Date.now() - generationStart
  const content = response.text || ''
  const contentLength = content.length
  const wordCount = content.split(/\s+/).length
  
  console.log(`[ThesisGeneration] Thesis generation completed (${generationDuration}ms)`)
  console.log(`[ThesisGeneration] Generated content: ${contentLength} characters, ~${wordCount} words`)
  
  return content
}

/**
 * Main job handler
 * @param testMode - If true, returns selected sources JSON instead of generating thesis
 */
async function processThesisGeneration(thesisId: string, thesisData: ThesisData, testMode: boolean = false) {
  const processStartTime = Date.now()
  console.log('='.repeat(80))
  console.log(`[PROCESS] Starting thesis generation for thesis ${thesisId}`)
  console.log(`[PROCESS] Test mode: ${testMode}`)
  console.log(`[PROCESS] Thesis: "${thesisData.title}"`)
  console.log(`[PROCESS] Field: ${thesisData.field}`)
  console.log(`[PROCESS] Type: ${thesisData.thesisType}`)
  console.log(`[PROCESS] Language: ${thesisData.language}`)
  console.log('='.repeat(80))
  
  try {
    // Step 1: Generate search queries
    console.log('\n[PROCESS] ========== Step 1: Generate Search Queries ==========')
    const step1Start = Date.now()
    const chapterQueries = await generateSearchQueries(thesisData)
    const step1Duration = Date.now() - step1Start
    console.log(`[PROCESS] Step 1 completed in ${step1Duration}ms`)
    console.log(`[PROCESS] Generated queries for ${chapterQueries.length} chapters`)

    // Step 2 & 3: Query OpenAlex and Semantic Scholar
    console.log('\n[PROCESS] ========== Step 2-3: Query OpenAlex and Semantic Scholar ==========')
    const step2Start = Date.now()
    const allSources: Source[] = []
    let totalQueries = 0

    for (const chapterQuery of chapterQueries) {
      console.log(`[PROCESS] Processing chapter: ${(chapterQuery as any).chapterNumber || chapterQuery.chapter || 'N/A'}`)
      
      // Query in both languages
      const germanQueries = chapterQuery.queries?.german || []
      const englishQueries = chapterQuery.queries?.english || []
      console.log(`[PROCESS]   German queries: ${germanQueries.length}, English queries: ${englishQueries.length}`)
      
      for (const query of germanQueries) {
        totalQueries++
        console.log(`[PROCESS]   Query ${totalQueries}: "${query}" (German)`)
        const openAlexResults = await queryOpenAlex(query, 'german')
        allSources.push(...openAlexResults)
        
        const semanticResults = await querySemanticScholar(query)
        allSources.push(...semanticResults)
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200))
      }

      for (const query of englishQueries) {
        totalQueries++
        console.log(`[PROCESS]   Query ${totalQueries}: "${query}" (English)`)
        const openAlexResults = await queryOpenAlex(query, 'english')
        allSources.push(...openAlexResults)
        
        const semanticResults = await querySemanticScholar(query)
        allSources.push(...semanticResults)
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    const step2Duration = Date.now() - step2Start
    console.log(`[PROCESS] Step 2-3 completed in ${step2Duration}ms`)
    console.log(`[PROCESS] Total queries executed: ${totalQueries}`)
    console.log(`[PROCESS] Found ${allSources.length} total sources`)
    const openAlexCount = allSources.filter(s => s.source === 'openalex').length
    const semanticCount = allSources.filter(s => s.source === 'semantic_scholar').length
    console.log(`[PROCESS]   OpenAlex: ${openAlexCount}, Semantic Scholar: ${semanticCount}`)

    // Step 4: Deduplicate and enrich with Unpaywall
    console.log('\n[PROCESS] ========== Step 4: Deduplicate and Enrich Sources ==========')
    const step4Start = Date.now()
    const deduplicated = await deduplicateAndEnrichSources(allSources)
    const step4Duration = Date.now() - step4Start
    console.log(`[PROCESS] Step 4 completed in ${step4Duration}ms`)
    console.log(`[PROCESS] ${deduplicated.length} sources after deduplication and enrichment`)

    // Step 5: Rank by relevance
    console.log('\n[PROCESS] ========== Step 5: Rank Sources by Relevance ==========')
    const step5Start = Date.now()
    const ranked = await rankSourcesByRelevance(deduplicated, thesisData)
    const step5Duration = Date.now() - step5Start
    console.log(`[PROCESS] Step 5 completed in ${step5Duration}ms`)
    console.log(`[PROCESS] Ranked ${ranked.length} sources`)

    // Step 6: Download and upload PDFs (top 50 most relevant, exclude low relevance)
    console.log('\n[PROCESS] ========== Step 6: Download and Upload PDFs ==========')
    const step6Start = Date.now()
    // Filter out sources with relevance score < 40 and take top 50
    const topSources = ranked
      .filter(s => s.relevanceScore && s.relevanceScore >= 40)
      .slice(0, 50)
    
    console.log(`[PROCESS] Top sources to process: ${topSources.length} (relevance >= 40)`)
    const sourcesWithPdf = topSources.filter(s => s.pdfUrl).length
    console.log(`[PROCESS] Sources with PDF URLs: ${sourcesWithPdf}`)
    
    let uploadedCount = 0
    let failedCount = 0

    for (let i = 0; i < topSources.length; i++) {
      const source = topSources[i]
      console.log(`[PROCESS] Processing source ${i + 1}/${topSources.length}: "${source.title}"`)
      
      if (source.pdfUrl) {
        const success = await downloadAndUploadPDF(source, thesisData.fileSearchStoreId, thesisId)
        if (success) {
          uploadedCount++
        } else {
          failedCount++
        }
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000))
      } else {
        console.log(`[PROCESS] Skipping source (no PDF URL): "${source.title}"`)
      }
    }

    const step6Duration = Date.now() - step6Start
    console.log(`[PROCESS] Step 6 completed in ${step6Duration}ms`)
    console.log(`[PROCESS] Uploaded ${uploadedCount} PDFs, ${failedCount} failed`)

    // If test mode, return selected sources JSON instead of generating thesis
    if (testMode) {
      console.log('\n[PROCESS] ========== Test Mode: Returning Selected Sources ==========')
      
      // Get top sources that would be used (filtered by relevance and with PDF URLs)
      const selectedSources = ranked
        .filter(s => s.relevanceScore && s.relevanceScore >= 40)
        .slice(0, 50)
        .map(source => ({
          title: source.title,
          authors: source.authors,
          year: source.year,
          doi: source.doi,
          url: source.url,
          pdfUrl: source.pdfUrl,
          abstract: source.abstract,
          journal: source.journal,
          publisher: source.publisher,
          citationCount: source.citationCount,
          relevanceScore: source.relevanceScore,
          source: source.source, // 'openalex' or 'semantic_scholar'
        }))

      // Prepare statistics
      const statistics = {
        totalSourcesFound: allSources.length,
        sourcesAfterDeduplication: deduplicated.length,
        sourcesAfterRanking: ranked.length,
        sourcesWithPDFs: ranked.filter(s => s.pdfUrl).length,
        uploadedPDFs: uploadedCount,
        selectedSourcesCount: selectedSources.length,
      }

      // Update thesis status to indicate test completed
      console.log('[PROCESS] Updating thesis in database with test mode results...')
      const dbUpdateStart = Date.now()
      await retryApiCall(
        async () => {
          const result = await supabase
            .from('theses')
            .update({
              status: 'draft',
              metadata: {
                testMode: true,
                testCompletedAt: new Date().toISOString(),
                statistics,
                selectedSources: selectedSources,
              },
            })
            .eq('id', thesisId)
          if (result.error) throw result.error
          return result
        },
        `Update thesis status (test mode): ${thesisId}`
      )
      const dbUpdateDuration = Date.now() - dbUpdateStart
      console.log(`[PROCESS] Database updated in ${dbUpdateDuration}ms`)

      const processDuration = Date.now() - processStartTime
      console.log(`[PROCESS] Test mode completed in ${processDuration}ms`)
      console.log(`[PROCESS] Selected ${selectedSources.length} sources`)
      console.log('='.repeat(80))
      
      return { 
        success: true, 
        testMode: true,
        selectedSources,
        statistics: {
          totalSourcesFound: allSources.length,
          sourcesAfterDeduplication: deduplicated.length,
          sourcesAfterRanking: ranked.length,
          sourcesWithPDFs: ranked.filter(s => s.pdfUrl).length,
          uploadedPDFs: uploadedCount,
          selectedSourcesCount: selectedSources.length,
        },
      }
    }

    // Step 7: Generate thesis content (only in production mode)
    console.log('\n[PROCESS] ========== Step 7: Generate Thesis Content ==========')
    const step7Start = Date.now()
    const thesisContent = await generateThesisContent(thesisData, ranked)
    const step7Duration = Date.now() - step7Start
    console.log(`[PROCESS] Step 7 completed in ${step7Duration}ms`)

    // Update thesis in database
    console.log('[PROCESS] Updating thesis in database with generated content...')
    const dbUpdateStart = Date.now()
    await retryApiCall(
      async () => {
        const result = await supabase
          .from('theses')
          .update({
            latex_content: thesisContent,
            status: 'completed',
            completed_at: new Date().toISOString(),
          })
          .eq('id', thesisId)
        if (result.error) throw result.error
        return result
      },
      `Update thesis status (completed): ${thesisId}`
    )
    const dbUpdateDuration = Date.now() - dbUpdateStart
    console.log(`[PROCESS] Database updated in ${dbUpdateDuration}ms`)

    const processDuration = Date.now() - processStartTime
    console.log('\n[PROCESS] ========== Thesis Generation Complete ==========')
    console.log(`[PROCESS] Total processing time: ${Math.round(processDuration / 1000)}s (${processDuration}ms)`)
    console.log(`[PROCESS] Thesis generation completed for thesis ${thesisId}`)
    console.log('='.repeat(80))
    
    return { success: true }
  } catch (error) {
    const processDuration = Date.now() - processStartTime
    console.error('\n[PROCESS] ========== ERROR in Thesis Generation ==========')
    console.error(`[PROCESS] Error after ${Math.round(processDuration / 1000)}s (${processDuration}ms)`)
    console.error('[PROCESS] Error details:', error)
    console.error('='.repeat(80))
    
    // Update thesis status to draft on error
    await retryApiCall(
      async () => {
        const result = await supabase
          .from('theses')
          .update({ status: 'draft' })
          .eq('id', thesisId)
        if (result.error) throw result.error
        return result
      },
      `Update thesis status (error): ${thesisId}`
    ).catch(err => {
      // If even the error update fails, just log it
      console.error('Failed to update thesis status on error:', err)
    })

    throw error
  }
}

// API endpoint to start thesis generation job
app.post('/jobs/thesis-generation', authenticate, async (req: Request, res: Response) => {
  const requestStart = Date.now()
  console.log('\n[API] ========== POST /jobs/thesis-generation ==========')
  console.log('[API] Request received at:', new Date().toISOString())
  
  try {
    const { thesisId, thesisData, testMode } = req.body
    console.log('[API] Request body:', {
      thesisId,
      testMode: testMode === true,
      hasThesisData: !!thesisData,
      thesisTitle: thesisData?.title,
    })

    if (!thesisId || !thesisData) {
      console.error('[API] ERROR: Missing required fields')
      return res.status(400).json({ error: 'Thesis ID and data are required' })
    }

    const isTestMode = testMode === true
    console.log(`[API] Mode: ${isTestMode ? 'TEST MODE' : 'PRODUCTION MODE'}`)

    if (isTestMode) {
      // In test mode, process synchronously and return results
      console.log('[API] Running in TEST MODE - will return selected sources JSON')
      try {
        const result = await processThesisGeneration(thesisId, thesisData, true)
        const requestDuration = Date.now() - requestStart
        console.log(`[API] Test mode completed in ${requestDuration}ms`)
        console.log('[API] Returning test mode results')
        return res.json(result)
      } catch (error) {
        const requestDuration = Date.now() - requestStart
        console.error(`[API] ERROR in test mode after ${requestDuration}ms:`, error)
        return res.status(500).json({
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    } else {
      // In production mode, start processing asynchronously
      console.log('[API] Starting background job (async)...')
      processThesisGeneration(thesisId, thesisData, false).catch(error => {
        console.error('[API] Background job error:', error)
      })

      // Return immediately
      const requestDuration = Date.now() - requestStart
      console.log(`[API] Job started, returning immediately (${requestDuration}ms)`)
      return res.json({
        success: true,
        jobId: `job-${thesisId}-${Date.now()}`,
        message: 'Thesis generation job started',
      })
    }
  } catch (error) {
    const requestDuration = Date.now() - requestStart
    console.error(`[API] ERROR starting job after ${requestDuration}ms:`, error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

// Job status query endpoint
app.get('/jobs/:thesisId', authenticate, async (req: Request, res: Response) => {
  const requestStart = Date.now()
  console.log('\n[API] ========== GET /jobs/:thesisId ==========')
  console.log('[API] Request received at:', new Date().toISOString())
  
  try {
    const { thesisId } = req.params
    console.log('[API] Querying status for thesis:', thesisId)

    if (!thesisId) {
      console.error('[API] ERROR: Thesis ID is required')
      return res.status(400).json({ error: 'Thesis ID is required' })
    }

    // Query database for thesis status
    console.log('[API] Querying database for thesis status...')
    const queryStart = Date.now()
    const { data: thesis, error } = await supabase
      .from('theses')
      .select('id, status, created_at, updated_at, completed_at, metadata')
      .eq('id', thesisId)
      .single()
    const queryDuration = Date.now() - queryStart
    console.log(`[API] Database query completed in ${queryDuration}ms`)

    if (error) {
      console.error('[API] ERROR querying thesis:', error)
      return res.status(500).json({ error: 'Failed to query thesis status' })
    }

    if (!thesis) {
      console.log('[API] Thesis not found:', thesisId)
      return res.status(404).json({ error: 'Thesis not found' })
    }

    console.log('[API] Thesis found:', {
      id: thesis.id,
      status: thesis.status,
      hasMetadata: !!thesis.metadata,
    })

    // Return job status
    const requestDuration = Date.now() - requestStart
    console.log(`[API] Returning status (${requestDuration}ms)`)
    return res.json({
      thesisId: thesis.id,
      status: thesis.status, // 'draft', 'generating', 'completed'
      createdAt: thesis.created_at,
      updatedAt: thesis.updated_at,
      completedAt: thesis.completed_at,
      // Include metadata if available (e.g., test mode results, statistics)
      metadata: thesis.metadata || {},
    })
  } catch (error) {
    const requestDuration = Date.now() - requestStart
    console.error(`[API] ERROR querying job status after ${requestDuration}ms:`, error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  console.log('[API] Health check requested')
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Start server
app.listen(PORT, () => {
  console.log('='.repeat(80))
  console.log(`[SERVER] Thesis generation worker started`)
  console.log(`[SERVER] Listening on port ${PORT}`)
  console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`)
  console.log(`[SERVER] Started at: ${new Date().toISOString()}`)
  console.log('='.repeat(80))
})

