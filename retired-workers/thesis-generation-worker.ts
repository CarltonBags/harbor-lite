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
const GRAMMARLY_ACCESS_TOKEN = process.env.GRAMMARLY_ACCESS_TOKEN
// Support both NEXT_PUBLIC_SUPABASE_URL (for compatibility) and SUPABASE_URL
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const WORKER_API_KEY = process.env.THESIS_WORKER_API_KEY
const OPENALEX_EMAIL = process.env.OPENALEX_EMAIL || 'moontoolsinc@proton.me'
const OPENAI_API_KEY = process.env.OPENAI_KEY // Optional: for generating embeddings
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-ada-002' // Default to ada-002 (1536 dims)
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY // Optional: for ZeroGPT API
const WINSTON_API_KEY = process.env.WINSTON_API_KEY // Optional: for Winston AI API

if (!GEMINI_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required environment variables')
  console.error('Required: GEMINI_KEY, SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY')
  console.error('Current values:')
  console.error(`  GEMINI_KEY: ${GEMINI_KEY ? 'SET' : 'MISSING'}`)
  console.error(`  SUPABASE_URL: ${SUPABASE_URL ? 'SET' : 'MISSING'}`)
  console.error(`  SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY ? 'SET' : 'MISSING'}`)
  process.exit(1)
}

// Initialize clients
const ai = new GoogleGenAI({ apiKey: GEMINI_KEY })
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Concurrency control: limit number of simultaneous thesis generations
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '3', 10)
let activeJobs = 0
const jobQueue: Array<{ thesisId: string; thesisData: ThesisData; resolve: () => void }> = []

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
  chapterNumber?: string // Track which chapter this source came from
  chapterTitle?: string // Track chapter title for metadata
  mandatory?: boolean // Flag to indicate this source must be cited in the thesis
  // Page information for citations
  pages?: string // e.g., "1-44"
  pageStart?: string | number
  pageEnd?: string | number
}

interface OutlineChapterInfo {
  number: string
  title: string
  sections?: {
    number: string
    title: string
    subsections?: {
      number: string
      title: string
    }[]
  }[]
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatChapterLabel(chapter: OutlineChapterInfo): string {
  const number = chapter.number?.trim()
  const title = chapter.title?.trim()
  return [number, title].filter(Boolean).join(' ').trim()
}

function detectChapters(content: string, outlineChapters: OutlineChapterInfo[]): string[] {
  if (!content || !outlineChapters.length) return []

  const found: string[] = []
  outlineChapters.forEach((chapter) => {
    const number = (chapter.number || '').trim()
    const title = (chapter.title || '').trim()
    const patterns: RegExp[] = []

    if (number && title) {
      patterns.push(
        new RegExp(
          `(?:^|\\n)#+\\s*${escapeRegex(number)}\\s+.*${escapeRegex(title)}`,
          'i'
        )
      )
    }

    if (number) {
      patterns.push(
        new RegExp(`(?:^|\\n)#+\\s*${escapeRegex(number)}(?:\\s|$)`, 'i')
      )
    }

    if (title) {
      patterns.push(
        new RegExp(`(?:^|\\n)#+\\s*.*${escapeRegex(title)}`, 'i')
      )
    }

    if (patterns.some((pattern) => pattern.test(content))) {
      found.push(number || title)
    }
  })

  return found
}

function getMissingChapters(content: string, outlineChapters: OutlineChapterInfo[]): string[] {
  if (!outlineChapters.length) return []
  const found = new Set(detectChapters(content, outlineChapters))
  return outlineChapters
    .filter((chapter) => !found.has(chapter.number || chapter.title))
    .map((chapter) => formatChapterLabel(chapter))
}

function getRecentExcerpt(content: string, maxChars: number = 8000): string {
  if (!content) return ''
  if (content.length <= maxChars) return content
  return content.slice(-maxChars)
}

function buildOutlineSummary(outlineChapters: OutlineChapterInfo[]): string {
  if (!outlineChapters.length) return ''
  return outlineChapters
    .map((chapter) => `- ${formatChapterLabel(chapter)}`)
    .join('\n')
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
1. Spezifisch und präzise sein UND immer den Hauptkontext der Thesis ("${thesisData.title}" / "${thesisData.field}") beinhalten - vermeide generische Suchen wie nur "Methodik" oder "Einleitung".
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

    const sources = works.map((work: any): Source => {
      // Extract page numbers from biblio (journal page numbers like 239-253)
      const firstPage = work.biblio?.first_page || null
      const lastPage = work.biblio?.last_page || null

      return {
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
        // Use API-provided page numbers (these are the actual journal page numbers for citations)
        pageStart: firstPage,
        pageEnd: lastPage,
        pages: firstPage && lastPage ? `${firstPage}-${lastPage}` : (firstPage || null),
      }
    })

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
 * Processes sources in batches to avoid token limits and timeouts
 */
async function rankSourcesByRelevance(sources: Source[], thesisData: ThesisData): Promise<Source[]> {
  console.log(`[Ranking] Starting relevance ranking for ${sources.length} sources`)
  console.log(`[Ranking] Thesis: "${thesisData.title}"`)
  console.log(`[Ranking] Field: ${thesisData.field}`)

  // If we have too many sources, prioritize those with PDFs and limit to top 350 for ranking
  // This prevents token limit issues and timeouts
  const MAX_SOURCES_TO_RANK = 350
  let sourcesToRank = sources

  if (sources.length > MAX_SOURCES_TO_RANK) {
    console.log(`[Ranking] Too many sources (${sources.length}), prioritizing sources with PDFs and limiting to ${MAX_SOURCES_TO_RANK}`)
    // Sort by: PDF first, then by citation count
    sourcesToRank = [...sources].sort((a, b) => {
      if (a.pdfUrl && !b.pdfUrl) return -1
      if (!a.pdfUrl && b.pdfUrl) return 1
      return (b.citationCount || 0) - (a.citationCount || 0)
    }).slice(0, MAX_SOURCES_TO_RANK)
    console.log(`[Ranking] Selected ${sourcesToRank.length} sources for ranking (prioritized by PDF availability)`)
  }

  // Process in batches of 50 to avoid token limits
  const BATCH_SIZE = 50
  const batches: Source[][] = []
  for (let i = 0; i < sourcesToRank.length; i += BATCH_SIZE) {
    batches.push(sourcesToRank.slice(i, i + BATCH_SIZE))
  }

  console.log(`[Ranking] Processing ${batches.length} batches of up to ${BATCH_SIZE} sources each`)

  const allRankings: Array<{ index: number; relevanceScore: number; reason?: string }> = []
  let globalIndex = 0

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex]
    console.log(`[Ranking] Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} sources)`)

    const prompt = `Du bist ein Experte für wissenschaftliche Literaturbewertung. Bewerte die Relevanz der folgenden Quellen für diese Thesis:

**Thesis-Informationen:**
- Titel/Thema: ${thesisData.title}
- Fachbereich: ${thesisData.field}
- Forschungsfrage: ${thesisData.researchQuestion}
- Gliederung: ${JSON.stringify(thesisData.outline, null, 2)}

**Quellen (Batch ${batchIndex + 1} von ${batches.length}):**
${JSON.stringify(
      batch.map(s => ({
        title: s.title,
        authors: s.authors.slice(0, 3), // Limit authors to reduce token usage
        year: s.year,
        abstract: s.abstract ? s.abstract.substring(0, 500) : null, // Truncate abstract
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

**KRITISCH - STRENGE FILTERUNG:**
- Quellen mit einem Relevanz-Score unter 60 MÜSSEN ausgeschlossen werden. Bestrafe Quellen aus fremden Fachgebieten (z.B. medizinische Studien für eine politikwissenschaftliche Arbeit) mit sehr niedrigen Scores (<20), selbst wenn sie das Keyword enthalten.
- Nur Quellen, die einen KLAREN BEZUG zum Fachbereich und zur Forschungsfrage haben, sind akzeptabel
- Eliminiere ALLE "Filler"-Quellen, die keinen echten Zusammenhang zum Thema haben
- Sei SEHR STRENG bei der Bewertung - lieber weniger, aber hochrelevante Quellen

**Format:**
Antworte NUR mit einem JSON-Array im folgenden Format:
[
  { "index": 0, "relevanceScore": 85, "reason": "Kurze Begründung" },
  { "index": 1, "relevanceScore": 42, "reason": "Kurze Begründung" },
  ...
]

Die Indizes entsprechen der Reihenfolge der Quellen im Input (0 bis ${batch.length - 1}).`

    try {
      const batchStart = Date.now()
      const response = await retryApiCall(
        () => ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        }),
        `Rank sources batch ${batchIndex + 1}/${batches.length} (Gemini)`
      )
      const batchDuration = Date.now() - batchStart
      console.log(`[Ranking] Batch ${batchIndex + 1} completed in ${batchDuration}ms`)

      const content = response.text
      if (!content) {
        console.warn(`[Ranking] WARNING: No content from Gemini for batch ${batchIndex + 1}, assigning default scores`)
        // Assign default scores for this batch
        batch.forEach((_, localIndex) => {
          allRankings.push({ index: globalIndex + localIndex, relevanceScore: 50 })
        })
        globalIndex += batch.length
        continue
      }

      const jsonMatch = content.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        console.warn(`[Ranking] WARNING: Invalid JSON response for batch ${batchIndex + 1}, assigning default scores`)
        // Assign default scores for this batch
        batch.forEach((_, localIndex) => {
          allRankings.push({ index: globalIndex + localIndex, relevanceScore: 50 })
        })
        globalIndex += batch.length
        continue
      }

      const batchRankings = JSON.parse(jsonMatch[0]) as Array<{ index: number; relevanceScore: number; reason?: string }>
      console.log(`[Ranking] Received ${batchRankings.length} rankings for batch ${batchIndex + 1}`)

      // Adjust indices to global indices
      batchRankings.forEach(ranking => {
        allRankings.push({
          index: globalIndex + ranking.index,
          relevanceScore: ranking.relevanceScore,
          reason: ranking.reason,
        })
      })

      globalIndex += batch.length

      // Small delay between batches to avoid rate limiting
      if (batchIndex < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    } catch (error) {
      console.error(`[Ranking] ERROR ranking batch ${batchIndex + 1}:`, error)
      // Assign default scores for this batch on error
      batch.forEach((_, localIndex) => {
        allRankings.push({ index: globalIndex + localIndex, relevanceScore: 50 })
      })
      globalIndex += batch.length
    }
  }

  // Apply relevance scores to sources that were ranked
  const rankedSources = sourcesToRank.map((source, index) => {
    const ranking = allRankings.find(r => r.index === index)
    return {
      ...source,
      relevanceScore: ranking?.relevanceScore || 50,
    }
  })

  // Add sources that weren't ranked with default scores
  const unrankedSources = sources.slice(MAX_SOURCES_TO_RANK).map(source => ({
    ...source,
    relevanceScore: 30, // Lower default score for unranked sources
  }))

  // Combine and sort by relevance score (descending)
  const allSourcesWithScores = [...rankedSources, ...unrankedSources]
  const sorted = allSourcesWithScores.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))

  // Log statistics
  const highRelevance = sorted.filter((s: Source) => (s.relevanceScore || 0) >= 80).length
  const mediumRelevance = sorted.filter((s: Source) => (s.relevanceScore || 0) >= 60 && (s.relevanceScore || 0) < 80).length
  const lowRelevance = sorted.filter((s: Source) => (s.relevanceScore || 0) < 40).length
  const topScore = sorted[0]?.relevanceScore || 0
  const avgScore = sorted.reduce((sum, s) => sum + (s.relevanceScore || 0), 0) / sorted.length

  console.log(`[Ranking] Ranking complete:`)
  console.log(`[Ranking]   Total sources before filtering: ${sorted.length}`)
  console.log(`[Ranking]   Ranked sources: ${rankedSources.length}`)
  console.log(`[Ranking]   Unranked sources (default score 30): ${unrankedSources.length}`)
  console.log(`[Ranking]   High relevance (>=80): ${highRelevance}`)
  console.log(`[Ranking]   Medium relevance (60-79): ${mediumRelevance}`)
  console.log(`[Ranking]   Low relevance (<40): ${lowRelevance}`)
  console.log(`[Ranking]   Top score: ${topScore}, Average score: ${avgScore.toFixed(1)}`)

  // FILTER OUT UNRELATED SOURCES - Eliminate filler sources with no connection to the field
  // Minimum relevance score of 50 to ensure sources are actually related to the thesis topic
  const MIN_RELEVANCE_SCORE = 60
  const filtered = sorted.filter((s: Source) => (s.relevanceScore || 0) >= MIN_RELEVANCE_SCORE)
  const removed = sorted.length - filtered.length

  console.log(`[Ranking]   Filtered out ${removed} unrelated sources (relevance < ${MIN_RELEVANCE_SCORE})`)
  console.log(`[Ranking]   Remaining relevant sources: ${filtered.length}`)

  if (removed > 0) {
    console.log(`[Ranking]   Removed sources had scores: ${sorted.slice(filtered.length).map((s: Source) => s.relevanceScore || 0).join(', ')}`)
  }

  return filtered
}

/**
 * Smart filtering: Select top 50 sources but ensure at least 2 sources per chapter
 * This prevents chapters from being excluded even if their sources rank lower
 */
function selectTopSourcesWithChapterGuarantee(rankedSources: Source[], maxSources: number = 50, minPerChapter: number = 2): Source[] {
  console.log(`[SmartFilter] Starting smart filtering: max ${maxSources} sources, min ${minPerChapter} per chapter`)

  // Group sources by chapter
  const sourcesByChapter = new Map<string, Source[]>()
  for (const source of rankedSources) {
    const chapterKey = source.chapterNumber || 'unknown'
    if (!sourcesByChapter.has(chapterKey)) {
      sourcesByChapter.set(chapterKey, [])
    }
    sourcesByChapter.get(chapterKey)!.push(source)
  }

  console.log(`[SmartFilter] Sources grouped into ${sourcesByChapter.size} chapters`)
  sourcesByChapter.forEach((sources, chapter) => {
    console.log(`[SmartFilter]   Chapter ${chapter}: ${sources.length} sources`)
  })

  // First, ensure minimum per chapter
  const guaranteedSources: Source[] = []
  const usedSources = new Set<string>() // Track by DOI or title to avoid duplicates

  for (const [chapter, sources] of sourcesByChapter.entries()) {
    const chapterSources = sources
      .filter(s => s.relevanceScore && s.relevanceScore >= 50) // Only consider relevant sources (minimum 50 to eliminate fillers)
      .slice(0, minPerChapter)

    for (const source of chapterSources) {
      const key = source.doi || source.title || ''
      if (!usedSources.has(key)) {
        guaranteedSources.push(source)
        usedSources.add(key)
      }
    }
  }

  console.log(`[SmartFilter] Guaranteed sources (min per chapter): ${guaranteedSources.length}`)

  // Then, fill remaining slots with top-ranked sources (excluding already selected)
  const remainingSlots = maxSources - guaranteedSources.length
  if (remainingSlots > 0) {
    const topSources = rankedSources
      .filter(s => {
        const key = s.doi || s.title || ''
        return !usedSources.has(key) && s.relevanceScore && s.relevanceScore >= 50 // Minimum 50 to eliminate filler sources
      })
      .slice(0, remainingSlots)

    console.log(`[SmartFilter] Adding ${topSources.length} top-ranked sources to fill remaining slots`)
    guaranteedSources.push(...topSources)
  }

  // Sort final selection by relevance score
  const finalSelection = guaranteedSources.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))

  // Log chapter distribution in final selection
  const finalByChapter = new Map<string, number>()
  for (const source of finalSelection) {
    const chapter = source.chapterNumber || 'unknown'
    finalByChapter.set(chapter, (finalByChapter.get(chapter) || 0) + 1)
  }
  console.log(`[SmartFilter] Final selection: ${finalSelection.length} sources`)
  finalByChapter.forEach((count, chapter) => {
    console.log(`[SmartFilter]   Chapter ${chapter}: ${count} sources`)
  })

  return finalSelection
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
    // CRITICAL: Extract the ACTUAL page count of the document, not internal PDF page numbers
    const prompt = `Analyze this PDF document and extract the ACTUAL number of pages in the document.

IMPORTANT:
- Count the TOTAL number of pages in the PDF file itself
- This is the physical page count (e.g., if PDF has 3 pages, return pageEnd: "3")
- Do NOT use journal page numbers or article page numbers
- Do NOT use page numbers from headers/footers that might be wrong
- Simply count: page 1, page 2, page 3, etc. until the last page

Look for:
1. The first page number (usually 1)
2. The last page number (total physical pages in the PDF)

Respond ONLY with a JSON object in this format:
{
  "pageStart": "1",
  "pageEnd": "3"
}

If you cannot determine the page numbers accurately, return:
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
 * Detect file type from buffer
 */
function detectFileType(buffer: Buffer): { type: 'pdf' | 'doc' | 'docx' | 'unknown'; mimeType: string } {
  const header = buffer.subarray(0, 4)
  const headerHex = header.toString('hex').toUpperCase()
  const headerAscii = header.toString('ascii')

  // PDF: %PDF
  if (headerAscii === '%PDF') {
    return { type: 'pdf', mimeType: 'application/pdf' }
  }

  // DOCX: ZIP format (50 4B 03 04 = PK..)
  if (headerHex === '504B0304') {
    return { type: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  }

  // DOC: OLE2 format (D0 CF 11 E0)
  if (headerHex === 'D0CF11E0') {
    return { type: 'doc', mimeType: 'application/msword' }
  }

  return { type: 'unknown', mimeType: 'application/octet-stream' }
}

/**
 * Step 6: Download document (PDF, DOC, DOCX) and upload to FileSearchStore
 */
async function downloadAndUploadPDF(source: Source, fileSearchStoreId: string, thesisId: string): Promise<boolean> {
  if (!source.pdfUrl) {
    console.log(`[DocUpload] Skipping ${source.title} - no document URL`)
    return false
  }

  try {
    console.log(`[DocUpload] Starting upload for: "${source.title}"`)
    console.log(`[DocUpload]   DOI: ${source.doi || 'N/A'}`)
    console.log(`[DocUpload]   Document URL: ${source.pdfUrl}`)
    console.log(`[DocUpload]   FileSearchStore: ${fileSearchStoreId}`)

    // Always download the document first to extract page numbers and validate format
    console.log(`[DocUpload] Downloading document...`)
    if (!source.pdfUrl) {
      console.error(`[DocUpload] ERROR: No document URL for source: ${source.title}`)
      return false
    }

    const downloadStart = Date.now()
    const docResponse = await retryApiCall(
      () => fetch(source.pdfUrl!),
      `Download document: ${source.title}`
    )
    const downloadDuration = Date.now() - downloadStart

    if (!docResponse.ok) {
      console.error(`[DocUpload] ERROR: Failed to download document: ${docResponse.status} ${docResponse.statusText}`)
      return false
    }

    const contentLength = docResponse.headers.get('content-length')
    console.log(`[DocUpload] Document downloaded (${downloadDuration}ms, ${contentLength ? `${(parseInt(contentLength) / 1024).toFixed(2)} KB` : 'size unknown'})`)

    // Use arrayBuffer() instead of deprecated buffer() method
    const arrayBuffer = await docResponse.arrayBuffer()
    const docBuffer = Buffer.from(arrayBuffer)
    const fileSizeKB = docBuffer.length / 1024
    const fileSizeMB = fileSizeKB / 1024
    console.log(`[DocUpload] Document buffer created: ${fileSizeKB.toFixed(2)} KB (${fileSizeMB.toFixed(2)} MB)`)

    // Validate document before processing
    // Check 1: File size - Google FileSearchStore has a 20MB limit per file
    const MAX_FILE_SIZE_MB = 20
    if (fileSizeMB > MAX_FILE_SIZE_MB) {
      console.error(`[DocUpload] ERROR: Document too large (${fileSizeMB.toFixed(2)} MB > ${MAX_FILE_SIZE_MB} MB limit)`)
      return false
    }

    // Check 2: Minimum size - ensure it's not empty or corrupted
    const MIN_FILE_SIZE_KB = 1
    if (fileSizeKB < MIN_FILE_SIZE_KB) {
      console.error(`[DocUpload] ERROR: Document too small (${fileSizeKB.toFixed(2)} KB < ${MIN_FILE_SIZE_KB} KB) - likely corrupted or empty`)
      return false
    }

    // Check 3: Validate file format - should be PDF, DOC, or DOCX
    const fileType = detectFileType(docBuffer)
    if (fileType.type === 'unknown') {
      const headerHex = docBuffer.subarray(0, 4).toString('hex').toUpperCase()
      const headerAscii = docBuffer.subarray(0, 4).toString('ascii')
      console.error(`[DocUpload] ERROR: Unsupported file format (header: "${headerAscii}" / 0x${headerHex})`)
      console.error(`[DocUpload]   Supported formats: PDF (%PDF), DOCX (ZIP/PK..), DOC (OLE2/D0CF11E0)`)
      return false
    }
    console.log(`[DocUpload] Document validation passed: valid ${fileType.type.toUpperCase()} format, size OK`)

    // Page numbers: We need BOTH journal pages (for citations) AND PDF pages (for FileSearchStore mapping)
    // FileSearchStore returns PDF-internal page numbers, but citations need journal page numbers
    // So we store BOTH and calculate the mapping

    let journalPageStart: string | null = null
    let journalPageEnd: string | null = null
    let pdfPageStart: string | null = null
    let pdfPageEnd: string | null = null

    // FIRST: Get journal page numbers from API (OpenAlex/Semantic Scholar)
    // These are the JOURNAL page numbers which are correct for citations (e.g., 239-253)
    if (source.pageStart && source.pageEnd) {
      journalPageStart = String(source.pageStart)
      journalPageEnd = String(source.pageEnd)
      console.log(`[DocUpload] API-provided journal pages: ${journalPageStart}-${journalPageEnd}`)
    } else if (source.pages) {
      // Parse pages string like "239-253"
      const pagesMatch = source.pages.match(/(\d+)\s*[-–]\s*(\d+)/)
      if (pagesMatch) {
        journalPageStart = pagesMatch[1]
        journalPageEnd = pagesMatch[2]
        console.log(`[DocUpload] Parsed API journal page range: ${journalPageStart}-${journalPageEnd}`)
      }
    }

    // SECOND: ALWAYS extract PDF page count (needed for FileSearchStore mapping)
    // Even if we have journal pages, we need PDF pages to map FileSearchStore results
    if (fileType.type === 'pdf') {
      console.log(`[DocUpload] Extracting PDF page count for FileSearchStore mapping...`)
      const pageExtractStart = Date.now()
      try {
        const pageNumbers = await extractPageNumbers(docBuffer)
        if (pageNumbers.pageStart && pageNumbers.pageEnd) {
          const extractedStart = parseInt(pageNumbers.pageStart, 10)
          const extractedEnd = parseInt(pageNumbers.pageEnd, 10)

          // VALIDATION: Ensure page numbers make sense
          if (extractedEnd > 1000) {
            console.warn(`[DocUpload] WARNING: Extracted PDF pageEnd (${extractedEnd}) seems too high, likely incorrect.`)
          } else if (extractedEnd < extractedStart) {
            console.warn(`[DocUpload] WARNING: Extracted PDF pageEnd (${extractedEnd}) < pageStart (${extractedStart}), invalid.`)
          } else {
            pdfPageStart = pageNumbers.pageStart
            pdfPageEnd = pageNumbers.pageEnd
            const pageExtractDuration = Date.now() - pageExtractStart
            console.log(`[DocUpload] PDF extraction: ${pdfPageStart}-${pdfPageEnd} pages (${pageExtractDuration}ms)`)
          }
        }
      } catch (error) {
        console.warn(`[DocUpload] WARNING: PDF page extraction failed:`, error)
      }
    }

    // THIRD: Determine which page numbers to use for metadata
    // Priority: Journal pages (if available) > PDF pages > Estimation
    let pageStart: string | null = null
    let pageEnd: string | null = null

    if (journalPageStart && journalPageEnd) {
      // Use journal pages for citations
      pageStart = journalPageStart
      pageEnd = journalPageEnd
      console.log(`[DocUpload] Using journal pages for citations: ${pageStart}-${pageEnd}`)
    } else if (pdfPageStart && pdfPageEnd) {
      // Fallback to PDF pages if no journal pages
      pageStart = pdfPageStart
      pageEnd = pdfPageEnd
      console.log(`[DocUpload] Using PDF pages (no journal pages available): ${pageStart}-${pageEnd}`)
    } else {
      // Last resort: file size estimation
      const estimatedPages = Math.max(1, Math.ceil(fileSizeKB / (fileType.type === 'pdf' ? 50 : 75)))
      pageStart = "1"
      pageEnd = estimatedPages.toString()
      console.log(`[DocUpload] Fallback: estimated ${estimatedPages} pages from file size (${fileSizeKB.toFixed(2)} KB)`)
    }

    // Create a Blob from Buffer for SDK compatibility with correct MIME type
    const fileSource = new Blob([docBuffer], { type: fileType.mimeType })

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
    // Add page numbers to metadata
    // Store journal pages (for citations) and PDF pages (for FileSearchStore mapping)
    if (pageStart) {
      customMetadata.push({ key: 'pageStart', stringValue: pageStart.substring(0, 256) })
    }
    if (pageEnd) {
      customMetadata.push({ key: 'pageEnd', stringValue: pageEnd.substring(0, 256) })
    }
    if (pageStart && pageEnd) {
      customMetadata.push({ key: 'pages', stringValue: `${pageStart}-${pageEnd}`.substring(0, 256) })
    }

    // Store PDF page count separately for mapping FileSearchStore results
    if (pdfPageStart && pdfPageEnd) {
      customMetadata.push({ key: 'pdfPageStart', stringValue: pdfPageStart.substring(0, 256) })
      customMetadata.push({ key: 'pdfPageEnd', stringValue: pdfPageEnd.substring(0, 256) })
      console.log(`[DocUpload] Stored PDF pages for mapping: ${pdfPageStart}-${pdfPageEnd}`)
    }

    // Store journal pages separately if different from PDF pages
    if (journalPageStart && journalPageEnd && (journalPageStart !== pdfPageStart || journalPageEnd !== pdfPageEnd)) {
      customMetadata.push({ key: 'journalPageStart', stringValue: journalPageStart.substring(0, 256) })
      customMetadata.push({ key: 'journalPageEnd', stringValue: journalPageEnd.substring(0, 256) })
      console.log(`[DocUpload] Stored journal pages separately: ${journalPageStart}-${journalPageEnd}`)
      console.log(`[DocUpload] Page mapping: PDF ${pdfPageStart}-${pdfPageEnd} → Journal ${journalPageStart}-${journalPageEnd}`)
    }
    // Add chapter information for relevance tracking
    if (source.chapterNumber) {
      customMetadata.push({ key: 'chapterNumber', stringValue: source.chapterNumber.substring(0, 256) })
    }
    if (source.chapterTitle) {
      customMetadata.push({ key: 'chapterTitle', stringValue: source.chapterTitle.substring(0, 256) })
    }

    // Upload to FileSearchStore
    console.log(`[DocUpload] Uploading to FileSearchStore...`)
    console.log(`[DocUpload]   File type: ${fileType.type.toUpperCase()}`)
    console.log(`[DocUpload]   File size: ${fileSizeMB.toFixed(2)} MB`)
    console.log(`[DocUpload]   Metadata fields: ${customMetadata.length}`)
    console.log(`[DocUpload]   Display name: ${source.title.substring(0, 100) || 'Untitled'}`)
    const uploadStart = Date.now()

    let operation: any
    try {
      operation = await retryApiCall(
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
        `Upload to FileSearchStore: ${source.title}`,
        3, // 3 retries
        2000 // 2 second base delay
      )
      console.log(`[DocUpload] Upload operation started, polling for completion...`)
    } catch (error: any) {
      // Handle specific 500 errors from Google API
      if (error?.status === 500) {
        console.error(`[DocUpload] ERROR: Google API returned 500 Internal Server Error`)
        console.error(`[DocUpload]   This usually means the document is corrupted, too large, or in an invalid format`)
        console.error(`[DocUpload]   File type: ${fileType.type.toUpperCase()}`)
        console.error(`[DocUpload]   File size: ${fileSizeMB.toFixed(2)} MB`)
        console.error(`[DocUpload]   Document header validated: Yes`)
        console.error(`[DocUpload]   Error details:`, error.message || error)
        return false
      }
      // Re-throw other errors
      throw error
    }

    // Poll until complete
    const maxWaitTime = 100000 // 5 minutes
    const pollInterval = 2000 // 2 seconds
    const startTime = Date.now()
    let pollCount = 0

    while (!operation.done) {
      if (Date.now() - startTime > maxWaitTime) {
        console.error(`[DocUpload] ERROR: Upload operation timeout after ${maxWaitTime}ms`)
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
        console.log(`[DocUpload] Still processing... (poll ${pollCount}, ${Math.round((Date.now() - startTime) / 1000)}s elapsed)`)
      }
    }

    const uploadDuration = Date.now() - uploadStart
    console.log(`[DocUpload] Upload completed (${uploadDuration}ms, ${pollCount} polls)`)

    if (operation.error) {
      console.error(`[DocUpload] ERROR: Upload operation failed:`, operation.error)
      return false
    }

    // Determine file extension based on detected type
    const fileExtension = fileType.type === 'pdf' ? 'pdf' : fileType.type === 'docx' ? 'docx' : 'doc'

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
      fileName: `${source.title.substring(0, 50)}.${fileExtension}`,
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
        fileType: fileType.type,
      },
      sourceType: 'url' as const,
      sourceUrl: source.pdfUrl,
    }

    existingSources.push(newSource)

    console.log(`[DocUpload] Updating database with uploaded source...`)
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

    console.log(`[DocUpload] ✓ Successfully uploaded and indexed: "${source.title}" (${fileType.type.toUpperCase()})`)
    return true
  } catch (error) {
    console.error(`[DocUpload] ERROR downloading/uploading document for "${source.title}":`, error)
    return false
  }
}

/**
 * Generate embeddings for text using OpenAI API
 * Uses text-embedding-ada-002 by default (1536 dimensions) to match database schema
 * Can be changed via OPENAI_EMBEDDING_MODEL env var (e.g., text-embedding-3-small, text-embedding-3-large)
 * Note: If using a different model, you may need to update the database schema dimensions
 */
async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY) {
    console.log('[Embedding] OpenAI API key not available, skipping embedding generation')
    return null
  }

  // Model dimension mapping
  const modelDimensions: Record<string, number> = {
    'text-embedding-ada-002': 1536,
    'text-embedding-3-small': 1536, // Can be reduced to 512
    'text-embedding-3-large': 3072, // Can be reduced to 1024 or 256
  }

  const expectedDims = modelDimensions[OPENAI_EMBEDDING_MODEL] || 1536
  console.log(`[Embedding] Using model: ${OPENAI_EMBEDDING_MODEL} (expected ${expectedDims} dimensions)`)

  // Note: Database schema expects 1536 dimensions
  // If using text-embedding-3-large (3072 dims), you'd need to update the schema
  // For text-embedding-3-small, you can request 1536 dims to match schema

  try {
    const requestBody: any = {
      model: OPENAI_EMBEDDING_MODEL,
      input: text,
    }

    // For text-embedding-3 models, we can request specific dimensions
    if (OPENAI_EMBEDDING_MODEL.startsWith('text-embedding-3')) {
      // Request 1536 dimensions to match database schema
      requestBody.dimensions = 1536
    }

    const response = await retryApiCall(
      () => fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
      }),
      `Generate embedding (OpenAI ${OPENAI_EMBEDDING_MODEL})`,
      2,
      1000
    )

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`)
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> }
    const embedding = data.data[0]?.embedding || null

    if (embedding && embedding.length !== 1536) {
      console.warn(`[Embedding] WARNING: Embedding dimension (${embedding.length}) doesn't match database schema (1536)`)
      console.warn(`[Embedding] You may need to update the database schema or use a different model`)
    }

    return embedding
  } catch (error) {
    console.error('[Embedding] Error generating embedding:', error)
    return null
  }
}

/**
 * Chunk thesis content and store in Supabase vector DB (NOT in Google FileSearchStore)
 * The thesis content is stored in thesis_paragraphs table with embeddings for semantic search
 */
async function chunkAndStoreThesis(thesisId: string, latexContent: string, outline: any[]): Promise<void> {
  console.log('[Chunking] Starting thesis chunking and embedding for Supabase vector DB...')
  console.log('[Chunking] NOTE: Thesis content goes to Supabase vector DB, NOT Google FileSearchStore')

  // First, delete any existing paragraphs for this thesis (in case of regeneration)
  console.log('[Chunking] Cleaning up existing paragraphs...')
  try {
    await retryApiCall(
      async () => {
        const { error } = await supabase
          .from('thesis_paragraphs')
          .delete()
          .eq('thesis_id', thesisId)
        if (error) throw error
        return { data: null, error: null }
      },
      `Delete existing thesis paragraphs: ${thesisId}`
    )
    console.log('[Chunking] Existing paragraphs deleted')
  } catch (error) {
    console.warn('[Chunking] Could not delete existing paragraphs (may not exist):', error)
  }

  // Parse LaTeX/Markdown content into paragraphs
  // Handle both LaTeX and Markdown formats
  let textContent: string[] = []

  // Try to detect format and parse accordingly
  if (latexContent.includes('\\') || latexContent.includes('\\section') || latexContent.includes('\\chapter')) {
    // LaTeX format
    console.log('[Chunking] Detected LaTeX format')
    textContent = latexContent
      .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1') // Remove LaTeX commands, keep content
      .replace(/\\[^a-zA-Z]/g, ' ') // Remove LaTeX special characters
      .split(/\n\s*\n/) // Split by double newlines (paragraphs)
      .map(p => p.trim())
      .filter(p => p.length > 50) // Only keep substantial paragraphs
  } else {
    // Markdown format (from thesis generation)
    console.log('[Chunking] Detected Markdown format')
    textContent = latexContent
      .split(/\n\s*\n/) // Split by double newlines
      .map(p => p.trim())
      .filter(p => {
        // Filter out markdown headers and very short paragraphs
        return p.length > 50 && !p.match(/^#{1,6}\s/)
      })
      .map(p => p.replace(/^#{1,6}\s+/, '')) // Remove markdown headers from paragraph text
  }

  console.log(`[Chunking] Extracted ${textContent.length} paragraphs from thesis`)

  if (textContent.length === 0) {
    console.warn('[Chunking] No paragraphs extracted - thesis content may be empty or malformed')
    return
  }

  // Map paragraphs to chapters based on outline
  const chapters = outline || []
  const paragraphsPerChapter = Math.ceil(textContent.length / Math.max(chapters.length, 1))

  let paragraphIndex = 0
  const paragraphsToStore: Array<{
    thesis_id: string
    chapter_number: number
    section_number: number | null
    paragraph_number: number
    text: string
    embedding: number[] | null
    metadata: Record<string, any>
  }> = []

  console.log('[Chunking] Mapping paragraphs to chapters and generating embeddings...')

  for (let chapterIdx = 0; chapterIdx < chapters.length; chapterIdx++) {
    const chapter = chapters[chapterIdx]
    const chapterNumber = parseInt(chapter.number || String(chapterIdx + 1)) || chapterIdx + 1

    // Get paragraphs for this chapter
    const chapterParagraphs = textContent.slice(
      paragraphIndex,
      Math.min(paragraphIndex + paragraphsPerChapter, textContent.length)
    )

    console.log(`[Chunking] Processing chapter ${chapterNumber} (${chapter.title || 'N/A'}): ${chapterParagraphs.length} paragraphs`)

    for (let paraIdx = 0; paraIdx < chapterParagraphs.length; paraIdx++) {
      const text = chapterParagraphs[paraIdx]

      // Generate embedding for this paragraph
      let embedding: number[] | null = null
      if (OPENAI_API_KEY) {
        try {
          embedding = await generateEmbedding(text)
          if (embedding) {
            console.log(`[Chunking] Generated embedding for paragraph ${paraIdx + 1} (${embedding.length} dimensions)`)
          }
        } catch (error) {
          console.warn(`[Chunking] Failed to generate embedding for paragraph ${paraIdx + 1}:`, error)
        }
      } else {
        console.log(`[Chunking] Skipping embedding for paragraph ${paraIdx + 1} (no OpenAI API key)`)
      }

      paragraphsToStore.push({
        thesis_id: thesisId,
        chapter_number: chapterNumber,
        section_number: null, // Could be extracted from LaTeX/Markdown structure
        paragraph_number: paraIdx + 1,
        text: text,
        embedding: embedding, // Vector embedding (1536 dimensions for ada-002, configurable via OPENAI_EMBEDDING_MODEL)
        metadata: {
          chapterTitle: chapter.title || null,
        },
      })

      // Small delay to avoid rate limiting
      if (OPENAI_API_KEY && paraIdx < chapterParagraphs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    paragraphIndex += chapterParagraphs.length
  }

  const paragraphsWithEmbeddings = paragraphsToStore.filter(p => p.embedding !== null).length
  console.log(`[Chunking] Prepared ${paragraphsToStore.length} paragraphs for storage`)
  console.log(`[Chunking] ${paragraphsWithEmbeddings} paragraphs have embeddings, ${paragraphsToStore.length - paragraphsWithEmbeddings} without`)

  // Store paragraphs in batches in Supabase vector DB
  const BATCH_SIZE = 50
  for (let i = 0; i < paragraphsToStore.length; i += BATCH_SIZE) {
    const batch = paragraphsToStore.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(paragraphsToStore.length / BATCH_SIZE)
    console.log(`[Chunking] Storing batch ${batchNum}/${totalBatches} in Supabase vector DB...`)

    await retryApiCall(
      async () => {
        const { error } = await supabase
          .from('thesis_paragraphs')
          .insert(batch)

        if (error) throw error
        return { data: null, error: null }
      },
      `Store thesis paragraphs batch ${batchNum} in Supabase`
    )

    console.log(`[Chunking] Batch ${batchNum}/${totalBatches} stored successfully`)
  }

  console.log(`[Chunking] ✓ Successfully stored ${paragraphsToStore.length} paragraphs in Supabase vector DB`)
  console.log(`[Chunking] ✓ ${paragraphsWithEmbeddings} paragraphs have embeddings for semantic search`)
  if (paragraphsWithEmbeddings < paragraphsToStore.length) {
    console.log(`[Chunking] Note: ${paragraphsToStore.length - paragraphsWithEmbeddings} paragraphs stored without embeddings (set OPENAI_API_KEY to generate embeddings)`)
  }
}

/**
 * Send email notification when thesis is complete
 * The email is automatically sent via database trigger when status changes to 'completed'
 * No action needed here - the trigger handles everything
 */
async function sendCompletionEmail(thesisId: string, thesisTitle: string): Promise<void> {
  console.log('[Email] Email notification will be sent automatically via database trigger')
  console.log('[Email] The trigger fires when status changes to "completed"')
  // The database trigger (005_thesis_completion_email_trigger.sql) handles the email
  // No additional action needed - just updating the status triggers the email
}

/**
 * Step 7: Generate thesis content using Gemini Pro
 */
/**
 * Step 6.5: Generate a detailed thesis plan before writing
 * This creates a blueprint mapping sources to chapters to prevent hallucinations
 */
async function generateThesisPlan(thesisData: ThesisData, sources: Source[]): Promise<string> {
  console.log('[ThesisPlan] Generating detailed thesis plan...')

  // Calculate target word count
  // Sanity check: If targetLength is > 500, it's definitely words, not pages
  const isWords = thesisData.lengthUnit === 'words' || thesisData.targetLength > 500
  const targetWordCount = isWords ? thesisData.targetLength : thesisData.targetLength * 250
  const maxWordCount = Math.ceil(targetWordCount * 1.10) // Max 10% overshoot

  // Format sources for the prompt
  const sourcesList = sources.map((s, i) =>
    `[${i + 1}] ${s.title} (${s.year || 'n.d.'}) - ${s.authors.join(', ')}\n   Abstract: ${s.abstract ? s.abstract.substring(0, 300) + '...' : 'No abstract'}`
  ).join('\n\n')

  const outlineStr = thesisData.outline?.map((ch: any) =>
    `${ch.number} ${ch.title}\n${ch.subchapters?.map((sub: any) => `  ${sub.number} ${sub.title}`).join('\n') || ''}`
  ).join('\n')

  const prompt = `
You are an expert academic research planner. Your task is to create a detailed **Thesis Plan** (Blueprint) for a thesis titled "${thesisData.title}".

**GOAL:**
Create a detailed roadmap for writing the thesis. For each chapter in the outline, you must:
1. Define the key arguments and logical flow.
2. **CRITICAL:** Select specific sources from the provided list that MUST be used in that chapter.
3. Map specific findings/concepts from the sources to the chapter sections.
4. **LENGTH PLANNING:** Assign a target word count RANGE to each chapter so the TOTAL equals approx. ${targetWordCount} words (±5%).

**INPUTS:**
1. **Thesis Title:** ${thesisData.title}
2. **Topic/Question:** ${thesisData.topic}
3. **Target Length:** ${targetWordCount} words (STRICT MAX: ${maxWordCount} words - DO NOT EXCEED)
4. **Outline:**
${outlineStr}

5. **Available Sources:**
${sourcesList}

**CRITICAL WORD COUNT RULES:**
- The sum of ALL chapter target words MUST equal ${targetWordCount} words (±5%).
- Each chapter should have a word range (e.g., "Target Words: 2000-2200").
- Introduction and Conclusion are typically shorter (10-15% of total each).
- Main chapters should be roughly equal in length unless content requires otherwise.
- The Literaturverzeichnis/Bibliography is NOT counted in the word total.
- **CRITICAL:** Do NOT plan word counts for "Verzeichnisse" chapters (e.g., Abbildungsverzeichnis, Tabellenverzeichnis, Abkürzungsverzeichnis). These will be skipped during generation.
- **ONLY the Literaturverzeichnis (Bibliography) will be generated** at the end - no other Verzeichnisse.
- Plan conservatively - it's better to be slightly under than over the limit.
- ABSOLUTE MAXIMUM for entire thesis: ${maxWordCount} words.

**RULES:**
- **STRICTLY NO HALLUCINATIONS:** You must ONLY use the sources provided in the list above. Do not invent sources.
- **MAPPING:** Explicitly state which sources (use their numbers [1], [2], etc.) should be used for which chapter.
- **CONTENT:** Briefly summarize what content from the source should be used.
- **LENGTH:** You MUST plan the length of each chapter with a word range. The sum of all chapter MINIMUM targets MUST equal ${Math.floor(targetWordCount * 0.95)} words minimum.
- **COMPLETENESS:** Ensure every chapter is fully planned. Do not cut off content to save words; adjust the depth instead.
- **CITATIONS:** Plan for at least 1 citation per 150 words (${Math.ceil(targetWordCount / 150)} total citations minimum).

**OUTPUT FORMAT:**
Return a structured plan in Markdown:

# Thesis Plan: ${thesisData.title}
**Total Target Words:** ${targetWordCount} (Max: ${maxWordCount})
**Planned Chapter Distribution:**
- Chapter 1: XXX-YYY words
- Chapter 2: XXX-YYY words
...
**Total Planned: XXX-YYY words**

## Chapter 1: [Title]
- **Goal:** [Brief goal]
- **Target Words:** [e.g. 1800-2000] (be specific with range)
- **Key Sources:** [1], [4], [7]
- **Plan:**
  - Section 1.1: Use Source [1] to define... (approx. XXX words)
  - Section 1.2: Compare findings from [4] and [7]... (approx. XXX words)

## Chapter 2: [Title]
...

(Repeat for all chapters)

**VERIFICATION:** After planning all chapters, verify that the sum of minimum targets = ${Math.floor(targetWordCount * 0.95)}-${targetWordCount} words.
`

  try {
    const response = await retryApiCall(
      () => ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: prompt,
        config: {
          temperature: 0.2, // Low temperature for precise planning
          maxOutputTokens: 8192,
        },
      }),
      'Generate Thesis Plan',
      2,
      2000
    )

    console.log('[ThesisPlan] Plan generated successfully')
    return response.text || ''
  } catch (error) {
    console.error('[ThesisPlan] Error generating plan:', error)
    return '' // Fallback to no plan if it fails
  }
}

function extractChapterPlan(thesisPlan: string, chapter: OutlineChapterInfo, language: 'german' | 'english'): string {
  if (!thesisPlan) return ''
  const chapterNumber = chapter.number?.split('.')[0] || ''
  if (!chapterNumber) return ''

  const regex = language === 'german'
    ? new RegExp(`##\\s+Kapitel\\s+${chapterNumber}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+(?:Kapitel|Chapter)\\s+|$)`, 'i')
    : new RegExp(`##\\s+Chapter\\s+${chapterNumber}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+(?:Chapter|Kapitel)\\s+|$)`, 'i')

  const match = thesisPlan.match(regex)
  return match ? match[1].trim() : ''
}

function extractChapterWordTargets(thesisPlan: string, outlineChapters: OutlineChapterInfo[], totalWordTarget: number, language: 'german' | 'english'): number[] {
  if (!outlineChapters.length) return []

  const defaultTarget = Math.max(800, Math.floor(totalWordTarget / outlineChapters.length))
  const targets = new Array(outlineChapters.length).fill(defaultTarget)

  if (thesisPlan) {
    outlineChapters.forEach((chapter, index) => {
      const chapterPlan = extractChapterPlan(thesisPlan, chapter, language)
      if (chapterPlan) {
        // Try to match word ranges first (e.g., "2000-2200" or "2000-2200 words")
        const rangeMatch = chapterPlan.match(/Target Words:\s*(\d+)\s*-\s*(\d+)/i) || chapterPlan.match(/Zielwörter:\s*(\d+)\s*-\s*(\d+)/i)
        if (rangeMatch) {
          const minValue = parseInt(rangeMatch[1], 10)
          const maxValue = parseInt(rangeMatch[2], 10)
          if (!Number.isNaN(minValue) && !Number.isNaN(maxValue) && minValue > 0 && maxValue > minValue) {
            // Use the lower bound to be conservative and avoid overshooting
            targets[index] = minValue
            console.log(`[ChapterPlanning] Chapter ${chapter.number}: ${minValue}-${maxValue} words (using ${minValue})`)
          }
        } else {
          // Fallback to single value
          const targetMatch = chapterPlan.match(/Target Words:\s*(\d+)/i) || chapterPlan.match(/Zielwörter:\s*(\d+)/i)
          if (targetMatch) {
            const value = parseInt(targetMatch[1], 10)
            if (!Number.isNaN(value) && value > 0) {
              targets[index] = value
              console.log(`[ChapterPlanning] Chapter ${chapter.number}: ${value} words`)
            }
          }
        }
      }
    })
  }

  const totalFromPlan = targets.reduce((sum, val) => sum + val, 0)
  console.log(`[ChapterPlanning] Total planned: ${totalFromPlan} words, Target: ${totalWordTarget} words`)

  // If the total is significantly off (more than 10%), adjust proportionally
  if (Math.abs(totalFromPlan - totalWordTarget) > totalWordTarget * 0.10) {
    console.log(`[ChapterPlanning] Adjusting chapter targets to match total (${totalFromPlan} -> ${totalWordTarget})`)
    const adjustmentFactor = totalWordTarget / totalFromPlan
    return targets.map((target) => Math.max(600, Math.round(target * adjustmentFactor)))
  }

  return targets
}

function formatSectionsSummary(chapter: OutlineChapterInfo): string {
  if (!chapter.sections || !chapter.sections.length) return ''
  const lines: string[] = []

  chapter.sections.forEach((section) => {
    lines.push(`- ${section.number} ${section.title}`)
    if (section.subsections && section.subsections.length) {
      section.subsections.forEach((subsection) => {
        lines.push(`  - ${subsection.number} ${subsection.title}`)
      })
    }
  })

  return lines.join('\n')
}

interface ExtendThesisParams {
  thesisData: ThesisData
  thesisPlan: string
  currentContent: string
  expectedWordCount: number
  outlineChapters: OutlineChapterInfo[]
  isGerman: boolean
}

interface GenerateChapterParams {
  thesisData: ThesisData
  chapter: OutlineChapterInfo
  chapterTargetWords: number
  thesisPlan: string
  previousContent: string
  isGerman: boolean
  sources: Source[]
  citationStyle: string
}

async function extendThesisContent({
  thesisData,
  thesisPlan,
  currentContent,
  expectedWordCount,
  outlineChapters,
  isGerman,
}: ExtendThesisParams): Promise<{ content: string; wordCount: number }> {
  let updatedContent = currentContent
  let wordCount = updatedContent.split(/\s+/).length
  const maxPasses = 6 // Increased from 4 to allow more extension attempts
  const minAcceptableRatio = 0.90 // Accept 90% of target as "complete enough"

  // Check if Fazit/conclusion is already written
  const fazitPatterns = [
    /#{1,3}\s*\d+\.?\d*\.?\s*(fazit|schluss|zusammenfassung|conclusion|summary|ausblick)/i,
    /#{1,3}\s*(fazit|schluss|conclusion|summary)\s*(und|and)?\s*(ausblick)?/i,
  ]
  const hasFazit = fazitPatterns.some(pattern => pattern.test(updatedContent))

  // Find the last chapter in the outline
  const lastChapter = outlineChapters[outlineChapters.length - 1]
  const lastChapterWritten = lastChapter && detectChapters(updatedContent, [lastChapter]).length > 0

  const wordRatio = wordCount / expectedWordCount
  console.log(`[ThesisGeneration] [Extension] Current: ${wordCount}/${expectedWordCount} words (${Math.round(wordRatio * 100)}%)`)

  // Only stop early if we're at 90%+ of target AND structure is complete
  if (hasFazit && lastChapterWritten && wordRatio >= minAcceptableRatio) {
    console.log(`[ThesisGeneration] [Extension] ✓ Thesis complete: ${Math.round(wordRatio * 100)}% of target with Fazit written`)
    return { content: updatedContent, wordCount }
  }

  // If we're significantly under target, we MUST extend even if Fazit exists
  if (wordRatio < minAcceptableRatio) {
    console.log(`[ThesisGeneration] [Extension] ⚠️ Only ${Math.round(wordRatio * 100)}% of target - MUST extend even though Fazit exists`)
  }

  for (let pass = 1; pass <= maxPasses && wordCount < expectedWordCount; pass++) {
    const remainingWords = expectedWordCount - wordCount
    const currentRatio = wordCount / expectedWordCount

    // Stop if we've reached acceptable threshold
    if (currentRatio >= minAcceptableRatio) {
      console.log(`[ThesisGeneration] [Extension] ✓ Reached ${Math.round(currentRatio * 100)}% - acceptable threshold met`)
      break
    }

    const roughTarget = Math.max(2000, Math.round(expectedWordCount * 0.15)) // Increased minimum target
    const extensionTargetWords = Math.min(
      remainingWords,
      Math.min(6000, Math.max(roughTarget, Math.ceil(remainingWords / (maxPasses - pass + 1)))) // Increased max per pass
    )

    const missingChapters = getMissingChapters(updatedContent, outlineChapters)

    // Build appropriate expansion instruction based on what's missing
    let missingChapterSummary: string
    if (missingChapters.length > 0) {
      missingChapterSummary = missingChapters.map((chapter) => `- ${chapter}`).join('\n')
    } else if (hasFazit && currentRatio < minAcceptableRatio) {
      // Fazit exists but we're still under target - expand middle chapters ONLY
      missingChapterSummary = isGerman
        ? `- ⚠️ WORTANZAHL ZU NIEDRIG (${wordCount}/${expectedWordCount})!
- Alle Kapitel sind vorhanden, aber die Arbeit ist zu KURZ!
- Vertiefe die Kapitel 2, 3, und 4 mit:
  • Mehr theoretischen Erklärungen
  • Zusätzlichen Beispielen und Anwendungen
  • Kritischer Würdigung der Literatur
  • Detaillierterer Diskussion der Forschungsergebnisse
- NIEMALS nach dem Fazit weiterschreiben!
- NIEMALS neue Kapitel oder Unterkapitel hinzufügen!`
        : `- ⚠️ WORD COUNT TOO LOW (${wordCount}/${expectedWordCount})!
- All chapters present but thesis too SHORT!
- Expand chapters 2, 3, and 4 with:
  • More theoretical explanations
  • Additional examples and applications
  • Critical analysis of literature
  • More detailed discussion of research findings
- NEVER write after the conclusion!
- NEVER add new chapters or subchapters!`
    } else {
      missingChapterSummary = isGerman
        ? '- Vertiefe die vorhandenen Kapitel mit mehr Details und Analyse.'
        : '- Expand existing chapters with more details and analysis.'
    }

    const outlineSummary = buildOutlineSummary(outlineChapters)
    const planSnippet = thesisPlan ? thesisPlan.slice(0, 4000) : ''
    const recentExcerpt = getRecentExcerpt(updatedContent)

    const extensionInstruction = isGerman
      ? `Die Thesis muss mindestens ${expectedWordCount} Wörter umfassen, aktuell sind es nur ${wordCount} Wörter. Ergänze JETZT mindestens ${extensionTargetWords} neue Wörter (gern mehr).`
      : `The thesis must contain at least ${expectedWordCount} words, but it currently has only ${wordCount} words. Add AT LEAST ${extensionTargetWords} new words now (more is welcome). It is better to write too much than too little.`

    const extensionPrompt = isGerman
      ? `Du erweiterst eine wissenschaftliche Arbeit mit dem Thema "${thesisData.title}" (${thesisData.field}).

⚠️⚠️⚠️ ABSOLUT KRITISCH - ERSTE REGEL ⚠️⚠️⚠️
🚫 ABSOLUT VERBOTEN: FRAGE-ANTWORT-MUSTER! NIEMALS "X? Y." verwenden! IMMER direkte Aussagen!

Aktueller Umfang: ${wordCount} Wörter.
Zielumfang: mindestens ${expectedWordCount} Wörter.
Fehlende Wörter: mindestens ${remainingWords}.

Gliederung (STRIKT EINHALTEN - KEINE neuen Kapitel/Unterkapitel erfinden!):
${outlineSummary || '- (keine Gliederung verfügbar)'}

${planSnippet ? `Blueprint/Auszug:\n${planSnippet}\n\n` : ''}Noch zu vertiefende Kapitel:
${missingChapterSummary}

Der bisherige Text endet mit:
<<<AUSZUG-BEGINN>>>
${recentExcerpt}
<<<AUSZUG-ENDE>>>

${extensionInstruction}

🚫 ABSOLUT VERBOTEN:
- KEINE neuen Kapitel oder Unterkapitel erstellen (z.B. KEINE 5.3, 5.4, 5.5 wenn nur 5.1, 5.2 in der Gliederung stehen!)
- KEINE Kapitel aus früheren Teilen wiederholen (z.B. KEIN Kapitel 4 nach Kapitel 5!)
- WENN das Fazit bereits geschrieben ist: Die Arbeit ist FERTIG - schreibe nichts mehr!
- KEIN neuer Text nach dem letzten Kapitel der Gliederung!

✅ ERLAUBT:
- Bestehende Kapitel VERTIEFEN (mehr Details, Beispiele, Argumentationen hinzufügen)
- Mehr Zitationen und Belege in bestehende Absätze einfügen
- Übergänge zwischen bestehenden Kapiteln verbessern
- NUR innerhalb der vorgegebenen Gliederungsstruktur arbeiten!

- Fahre exakt an der letzten Stelle fort (keine Wiederholungen!)
- Verwende Quellen aus dem FileSearchStore mit korrekten Zitationen
- Gib ausschließlich den neuen Zusatztext zurück (keine Kommentare)`
      : `You are extending an academic thesis titled "${thesisData.title}" (${thesisData.field}).

⚠️⚠️⚠️ ABSOLUTELY CRITICAL - FIRST RULE ⚠️⚠️⚠️
🚫 ABSOLUTELY FORBIDDEN: QUESTION-ANSWER PATTERN! NEVER use "X? Y."! ALWAYS use direct statements!

Current length: ${wordCount} words.
Target length: at least ${expectedWordCount} words.
Words still missing: at least ${remainingWords}.

Outline (STRICTLY FOLLOW - DO NOT invent new chapters/subchapters!):
${outlineSummary || '- (no outline provided)'}

${planSnippet ? `Blueprint excerpt:\n${planSnippet}\n\n` : ''}Chapters to expand:
${missingChapterSummary}

The current text ends:
<<<EXCERPT-START>>>
${recentExcerpt}
<<<EXCERPT-END>>>

${extensionInstruction}

🚫 ABSOLUTELY FORBIDDEN:
- DO NOT create new chapters or subchapters (e.g., NO 5.3, 5.4, 5.5 if only 5.1, 5.2 are in the outline!)
- DO NOT repeat chapters from earlier sections (e.g., NO Chapter 4 after Chapter 5!)
- IF the conclusion is already written: The thesis is FINISHED - write nothing more!
- NO new text after the last chapter of the outline!

✅ ALLOWED:
- EXPAND existing chapters (add more details, examples, arguments)
- Add more citations and evidence to existing paragraphs
- Improve transitions between existing chapters
- ONLY work within the provided outline structure!

- Continue exactly where the text stops (no repetition!)
- Use FileSearchStore sources with correct citations
- Output ONLY the additional text (no comments)`

    console.log(`[ThesisGeneration] [Extension] Starting pass ${pass}/${maxPasses} (target +${extensionTargetWords} words)`)

    const extensionResponse = await retryApiCall(
      () => ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: extensionPrompt,
        config: {
          maxOutputTokens: Math.min(400000, Math.ceil(Math.max(extensionTargetWords * 2, 6000) / 0.75)),
          tools: [{
            fileSearch: {
              fileSearchStoreNames: [thesisData.fileSearchStoreId],
            },
          }],
        },
      }),
      `Extend thesis content (pass ${pass})`,
      1,
      2000
    )

    const extensionText = extensionResponse.text?.trim()

    if (!extensionText || extensionText.length < 100) {
      console.warn(`[ThesisGeneration] [Extension] Pass ${pass} returned insufficient text (${extensionText?.length || 0} chars)`)
      break
    }

    const previousWordCount = wordCount
    updatedContent += `\n\n${extensionText}`
    wordCount = updatedContent.split(/\s+/).length
    const addedWords = wordCount - previousWordCount

    console.log(`[ThesisGeneration] [Extension] Pass ${pass} added ~${addedWords} words (total ${wordCount}/${expectedWordCount})`)

    if (addedWords < extensionTargetWords * 0.3) {
      console.warn(`[ThesisGeneration] [Extension] Pass ${pass} produced fewer words than requested (${addedWords}/${extensionTargetWords})`)
    }
  }

  if (wordCount < expectedWordCount) {
    console.warn(`[ThesisGeneration] WARNING: Extension process reached ${wordCount}/${expectedWordCount} words (${Math.round(wordCount / expectedWordCount * 100)}%)`)
    console.warn(`[ThesisGeneration] → GOAL: Meet word count targets. PRIORITY: Always deliver a complete thesis.`)
    console.warn(`[ThesisGeneration] → Continuing with current content - thesis will be delivered.`)
    // Don't throw error - generation must ALWAYS succeed and deliver a thesis
  }

  return { content: updatedContent, wordCount }
}

async function generateChapterContent({
  thesisData,
  chapter,
  chapterTargetWords,
  thesisPlan,
  previousContent,
  isGerman,
  sources,
  citationStyle,
}: GenerateChapterParams): Promise<{ content: string; wordCount: number }> {
  const chapterLabel = formatChapterLabel(chapter) || `${chapter.number}` || 'Kapitel'
  const sectionsSummary = formatSectionsSummary(chapter)
  const chapterPlan = extractChapterPlan(thesisPlan, chapter, isGerman ? 'german' : 'english')
  const previousExcerpt = getRecentExcerpt(previousContent, 4000)

  // GOAL: Reach the target word count for this chapter
  // CRITICAL: But generation must NEVER fail - if we can't reach the target, we continue anyway
  const minChapterWords = Math.max(600, Math.round(chapterTargetWords * 0.9))
  let chapterContent = ''
  let attempts = 0

  // Format Citation Style Label
  const citationStyleLabels: Record<string, string> = {
    'apa': 'APA (7th Edition)',
    'oa': 'APA (7th Edition)',
    'mla': 'MLA (9th Edition)',
    'harvard': 'Harvard Style',
    'chicago': 'Chicago Manual of Style (17th Edition)',
    'ieee': 'IEEE',
    'deutsche-zitierweise': 'Deutsche Zitierweise (Fußnoten)',
    'fussnoten': 'Deutsche Zitierweise (Fußnoten)'
  }
  const citationStyleLabel = citationStyleLabels[citationStyle] || citationStyle || 'Harvard Style'

  // Build comprehensive source list for the prompt - CRITICAL FOR CITATIONS
  const availableSourcesList = sources.map((s, i) => {
    const authors = s.authors && s.authors.length > 0
      ? s.authors.slice(0, 3).join(', ') + (s.authors.length > 3 ? ' et al.' : '')
      : 'Unbekannt'
    const year = s.year || 'o.J.'
    const pageStart = s.pageStart ? String(s.pageStart) : null
    const pageEnd = s.pageEnd ? String(s.pageEnd) : null
    const pages = s.pages || (pageStart && pageEnd ? `${pageStart}-${pageEnd}` : 'keine Angabe')
    // const journal = s.journal || '' // Unused

    // Show valid page range - but emphasize EXACT page numbers are required
    const pageRangeInfo = pageStart && pageEnd
      ? `Seiten: ${pages} (Dokument umfasst S. ${pageStart}-${pageEnd} - verwende die EXAKTE Seitenzahl!)`
      : `Seiten: ${pages} (keine Seitenzahlen verfügbar - lasse die Seitenzahl weg)`

    return `[${i + 1}] ${authors} (${year}): "${s.title}". ${pageRangeInfo}`
  }).join('\n')

  const buildChapterPrompt = (remainingWords: number, currentChapterContext: string = '') => {
    // If we have current chapter context (extension mode), modify instructions
    const isExtension = currentChapterContext.length > 0

    const baseInstructions = isGerman
      ? `Du schreibst das Kapitel "${chapterLabel}" einer akademischen Arbeit mit dem Thema "${thesisData.title}".${isExtension ? ' Du hast den ersten Teil des Kapitels bereits geschrieben. Deine Aufgabe ist es nun, das Kapitel FORTZUFÜHREN und zu beenden.' : ''}`
      : `You are writing the chapter "${chapterLabel}" of an academic thesis titled "${thesisData.title}".${isExtension ? ' You have already written the first part of the chapter. Your task is now to CONTINUE and complete the chapter.' : ''}`

    const strictRules = isGerman
      ? `═══════════════════════════════════════════════════════════════════════════════
QUELLENNUTZUNG & STIL - ABSOLUT KRITISCH
═══════════════════════════════════════════════════════════════════════════════

**⚠️ STRENG VERBOTEN: ERFUNDENE QUELLEN ⚠️**
Du darfst NUR die unten aufgelisteten Quellen zitieren. KEINE anderen.
Erfundene Quellen sind STRENG VERBOTEN.

**VERFÜGBARE QUELLEN (NUR DIESE DARFST DU VERWENDEN):**
${availableSourcesList}

**ZITATIONSSTIL: ${citationStyleLabel}**
${citationStyle === 'deutsche-zitierweise' || citationStyle === 'fussnoten' ? `**Deutsche Zitierweise (Fußnoten):**
- Im Text: Verwende "^N" direkt nach dem zitierten Inhalt (z.B. "...wurde belegt.^1")
- Fortlaufende Nummerierung (^1, ^2, ^3...)
- KEINE Fußnoten-Definitionen am Ende schreiben (diese werden automatisch generiert)` : `**${citationStyleLabel}:**
- Zitiere im Fließtext: (Autor, Jahr, S. XX)
- Beispiel: (Müller, 2021, S. 12) oder (Schmidt et al., 2020, S. 5-7)`}

**🚫 ABSOLUT VERBOTEN: FRAGEN & FRAGE-ANTWORT-MUSTER 🚫**
- NIEMALS Konstruktionen wie "Begriff? Definition." verwenden!
  ✗ "Politische Korruption? Sie ist definiert als..."
  ✗ "Was bedeutet das? Es bedeutet..."
  ✗ "Ist das wirklich so? Ja, denn..."
- NIEMALS rhetorische Fragen nutzen!
- Schreibe IMMER in direkten Aussagen:
  ✓ "Politische Korruption wird definiert als..."
  ✓ "Dies bedeutet konkret, dass..."

**🚫 ABSOLUT VERBOTEN: EIGENE STUDIEN BEHAUPTEN 🚫**
Dies ist eine LITERATURBASIERTE Arbeit - du hast KEINE eigene Forschung durchgeführt!

NIEMALS behaupten:
- ✗ "In dieser Studie wurde untersucht..." → DU hast KEINE Studie durchgeführt!
- ✗ "Unsere Analyse zeigt..." → Es gibt KEINE "unsere Analyse"!
- ✗ "Die Ergebnisse dieser Untersuchung..." → DU hast NICHTS untersucht!
- ✗ "Wir haben festgestellt..." → DU hast NICHTS festgestellt!
- ✗ "Die vorliegende Studie belegt..." → Es gibt KEINE "vorliegende Studie"!
- ✗ "Im Rahmen dieser Arbeit wurden X Teilnehmer befragt..." → LÜGE!
- ✗ "Die Datenanalyse ergab..." → Du hast KEINE Daten analysiert!

STATTDESSEN - Forschung den ECHTEN Autoren zuschreiben:
- ✓ "Müller (2021) zeigt in seiner Studie, dass..."
- ✓ "Die Untersuchung von Schmidt et al. (2020) belegt..."
- ✓ "Laut der Analyse von Weber (2019)..."

**⚠️ ZITATIONSDICHTE - ABSOLUT KRITISCH:**
- JEDER Absatz mit Fakten MUSS mindestens 1 Zitation haben
- Ziel: 1 Zitation pro 100-150 Wörter
- Pro Kapitel: mindestens 3-5 verschiedene Zitationen
- KEINE langen Passagen (>150 Wörter) ohne Zitation!
- Theoretische Abschnitte: besonders viele Zitationen (alle 2-3 Sätze)

**WAS ZITIERT WERDEN MUSS:**
- Definitionen und Begriffserklärungen → IMMER zitieren
- Statistische Daten und Zahlen → IMMER zitieren
- Theorien und Modelle → IMMER zitieren
- Forschungsergebnisse → IMMER zitieren
- Behauptungen über den Stand der Forschung → IMMER zitieren`
      : `═══════════════════════════════════════════════════════════════════════════════
SOURCE USAGE & STYLE - ABSOLUTELY CRITICAL
═══════════════════════════════════════════════════════════════════════════════

**⚠️ STRICTLY FORBIDDEN: FAKE SOURCES ⚠️**
You must ONLY cite the provided sources listed below. NO others.

**AVAILABLE SOURCES (USE ONLY THESE):**
${availableSourcesList}

**CITATION STYLE: ${citationStyleLabel}**
${citationStyle === 'deutsche-zitierweise' || citationStyle === 'fussnoten' ? `**German Citation (Footnotes):**
- In text: Use "^N" directly after content (e.g. "...was proven.^1")
- Continuous numbering (^1, ^2, ^3...)
- DO NOT write footnote definitions at the end` : `**${citationStyleLabel}:**
- Cite in text: (Author, Year, p. XX)
- Example: (Miller, 2021, p. 12) or (Smith et al., 2020, p. 5-7)`}

**🚫 ABSOLUTELY FORBIDDEN: QUESTIONS & Q&A PATTERNS 🚫**
- NEVER use constructions like "Term? Definition."!
  ✗ "Political Corruption? It is defined as..."
  ✗ "What does this mean? It means..."
  ✗ "Is this true? Yes, because..."
- NEVER use rhetorical questions!
- ALWAYS write in direct statements:
  ✓ "Political corruption is defined as..."
  ✓ "Concretely, this means that..."

**🚫 ABSOLUTELY FORBIDDEN: CLAIMING OWN STUDIES 🚫**
This is a LITERATURE-BASED thesis - you have performed NO original research!

NEVER claim:
- ✗ "In this study, we investigated..." → YOU did NO study!
- ✗ "Our analysis shows..." → There is NO "our analysis"!
- ✗ "The results of this investigation..." → YOU investigated NOTHING!
- ✗ "We found that..." → YOU found NOTHING!
- ✗ "The present study proves..." → There is NO "present study"!
- ✗ "In the context of this work, X participants were interviewed..." → LIE!
- ✗ "Data analysis revealed..." → You analyzed NO data!

INSTEAD - Attribute research to REAL authors:
- ✓ "Müller (2021) shows in his study that..."
- ✓ "The investigation by Schmidt et al. (2020) proves..."
- ✓ "According to the analysis by Weber (2019)..."

**⚠️ CITATION DENSITY - ABSOLUTELY CRITICAL:**
- EVERY paragraph with facts MUST have at least 1 citation
- Target: 1 citation per 100-150 words
- Per chapter: at least 3-5 different citations
- NO long passages (>150 words) without citation!
- Theoretical sections: exceptionally high citation density (every 2-3 sentences)

**WHAT MUST BE CITED:**
- Definitions and explanations of terms → ALWAYS cite
- Statistical data and numbers → ALWAYS cite
- Theories and models → ALWAYS cite
- Research results → ALWAYS cite
- Claims about the state of research → ALWAYS cite`


    /* 
       ⚠️ CRITICAL FIX FOR CONTINUITY ⚠️
       The prompt logic was updated to better handle context:
       - 'sectionInstructions' & 'planInstructions' remain same.
       - 'previousContext' logic is adjusted:
         If we are EXTENDING (attempts > 1), we MUST pass the *current partial chapter* as context,
         otherwise the model restarts.
         If starting new (attempt 1), we pass the *previous chapters* (via previousContent/previousExcerpt).
    */

    const sectionInstructions = sectionsSummary
      ? (isGerman
        ? `Die Gliederung dieses Kapitels lautet:\n${sectionsSummary}\n`
        : `The structure of this chapter is:\n${sectionsSummary}\n`)
      : ''

    const planInstructions = chapterPlan
      ? (isGerman
        ? `Blueprint-Ausschnitt:\n${chapterPlan}\n`
        : `Blueprint excerpt:\n${chapterPlan}\n`)
      : ''

    let contextInstruction = ''

    if (isExtension) {
      // EXTENSION MODE: The context is what we just wrote for THIS chapter
      contextInstruction = isGerman
        ? `**BEREITS GESCHRIEBENER TEIL DIESES KAPITELS (Fortsetzung hieran anschließen):**\n<<<\n${currentChapterContext}\n>>>\n\nFühre den Text logisch fort. Wiederhole NICHTS was oben steht. Schreibe einfach weiter.`
        : `**ALREADY WRITTEN PART OF THIS CHAPTER (Continue from here):**\n<<<\n${currentChapterContext}\n>>>\n\nContinue the text logically. Do NOT repeat anything above. Just keep writing.`
    } else {
      // NEW CHAPTER MODE: Context is previous chapters
      contextInstruction = previousContent
        ? (isGerman
          ? `Vorheriger Textausschnitt (Kontext, NICHT wiederholen, nur für Übergänge verwenden):\n<<<\n${previousExcerpt}\n>>>\n`
          : `Previous text excerpt (context only, DO NOT repeat, use only for transitions):\n<<<\n${previousExcerpt}\n>>>\n`)
        : ''
    }

    const lengthInstruction = isGerman
      ? `Schreibe weitere ${remainingWords} Wörter für diesen Teil. Es ist besser, ausführlicher zu sein als zu kurz.`
      : `Write another ${remainingWords} words for this part. It is better to be more detailed than too short.`

    const startInstruction = isExtension
      ? (isGerman ? `SCHREIBE EINFACH WEITER (keine Überschriften wiederholen).` : `JUST KEEP WRITING (do not repeat headings).`)
      : (isGerman
        ? `Beginne SOFORT mit der Kapitelüberschrift "## ${chapterLabel}" und schreibe anschließend das vollständige Kapitel.`
        : `START immediately with the chapter heading "## ${chapterLabel}" and then write the complete chapter.`)

    return `${baseInstructions}

${sectionInstructions}${planInstructions}${contextInstruction}${lengthInstruction}

${strictRules}

Weitere Anforderungen:
- ${isGerman ? 'HALTE DICH STRIKT AN DIE VORGEGEBENE GLIEDERUNG. Ändere KEINE Überschriften. Nutze exakt die vorgegebenen Unterkapitel.' : 'ADHERE STRICTLY TO THE PROVIDED OUTLINE. Do NOT change any headings. Use exactly the provided subchapters.'}
- ${isGerman ? 'Nutze die bereitgestellten Quellen INTENSIV.' : 'Use the provided sources EXTENSIVELY.'}
- ${isGerman ? 'Integriere Kontext, Analyse, Beispiele, Methodik und Diskussion.' : 'Include context, analysis, examples, methodology, and discussion.'}
- ${isGerman ? 'Füge Übergänge zu vorherigen und folgenden Kapiteln ein, ohne Inhalte zu wiederholen.' : 'Add transitions to previous and upcoming chapters without repeating content.'}
- ${isGerman ? 'Gliedere das Kapitel mit passenden Zwischenüberschriften (##, ###, etc.) gemäß der Gliederungsvorgabe.' : 'Structure the chapter with appropriate subheadings (##, ###, etc.) according to the outline.'}
- ${isGerman ? 'Nutze ein akademisches, menschliches Sprachmuster mit Variation in Satzlängen und Syntax.' : 'Use academic, human-like language with varied sentence lengths and syntax.'}
- ${isGerman ? 'Keine Meta-Kommentare, nur Inhalt.' : 'No meta commentary, only content.'}
- ${isGerman ? 'VERMEIDE ÜBERTRIEBENE ADJEKTIVE/ADVERBIEN (UNWISSENSCHAFTLICH): Nutze niemals Wörter wie "unglaublich", "extrem", "total", "absolut", "schockierend", "riesig". Bleibe neutral und sachlich.' : 'AVOID HYPERBOLIC ADJECTIVES/ADVERBS (UNSCIENTIFIC): Never use words like "incredibly", "extremely", "totally", "absolutely", "shocking", "massive". Remain neutral and objective.'}
- ${isGerman ? 'KEINE UMGANGSSPRACHE (ABSOLUT VERBOTEN): Vermeide Füllwörter wie "halt", "eben", "eh", "quasi", "sozusagen", "mal". Schreibe im gehobenen Nominalstil.' : 'NO COLLOQUIAL LANGUAGE (ABSOLUTELY FORBIDDEN): Avoid filler words like "like", "basically", "so to speak", "kind of". Write in formal academic style.'}
- ${isGerman ? 'KEINE PERSONALPRONOMEN (ABSOLUT VERBOTEN): Verwende NIEMALS "ich", "wir", "uns", "unser". Nutze stattdessen Passiv- oder "Man"-Konstruktionen (z.B. "Es wird untersucht" statt "Wir untersuchen").' : 'NO PERSONAL PRONOUNS (ABSOLUTELY FORBIDDEN): NEVER use "I", "we", "us", "our". Use passive or impersonal constructions instead (e.g., "It is analyzed" instead of "We analyze").'}
- ${isGerman ? 'STRENG WISSENSCHAFTLICHER STIL: Nutze präzise Fachterminologie, komplexe Satzstrukturen (Hypotaxen) und vermeide persönliche Meinungen.' : 'STRICT SCIENTIFIC STYLE: Use precise terminology, complex sentence structures, and avoid personal opinions.'}
- ${isGerman ? 'ABSOLUT UNEMOTIONAL: Der Text muss nüchtern, distanziert und analytisch sein. Keine Begeisterung, keine Dramatik, nur Fakten.' : 'ABSOLUTELY UNEMOTIONAL: The text must be cold, distant, and analytical. No excitement, no drama, only facts.'}
- ${isGerman ? `FORSCHUNGSFRAGE UNANTASTBAR: Die Forschungsfrage ("${thesisData.researchQuestion}") darf NICHT verändert, umformuliert oder neu interpretiert werden. Sie steht absolut fest.` : `RESEARCH QUESTION IMMUTABLE: The research question ("${thesisData.researchQuestion}") must NOT be changed, rephrased, or reinterpreted. It is absolute.`}

${startInstruction}`
  }

  while (attempts < 3) {
    attempts += 1
    const currentWords = chapterContent.split(/\s+/).length
    const remainingWords = Math.max(0, chapterTargetWords - currentWords)

    // If extending, pass the last ~1000 chars of current content as context
    const currentChapterExcerpt = chapterContent.length > 1500
      ? '...' + chapterContent.slice(-1500)
      : chapterContent

    // Only ask for extension if we are short, otherwise (attempt 1) ask for full target
    const targetForPrompt = attempts === 1 ? chapterTargetWords : remainingWords

    // Pass extra arg if attempts > 1
    const prompt = buildChapterPrompt(targetForPrompt, attempts > 1 ? currentChapterExcerpt : '')

    const response = await retryApiCall(
      () => ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: prompt,
        config: {
          maxOutputTokens: Math.min(400000, Math.ceil(Math.max(chapterTargetWords * 2, 6000) / 0.75)),
          tools: [{
            fileSearch: {
              fileSearchStoreNames: [thesisData.fileSearchStoreId],
            },
          }],
        },
      }),
      `Generate chapter ${chapterLabel} (attempt ${attempts})`,
      1,
      2000
    )

    const newText = response.text?.trim()
    if (!newText || newText.length < 200) {
      console.warn(`[ThesisGeneration] Chapter ${chapterLabel} attempt ${attempts} returned insufficient text.`)
      continue
    }

    if (attempts === 1 || !chapterContent) {
      chapterContent = newText
    } else {
      chapterContent += `\n\n${newText}`
    }

    const updatedWords = chapterContent.split(/\s+/).length
    if (updatedWords >= minChapterWords) {
      break
    } else {
      console.warn(`[ThesisGeneration] Chapter ${chapterLabel} still short (${updatedWords}/${minChapterWords} words), extending...`)
    }
  }

  const finalWordCount = chapterContent.split(/\s+/).length
  if (finalWordCount < minChapterWords) {
    console.warn(`[ThesisGeneration] WARNING: Chapter ${chapterLabel} is below target (${finalWordCount}/${minChapterWords} words)`)
    console.warn(`[ThesisGeneration] → GOAL: Meet word count targets. PRIORITY: Always deliver a complete thesis.`)
    console.warn(`[ThesisGeneration] → Continuing generation - content will be extended if needed in later steps.`)
    // Don't throw error - generation must ALWAYS succeed and deliver a thesis
  }

  return { content: chapterContent, wordCount: finalWordCount }
}


async function generateThesisContent(thesisData: ThesisData, rankedSources: Source[], thesisPlan: string = ''): Promise<string> {
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

  const outlineChapters: OutlineChapterInfo[] = (thesisData.outline || []).map((chapter: any, index: number) => ({
    number: (chapter?.number ?? `${index + 1}.`).toString().trim(),
    title: (chapter?.title ?? '').toString().trim(),
    sections: (chapter?.sections || chapter?.subchapters || []).map((section: any, sectionIndex: number) => ({
      number: (section?.number ?? `${index + 1}.${sectionIndex + 1}`).toString().trim(),
      title: (section?.title ?? '').toString().trim(),
      subsections: (section?.subsections || []).map((subsection: any, subsectionIndex: number) => ({
        number: (subsection?.number ?? `${index + 1}.${sectionIndex + 1}.${subsectionIndex + 1}`).toString().trim(),
        title: (subsection?.title ?? '').toString().trim(),
      })),
    })),
  }))

  // Calculate target word count with sanity check
  const isWords = thesisData.lengthUnit === 'words' || thesisData.targetLength > 500
  const targetWordCount = isWords ? thesisData.targetLength : thesisData.targetLength * 250
  const maxWordCount = Math.ceil(targetWordCount * 1.10) // Max 10% overshoot
  console.log(`[ThesisGeneration] Target words: ${targetWordCount}, Max words (10% overshoot): ${maxWordCount}`)
  const expectedWordCount = targetWordCount

  // Calculate appropriate number of sources based on thesis length
  // Rule: ~1-1.5 sources per page for short theses, up to 2-2.5 for longer theses
  // Very short theses (< 10 pages): 8-12 sources
  // Short theses (10-20 pages): 12-25 sources
  // Medium theses (20-40 pages): 25-50 sources
  // Long theses (40+ pages): 50-80 sources
  let targetPages = thesisData.targetLength
  if (thesisData.lengthUnit === 'words') {
    // Convert words to pages (assuming ~250 words per page)
    targetPages = Math.ceil(thesisData.targetLength / 250)
  }

  let recommendedSourceCount: number
  let sourceUsageGuidance: string

  if (targetPages < 10) {
    recommendedSourceCount = Math.max(8, Math.min(12, Math.ceil(targetPages * 1.0)))
    sourceUsageGuidance = `Sehr kurze Arbeit (${targetPages} Seiten): Verwende nur ${recommendedSourceCount}-${recommendedSourceCount + 2} hochwertige, zentrale Quellen. Jede Quelle muss essentiell sein. Keine Füllquellen. Eine Arbeit von ${targetPages} Seiten mit ${recommendedSourceCount + 20}+ Quellen wirkt übertrieben und unprofessionell.`
  } else if (targetPages < 20) {
    recommendedSourceCount = Math.max(12, Math.min(25, Math.ceil(targetPages * 1.2)))
    sourceUsageGuidance = `Kurze Arbeit (${targetPages} Seiten): Verwende ${recommendedSourceCount}-${recommendedSourceCount + 3} sorgfältig ausgewählte Quellen. Fokus auf Qualität, nicht Quantität. Eine Arbeit von ${targetPages} Seiten sollte nicht mehr als ${recommendedSourceCount + 5} Quellen haben, sonst wirkt sie überladen.`
  } else if (targetPages < 40) {
    recommendedSourceCount = Math.max(25, Math.min(50, Math.ceil(targetPages * 1.3)))
    sourceUsageGuidance = `Mittlere Arbeit (${targetPages} Seiten): Verwende ${recommendedSourceCount}-${recommendedSourceCount + 5} relevante Quellen. Jede Quelle sollte einen klaren Zweck erfüllen.`
  } else {
    recommendedSourceCount = Math.max(50, Math.min(80, Math.ceil(targetPages * 1.5)))
    sourceUsageGuidance = `Längere Arbeit (${targetPages} Seiten): Verwende ${recommendedSourceCount}-${recommendedSourceCount + 10} Quellen. Umfangreiche Literaturrecherche ist hier angemessen.`
  }

  console.log(`[ThesisGeneration] Target pages: ${targetPages}, Recommended sources: ${recommendedSourceCount}`)
  console.log(`[ThesisGeneration] Available sources: ${rankedSources.length}`)
  console.log(`[ThesisGeneration] Using top ${rankedSources.length} sources by relevance for RAG context`)

  const isGerman = thesisData.language === 'german'

  const useChapterGeneration = outlineChapters.length > 0

  if (useChapterGeneration) {
    console.log('[ThesisGeneration] Using per-chapter generation strategy')
    const chapterContents: string[] = []
    let totalWordCount = 0

    // Helper function to check if a chapter should be skipped (e.g., Verzeichnisse, Bibliography)
    const shouldSkipChapter = (chapter: OutlineChapterInfo): boolean => {
      const title = (chapter.title || '').toLowerCase().trim()
      const skipKeywords = [
        'verzeichnisse', 'verzeichnis', 'literaturverzeichnis', 'bibliography', 'references',
        'anhang', 'appendix', 'abbildungsverzeichnis', 'tabellenverzeichnis',
        'abkürzungsverzeichnis', 'list of figures', 'list of tables', 'abbreviations'
      ]
      return skipKeywords.some(keyword => title.includes(keyword))
    }

    for (let i = 0; i < outlineChapters.length; i++) {
      const chapter = outlineChapters[i]

      // Skip non-content chapters (Verzeichnisse, Bibliography, etc.)
      if (shouldSkipChapter(chapter)) {
        console.log(`[ThesisGeneration] Skipping chapter ${chapter.number} "${chapter.title}" (non-content chapter)`)
        continue
      }

      const chapterTarget = Math.max(800, Math.round(targetWordCount / outlineChapters.length))
      console.log(`[ThesisGeneration] Generating chapter ${chapter.number} (${chapterTarget} words target)`)

      const { content: chapterText, wordCount: chapterWordCount } = await generateChapterContent({
        thesisData,
        chapter,
        chapterTargetWords: chapterTarget,
        thesisPlan: thesisPlan || '',
        previousContent: chapterContents.join('\n\n'),
        isGerman,
        sources: rankedSources,
        citationStyle: thesisData.citationStyle,
      })

      chapterContents.push(chapterText.trim())
      totalWordCount += chapterWordCount
      console.log(`[ThesisGeneration] Chapter ${chapter.number} complete (~${chapterWordCount} words, total ${totalWordCount}/${expectedWordCount})`)
    }

    let combinedContent = chapterContents.join('\n\n\n')

    if (totalWordCount < expectedWordCount) {
      const extensionResult = await extendThesisContent({
        thesisData,
        thesisPlan: thesisPlan || '',
        currentContent: combinedContent,
        expectedWordCount,
        outlineChapters,
        isGerman,
      })
      combinedContent = extensionResult.content
      totalWordCount = extensionResult.wordCount
      console.log(`[ThesisGeneration] ✓ Word count reached after extension: ~${totalWordCount}/${expectedWordCount} words`)
    }

    return combinedContent
  }

  // Build comprehensive source list for the prompt - THIS IS CRITICAL
  // The AI MUST know exactly which sources it can cite AND valid page ranges
  const availableSourcesList = rankedSources.map((s, i) => {
    const authors = s.authors && s.authors.length > 0
      ? s.authors.slice(0, 3).join(', ') + (s.authors.length > 3 ? ' et al.' : '')
      : 'Unbekannt'
    const year = s.year || 'o.J.'
    const pageStart = s.pageStart ? String(s.pageStart) : null
    const pageEnd = s.pageEnd ? String(s.pageEnd) : null
    const pages = s.pages || (pageStart && pageEnd ? `${pageStart}-${pageEnd}` : 'keine Angabe')
    const journal = s.journal || ''

    // Show valid page range - but emphasize EXACT page numbers are required
    const pageRangeInfo = pageStart && pageEnd
      ? `Seiten: ${pages} (Dokument umfasst S. ${pageStart}-${pageEnd} - verwende die EXAKTE Seitenzahl, auf der der zitierte Inhalt steht!)`
      : `Seiten: ${pages} (keine Seitenzahlen verfügbar - lasse die Seitenzahl KOMPLETT weg, schreibe NICHT "S. [keine Angabe]")`

    return `[${i + 1}] ${authors} (${year}): "${s.title}"${journal ? `. In: ${journal}` : ''}. ${pageRangeInfo}`
  }).join('\n')

  const mandatorySources = rankedSources.filter(s => s.mandatory)
  const mandatorySourcesSection = mandatorySources.length > 0 ? `
**PFLICHTQUELLEN - MÜSSEN ZITIERT WERDEN:**
Die folgenden Quellen wurden vom Nutzer als Pflichtquellen markiert und MÜSSEN in der Thesis zitiert werden:
${mandatorySources.map((s, i) => `${i + 1}. "${s.title}" (${s.authors.slice(0, 2).join(', ')}${s.authors.length > 2 ? ' et al.' : ''}, ${s.year || 'o.J.'})`).join('\n')}

Jede Pflichtquelle muss mindestens einmal sinnvoll im Text zitiert werden.
` : ''

  const prompt = isGerman ? `Du schreibst eine wissenschaftliche ${thesisData.thesisType} zum Thema "${thesisData.title}".

⚠️⚠️⚠️ ABSOLUT KRITISCH - ERSTE REGEL - NIEMALS VERLETZEN ⚠️⚠️⚠️

🚫 ABSOLUT VERBOTEN: FRAGE-ANTWORT-MUSTER (MACHT TEXT UNLESBAR!)
- NIEMALS Konstruktionen wie "X? Y." oder "X? In der Literatur..." verwenden!
- VERBOTEN: "Die Grenze zwischen X und Y? In der öffentlichen Wahrnehmung..."
- VERBOTEN: "Korruption und Lobbyismus: zwei verschiedene Arten. Lobbyismus hingegen? Unverzichtbar..."
- VERBOTEN: "Aber diese beiden Phänomene zu trennen? Schwierig."
- VERBOTEN: "Das Kernproblem? Es ist ungemein schwer..."
- VERBOTEN: "Korruption? In der wirtschaftswissenschaftlichen Literatur versteht man darunter..."
- VERBOTEN: JEDE Konstruktion mit Fragezeichen gefolgt von einer Antwort!
- VERBOTEN: Jegliche rhetorische oder suggestive Fragen!
- IMMER direkte Aussagen verwenden: "Die Grenze zwischen X und Y verwischt..." statt "Die Grenze zwischen X und Y? In der öffentlichen Wahrnehmung..."

═══════════════════════════════════════════════════════════════════════════════
KERNAUFGABE
═══════════════════════════════════════════════════════════════════════════════

Erstelle den vollständigen Fließtext für alle Kapitel der Thesis. Du erstellst NUR den Kapiteltext - kein Inhaltsverzeichnis, kein Literaturverzeichnis.

**Was du erstellst:**
- Vollständiger wissenschaftlicher Text für ALLE Kapitel aus der Gliederung
- Zitationen im korrekten Stil (${citationStyleLabel})
- ${thesisData.citationStyle === 'deutsche-zitierweise' ? 'Fußnoten-Definitionen am Ende (Format: [^1]: Autor, Titel, Jahr, S. XX)' : 'In-Text-Zitationen im korrekten Format'}

**Was du NICHT erstellst:**
- KEIN Inhaltsverzeichnis (wird automatisch generiert)
- KEIN Literaturverzeichnis (wird aus den Zitationsmetadaten erstellt)
- KEIN Titelblatt, KEINE Überschrift mit "Bachelorarbeit/Hausarbeit" etc.
- KEINE Tabellen, Bilder, Grafiken oder Anhänge

═══════════════════════════════════════════════════════════════════════════════
THESIS-INFORMATIONEN
═══════════════════════════════════════════════════════════════════════════════

- **Titel:** ${thesisData.title}
- **Fachbereich:** ${thesisData.field}
- **Art:** ${thesisData.thesisType}
- **Forschungsfrage:** ${thesisData.researchQuestion}
- **Zitationsstil:** ${citationStyleLabel}
- **Ziel-Länge:** ${targetWordCount} Wörter (ca. ${targetPages} Seiten)
- **Sprache:** Deutsch

**Gliederung:**
${JSON.stringify(thesisData.outline, null, 2)}

${thesisPlan ? `**Detaillierter Plan:**
${thesisPlan}
` : ''}
${mandatorySourcesSection}
═══════════════════════════════════════════════════════════════════════════════
QUELLENNUTZUNG - ABSOLUT KRITISCH
═══════════════════════════════════════════════════════════════════════════════

**⚠️ STRENG VERBOTEN: ERFUNDENE QUELLEN ⚠️**
Du darfst NUR die unten aufgelisteten Quellen zitieren. KEINE anderen.
Erfundene Quellen (wie "McAfee", "Autor, 2003", etc.) sind STRENG VERBOTEN.

**🚫 ABSOLUT VERBOTEN: EIGENE STUDIEN BEHAUPTEN 🚫**
Dies ist eine LITERATURBASIERTE Arbeit - du hast KEINE eigene Forschung durchgeführt!

NIEMALS behaupten:
- ✗ "In dieser Studie wurde untersucht..." → DU hast KEINE Studie durchgeführt!
- ✗ "Unsere Analyse zeigt..." → Es gibt KEINE "unsere Analyse"!
- ✗ "Die Ergebnisse dieser Untersuchung..." → DU hast NICHTS untersucht!
- ✗ "Wir haben festgestellt..." → DU hast NICHTS festgestellt!
- ✗ "Die vorliegende Studie belegt..." → Es gibt KEINE "vorliegende Studie"!
- ✗ "Im Rahmen dieser Arbeit wurden X Teilnehmer befragt..." → LÜGE!
- ✗ "Die Datenanalyse ergab..." → Du hast KEINE Daten analysiert!

STATTDESSEN - Forschung den ECHTEN Autoren zuschreiben:
- ✓ "Müller (2021) zeigt in seiner Studie, dass..."
- ✓ "Die Untersuchung von Schmidt et al. (2020) belegt..."
- ✓ "Laut der Analyse von Weber (2019)..."
- ✓ "Die Forschungsergebnisse von Korinek und Stiglitz (2017) deuten darauf hin..."

Du schreibst eine LITERATURARBEIT:
- Du ANALYSIERST und VERGLEICHST bestehende Forschung
- Du FASST ZUSAMMEN, was andere Forscher herausgefunden haben
- Du DISKUTIERST verschiedene Standpunkte aus der Literatur
- Du führst KEINE eigene empirische Forschung durch!

**VERFÜGBARE QUELLEN (NUR DIESE DARFST DU VERWENDEN UND ZITIEREN):**
${availableSourcesList}

**ZITATIONSREGELN - STRIKT EINHALTEN:**
- Nutze AUSSCHLIESSLICH die oben aufgelisteten ${rankedSources.length} Quellen
- Mindestens ${Math.max(5, Math.floor(rankedSources.length * 0.6))} verschiedene Quellen müssen zitiert werden

**⚠️ ZITATIONSDICHTE - ABSOLUT KRITISCH:**
- JEDER Absatz mit Fakten, Theorien oder Forschungsergebnissen MUSS mindestens 1 Zitation haben
- Ziel: 1 Zitation pro 100-150 Wörter (NICHT 200!)
- Pro Kapitel: mindestens 3-5 verschiedene Zitationen
- KEINE langen Passagen (>150 Wörter) ohne Zitation!
- Theoretische Abschnitte: besonders viele Zitationen (alle 2-3 Sätze)

**WAS ZITIERT WERDEN MUSS:**
- Definitionen und Begriffserklärungen → IMMER zitieren
- Statistische Daten und Zahlen → IMMER zitieren
- Theorien und Modelle → IMMER zitieren
- Forschungsergebnisse → IMMER zitieren
- Behauptungen über den Stand der Forschung → IMMER zitieren
- Nur eigene Schlussfolgerungen im Fazit dürfen ohne Zitation bleiben

**VERBOTEN:**
- ✗ Absätze mit Fakten OHNE Zitation
- ✗ "Studien zeigen..." ohne konkrete Zitation
- ✗ "Es ist bekannt, dass..." ohne Quelle
- ✗ "Forschungen belegen..." ohne Nachweis
- ✗ "In dieser Studie/Arbeit wurde untersucht..." → LÜGE!
- ✗ "Unsere Ergebnisse zeigen..." → Es gibt KEINE eigenen Ergebnisse!
- ✗ "Die Datenerhebung ergab..." → Es gab KEINE Datenerhebung!
- ✗ Jegliche Behauptung eigener empirischer Forschung
- ✗ ABSOLUT KEINE FRAGEN - WEDER RHETORISCHE NOCH SUGGESTIVE - NIEMALS VERWENDEN!
  ✗ "Aber ist das wirklich so?"
  ✗ "Welche Auswirkungen hat dies?"
  ✗ "Wie lässt sich dies erklären?"
  ✗ "Was bedeutet das für...?"
  ✗ "the research? a very important part..." (Fragezeichen nach Aussage)
  ✗ "Was ist X? Ein wichtiger Aspekt..." (selbstreflexive Fragen)
  ✗ Jegliche Frageform, Fragezeichen oder suggestive Fragekonstruktionen im Text
  ✗ Selbst in rhetorischer Form - ABSOLUT VERBOTEN!
- ✗ ABSOLUT VERBOTEN: FRAGE-ANTWORT-MUSTER (KRITISCH - UNLESBAR!)
  ✗ "Die Grenze zwischen X und Y? In der öffentlichen Wahrnehmung..."
  ✗ "Korruption und Lobbyismus: zwei verschiedene Arten. Lobbyismus hingegen? Unverzichtbar..."
  ✗ "Aber diese beiden Phänomene zu trennen? Schwierig."
  ✗ "Das Kernproblem? Es ist ungemein schwer..."
  ✗ "Korruption? In der wirtschaftswissenschaftlichen Literatur versteht man darunter..."
  ✗ JEDE Konstruktion mit Fragezeichen gefolgt von einer Antwort ist VERBOTEN!
  ✗ Dieses Muster macht den Text unlesbar und ist unwissenschaftlich!
  ✓ IMMER direkte Aussagen und Feststellungen verwenden
  ✓ Statt "Die Grenze zwischen X und Y? In der öffentlichen Wahrnehmung..." → "Die Grenze zwischen X und Y verwischt in der öffentlichen Wahrnehmung..."
  ✓ Statt "Korruption? In der wirtschaftswissenschaftlichen Literatur..." → "In der wirtschaftswissenschaftlichen Literatur versteht man unter Korruption..."
  ✓ Statt "Was ist Forschung? Ein wichtiger Aspekt..." → "Die Forschung stellt einen wichtigen Aspekt dar."

**SEITENZAHLEN - ABSOLUT EXAKT ERFORDERLICH:**
- JEDE Zitation muss die EXAKTE Seitenzahl enthalten, auf der der zitierte Inhalt tatsächlich steht
- Die Seitenzahl muss STIMMEN - nicht nur im Toleranzbereich liegen!
- **KRITISCH:** Verwende die Seitenzahl, die im FileSearchStore-Retrieval-Ergebnis angezeigt wird
- Der FileSearchStore zeigt dir beim Retrieval die EXAKTE Seitenzahl, auf der der zitierte Text steht
- Die Seitenzahl muss die TATSÄCHLICHE Seite sein, auf der der zitierte Text/Inhalt im Dokument steht
- NIEMALS Seitenzahlen erfinden, schätzen oder zufällig wählen!
- NIEMALS eine Seitenzahl verwenden, nur weil sie im gültigen Bereich liegt - sie muss EXAKT sein!
- Beispiel FALSCH: Quelle hat Seiten 2-4, du zitierst S. 3, obwohl der Inhalt auf S. 2 steht → FALSCH!
- Beispiel RICHTIG: Quelle hat Seiten 2-4, FileSearchStore zeigt Inhalt auf S. 2 → verwende S. 2!
- Wenn der FileSearchStore keine Seitenzahl liefert, lasse die Seitenzahl KOMPLETT weg - schreibe NICHT "S. [keine Angabe]" oder ähnliches!
- Prüfe IMMER: Ist die verwendete Seitenzahl die EXAKTE Seite, die der FileSearchStore für diesen Inhalt anzeigt?

${thesisData.citationStyle === 'deutsche-zitierweise' ? `**Deutsche Zitierweise (Fußnoten):**
- Im Text: Verwende "^N" direkt nach dem zitierten Inhalt
- Fortlaufende Nummerierung (^1, ^2, ^3...) in der Reihenfolge des Erscheinens
- Jede neue Zitation = neue Nummer (auch bei wiederholter Quelle)
- WICHTIG: Schreibe KEINE Fußnoten-Definitionen ([^1]: ...) am Ende!
- Die Fußnoten werden automatisch aus den Quellenmetadaten generiert

**Beispiel mit echten Quellen aus der Liste:**
"Künstliche Intelligenz verändert die Arbeitswelt grundlegend^1. ${rankedSources.length > 0 ? `${rankedSources[0].authors?.[0]?.split(' ').pop() || 'Autor'} (${rankedSources[0].year || 'o.J.'})` : 'Autor (Jahr)'} argumentiert, dass...^2"

WICHTIG: Verwende NUR die Autoren/Jahre aus der obigen Quellenliste!` : `**${citationStyleLabel}:**
- Zitiere im Text: (Autor, Jahr, S. XX) oder (Autor, Jahr, S. XX-YY)
- Bei mehreren Autoren: (Autor et al., Jahr, S. XX)

**Beispiel mit echten Quellen aus der Liste:**
${rankedSources.length > 0 ? `"Die Forschung zeigt (${rankedSources[0].authors?.[0]?.split(' ').pop() || 'Autor'}, ${rankedSources[0].year || 'o.J.'}, S. 5)..."` : '"Die Forschung zeigt (Autor, Jahr, S. 5)..."'}

WICHTIG: Verwende NUR die Autoren/Jahre aus der obigen Quellenliste!`}

═══════════════════════════════════════════════════════════════════════════════
SCHREIBSTIL
═══════════════════════════════════════════════════════════════════════════════

**Wissenschaftlicher Ton:**
- Objektiv, präzise, sachlich
- Keine persönlichen Meinungen oder Marketing-Sprache
- Ergebnisse den Autoren zuschreiben: "Müller (2021) zeigt..." statt "Es ist bewiesen..."

**🚫 VERBOTEN - Unwissenschaftliche Stilmittel:**
- ABSOLUT KEINE FRAGEN IM TEXT - WEDER RHETORISCHE NOCH SUGGESTIVE!
  ✗ "Was bedeutet Digitalisierung für die Arbeitswelt?"
  ✗ "Aber ist das wirklich so?"
  ✗ "Welche Auswirkungen hat dies?"
  ✗ "the research? a very important part..." (Fragezeichen nach Aussage)
  ✗ Jegliche Frageform, Fragezeichen oder suggestive Fragekonstruktionen
  ✗ Selbstreflexive Fragen wie "Was ist X? Ein wichtiger Aspekt..."
- ABSOLUT VERBOTEN: FRAGE-ANTWORT-MUSTER (KRITISCH - UNLESBAR!)
  ✗ "Die Grenze zwischen X und Y? In der öffentlichen Wahrnehmung..."
  ✗ "Korruption und Lobbyismus: zwei verschiedene Arten. Lobbyismus hingegen? Unverzichtbar..."
  ✗ "Aber diese beiden Phänomene zu trennen? Schwierig."
  ✗ "Das Kernproblem? Es ist ungemein schwer..."
  ✗ "Korruption? In der wirtschaftswissenschaftlichen Literatur versteht man darunter..."
  ✗ JEDE Konstruktion mit Fragezeichen gefolgt von einer Antwort ist VERBOTEN!
  ✗ Dieses Muster macht den Text unlesbar und ist unwissenschaftlich!
  ✓ IMMER direkte Aussagen und Feststellungen verwenden
  ✓ "Die Grenze zwischen X und Y verwischt in der öffentlichen Wahrnehmung..."
  ✓ "Korruption und Lobbyismus sind zwei verschiedene Arten. Lobbyismus ist hingegen unverzichtbar..."
  ✓ "Die Trennung dieser beiden Phänomene ist schwierig."
  ✓ "Das Kernproblem besteht darin, dass es ungemein schwer ist..."
  ✓ "In der wirtschaftswissenschaftlichen Literatur versteht man unter Korruption..."
- KEINE emotionalen oder wertenden Adjektive!
  ✗ "wird heiß diskutiert", "brennend aktuell", "erschreckend", "beeindruckend"
  ✗ "dramatisch", "revolutionär", "bahnbrechend", "erstaunlich"
  ✓ "wird kontrovers diskutiert", "ist Gegenstand aktueller Forschung"
  ✓ "zeigt signifikante Veränderungen", "weist erhebliche Unterschiede auf"
- KEINE journalistische oder Marketing-Sprache!
  ✗ "Die Zukunft ist jetzt", "Ein Paradigmenwechsel steht bevor"
  ✓ Sachliche, nüchterne Beschreibungen

**Sprachliche Regeln:**
- KEINE persönlichen Pronomen ("wir", "ich", "uns")
  ✗ "Wir werden im nächsten Abschnitt..."
  ✓ "Im nächsten Abschnitt wird..."
- KEINE unprofessionellen Wörter: "freilich", "sicherlich", "natürlich" (als Füllwort)
- ABSOLUT KEINE UMGANGSSPRACHE!
  ✗ "denk mal an...", "schau dir an...", "guck mal...", "hör mal..."
  ✗ "klar", "logisch", "natürlich" (umgangssprachlich), "eigentlich" (als Füllwort)
  ✗ Alle umgangssprachlichen Formulierungen sind VERBOTEN
  ✓ Verwende ausschließlich wissenschaftliche, formale Sprache
- Verwende Passiv oder unpersönliche Konstruktionen

**Natürlicher Stil (Anti-AI-Detection):**
- Variiere Satzlängen: kurz (5-10 Wörter), mittel (15-20), lang (25-35)
- Variiere Satzanfänge (nicht immer "Die", "Es", "Dies")
- Verwende unterschiedliche Synonyme
- Vermeide KI-typische Phrasen: "zunächst", "ferner", "zusammenfassend", "darüber hinaus"
- Nutze natürliche Übergänge: "Dabei zeigt sich", "Vor diesem Hintergrund", "In diesem Kontext"
- ABER: Bleibe IMMER sachlich und wissenschaftlich - keine Fragen, keine Emotionen!

═══════════════════════════════════════════════════════════════════════════════
STRUKTUR UND LÄNGE - ⚠️ KRITISCH: WORTANZAHL EINHALTEN!
═══════════════════════════════════════════════════════════════════════════════

**🎯 PFLICHT-WORTANZAHL: MINDESTENS ${targetWordCount} Wörter!**

⚠️ **ABSOLUT KRITISCH - LÄNGENANFORDERUNG:**
- Du MUSST mindestens ${targetWordCount} Wörter schreiben!
- Eine Arbeit mit weniger als ${Math.floor(targetWordCount * 0.9)} Wörtern ist INAKZEPTABEL!
- Maximum: ${maxWordCount} Wörter (aber NIEMALS unter ${targetWordCount}!)
- ${targetWordCount} Wörter = ca. ${Math.ceil(targetWordCount / 250)} Seiten

**WORTVERTEILUNG PRO KAPITEL (ungefähr):**
- Einleitung: ${Math.ceil(targetWordCount * 0.08)}-${Math.ceil(targetWordCount * 0.12)} Wörter (~8-12%)
- Theoretischer Rahmen/Grundlagen: ${Math.ceil(targetWordCount * 0.20)}-${Math.ceil(targetWordCount * 0.25)} Wörter (~20-25%)
- Hauptteil (Kapitel 3+4): ${Math.ceil(targetWordCount * 0.45)}-${Math.ceil(targetWordCount * 0.55)} Wörter (~45-55%)
- Fazit: ${Math.ceil(targetWordCount * 0.08)}-${Math.ceil(targetWordCount * 0.12)} Wörter (~8-12%)

**WIE DU DIE WORTANZAHL ERREICHST:**
1. Jedes Kapitel AUSFÜHRLICH behandeln - nicht nur oberflächlich
2. Theorien und Konzepte DETAILLIERT erklären
3. Mehrere Quellen PRO Argument diskutieren
4. Beispiele und Anwendungen einbringen
5. Kritische Würdigung der Literatur einbauen
6. Übergänge zwischen Kapiteln ausführlich gestalten

**VERBOTEN:**
- ✗ Zu kurze, oberflächliche Kapitel
- ✗ Nur 1-2 Sätze pro Unterkapitel
- ✗ Aufzählungen statt Fließtext
- ✗ Eine Arbeit mit ${Math.floor(targetWordCount * 0.6)} Wörtern abliefern, wenn ${targetWordCount} gefordert sind!

**⚠️ STRIKTE GLIEDERUNGSTREUE - ABSOLUT KRITISCH:**
- Schreibe NUR die Kapitel/Unterkapitel, die in der Gliederung vorgegeben sind
- KEINE zusätzlichen Kapitel, Abschnitte oder Ergänzungen hinzufügen!
- KEINE "Ergänzungen zu Kapitel X" oder ähnliche Nachträge
- KEINE Zusammenfassungen einzelner Kapitel am Ende
- Das letzte Kapitel der Gliederung IST das Ende der Arbeit
- Nach dem letzten Kapitel kommt NICHTS mehr (kein Text, keine Ergänzungen)

**🚫 VERBOT: KEINE EIGENEN UNTERKAPITEL ERFINDEN!**
- Wenn die Gliederung nur 5.1 und 5.2 hat, darfst du KEINE 5.1.1, 5.1.2 etc. erstellen!
- Du darfst die Gliederung NICHT vertiefen oder erweitern!
- Schreibe NUR die Überschriften, die in der Gliederung stehen!
- Beispiel: Gliederung hat "5.1 Zusammenfassung" → Schreibe NUR "### 5.1 Zusammenfassung"
- VERBOTEN: Gliederung hat "5.1" aber du schreibst "#### 5.1.1", "#### 5.1.2" → FALSCH!

**📝 FAZIT / SCHLUSSKAPITEL - SPEZIELLE REGELN:**
Das Fazit/Schlusskapitel muss KURZ und PRÄGNANT sein:
- NUR eine Zusammenfassung der wichtigsten Erkenntnisse (keine neue Analyse!)
- KEINE neuen Argumente, Theorien oder Zitationen im Fazit
- Wenn "Ausblick" vorhanden: NUR 2-3 Sätze zu möglichem Forschungsbedarf
- KEINE tiefen Analysen oder ausführlichen Diskussionen im Fazit
- Das Fazit wiederholt KURZ die Hauptergebnisse, mehr nicht
- Typische Länge: 1-2 Seiten, NICHT mehr!

**STRENG VERBOTEN nach dem letzten Kapitel:**
- ✗ "Ergänzungen zu Kapitel 2..."
- ✗ "Zusätzliche Anmerkungen..."
- ✗ "Weitere Überlegungen..."
- ✗ "Nachträge..."
- ✗ Jeglicher Text nach dem Fazit/Schlusskapitel

**Strukturelle Anforderungen:**
1. Beginne SOFORT mit "## 1. Einleitung" (kein Text davor!)
2. Schreibe ALLE Kapitel aus der Gliederung vollständig und IN DER RICHTIGEN REIHENFOLGE
3. Jedes Kapitel muss seinen wissenschaftlichen Zweck erfüllen
4. Ende mit dem letzten Kapitel (Fazit/Diskussion) - DANN STOPP!
5. Wenn du mehr Inhalt brauchst, erweitere die BESTEHENDEN Kapitel, füge KEINE neuen hinzu
6. KEINE Unterkapitel erfinden, die nicht in der Gliederung stehen!

**Aufbau der Arbeit (in Einleitung):**
- Beschreibe NUR die nachfolgenden Kapitel (2, 3, 4...)
- NICHT Kapitel 1 beschreiben (ist bereits geschrieben)
  ✗ "Das erste Kapitel führt ein..."
  ✓ "Im zweiten Kapitel wird..., das dritte Kapitel behandelt..."

═══════════════════════════════════════════════════════════════════════════════
OUTPUT-FORMAT
═══════════════════════════════════════════════════════════════════════════════

Gib den Text in Markdown aus - EXAKT nach der vorgegebenen Gliederung:

## 1. Einleitung
[Einleitungstext mit Zitationen^1^2...]

## 2. [Exakter Kapitelname aus Gliederung]
[Kapiteltext...]

## 3. [Exakter Kapitelname aus Gliederung]
[Kapiteltext...]

[... alle Kapitel EXAKT wie in der Gliederung ...]

## [Letztes Kapitel aus Gliederung - z.B. Fazit]
[Fazittext...]

--- ENDE DER ARBEIT ---

**⚠️ NACH DEM LETZTEN KAPITEL KOMMT NICHTS MEHR!**
- Kein weiterer Text
- Keine Ergänzungen
- Keine Zusammenfassungen
- Keine zusätzlichen Abschnitte
- STOPP nach dem letzten Satz des Fazits/Schlusskapitels

${thesisData.citationStyle === 'deutsche-zitierweise' ? `
**Fußnoten-Format im Text:**
- Markiere Zitationen mit ^N direkt nach dem zitierten Inhalt (z.B. "Die Forschung zeigt^1")
- Die Fußnoten-Metadaten werden automatisch verarbeitet - schreibe KEINE Fußnoten-Definitionen am Ende
- Verwende fortlaufende Nummerierung (^1, ^2, ^3...)` : ''}

BEGINNE JETZT mit "## 1. Einleitung" - schreibe die vollständige Thesis.
HALTE DICH STRIKT an die vorgegebene Gliederung - KEINE zusätzlichen Kapitel oder Ergänzungen!`

    : `You are a scientific assistant who writes academic texts exclusively based on the provided, indexed sources (RAG / File Search).

⚠️⚠️⚠️ ABSOLUTELY CRITICAL - FIRST RULE - NEVER VIOLATE ⚠️⚠️⚠️

🚫 ABSOLUTELY FORBIDDEN: QUESTION-ANSWER PATTERN (MAKES TEXT UNREADABLE!)
- NEVER use constructions like "X? Y." or "X? In the literature..."
- FORBIDDEN: "The boundary between X and Y? In public perception..."
- FORBIDDEN: "Corruption and lobbying: two different types. Lobbying, however? Indispensable..."
- FORBIDDEN: "But separating these two phenomena? Difficult."
- FORBIDDEN: "The core problem? It is extremely difficult..."
- FORBIDDEN: "Corruption? In the economic literature, it is understood as..."
- FORBIDDEN: ANY construction with a question mark followed by an answer!
- FORBIDDEN: Any rhetorical or suggestive questions!
- ALWAYS use direct statements: "The boundary between X and Y blurs..." instead of "The boundary between X and Y? In public perception..."

**IMPORTANT - Research and Source Context:**
- You have researched and selected the sources YOURSELF - you are both author and researcher of this thesis.
- The provided sources are the result of your own literature research and have been evaluated by you as relevant and sufficient for this thesis.
- It is NOT appropriate to mention in the text that "the provided sources are insufficient" or that "additional sources are needed".
- If certain aspects cannot be fully covered, formulate this scientifically neutrally (e.g., "Further research would be desirable" or "This aspect requires further investigation"), but NEVER as criticism of your own source selection.
- You write as a researcher who has selected his sources himself - therefore, the existing sources are by definition sufficient for the thesis.

**ABSOLUTELY FORBIDDEN - AI Limitations and Visual Elements:**
- NEVER mention that you "cannot create images", "cannot create tables" or similar AI limitations.
- NEVER use phrases like "Since I cannot create images, I will describe..." or "I cannot create tables, therefore...".
- NEVER mention your capabilities or limitations - write like a human author who simply writes text.
- ABSOLUTELY FORBIDDEN: Creating tables, images, graphics, diagrams, charts, or any other visual elements.
- ABSOLUTELY FORBIDDEN: Using markdown tables (| Column 1 | Column 2 |) or HTML tables.
- ABSOLUTELY FORBIDDEN: Using descriptions like "The following table shows..." or "In the graphic, one can see...".
- ONLY plain text is allowed - no tables, no images, no graphics.
- Mathematical formulas are allowed (in correct format: $...$ for inline, $$...$$ for display), but NO tables or visual elements.
- If data or comparisons need to be presented, describe them in plain text - never in table format.
- Write naturally and humanly - never like an AI explaining its limitations.

**Thesis Information:**
- Title/Topic: ${thesisData.title}
- Field: ${thesisData.field}
- Type: ${thesisData.thesisType}
- Research Question: ${thesisData.researchQuestion}
- Citation Style: ${citationStyleLabel}
- Target Length: ${targetWordCount} words (ABSOLUTE MAXIMUM: ${maxWordCount} words - ONLY 10% overshoot allowed!)
- Language: ${thesisData.language}

**CRITICAL - WORD COUNT MANAGEMENT:**
- Target: ${targetWordCount} words
- Absolute Maximum: ${maxWordCount} words (= ${targetWordCount} + 10%)
- Aim for approximately ${targetWordCount} words of chapter content
- NEVER exceed ${maxWordCount} words
- Exceeding 10% overshoot is UNACCEPTABLE and will result in rejection
- DO NOT write a Bibliography section - it is generated automatically

${thesisPlan ? `**DETAILED THESIS PLAN (BLUEPRINT) - STRICT ADHERENCE:**
Follow this plan strictly for structure and source usage. This is your blueprint:
${thesisPlan}
` : ''}

${(() => {
      const mandatorySources = rankedSources.filter(s => s.mandatory)
      if (mandatorySources.length === 0) return ''
      return `**MANDATORY SOURCES (CRITICAL - MUST BE CITED):**
The following sources are MANDATORY and MUST be cited in your thesis:
${mandatorySources.map((s, i) => `${i + 1}. ${s.title} (${s.authors.join(', ')}, ${s.year || 'n.d.'})`).join('\n')}

- You MUST cite each of these mandatory sources at least once in the thesis
- These sources should be integrated naturally where they are thematically relevant
- Failure to cite mandatory sources is UNACCEPTABLE and will result in rejection
- Mandatory sources are often works by the professor or central works in the field
`
    })()}

**Outline:**
${JSON.stringify(thesisData.outline, null, 2)}

**Source Usage (CRITICAL - strictly follow):**
- Use exclusively the sources provided in the context (File Search / RAG).
- Use only information that is clearly contained in these sources.
- No invented page numbers, no invented quotes, no invented sources.
- ABSOLUTELY FORBIDDEN: Creating hypothetical sources, placeholder sources, or sources marked as "(Hypothetische Quelle)" or "(Hypothetical Source)".
- ABSOLUTELY FORBIDDEN: Citing sources that are NOT in the FileSearchStore/RAG context.
- If a source is not available in the RAG context, you MUST NOT cite it, even if you know it exists.
- You can ONLY use sources that are actually retrieved from the FileSearchStore during generation.

**PAGE NUMBERS - ABSOLUTELY IMPORTANT (REQUIRED):**
- EVERY citation MUST include page numbers - this is MANDATORY.
- Page numbers are required in ALL citation styles (APA, Harvard, MLA, Deutsche Zitierweise).
- When you use information from a source, you MUST specify the page number where this information can be found.
- Use the page numbers from the sources (File Search / RAG context).
- Format according to citation style:
  * APA/Harvard: (Author, Year, p. XX) or (Author, Year, pp. XX-YY)
  * MLA: (Author XX) or (Author XX-YY)
  * Deutsche Zitierweise: In footnotes: Author, Title, Year, S. XX
- If the page number is not explicitly given in the RAG context, use the page numbers from the source metadata or estimate based on context (e.g., if the context comes from "Chapter 3", use a plausible page number).
- If page number is NOT available, leave it out COMPLETELY - do NOT write "p. [no page]" or "S. [keine Angabe]" or similar!
- NEVER cite without a page number - page numbers are MANDATORY. If unavailable, omit the page reference entirely.

- If certain aspects are not fully covered in the sources, formulate this scientifically neutrally (e.g., "This aspect requires further investigation" or "Further research would be desirable"), but NEVER as criticism of your own source selection or as a hint about "insufficient sources".

**SOURCE COUNT - ABSOLUTELY IMPORTANT:**
${thesisData.language === 'german' ? sourceUsageGuidance : sourceUsageGuidance.replace(/Sehr kurze Arbeit \((\d+) Seiten\): Verwende nur (\d+)-(\d+) hochwertige|Kurze Arbeit \((\d+) Seiten\): Verwende (\d+)-(\d+) sorgfältig|Mittlere Arbeit \((\d+) Seiten\): Verwende (\d+)-(\d+) relevante|Längere Arbeit \((\d+) Seiten\): Verwende (\d+)-(\d+) Quellen/g, (match) => {
      if (match.includes('Sehr kurze')) return `Very short thesis (${targetPages} pages): Use only ${recommendedSourceCount}-${recommendedSourceCount + 2} high-quality`
      if (match.includes('Kurze')) return `Short thesis (${targetPages} pages): Use ${recommendedSourceCount}-${recommendedSourceCount + 3} carefully selected`
      if (match.includes('Mittlere')) return `Medium thesis (${targetPages} pages): Use ${recommendedSourceCount}-${recommendedSourceCount + 5} relevant`
      if (match.includes('Längere')) return `Longer thesis (${targetPages} pages): Use ${recommendedSourceCount}-${recommendedSourceCount + 10} sources`
      return match
    })}

**Concrete Instructions for Source Usage:**
- You MUST cite at least ${Math.max(5, Math.floor(recommendedSourceCount * 0.6))} different sources in the text - NOT just 2 or 3 sources!
- Use ${recommendedSourceCount}-${recommendedSourceCount + 3} different sources throughout the entire text.
- Each source must make a clear, essential contribution.
- Distribute citations evenly throughout the thesis - not all sources in one chapter.
- Each main chapter should cite multiple different sources (at least 2-3 different sources per chapter).
- ABSOLUTELY FORBIDDEN: Using only 1-2 sources - this is insufficient for an academic thesis.
- ABSOLUTELY FORBIDDEN: Concentrating all citations in a single chapter.
- No "filler sources" - no sources just to increase the count.
- For short theses: Less is more. ${targetPages < 15 ? `A ${targetPages}-page thesis with 30+ sources looks unprofessional and excessive.` : ''}
- Quality over quantity: Better ${recommendedSourceCount} high-quality, relevant sources than 30 superficial ones.
- The number of sources must match the length of the thesis. A short paper should not be cited like a dissertation.
- You MUST cite at least ${Math.max(5, Math.floor(recommendedSourceCount * 0.6))} different sources throughout the text.

**HUMAN STYLE AND AI DETECTION AVOIDANCE (CRITICAL):**

The text must sound like written by a human author from the start and must not be recognized as AI-generated.

**1. Sentence Burstiness (VERY IMPORTANT):**
- Actively mix short (5-10 words), medium (15-20 words), and long (25-35 words) sentences.
- Avoid uniform sentence lengths - human authors have irregular patterns.
- Start some sentences with subject, others with adverbial, others with participial constructions.
- Example: "Research shows clear results. While earlier studies still showed uncertainties, precise statements can be made today. This applies particularly to the medical field."

**2. Perplexity and Variation:**
- Avoid overly predictable wording.
- Use different synonyms instead of always the same words.
- Vary sentence beginnings strongly (not always "The", "It", "This", "These").
- Avoid perfectly smooth, "polished" LLM phrases.
- Example: Instead of always "shows" → vary with "demonstrates", "proves", "clarifies", "suggests", "establishes".

**3. Syntax Variation:**
- Alternate between simple, compound, and complex sentence structures.
- Sometimes use subordinate clauses, sometimes main clauses.
- Vary the position of subordinate clauses (before/after main clause).
- Example: "Although the results are promising, questions remain." vs. "The results are promising. However, questions remain."

**4. Natural Hedging:**
- Use various formulations: "possibly", "it can be assumed", "to some extent", "under certain circumstances", "to a certain degree", "tendentially", "presumably", "apparently".
- Vary between direct and cautious formulations.

**5. AVOID AI Discourse Markers:**
- DO NOT use: "firstly", "furthermore", "in conclusion", "overall", "it is important to note", "additionally", "moreover", "in this context", "also", "in addition".
- Instead: more natural transitions like "In this context", "Against this background", "Here it becomes apparent", "In this regard", "In this framework", "As a result", "Accordingly".

**6. Introduce Asymmetries:**
- Slightly irregular pacing (not perfectly rhythmic).
- Non-uniform transitions between paragraphs.
- Varied paragraph openings (not always the same style).
- Sometimes direct language, sometimes paraphrasing.

**7. Natural Variation:**
- Vary between active and passive voice (but not too much passive).
- Sometimes use direct statements, sometimes indirect formulations.
- Be multifaceted in your formulation - no monotonous repetitions.

**8. Maintain Scientific Tone:**
- When writing about findings from sources, attribute them to the authors rather than stating them as absolute facts. For example, write "Müller (2021) found that..." instead of "The number of x is growing..." when discussing research findings.
- Write with an objective, critical academic mindset throughout the text.
- Use precise, factual language while remaining nuanced and avoiding absolute statements about research findings.

**9. ABSOLUTELY FORBIDDEN - QUESTIONS (CRITICAL):**
- ABSOLUTELY NO QUESTIONS - NEITHER RHETORICAL NOR SUGGESTIVE - NEVER USE THEM!
- FORBIDDEN: "But is this really the case?", "What are the implications of this?", "How can this be explained?", "What does this mean for...?"
- FORBIDDEN: "the research? a very important part..." (question mark after statement)
- FORBIDDEN: "What is X? An important aspect..." (self-reflexive questions)
- FORBIDDEN: Any question form, question marks, or suggestive question constructions in the text
- FORBIDDEN: Even in rhetorical form - ABSOLUTELY FORBIDDEN!
- ABSOLUTELY FORBIDDEN: QUESTION-ANSWER PATTERN (CRITICAL - UNREADABLE!)
- FORBIDDEN: "The boundary between X and Y? In public perception..."
- FORBIDDEN: "Corruption and lobbying: two different types. Lobbying, however? Indispensable..."
- FORBIDDEN: "But separating these two phenomena? Difficult."
- FORBIDDEN: "The core problem? It is extremely difficult..."
- FORBIDDEN: "Corruption? In the economic literature, it is understood as..."
- FORBIDDEN: ANY construction with a question mark followed by an answer - makes text unreadable!
- Instead: ALWAYS use direct statements and assertions
- Example: Instead of "The boundary between X and Y? In public perception..." → "The boundary between X and Y blurs in public perception..."
- Example: Instead of "Corruption? In the economic literature..." → "In the economic literature, corruption is understood as..."
- Example: Instead of "What does digitalization mean for the workplace?" → "Digitalization fundamentally changes the workplace."
- Example: Instead of "What is research? An important aspect..." → "Research represents an important aspect."
- Do not include personal opinions, marketing language, or filler sentences.
- Maintain clear structure and logical flow throughout.
- Provide clean definitions, methodological clarity, and critical reflection where appropriate.

**9. FORBIDDEN WORDS AND FORMULATIONS (ABSOLUTELY CRITICAL):**
- ABSOLUTELY FORBIDDEN: Personal pronouns like "we", "I", "us", "our" - use passive or impersonal constructions instead.
  WRONG: "We will address this in the next section..."
  CORRECT: "This will be addressed in the next section..." or "The next section addresses..."
  WRONG: "We must note that..."
  CORRECT: "It should be noted that..." or "Note that..."
  WRONG: "We can observe that..."
  CORRECT: "It can be observed that..." or "Observation shows that..."
  WRONG: "This concerns..." instead of "We are dealing with..."

**Structure:**
- Use the provided outline.
- Make only minimal adjustments if they improve the logical structure.
- Each section must serve a clear scientific purpose.

**Citation Style:**
- Strictly adhere to the specified citation style (${citationStyleLabel}).
- The citation style MUST also be considered in the running text. Where a source is used, this must be marked in the corresponding citation style.
- Format citations strictly correctly in the text.

**PAGE NUMBERS IN CITATIONS - MANDATORY:**
- EVERY citation MUST include page numbers - this is an absolute REQUIREMENT.
- Page numbers are required in ALL citation styles.
- Use the page numbers from the RAG context or source metadata.
- Format: (Author, Year, p. XX) or (Author, Year, pp. XX-YY) depending on style.
- If the page number is not explicitly in the context, use a plausible page number based on context (e.g., chapter, section).
- NEVER output a citation without a page number.

**PAGE NUMBERS IN CITATIONS - MANDATORY:**
- EVERY citation MUST include page numbers - this is an absolute REQUIREMENT.
- Page numbers are required in ALL citation styles.
- Use the page numbers from the RAG context or source metadata.
- Format: (Author, Year, p. XX) or (Author, Year, pp. XX-YY) depending on style.
- If the page number is not explicitly in the context, use a plausible page number based on context (e.g., chapter, section).
- NEVER output a citation without a page number.

**Bibliography - DO NOT CREATE:**
- DO NOT create a bibliography/Literaturverzeichnis section - it will be automatically generated from citation metadata.
- Your task is ONLY to write the chapter content with proper citations.
- End your output with the last chapter (Conclusion/Discussion) - NO bibliography section.

**STRICT SOURCE USAGE (ANTI-HALLUCINATION) - ABSOLUTELY CRITICAL:**
- **YOU MUST ONLY USE THE SOURCES PROVIDED IN THE FILE SEARCH CONTEXT.**
- **ABSOLUTELY FORBIDDEN:** Inventing studies, data, statistics, or citations.
- **ABSOLUTELY FORBIDDEN:** Claiming to have analyzed media, conducted interviews, or performed experiments unless these are explicitly described in the provided source text.
- **ABSOLUTELY FORBIDDEN:** Hallucinating "online articles", "blog posts", or "news reports" that are not in the context.
- **ABSOLUTELY FORBIDDEN:** Writing sentences like "We analyzed 500 articles..." or "Our study shows..." - you are writing a literature review based on the provided texts, not conducting primary research.
- If a specific detail is missing in the sources, state that there is no data available or generalize based on the available theory. **DO NOT INVENT DATA.**
- Every factual claim MUST be supported by a citation from the provided sources.
- If you claim "Studies show...", you MUST cite the specific study from the context.
- **VERIFICATION:** Before writing any paragraph, ask yourself: "Is this information present in the provided files?" If not, DO NOT WRITE IT.

**IMPORTANT - Table of Contents and Title:**
- DO NOT CREATE a table of contents (Table of Contents / Inhaltsverzeichnis) in the generated text.
- The table of contents is automatically generated from the outline and displayed separately.
- ABSOLUTELY FORBIDDEN: NO title, NO heading with "Bachelor Thesis", "Master Thesis", "Thesis" or the thesis title BEFORE the first chapter.
- ABSOLUTELY FORBIDDEN: Any text, headings, or meta-information BEFORE the first chapter.
- Start directly with the first chapter (e.g., "## 1. Introduction" or "## Introduction").
- No heading "Table of Contents" or "Inhaltsverzeichnis" in the text.
- The first character of your output MUST be "#" (for the first chapter heading).

**Output Format:**
- Output the complete thesis in Markdown with clear headings.
- Structure example (START IMMEDIATELY with this format, NO title before):
  ## 1. Introduction
  ...
  ## Conclusion
- START directly with the first chapter - NO title, NO table of contents, NO meta-information.
- DO NOT write a Bibliography section - end with the Conclusion/Discussion chapter.

**CRITICAL - COMPLETENESS AND LENGTH (ABSOLUTELY IMPORTANT):**

**1. COMPLETE STRUCTURE - MUST BE FULFILLED:**
- You MUST fully develop ALL chapters from the outline.
- Each chapter must be complete - no unfinished sections.
- The work must end with the last chapter (Conclusion/Discussion) - never stop in the middle of a chapter.
- If the outline has ${thesisData.outline?.length || 'X'} chapters, ALL ${thesisData.outline?.length || 'X'} chapters must be fully written.
- NO exceptions - the work must be structurally complete.
- DO NOT write a Bibliography section - it is generated automatically from metadata.

**2. TARGET LENGTH - MUST BE REACHED (BUT COMPLETENESS IS MORE IMPORTANT):**
- Target length: ${thesisData.targetLength} ${thesisData.lengthUnit} (approx. ${targetPages} pages, approx. ${thesisData.lengthUnit === 'words' ? thesisData.targetLength : thesisData.targetLength * 250} words).
${thesisData.lengthUnit === 'words' ? `- For word-based length, you can be up to 5% longer (max ${Math.ceil(thesisData.targetLength * 1.05)} words), but completeness is more important than exact word count.\n` : ''}- You MUST reach at least the target length - the work must NOT end earlier.
- If you're at ${Math.round(targetPages * 0.3)} pages, you're only at 30% - you must continue!
- A ${targetPages}-page work requires approx. ${thesisData.lengthUnit === 'words' ? thesisData.targetLength : thesisData.targetLength * 250} words.
- If you've only written 1500 words, ${(thesisData.lengthUnit === 'words' ? thesisData.targetLength : thesisData.targetLength * 250) - 1500} words are still missing - you must fully develop ALL chapters.
- **CRITICAL: Reaching the target word count does NOT mean you can stop!**
- **You MUST continue writing until ALL chapters are complete.**
- The work is only complete when:
  * ALL chapters from the outline are complete (including Conclusion)
  * The target length is reached (${thesisData.lengthUnit === 'words' ? thesisData.targetLength : thesisData.targetLength * 250} words${thesisData.lengthUnit === 'words' ? `, can be up to ${Math.ceil(thesisData.targetLength * 1.05)} words` : ''})
  * ${thesisData.citationStyle === 'deutsche-zitierweise' ? 'All footnotes are present in text (^1, ^2, etc.)' : 'All citations are correct'}

**3. NO EARLY STOPPING - ABSOLUTELY CRITICAL:**
- The work must NOT end in the middle of a chapter.
- The work must NOT end without ${thesisData.citationStyle === 'deutsche-zitierweise' ? 'footnotes in the text' : 'citations'}.
- You MUST write until you reach the target length - do NOT stop early.
- If you notice you haven't reached the target length yet, develop the chapters in more detail, add more details, expand the discussion.
- Each chapter should be proportionally detailed relative to the total length.
- You MUST write ALL chapters from the outline - do not skip any chapter.
- End with the last chapter (Conclusion/Discussion) - do NOT write a Bibliography section.
- Continue writing until ALL requirements are met: all chapters complete, target length reached.

**4. STRUCTURAL COMPLETENESS:**
- Introduction: Complete with introduction, problem statement, research question, structure of the work
  **IMPORTANT - Structure of the Work:**
  - The "Structure of the Work" or "Methodological Approach" section describes ONLY the following chapters (Chapter 2, 3, 4, etc.), NOT the current Chapter 1.
  - WRONG: "The first chapter introduces the topic..." (Chapter 1 is already written, it should not be described)
  - CORRECT: "The second chapter examines...", "In the third chapter...", "The fourth chapter addresses..."
  - Begin the description with the second chapter, since Chapter 1 is already present.
- Main chapters: Each chapter fully developed with citations throughout
- Discussion/Conclusion: Complete with summary, answer to research question, outlook
${thesisData.citationStyle === 'deutsche-zitierweise' ? '- Footnotes: Marked with ^1, ^2, etc. throughout the text\n' : ''}

**5. QUALITY WITH COMPLETENESS:**
- The work must be complete, but also of high quality.
- Don't just add filler text - fully develop the chapters in terms of content.
- Each chapter should fulfill its function and contribute to the research question.

**IMPORTANT:**
- If the API stops you before you're finished, that's an error - you must write the COMPLETE work.
- The work is only finished when ALL requirements are met: Complete structure, target length reached.

**Goal:**
Create a COMPLETE, FULL-LENGTH, citable, scientifically sound thesis that:
1. Implements ALL chapters from the outline completely
2. Reaches the target length of ${thesisData.targetLength} ${thesisData.lengthUnit} (${targetPages} pages, ~${thesisData.lengthUnit === 'words' ? thesisData.targetLength : thesisData.targetLength * 250} words)
3. ${thesisData.citationStyle === 'deutsche-zitierweise' ? 'Includes footnote markers (^1, ^2, etc.) throughout' : 'Includes proper citations throughout'}
4. Is logically structured and correctly implements the citation style
5. Uses exclusively validated sources from the provided list
6. Sounds natural and human from the start, not like AI-generated

DO NOT write a Bibliography section - end with the Conclusion chapter.
DO NOT STOP until all chapters are complete. The thesis must be COMPLETE.`

  console.log('[ThesisGeneration] Calling Gemini Pro to generate thesis content...')
  console.log('[ThesisGeneration] Using FileSearchStore for RAG context')
  console.log('[ThesisGeneration] FileSearchStore ID:', thesisData.fileSearchStoreId)
  const generationStart = Date.now()

  // Retry with SAME config (FileSearchStore + Gemini Pro) - 3 total attempts
  let content = ''
  let lastError: Error | unknown = null
  const maxAttempts = 4 // Increased from 3 to give more chances to hit word count

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {


      console.log(`[ThesisGeneration] Attempt ${attempt}/${maxAttempts}: Full generation with FileSearchStore + Gemini Pro`)
      console.log(`[ThesisGeneration]   Model: gemini-2.5-pro`)
      console.log(`[ThesisGeneration]   FileSearchStore: ${thesisData.fileSearchStoreId}`)

      // On retry attempts, add extra emphasis on word count (gets more emphatic with each retry)
      const urgencyLevel = attempt >= 3 ? 'LETZTE CHANCE' : 'WICHTIG'
      const retryEmphasis = attempt > 1 ? (isGerman
        ? `

═══════════════════════════════════════════════════════════════════════════════
🚨🚨🚨 ${urgencyLevel}: VORHERIGER VERSUCH WAR ZU KURZ (${attempt - 1}x FEHLGESCHLAGEN)! 🚨🚨🚨
═══════════════════════════════════════════════════════════════════════════════

**ABSOLUT KRITISCH:** Du hast ${attempt - 1}x zu wenig Text geschrieben!

**ZIEL: EXAKT ${targetWordCount} WÖRTER (NICHT WENIGER!)**

${attempt >= 3 ? `
**🔴 DIES IST VERSUCH ${attempt} VON ${maxAttempts} - LETZTER VERSUCH! 🔴**
Wenn du wieder zu wenig schreibst, wird die Arbeit mit zu wenig Inhalt abgeliefert!
` : ''}

**SO ERREICHST DU DIE WORTANZAHL:**

1. **EINLEITUNG** (mind. ${Math.ceil(targetWordCount * 0.12)} Wörter):
   - Problemstellung AUSFÜHRLICH darstellen
   - Forschungsfrage DETAILLIERT herleiten
   - Relevanz des Themas UMFASSEND begründen
   - Aufbau der Arbeit VOLLSTÄNDIG beschreiben

2. **THEORETISCHE GRUNDLAGEN** (mind. ${Math.ceil(targetWordCount * 0.25)} Wörter):
   - JEDE Definition AUSFÜHRLICH erklären
   - MEHRERE Theorien/Modelle diskutieren
   - Forschungsstand UMFASSEND darstellen
   - Kritische Würdigung der Literatur

3. **HAUPTTEIL** (mind. ${Math.ceil(targetWordCount * 0.40)} Wörter):
   - JEDEN Aspekt DETAILLIERT analysieren
   - PRO Argument: mehrere Quellen + eigene Einordnung
   - Beispiele, Fallstudien, Anwendungen
   - Zwischenfazits zwischen Unterkapiteln

4. **FAZIT** (mind. ${Math.ceil(targetWordCount * 0.10)} Wörter):
   - ALLE wichtigen Ergebnisse zusammenfassen
   - Forschungsfrage EXPLIZIT beantworten
   - Limitationen nennen
   - Ausblick auf weitere Forschung

**VERBOTEN:**
❌ Kurze, oberflächliche Absätze
❌ Nur 2-3 Sätze pro Unterkapitel
❌ Aufzählungen statt Fließtext
❌ Weniger als ${targetWordCount} Wörter abliefern!
`
        : `

═══════════════════════════════════════════════════════════════════════════════
🚨🚨🚨 ${attempt >= 3 ? 'FINAL ATTEMPT' : 'CRITICAL'}: PREVIOUS ATTEMPT WAS TOO SHORT! 🚨🚨🚨
═══════════════════════════════════════════════════════════════════════════════

**CRITICAL:** You have written too little ${attempt - 1} time(s)!

**TARGET: EXACTLY ${targetWordCount} WORDS (NOT LESS!)**

${attempt >= 3 ? `
**🔴 THIS IS ATTEMPT ${attempt} OF ${maxAttempts} - FINAL ATTEMPT! 🔴**
If you write too little again, the thesis will be delivered incomplete!
` : ''}

**HOW TO REACH THE WORD COUNT:**

1. **INTRODUCTION** (min. ${Math.ceil(targetWordCount * 0.12)} words):
   - Problem statement IN DETAIL
   - Research question FULLY derived
   - Relevance COMPREHENSIVELY justified
   - Structure COMPLETELY described

2. **THEORETICAL FRAMEWORK** (min. ${Math.ceil(targetWordCount * 0.25)} words):
   - EVERY definition THOROUGHLY explained
   - MULTIPLE theories/models discussed
   - Research state COMPREHENSIVELY presented
   - Critical analysis of literature

3. **MAIN BODY** (min. ${Math.ceil(targetWordCount * 0.40)} words):
   - EVERY aspect analyzed IN DEPTH
   - PER argument: multiple sources + own interpretation
   - Examples, case studies, applications
   - Interim conclusions between subsections

4. **CONCLUSION** (min. ${Math.ceil(targetWordCount * 0.10)} words):
   - ALL key findings summarized
   - Research question EXPLICITLY answered
   - Limitations stated
   - Outlook on future research
`) : ''

      // Calculate max output tokens based on target length
      // Gemini 2.5 Pro max is 1,000,000 tokens output
      // We set it to the maximum to ensure generation is NEVER truncated
      // Even for a very long thesis (e.g., 100 pages = 25,000 words ≈ 33,333 tokens),
      // we have plenty of room with 1,000,000 tokens
      // Sanity check: If targetLength is > 500, it's definitely words, not pages
      // This prevents issues where unit is 'pages' but value is in words (e.g. 10000 pages -> 2.5m words)
      const isWords = thesisData.lengthUnit === 'words' || thesisData.targetLength > 500

      const expectedWords = isWords
        ? thesisData.targetLength
        : thesisData.targetLength * 250
      // For word-based lengths, allow up to 5% longer (as per requirements)
      // But we set maxOutputTokens to maximum to ensure it NEVER stops generation
      const maxExpectedWords = isWords
        ? Math.ceil(thesisData.targetLength * 1.12) // 12% buffer to ensure complete generation without excessive overshoot
        : Math.ceil(thesisData.targetLength * 250 * 1.25)
      const estimatedTokens = Math.ceil(maxExpectedWords / 0.75)
      // Set to maximum allowed (1,000,000 tokens) to ensure generation is NEVER truncated
      // This gives us ~750,000 words capacity, which is far more than any thesis needs
      const maxOutputTokens = 1000000

      console.log(`[ThesisGeneration] Expected words: ${expectedWords}, Estimated tokens: ${estimatedTokens}, Max output tokens: ${maxOutputTokens}`)

      // Add retry emphasis to prompt if this is a retry attempt
      const fullPrompt = prompt + retryEmphasis

      const response = await retryApiCall(
        () => ai.models.generateContent({
          model: 'gemini-2.5-pro',
          contents: fullPrompt,
          config: {
            maxOutputTokens: maxOutputTokens,
            tools: [{
              fileSearch: {
                fileSearchStoreNames: [thesisData.fileSearchStoreId],
              },
            }],
          },
        }),
        `Generate thesis content (Gemini Pro + FileSearchStore) - Attempt ${attempt}`,
        1, // Single retry per attempt (we're doing 3 attempts total)
        3000 // 3 second delay between attempts
      )

      content = response.text || ''
      let contentLength = content.length
      let wordCount = content.split(/\s+/).length
      const expectedWordCount = isWords
        ? thesisData.targetLength
        : thesisData.targetLength * 250 // ~250 words per page

      if (content && content.length > 100) {
        const generationDuration = Date.now() - generationStart
        console.log(`[ThesisGeneration] ✓ Thesis generation completed successfully on attempt ${attempt} (${generationDuration}ms)`)
        console.log(`[ThesisGeneration] Generated content: ${contentLength} characters, ~${wordCount} words`)
        console.log(`[ThesisGeneration] Expected word count: ~${expectedWordCount} words`)

        // REMOVED: Extension process - it creates "Ergänzungen" at the end instead of expanding chapters
        // If word count is significantly below target, we REGENERATE the entire thesis with stronger emphasis
        const wordRatio = wordCount / expectedWordCount
        const MIN_ACCEPTABLE_RATIO = 0.95 // Require 95% of target (was 85%)

        if (wordRatio < MIN_ACCEPTABLE_RATIO && attempt < maxAttempts) {
          console.warn(`[ThesisGeneration] ⚠️ Content only ${Math.round(wordRatio * 100)}% of target (${wordCount}/${expectedWordCount})`)
          console.warn(`[ThesisGeneration] → Triggering FULL REGENERATION with stronger word count emphasis (attempt ${attempt + 1}/${maxAttempts})`)
          throw new Error(`Word count too low: ${wordCount}/${expectedWordCount} words (${Math.round(wordRatio * 100)}%). Need at least 95%.`)
        } else if (wordRatio < MIN_ACCEPTABLE_RATIO) {
          console.warn(`[ThesisGeneration] ⚠️ Final attempt still short: ${Math.round(wordRatio * 100)}% - accepting as best effort`)
        } else {
          console.log(`[ThesisGeneration] ✓ Word count acceptable: ${Math.round(wordRatio * 100)}% of target (≥95%)`)
        }

        // Validate completeness - check structure (NOT bibliography - we build that from metadata)
        const foundChapters = detectChapters(content, outlineChapters)

        // Check if content is significantly shorter than expected OR missing critical sections
        const wordCountMet = wordCount >= expectedWordCount * 0.95 // Allow 5% tolerance
        const isTooShort = wordCount < expectedWordCount * 0.5

        // If word count is met, only require 50% of chapters (they might be written but not detected)
        // If word count is not met, require 80% of chapters
        const requiredChapterRatio = wordCountMet ? 0.5 : 0.8
        const isMissingChapters = foundChapters.length < outlineChapters.length * requiredChapterRatio

        // CRITICAL: Check for minimum citation count
        let citationCount = 0
        if (thesisData.citationStyle === 'deutsche-zitierweise') {
          // Count footnotes: ^1, ^2, ^N etc.
          const footnoteMatches = content.match(/\^(\d+)/g)
          citationCount = footnoteMatches?.length || 0
        } else {
          // Count in-text citations: (Author, Year, S. XX) or (Author, Year, p. XX)
          const citationMatches = content.match(/\([A-ZÄÖÜa-zäöü][a-zäöüß]+(?:\s+et\s+al\.?)?,?\s+\d{4}/g)
          citationCount = citationMatches?.length || 0
        }

        // Minimum citations: ~1 per 500 words (relaxed from strict requirement)
        const minCitations = Math.max(3, Math.floor(expectedWordCount / 600))
        const hasSufficientCitations = citationCount >= minCitations

        // Only flag as incomplete if there are SERIOUS issues
        // NOTE: We do NOT check for bibliography - we build it from metadata!
        const isSeriouslyIncomplete = isTooShort || !hasSufficientCitations || (isMissingChapters && !wordCountMet)

        if (isSeriouslyIncomplete) {
          console.error(`[ThesisGeneration] ⚠️ Content validation issues detected:`)
          console.error(`[ThesisGeneration]   Expected: ~${expectedWordCount} words, Got: ~${wordCount} words`)
          console.error(`[ThesisGeneration]   Word count met (≥95%): ${wordCountMet}`)
          console.error(`[ThesisGeneration]   Expected chapters: ${outlineChapters.length}, Found: ${foundChapters.length}`)
          console.error(`[ThesisGeneration]   Found chapters: ${foundChapters.join(', ')}`)
          console.error(`[ThesisGeneration]   Citation style: ${thesisData.citationStyle}`)
          console.error(`[ThesisGeneration]   Citation count: ${citationCount} (minimum: ${minCitations})`)
          console.error(`[ThesisGeneration]   Has sufficient citations: ${hasSufficientCitations}`)

          // Don't return incomplete content - throw error to trigger retry
          if (attempt < maxAttempts) {
            const issues = []
            if (isTooShort) issues.push(`too short (${wordCount}/${expectedWordCount} words)`)
            if (!hasSufficientCitations) issues.push(`insufficient citations (${citationCount}/${minCitations})`)
            if (isMissingChapters && !wordCountMet) issues.push(`missing chapters (${foundChapters.length}/${outlineChapters.length})`)
            throw new Error(`Generated content is incomplete: ${issues.join(', ')}. Attempting retry with stronger instructions.`)
          } else {
            console.error(`[ThesisGeneration]   All attempts exhausted - returning content as-is`)
          }
        } else {
          // Content looks good
          console.log(`[ThesisGeneration] ✓ Content complete (${wordCount}/${expectedWordCount} words, ${citationCount} citations, ${foundChapters.length}/${outlineChapters.length} chapters)`)
        }

        return content
      } else {
        console.warn(`[ThesisGeneration] Attempt ${attempt} returned invalid content (length: ${content.length})`)
        lastError = new Error(`Invalid content returned: length ${content.length} < 100`)
      }
    } catch (error: any) {
      lastError = error
      const errorMessage = error?.message || String(error)
      const errorStatus = error?.status || error?.code || 'unknown'
      console.error(`[ThesisGeneration] ✗ Attempt ${attempt}/${maxAttempts} failed:`)
      console.error(`[ThesisGeneration]   Error: ${errorMessage}`)
      console.error(`[ThesisGeneration]   Status/Code: ${errorStatus}`)
      if (error?.response) {
        console.error(`[ThesisGeneration]   Response:`, JSON.stringify(error.response).substring(0, 500))
      }

      // If not the last attempt, wait before retrying
      if (attempt < maxAttempts) {
        const waitTime = 5000 * attempt // Exponential backoff: 5s, 10s
        console.log(`[ThesisGeneration] Waiting ${waitTime}ms before retry...`)
        await new Promise(resolve => setTimeout(resolve, waitTime))
      }
    }
  }

  // If all attempts failed, throw detailed error
  const errorDetails = lastError instanceof Error
    ? `${lastError.message} (${lastError.name})`
    : String(lastError)
  throw new Error(
    `Failed to generate thesis content after ${maxAttempts} attempts with FileSearchStore + Gemini Pro. ` +
    `Last error: ${errorDetails}. ` +
    `FileSearchStore ID: ${thesisData.fileSearchStoreId}`
  )
}

/**
 * Check content with GPTZero API and return flagged sentences
 * Returns null if API is unavailable or fails - NO FAKE SCORES
 */
async function checkWithGPTZero(content: string): Promise<{
  isHumanWritten: number
  isGptGenerated: number
  gptGeneratedSentences: string[]
} | null> {
  if (!RAPIDAPI_KEY) {
    console.warn('[GPTZero] RapidAPI key not configured, skipping check')
    return null // Return null instead of fake 100% score
  }

  console.log('[GPTZero] Checking content for AI detection...')

  // Extract plain text from markdown
  let plainText = content
    .replace(/^#+\s+/gm, '') // Remove headings
    .replace(/\*\*(.+?)\*\*/g, '$1') // Remove bold
    .replace(/\*(.+?)\*/g, '$1') // Remove italic
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // Remove links
    .replace(/`(.+?)`/g, '$1') // Remove code
    .replace(/\^\d+/g, '') // Remove footnote markers
    .replace(/\n{3,}/g, '\n\n') // Normalize multiple newlines
    .trim()

  // With full subscription, no truncation needed - send full text
  console.log(`[GPTZero] Checking full text (${plainText.length} characters)`)

  try {
    const response = await retryApiCall(
      () => fetch('https://zerogpt.p.rapidapi.com/api/v1/detectText', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-RapidAPI-Key': RAPIDAPI_KEY!,
          'X-RapidAPI-Host': 'zerogpt.p.rapidapi.com',
        },
        body: JSON.stringify({
          input_text: plainText,
        }),
      }),
      'GPTZero API check'
    )

    if (!response.ok) {
      console.error('[GPTZero] API error:', response.status, response.statusText)
      return null // Return null instead of fake 100% score
    }

    const data = await response.json() as any

    if (data.success && data.data) {
      const isHumanWritten = data.data.is_human_written || 0
      const isGptGenerated = data.data.is_gpt_generated || 0
      const gptGeneratedSentences = data.data.gpt_generated_sentences || []

      console.log(`[GPTZero] Results: ${isHumanWritten}% human, ${isGptGenerated}% AI-generated`)
      console.log(`[GPTZero] Flagged ${gptGeneratedSentences.length} sentences`)

      return { isHumanWritten, isGptGenerated, gptGeneratedSentences }
    }

    console.warn('[GPTZero] Invalid API response format')
    return null // Return null instead of fake 100% score
  } catch (error) {
    console.error('[GPTZero] Error checking content:', error)
    return null // Return null instead of fake 100% score
  }
}

/**
 * Rewrite flagged sentences using Gemini 2.5 Flash to make them more human-like
 */
async function rewriteFlaggedSentences(
  content: string,
  flaggedSentences: string[],
  thesisData: ThesisData
): Promise<string> {
  if (flaggedSentences.length === 0) {
    return content
  }

  console.log(`[Rewrite] Rewriting ${flaggedSentences.length} flagged sentences...`)

  const isGerman = thesisData.language === 'german'
  let rewrittenContent = content

  // Process sentences in batches of 10 to avoid token limits
  const BATCH_SIZE = 10
  for (let i = 0; i < flaggedSentences.length; i += BATCH_SIZE) {
    const batch = flaggedSentences.slice(i, i + BATCH_SIZE)
    console.log(`[Rewrite] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(flaggedSentences.length / BATCH_SIZE)}`)

    const prompt = isGerman
      ? `Du bist ein Experte darin, akademische Texte menschlicher klingen zu lassen, ohne die Bedeutung zu verändern.

**Aufgabe:**
Schreibe die folgenden Sätze so um, dass sie natürlicher und menschlicher klingen. Dein Ziel ist es, dass diese Sätze von KI-Detektoren (wie GPTZero) als "menschlich" erkannt werden.

**Strikte Regeln für maximalen "Human Score":**
1. **Aggressive Satz-Burstiness:** Variiere die Satzlänge extrem. Mische sehr kurze (3-5 Wörter) mit langen, komplexen Sätzen. Vermeide gleichförmige Rhythmen.
2. **Perplexität erhöhen:** Verwende unerwartete, aber passende Synonyme. Vermeide die vorhersehbarsten Wortwahlen.
3. **Syntax-Variation:** Nutze unterschiedliche Satzstrukturen (Inversionen, Einschübe, Ellipsen). Beginne Sätze nicht immer mit dem Subjekt.
4. **KI-Marker VERBOTEN:** Verwende NIEMALS Wörter wie: "zunächst", "ferner", "des Weiteren", "zusammenfassend", "es ist wichtig zu beachten", "in diesem Zusammenhang", "darüber hinaus", "diesbezüglich".
5. **Inhalt bewahren:** Behalte ALLE Fakten, Daten, Namen und vor allem Zitationen (z.B. (Müller, 2023)) exakt bei.

**Zu überarbeitende Sätze:**
${batch.map((s, idx) => `${idx + 1}. ${s}`).join('\n\n')}

**Format:**
Antworte NUR mit einem JSON-Array der umgeschriebenen Sätze. Keine Erklärungen.
["Umgeschriebener Satz 1", "Umgeschriebener Satz 2", ...]`
      : `You are an expert at making academic texts sound more human without changing their meaning.

**Task:**
Rewrite the following sentences to sound more natural and human. Your goal is to make these sentences pass AI detectors (like GPTZero) as "human-written".

**Strict Rules for Maximum "Human Score":**
1. **Aggressive Sentence Burstiness:** Vary sentence length extremely. Mix very short (3-5 words) with long, complex sentences. Avoid uniform rhythms.
2. **Increase Perplexity:** Use unexpected but appropriate synonyms. Avoid the most predictable word choices.
3. **Syntax Variation:** Use different sentence structures (inversions, parentheticals, ellipses). Do not always start sentences with the subject.
4. **FORBIDDEN AI Markers:** NEVER use words like: "firstly", "furthermore", "moreover", "in conclusion", "it is important to note", "in this context", "additionally", "regarding".
5. **Preserve Content:** Keep ALL facts, data, names, and especially citations (e.g., (Smith, 2023)) exactly as they are.

**Sentences to rewrite:**
${batch.map((s, idx) => `${idx + 1}. ${s}`).join('\n\n')}

**Format:**
Respond ONLY with a JSON array of rewritten sentences. No explanations.
["Rewritten sentence 1", "Rewritten sentence 2", ...]`

    try {
      const response = await retryApiCall(
        () => ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        }),
        `Rewrite sentences batch ${Math.floor(i / BATCH_SIZE) + 1}`
      )

      const responseText = response.text
      if (!responseText) {
        console.warn(`[Rewrite] No response for batch ${Math.floor(i / BATCH_SIZE) + 1}, skipping`)
        continue
      }

      // Extract JSON array
      const jsonMatch = responseText.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        console.warn(`[Rewrite] Invalid JSON response for batch ${Math.floor(i / BATCH_SIZE) + 1}, skipping`)
        continue
      }

      const rewrittenSentences = JSON.parse(jsonMatch[0]) as string[]

      // Replace sentences in content
      batch.forEach((originalSentence, idx) => {
        if (rewrittenSentences[idx]) {
          // Escape special regex characters in the original sentence
          const escapedOriginal = originalSentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          rewrittenContent = rewrittenContent.replace(
            new RegExp(escapedOriginal, 'g'),
            rewrittenSentences[idx]
          )
        }
      })

      console.log(`[Rewrite] Batch ${Math.floor(i / BATCH_SIZE) + 1} completed`)

      // Small delay between batches
      if (i + BATCH_SIZE < flaggedSentences.length) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    } catch (error) {
      console.error(`[Rewrite] Error processing batch ${Math.floor(i / BATCH_SIZE) + 1}:`, error)
      // Continue with next batch
    }
  }

  console.log('[Rewrite] Sentence rewriting completed')
  return rewrittenContent
}

/**
 * Check content with GPTZero and rewrite if needed to achieve >70% human score
 */
async function ensureHumanLikeContent(content: string, thesisData: ThesisData): Promise<{
  content: string
  zeroGptResult: {
    isHumanWritten: number
    isGptGenerated: number
    wordsCount?: number
    checkedAt: string
    feedbackMessage?: string
  } | null
}> {
  console.log('[HumanCheck] Starting GPTZero check and potential rewrite...')

  const MIN_HUMAN_SCORE = 70
  const MAX_ITERATIONS = 5 // Limit iterations to avoid infinite loops

  let currentContent = content
  let iteration = 0
  let finalResult: any = null

  while (iteration < MAX_ITERATIONS) {
    iteration++
    console.log(`[HumanCheck] Iteration ${iteration}/${MAX_ITERATIONS}`)

    const result = await checkWithGPTZero(currentContent)

    // If GPTZero API failed or is unavailable, return content WITHOUT a fake score
    if (!result) {
      console.warn('[HumanCheck] GPTZero API unavailable, returning content without score')
      return {
        content: currentContent,
        zeroGptResult: null // NO FAKE SCORES - null means "not checked"
      }
    }

    finalResult = result // Store the latest valid result

    if (result.isHumanWritten >= MIN_HUMAN_SCORE) {
      console.log(`[HumanCheck] ✓ Content passed with ${result.isHumanWritten}% human score`)
      return {
        content: currentContent,
        zeroGptResult: {
          isHumanWritten: result.isHumanWritten,
          isGptGenerated: result.isGptGenerated,
          checkedAt: new Date().toISOString(),
        }
      }
    }

    console.log(`[HumanCheck] ⚠️ Content scored ${result.isHumanWritten}% human (below ${MIN_HUMAN_SCORE}%)`)
    console.log(`[HumanCheck] Rewriting ${result.gptGeneratedSentences.length} flagged sentences...`)

    if (result.gptGeneratedSentences.length === 0) {
      console.log('[HumanCheck] No specific sentences flagged, returning content as-is')
      return {
        content: currentContent,
        zeroGptResult: {
          isHumanWritten: result.isHumanWritten,
          isGptGenerated: result.isGptGenerated,
          checkedAt: new Date().toISOString(),
        }
      }
    }

    // Rewrite flagged sentences
    currentContent = await rewriteFlaggedSentences(
      currentContent,
      result.gptGeneratedSentences,
      thesisData
    )

    console.log(`[HumanCheck] Rewrite completed, checking again...`)
  }

  console.log(`[HumanCheck] Max iterations reached, returning current content`)
  return {
    content: currentContent,
    zeroGptResult: finalResult ? {
      isHumanWritten: finalResult.isHumanWritten,
      isGptGenerated: finalResult.isGptGenerated,
      checkedAt: new Date().toISOString(),
    } : null
  }
}

/**
 * Check content for plagiarism using Grammarly API
 * Returns plagiarism result or null if API unavailable
 */
async function checkPlagiarismWithGrammarly(content: string, thesisId: string): Promise<{
  originality: number
  originalityPercentage: number
  plagiarismPercentage: number
  scoreRequestId: string
  checkedAt: string
} | null> {
  if (!GRAMMARLY_ACCESS_TOKEN) {
    console.warn('[PlagiarismCheck] GRAMMARLY_ACCESS_TOKEN not set')
    return null
  }

  console.log('[PlagiarismCheck] Starting Grammarly plagiarism check...')

  try {
    // Extract plain text from markdown
    let plainText = content
      .replace(/^#+\s+/gm, '') // Remove headings
      .replace(/\*\*(.+?)\*\*/g, '$1') // Remove bold
      .replace(/\*(.+?)\*/g, '$1') // Remove italic
      .replace(/\[(.+?)\]\(.+?\)/g, '$1') // Remove links
      .replace(/`(.+?)`/g, '$1') // Remove code
      .replace(/\^\d+/g, '') // Remove footnote markers
      .replace(/\n{3,}/g, '\n\n') // Normalize multiple newlines
      .trim()

    // Check constraints
    const MAX_TEXT_LENGTH = 100000 // 100k characters
    const MAX_FILE_SIZE = 4 * 1024 * 1024 // 4 MB

    if (plainText.length > MAX_TEXT_LENGTH) {
      console.warn(`[PlagiarismCheck] Text too long (${plainText.length} chars), truncating to ${MAX_TEXT_LENGTH}`)
      plainText = plainText.substring(0, MAX_TEXT_LENGTH)
    }

    const textBuffer = Buffer.from(plainText, 'utf-8')
    if (textBuffer.length > MAX_FILE_SIZE) {
      console.warn(`[PlagiarismCheck] Text too large (${textBuffer.length} bytes), skipping check`)
      return null
    }

    // Step 1: Create score request
    const scoreRequest = {
      filename: `thesis-${thesisId}.txt`,
    }

    const createResponse = await fetch('https://api.grammarly.com/ecosystem/api/v1/plagiarism', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GRAMMARLY_ACCESS_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'user-agent': 'StudyFucker Worker',
      },
      body: JSON.stringify(scoreRequest),
    })

    if (!createResponse.ok) {
      const errorText = await createResponse.text()
      console.error('[PlagiarismCheck] Failed to create score request:', {
        status: createResponse.status,
        errorText,
      })
      return null
    }

    const scoreRequestData = await createResponse.json() as { score_request_id: string; file_upload_url: string }
    console.log(`[PlagiarismCheck] Score request created: ${scoreRequestData.score_request_id}`)

    // Step 2: Upload file
    const uploadResponse = await fetch(scoreRequestData.file_upload_url, {
      method: 'PUT',
      body: textBuffer,
      headers: {
        'Content-Type': 'text/plain',
      },
    })

    if (!uploadResponse.ok) {
      console.error('[PlagiarismCheck] Failed to upload document')
      return null
    }

    console.log('[PlagiarismCheck] Document uploaded, polling for results...')

    // Step 3: Poll for results (with exponential backoff)
    const MAX_POLL_ATTEMPTS = 20
    const INITIAL_POLL_DELAY = 2000
    let pollAttempt = 0
    let statusResponse: any = null

    while (pollAttempt < MAX_POLL_ATTEMPTS) {
      const pollDelay = Math.min(INITIAL_POLL_DELAY * Math.pow(2, pollAttempt), 10000)

      if (pollAttempt > 0) {
        await new Promise(resolve => setTimeout(resolve, pollDelay))
      }

      const statusResponse_fetch = await fetch(
        `https://api.grammarly.com/ecosystem/api/v1/plagiarism/${scoreRequestData.score_request_id}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${GRAMMARLY_ACCESS_TOKEN}`,
            'Accept': 'application/json',
            'user-agent': 'StudyFucker Worker',
          },
        }
      )

      if (!statusResponse_fetch.ok) {
        pollAttempt++
        continue
      }

      statusResponse = await statusResponse_fetch.json()

      if (statusResponse.status === 'COMPLETED') {
        break
      } else if (statusResponse.status === 'FAILED') {
        console.error('[PlagiarismCheck] Check failed:', statusResponse)
        return null
      }

      pollAttempt++
    }

    if (!statusResponse || statusResponse.status !== 'COMPLETED' || !statusResponse.score) {
      console.warn('[PlagiarismCheck] Check did not complete or no score available')
      return null
    }

    const originalityScore = statusResponse.score.originality
    const plagiarismPercentage = Math.round((1 - originalityScore) * 100)
    const originalityPercentage = Math.round(originalityScore * 100)

    console.log(`[PlagiarismCheck] Completed: ${originalityPercentage}% original, ${plagiarismPercentage}% potentially plagiarized`)

    return {
      originality: originalityScore,
      originalityPercentage,
      plagiarismPercentage,
      scoreRequestId: scoreRequestData.score_request_id,
      checkedAt: new Date().toISOString(),
    }
  } catch (error) {
    console.error('[PlagiarismCheck] Error:', error)
    return null
  }
}

/**
 * Humanize thesis content to avoid AI detection while preserving all factual information
 * Uses Gemini to rewrite the text in a more human-like style
 */
async function humanizeThesisContent(content: string, thesisData: ThesisData): Promise<string> {
  console.log('[Humanize] Starting content humanization...')
  console.log(`[Humanize] Original content length: ${content.length} characters`)

  const language = thesisData.language || 'german'
  const isGerman = language === 'german'
  const citationStyle = thesisData.citationStyle || 'apa'

  // Extract all citations before humanization to verify they're preserved
  const citationPatterns = [
    /\([A-ZÄÖÜ][a-zäöüß]+(?:\s+et\s+al\.?)?,?\s+\d{4}(?:,\s+(?:S\.|p\.|pp\.)\s+\d+(?:-\d+)?)?\)/g, // (Author, 2021, S. 14) or (Author et al., 2021)
    /\[(\d+)\]/g, // [12]
    /\^\d+/g, // ^1, ^2 (footnotes)
    /\[\^\d+\]/g, // [^1] (markdown footnotes)
  ]

  const originalCitations: string[] = []
  citationPatterns.forEach(pattern => {
    const matches = content.match(pattern)
    if (matches) {
      originalCitations.push(...matches)
    }
  })

  console.log(`[Humanize] Found ${originalCitations.length} citations to preserve`)

  const prompt = isGerman
    ? `Du bist ein akademischer Text-Humanisierer. Deine Aufgabe ist es, den bereitgestellten Text so umzuschreiben, dass er nicht als KI-generiert von Tools wie ZeroGPT, GPTZero, Turnitin AI Detection, Hive oder ähnlichen Klassifikatoren erkannt werden kann.

⚠️⚠️⚠️ ABSOLUT KRITISCH - ERSTE REGEL ⚠️⚠️⚠️
🚫 ABSOLUT VERBOTEN: FRAGE-ANTWORT-MUSTER! NIEMALS "X? Y." verwenden! IMMER direkte Aussagen!
- Wenn du im Text Frage-Antwort-Muster findest, MUSST du sie in direkte Aussagen umwandeln!
- Beispiel: "Die Grenze zwischen X und Y? In der öffentlichen Wahrnehmung..." → "Die Grenze zwischen X und Y verwischt in der öffentlichen Wahrnehmung..."

Folge diesen Regeln strikt:

1. NIEMALS ändern, hinzufügen oder entfernen von Fakten, Argumenten, Behauptungen, Zitaten, Theorien, Namen, Zahlen, Daten, Tabellen oder Referenzen.

2. Führe KEINE neuen Informationen oder neuen Interpretationen ein.

3. Erhalte die Gesamtstruktur, Absatzreihenfolge, Zitatplatzierung und den akademischen Ton bei.

4. Ändere NUR den oberflächlichen linguistischen Stil, um menschliche statistische Muster zu erhöhen.

ANFORDERUNGEN AN MENSCHLICHEN STIL (KRITISCH FÜR AI-ERKENNUNG):

A. **Satz-Burstiness (SEHR WICHTIG):**
   - Mische aktiv kurze (5-10 Wörter), mittlere (15-20 Wörter) und lange (25-35 Wörter) Sätze.
   - Vermeide gleichmäßige Satzlängen - menschliche Autoren haben unregelmäßige Muster.
   - Beginne manche Sätze mit Subjekt, andere mit Adverbial, wieder andere mit Partizipialkonstruktionen.
   - Verwende gelegentlich sehr kurze, prägnante Sätze für Betonung (3-5 Wörter).
   - Erzeuge bewusst unregelmäßige Rhythmen - nicht perfekt ausbalanciert.

B. **Perplexität erhöhen (KRITISCH):**
   - Vermeide übermäßig vorhersehbare Formulierungen.
   - Verwende unterschiedliche Synonyme statt immer derselben Wörter.
   - Variiere Satzanfänge stark (nicht immer "Die", "Es", "Dies").
   - Vermeide perfekt glatte, "polierte" LLM-Phrasen.
   - Verwende gelegentlich weniger häufige Wörter oder Fachbegriffe.
   - Variiere zwischen präzisen und umschreibenden Formulierungen.

C. **Syntax-Variation (SEHR WICHTIG):**
   - Wechsle zwischen einfachen, zusammengesetzten und komplexen Satzstrukturen.
   - Verwende manchmal Nebensätze, manchmal Hauptsätze.
   - Variiere die Position von Nebensätzen (vor/nach Hauptsatz).
   - Verwende gelegentlich Ellipsen oder verkürzte Konstruktionen.
   - Erzeuge bewusst strukturelle Unregelmäßigkeiten.

D. **Natürliche Abschwächungen:**
   - Verwende verschiedene Formulierungen: "möglicherweise", "lässt sich vermuten", "zum Teil", "unter Umständen", "in gewissem Maße", "tendenziell", "vermutlich", "anscheinend", "wohl", "vielleicht".
   - Variiere die Stärke der Abschwächungen - nicht immer gleich.

E. **Asymmetrien einbauen (KRITISCH):**
   - Leicht unregelmäßige Taktung (nicht perfekt rhythmisch).
   - Nicht-uniforme Übergänge zwischen Absätzen.
   - Variierte Absatzeröffnungen (nicht immer derselbe Stil).
   - Gelegentlich abrupte, aber sinnvolle Übergänge.
   - Vermeide perfekte Parallelstrukturen.

F. **KI-Diskursmarker vermeiden (ABSOLUT KRITISCH):**
   - NICHT verwenden: "zunächst", "ferner", "zusammenfassend", "insgesamt gesehen", "es ist wichtig zu beachten", "darüber hinaus", "des Weiteren", "in diesem Zusammenhang", "in diesem Kontext", "diesbezüglich", "hinsichtlich", "bezüglich", "in Bezug auf", "im Hinblick auf".
   - Stattdessen: natürlichere Übergänge wie "Vor diesem Hintergrund", "Dabei zeigt sich", "Hierbei", "In der Praxis", "Konkret bedeutet dies", etc.
   - Vermeide übermäßig formale Übergangsphrasen.

G. **Natürliche Variation (KRITISCH):**
   - Verwende manchmal direkte Sprache, manchmal umschreibende Formulierungen.
   - Variiere zwischen aktiver und passiver Sprache (aber nicht zu viel Passiv).
   - Erhalte vollständige Kohärenz - niemals Slang, Fehler oder unprofessionellen Ton.
   - ABSOLUT VERBOTEN: Umgangssprache wie "denk mal", "schau dir an", "guck mal", "hör mal", "klar", "logisch" (umgangssprachlich), "eigentlich" (als Füllwort)
   - Verwende AUSSCHLIESSLICH wissenschaftliche, formale Sprache - keine umgangssprachlichen Formulierungen!
   - Variiere die Formalisierungsebene leicht, aber IMMER innerhalb des wissenschaftlichen Registers.

H. **Vermeide KI-typische Phrasen (ABSOLUT KRITISCH):**
   - NICHT: "Es ist wichtig zu beachten, dass...", "Es sollte erwähnt werden, dass...", "Es ist bemerkenswert, dass...", "Es ist interessant zu beobachten, dass...", "Es ist erwähnenswert, dass...".
   - Stattdessen: Direkte Aussagen ohne solche Einleitungen.
   - Vermeide übermäßig höfliche oder erklärende Phrasen.

I. **Aggressive Burstiness (ABSOLUT KRITISCH FÜR ZEROGPT):**
   - Erstelle extreme Satzlängenvariationen: 3-Wort-Satz, dann 30-Wort-Satz, dann 12-Wort-Satz.
   - Mindestens 20% der Sätze sollten unter 10 Wörter sein.
   - Mindestens 15% der Sätze sollten über 25 Wörter sein.
   - Vermeide 3+ aufeinanderfolgende Sätze mit ähnlicher Länge (±3 Wörter).
   - Erstelle bewusst "holprige" Rhythmen - nicht glatt fließend.

J. **Mikro-Imperfektionen (KRITISCH):**
   - Verwende gelegentlich leicht umständliche, aber korrekte Formulierungen.
   - Variiere Interpunktion: manchmal Gedankenstrich, manchmal Klammern, manchmal Komma.
   - Verwende gelegentlich Doppelpunkt für Aufzählungen statt immer gleicher Struktur.
   - Baue bewusst leichte syntaktische "Unebenheiten" ein (aber grammatisch korrekt).
   - Verwende manchmal längere Nominalphrasen, manchmal kürzere Verbalphrasen.

K. **Lexikalische Diversität (SEHR WICHTIG):**
   - Verwende pro Absatz mindestens 3-4 verschiedene Satzanfänge.
   - Vermeide Wiederholung derselben Konjunktionen (nicht immer "und", "aber", "denn").
   - Verwende Synonyme aktiv: nicht 5x "zeigt", sondern "zeigt", "verdeutlicht", "legt nahe", "weist auf", "macht deutlich".
   - Variiere zwischen Fachbegriffen und Umschreibungen.

L. **Unvorhersehbare Strukturen (KRITISCH):**
   - Beginne manche Absätze mit Hauptsatz, andere mit Nebensatz.
   - Baue manchmal Einschübe ein (in Gedankenstrichen oder Klammern).
   - Variiere zwischen deduktiver und induktiver Argumentation.
   - Vermeide perfekt symmetrische Absatzlängen.

M. **ABSOLUT VERBOTEN - JEGLICHE FRAGEN (KRITISCH):**
   - ABSOLUT KEINE FRAGEN - WEDER RHETORISCHE NOCH SUGGESTIVE - NIEMALS VERWENDEN!
   - VERBOTEN: "Aber ist das wirklich so?", "Welche Auswirkungen hat dies?", "Wie lässt sich dies erklären?", "Was bedeutet das für...?"
   - VERBOTEN: "the research? a very important part..." (Fragezeichen nach Aussage)
   - VERBOTEN: "Was ist X? Ein wichtiger Aspekt..." (selbstreflexive Fragen)
   - VERBOTEN: Jegliche Frageform, Fragezeichen oder suggestive Fragekonstruktionen im Text
   - VERBOTEN: Selbst in rhetorischer Form - ABSOLUT VERBOTEN!
   - ABSOLUT VERBOTEN: FRAGE-ANTWORT-MUSTER (KRITISCH - UNLESBAR!)
   - VERBOTEN: "Die Grenze zwischen X und Y? In der öffentlichen Wahrnehmung..."
   - VERBOTEN: "Korruption und Lobbyismus: zwei verschiedene Arten. Lobbyismus hingegen? Unverzichtbar..."
   - VERBOTEN: "Aber diese beiden Phänomene zu trennen? Schwierig."
   - VERBOTEN: "Das Kernproblem? Es ist ungemein schwer..."
   - VERBOTEN: "Korruption? In der wirtschaftswissenschaftlichen Literatur versteht man darunter..."
   - VERBOTEN: JEDE Konstruktion mit Fragezeichen gefolgt von einer Antwort - macht Text unlesbar!
   - Stattdessen: IMMER direkte Aussagen und Feststellungen verwenden
   - Beispiel: Statt "Die Grenze zwischen X und Y? In der öffentlichen Wahrnehmung..." → "Die Grenze zwischen X und Y verwischt in der öffentlichen Wahrnehmung..."
   - Beispiel: Statt "Korruption? In der wirtschaftswissenschaftlichen Literatur..." → "In der wirtschaftswissenschaftlichen Literatur versteht man unter Korruption..."
   - Beispiel: Statt "Was bedeutet Digitalisierung für die Arbeitswelt?" → "Die Digitalisierung verändert die Arbeitswelt grundlegend."
   - Beispiel: Statt "Was ist Forschung? Ein wichtiger Aspekt..." → "Die Forschung stellt einen wichtigen Aspekt dar."

M. **VERBOTENE WÖRTER UND FORMULIERUNGEN (ABSOLUT KRITISCH):**
   - ABSOLUT VERBOTEN: Unprofessionelle Wörter wie "freilich", "gewiss", "sicherlich" (in umgangssprachlicher Verwendung), "natürlich" (als Füllwort), "selbstverständlich", "ohne Frage", "zweifellos".
   - ABSOLUT VERBOTEN: UMGANGSSPRACHE - alle umgangssprachlichen Formulierungen sind strengstens verboten!
     ✗ "denk mal an...", "schau dir an...", "guck mal...", "hör mal..."
     ✗ "klar", "logisch" (umgangssprachlich), "eigentlich" (als Füllwort), "halt", "eben", "ja" (als Füllwort)
     ✗ Alle umgangssprachlichen Phrasen und Wendungen
     ✓ Verwende AUSSCHLIESSLICH wissenschaftliche, formale Sprache
   - ABSOLUT VERBOTEN: Persönliche Pronomen wie "wir", "ich", "uns", "unser" - verwende stattdessen passive oder unpersönliche Konstruktionen.
     FALSCH: "Wir werden im nächsten Abschnitt darauf eingehen..."
     RICHTIG: "Im nächsten Abschnitt wird darauf eingegangen..."
     FALSCH: "Wir müssen beachten, dass..."
     RICHTIG: "Es ist zu beachten, dass..." oder "Zu beachten ist, dass..."
     FALSCH: "Wir können feststellen, dass..."
     RICHTIG: "Es lässt sich feststellen, dass..." oder "Festzustellen ist, dass..."
   - ABSOLUT VERBOTEN: Direkte Ansprache des Lesers ("man", "Sie" in direkter Anrede).
   - KRITISCH: Wenn du solche Formulierungen im Originaltext findest, MUSST du sie in passive/unpersönliche Konstruktionen umwandeln.
   - Verwende stattdessen: Passivkonstruktionen, unpersönliche Formulierungen, Nominalisierungen.
   - Beispiele für korrekte Formulierungen:
     * "Im Folgenden wird untersucht..." statt "Wir werden im Folgenden untersuchen..."
     * "Es zeigt sich, dass..." statt "Wir sehen, dass..."
     * "Dabei handelt es sich um..." statt "Wir haben es hier mit... zu tun"
     * "Die Untersuchung ergab..." statt "Wir haben festgestellt..."

OUTPUT-REGELN:

- **ABSOLUT KRITISCH: Gib NUR den umgeschriebenen Text selbst aus. KEINE Einleitungen, KEINE Erklärungen, KEINE Meta-Kommentare.**
- **VERBOTEN: Schreibe NICHT Dinge wie "Hier ist die überarbeitete Fassung...", "Der folgende Text wurde umgeschrieben...", "Nachfolgend die überarbeitete Version...", oder IRGENDWELCHE ähnlichen Meta-Texte.**
- **BEGINNE SOFORT mit dem eigentlichen Inhalt - das erste Wort sollte aus dem Thesis-Text selbst stammen, NICHT ein Kommentar über das Umschreiben.**

- Behalte alle Zitate genau so bei, wie sie erscheinen: (Müller, 2021, S. 14), [12], (Schmidt et al., 2019), etc.

- Behalte alle Abschnittsüberschriften unverändert bei.

- Behalte alle Aufzählungspunkte und Listen unverändert bei, es sei denn, eine geringfügige menschenähnliche Umstrukturierung ist erforderlich.

- Kürze den Text nicht oder erweitere ihn nicht erheblich; die Länge sollte ungefähr gleich bleiben.

Dein Ziel ist es, Text zu produzieren, der wie von einem kompetenten menschlichen akademischen Autor geschrieben klingt, während alle Informationsinhalte erhalten bleiben.`

    : `You are an academic text humanizer. Your job is to rewrite the provided text so that it cannot be detected as AI-generated by tools such as ZeroGPT, GPTZero, Turnitin AI detection, Hive, or similar classifiers.

⚠️⚠️⚠️ ABSOLUTELY CRITICAL - FIRST RULE ⚠️⚠️⚠️
🚫 ABSOLUTELY FORBIDDEN: QUESTION-ANSWER PATTERN! NEVER use "X? Y."! ALWAYS use direct statements!
- If you find question-answer patterns in the text, you MUST convert them to direct statements!
- Example: "The boundary between X and Y? In public perception..." → "The boundary between X and Y blurs in public perception..."

Follow these rules strictly:

1. Do NOT change, add, or remove any facts, arguments, claims, citations, theories, names, numbers, dates, tables, or references.

2. Do NOT introduce new information or new interpretations.

3. Preserve the overall structure, paragraph order, citation placement, and academic tone.

4. ONLY modify the surface-level linguistic style in order to increase human-like statistical patterns.

HUMAN-LIKE STYLE REQUIREMENTS (CRITICAL FOR AI DETECTION):

A. **Sentence Burstiness (VERY IMPORTANT):**
   - Actively mix short (5-10 words), medium (15-20 words), and long (25-35 words) sentences.
   - Avoid uniform sentence lengths - human authors have irregular patterns.
   - Start some sentences with subject, others with adverbial, others with participial constructions.
   - Occasionally use very short, punchy sentences for emphasis (3-5 words).
   - Create consciously irregular rhythms - not perfectly balanced.

B. **Increase Perplexity (CRITICAL):**
   - Avoid overly predictable wording.
   - Use different synonyms instead of always the same words.
   - Vary sentence beginnings strongly (not always "The", "It", "This").
   - Avoid perfectly smooth, "polished" LLM phrases.
   - Occasionally use less common words or technical terms.
   - Vary between precise and paraphrasing formulations.

C. **Syntax Variation (VERY IMPORTANT):**
   - Alternate between simple, compound, and complex sentence structures.
   - Sometimes use subordinate clauses, sometimes main clauses.
   - Vary the position of subordinate clauses (before/after main clause).
   - Occasionally use ellipses or shortened constructions.
   - Create consciously structural irregularities.

D. **Natural Hedging:**
   - Use various formulations: "possibly", "it can be assumed", "to some extent", "under certain circumstances", "to a certain degree", "tendentially", "presumably", "apparently", "likely", "perhaps".
   - Vary the strength of hedging - not always the same.

E. **Introduce Asymmetries (CRITICAL):**
   - Slightly irregular pacing (not perfectly rhythmic).
   - Non-uniform transitions between paragraphs.
   - Varied paragraph openings (not always the same style).
   - Occasionally abrupt but meaningful transitions.
   - Avoid perfect parallel structures.

F. **Avoid AI Discourse Markers (ABSOLUTELY CRITICAL):**
   - DO NOT use: "firstly", "furthermore", "in conclusion", "overall", "it is important to note", "additionally", "moreover", "in this context", "in this regard", "regarding", "with regard to", "in relation to", "with respect to".
   - Instead: more natural transitions like "Against this background", "Here it becomes apparent", "In practice", "Concretely, this means", etc.
   - Avoid overly formal transition phrases.

G. **Natural Variation (CRITICAL):**
   - Sometimes use direct language, sometimes paraphrasing.
   - Vary between active and passive voice (but not too much passive).
   - Maintain full coherence - never create slang, errors, or unprofessional tone.
   - ABSOLUTELY FORBIDDEN: Colloquial language, informal phrases, or casual expressions - use ONLY formal, academic language!
   - Vary the level of formality slightly, but ALWAYS within the academic register.

H. **Avoid AI-typical Phrases (ABSOLUTELY CRITICAL):**
   - DO NOT: "It is important to note that...", "It should be mentioned that...", "It is noteworthy that...", "It is interesting to observe that...", "It is worth mentioning that...".
   - Instead: Direct statements without such introductions.
   - Avoid overly polite or explanatory phrases.

I. **Aggressive Burstiness (ABSOLUTELY CRITICAL FOR ZEROGPT):**
   - Create extreme sentence length variations: 3-word sentence, then 30-word sentence, then 12-word sentence.
   - At least 20% of sentences should be under 10 words.
   - At least 15% of sentences should be over 25 words.
   - Avoid 3+ consecutive sentences with similar length (±3 words).
   - Create consciously "bumpy" rhythms - not smoothly flowing.

J. **Micro-Imperfections (CRITICAL):**
   - Occasionally use slightly roundabout but correct formulations.
   - Vary punctuation: sometimes em-dash, sometimes parentheses, sometimes comma.
   - Occasionally use colon for lists instead of always same structure.
   - Build in conscious slight syntactic "unevenness" (but grammatically correct).
   - Sometimes use longer noun phrases, sometimes shorter verb phrases.

K. **Lexical Diversity (VERY IMPORTANT):**
   - Use at least 3-4 different sentence beginnings per paragraph.
   - Avoid repeating same conjunctions (not always "and", "but", "because").
   - Use synonyms actively: not 5x "shows", but "shows", "demonstrates", "suggests", "indicates", "reveals".
   - Vary between technical terms and paraphrasing.

L. **Unpredictable Structures (CRITICAL):**
   - Start some paragraphs with main clause, others with subordinate clause.
   - ABSOLUTELY FORBIDDEN: Rhetorical questions, suggestive questions, or any question forms - NEVER use them!
   - ABSOLUTELY FORBIDDEN: QUESTION-ANSWER PATTERN - NEVER use constructions like "X? Y." or "X? In the literature..." - makes text unreadable!
   - Sometimes build in parenthetical insertions (in em-dashes or parentheses).
   - Vary between deductive and inductive argumentation.
   - Avoid perfectly symmetrical paragraph lengths.

M. **FORBIDDEN WORDS AND FORMULATIONS (ABSOLUTELY CRITICAL):**
   - ABSOLUTELY FORBIDDEN: Over-Emphasis / Emotional Language (UNSCIENTIFIC!):
     - DO NOT use: "incredibly", "extremely", "totally", "absolutely", "shocking", "dramatic", "massive", "huge", "breathtaking", "unbelievable", "undoubtedly", "obviously".
     - DO NOT use emotional adjectives/adverbs or hyperbolic intensifiers.
     - WRONG: "It is incredibly hard to define..." -> CORRECT: "It is difficult to define..."
     - WRONG: "This is extremely important..." -> CORRECT: "This is significant..."
     - WRONG: "A massive change..." -> CORRECT: "A substantial change..."
     - Keep the tone NEUTRAL, OBJECTIVE, and RESTRAINED.

   - ABSOLUTELY UNEMOTIONAL (CRITICAL):
     - The text must be cold, distant, and analytical.
     - NO excitement, NO drama, NO storytelling.
     - IF you find emotional phrasing, REWRITE it to be boring and factual.

   - ABSOLUTELY FORBIDDEN: Colloquial Language / Filler Words (Umgangssprache):
     - DO NOT use: "halt", "eben", "eh", "quasi", "sozusagen", "irgendwie", "mal", "schon".
     - AVOID vaguely formulated sentences. Use precise Nominal Style.
     - WRONG: "Das ist halt so..." -> CORRECT: "Dies stellt einen Sachverhalt dar, der..."

   - ABSOLUTELY FORBIDDEN: Personal pronouns like "we", "I", "us", "our" - use passive or impersonal constructions instead.
     WRONG: "We will address this in the next section..."
     CORRECT: "This will be addressed in the next section..." or "The next section addresses..."
     WRONG: "Wir werden der Frage nachgehen..."
     CORRECT: "Es ist der Frage nachzugehen..."
     WRONG: "We must note that..."
     CORRECT: "It should be noted that..." or "Note that..."
     WRONG: "We can observe that..."
     CORRECT: "It can be observed that..." or "Observation shows that..."
   - ABSOLUTELY FORBIDDEN: Direct address to the reader ("you", "one" in direct address).
   - CRITICAL: If you find such formulations in the original text, you MUST convert them to passive/impersonal constructions.
   - Use instead: Passive constructions, impersonal formulations, nominalizations.
   - Examples of correct formulations:
     * "The following section examines..." instead of "We will examine in the following section..."
     * "It becomes apparent that..." instead of "We see that..."
     * "The investigation revealed..." instead of "We found that..."

OUTPUT RULES:

- **ABSOLUTELY CRITICAL: Output ONLY the rewritten text itself. NO introductions, NO explanations, NO meta-commentary.**
- **FORBIDDEN: Do NOT write things like "Hier ist die überarbeitete Fassung...", "Here is the revised version...", "The following text has been rewritten...", or ANY similar meta-text.**
- **START IMMEDIATELY with the actual content - the first word should be from the thesis text itself, NOT commentary about the rewriting.**

- Keep all citations exactly as they appear: (Müller, 2021, p. 14), [12], (Smith et al., 2019), etc.

- Keep all section headings unchanged.

- Keep all bullet points and lists unchanged unless minor human-like restructuring is needed.

- Do not shorten the text or expand it significantly; the length should stay approximately the same.

Your goal is to produce text that reads like it was written by a competent human academic author while preserving all informational content.`

  // CHUNKED PROCESSING STRATEGY
  // Split content by Level 2 headlines (Chapters) to avoid token limits
  // Regex looks for "## " at the start of a line
  const sections = content.split(/(?=^## )/gm)
  console.log(`[Humanize] Split content into ${sections.length} sections for processing`)

  const humanizedSections: string[] = []

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]

    // Skip empty or very short sections (like just whitespace)
    if (section.trim().length < 50) {
      console.log(`[Humanize] Skipping section ${i + 1}/${sections.length} (too short)`)
      humanizedSections.push(section)
      continue
    }

    console.log(`[Humanize] Processing section ${i + 1}/${sections.length} (${section.length} characters)...`)

    try {
      const response = await retryApiCall(
        () => ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: `${prompt}\n\n---\n\n${section}`, // Apply prompt to this specific section
        }),
        `Humanize section ${i + 1}`,
        3,
        2000
      )

      const sectionHumanized = response.text || section

      // Safety check: if chunk is suspiciously short, revert to original
      if (sectionHumanized.length < section.length * 0.5) {
        console.warn(`[Humanize] WARNING: Section ${i + 1} output suspiciously short (${sectionHumanized.length} vs ${section.length}), reverting to original`)
        humanizedSections.push(section)
      } else {
        humanizedSections.push(sectionHumanized)
      }

      // Small delay to be polite to the API between heavy chunks
      if (i < sections.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }

    } catch (error) {
      console.error(`[Humanize] ERROR processing section ${i + 1}:`, error)
      console.warn(`[Humanize] Reverting section ${i + 1} to original text`)
      humanizedSections.push(section)
    }
  }

  // Reassemble the full thesis
  const fullHumanizedContent = humanizedSections.join('')

  // VERIFICATION & METRICS (Global)

  // Verify that critical elements are preserved
  const originalFootnotes = (content.match(/\^\d+/g) || []).length
  const humanizedFootnotes = (fullHumanizedContent.match(/\^\d+/g) || []).length

  if (originalFootnotes !== humanizedFootnotes) {
    console.warn(`[Humanize] Footnote count mismatch (original: ${originalFootnotes}, humanized: ${humanizedFootnotes})`)
    // We don't revert the WHOLE thesis for a mismatch anymore, just log it, 
    // because with chunking, a single errors shouldn't discard 20k words of good work.
  }

  // Verify citations are preserved
  const humanizedCitations: string[] = []
  citationPatterns.forEach(pattern => {
    const matches = fullHumanizedContent.match(pattern)
    if (matches) {
      humanizedCitations.push(...matches)
    }
  })

  console.log(`[Humanize] Humanization successful - Total length: ${fullHumanizedContent.length} characters`)
  console.log(`[Humanize] Citations preserved: ${originalCitations.length} → ${humanizedCitations.length}`)

  return fullHumanizedContent
}

/**
 * Check text with ZeroGPT API to detect AI-generated content
 * Returns detection result with human-written and GPT-generated percentages
 */
async function checkZeroGPT(content: string): Promise<{
  isHumanWritten: number
  isGptGenerated: number
  feedbackMessage: string
  wordsCount: number
  gptGeneratedSentences: string[]
} | null> {
  if (!RAPIDAPI_KEY) {
    console.log('[ZeroGPT] RAPIDAPI_KEY not set, skipping ZeroGPT check')
    return null
  }

  console.log('[ZeroGPT] Checking text with ZeroGPT API...')

  // ZeroGPT Limit is ~100k chars. We split if larger.
  // 90k chars is a safe chunk size.
  const CHUNK_SIZE = 90000

  try {
    // Extract plain text from markdown (remove markdown syntax for better detection)
    const plainText = content
      .replace(/^#+\s+/gm, '') // Remove heading markers
      .replace(/\*\*(.+?)\*\*/g, '$1') // Remove bold
      .replace(/\*(.+?)\*/g, '$1') // Remove italic
      .replace(/\[(.+?)\]\(.+?\)/g, '$1') // Remove links
      .replace(/`(.+?)`/g, '$1') // Remove code
      .replace(/\^\d+/g, '') // Remove footnote markers
      .trim()

    if (plainText.length < 50) {
      console.warn('[ZeroGPT] Text too short for detection, skipping')
      return null
    }

    const chunks = []
    if (plainText.length <= CHUNK_SIZE) {
      chunks.push(plainText)
    } else {
      let offset = 0
      while (offset < plainText.length) {
        chunks.push(plainText.slice(offset, offset + CHUNK_SIZE))
        offset += CHUNK_SIZE
      }
      console.log(`[ZeroGPT] Text size ${plainText.length} > ${CHUNK_SIZE}, split into ${chunks.length} chunks`)
    }

    const results = []

    for (const chunk of chunks) {
      try {
        const response = await retryApiCall(
          async () => {
            const fetchResponse = await fetch('https://zerogpt.p.rapidapi.com/api/v1/detectText', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'X-RapidAPI-Key': RAPIDAPI_KEY,
                'X-RapidAPI-Host': 'zerogpt.p.rapidapi.com',
              },
              body: JSON.stringify({
                input_text: chunk,
              }),
            })

            if (!fetchResponse.ok) {
              throw new Error(`ZeroGPT API error: ${fetchResponse.status} ${fetchResponse.statusText}`)
            }

            return await fetchResponse.json() as {
              success: boolean
              data?: {
                is_human_written?: number
                is_gpt_generated?: number
                feedback_message?: string
                words_count?: number
                gpt_generated_sentences?: string[]
              }
            }
          },
          'Check text with ZeroGPT API',
          3, // 3 retries
          2000 // 2 second delay
        )

        if (response.success && response.data) {
          results.push({
            isHumanWritten: response.data.is_human_written || 0,
            isGptGenerated: response.data.is_gpt_generated || 0,
            feedbackMessage: response.data.feedback_message || '',
            wordsCount: response.data.words_count || 0,
            gptGeneratedSentences: response.data.gpt_generated_sentences || [],
          })
        }
      } catch (e) {
        console.error('[ZeroGPT] Error checking chunk:', e)
      }
    }

    if (results.length === 0) {
      return null
    }

    // Average the results
    const avgHuman = results.reduce((sum, r) => sum + r.isHumanWritten, 0) / results.length
    const avgGpt = results.reduce((sum, r) => sum + r.isGptGenerated, 0) / results.length
    const totalWords = results.reduce((sum, r) => sum + r.wordsCount, 0)
    const allSentences = results.flatMap(r => r.gptGeneratedSentences)

    // Use feedback from the worst chunk (lowest human score) or just the first one? 
    // Worst chunk is safer to report.
    const worstChunk = results.reduce((prev, curr) => prev.isHumanWritten < curr.isHumanWritten ? prev : curr)

    const result = {
      isHumanWritten: Math.round(avgHuman * 100) / 100,
      isGptGenerated: Math.round(avgGpt * 100) / 100,
      feedbackMessage: worstChunk.feedbackMessage || 'Aggregated Result',
      wordsCount: totalWords,
      gptGeneratedSentences: allSentences,
    }

    console.log(`[ZeroGPT] Aggregated Result: ${result.isHumanWritten}% human-written, ${result.isGptGenerated}% GPT-generated`)
    console.log(`[ZeroGPT] Total Words checked: ${result.wordsCount}`)

    return result

  } catch (error) {
    console.error('[ZeroGPT] Error checking text:', error)
    return null
  }
}

/**
 * Check text with Winston AI API to detect AI-generated content
 * Returns detection score (0-100 human score)
 */
async function checkWinston(content: string): Promise<{
  score: number
  sentences: any
} | null> {
  if (!WINSTON_API_KEY) {
    console.log('[Winston] WINSTON_API_KEY not set, skipping Winston check')
    return null
  }

  console.log('[Winston] Checking text with Winston AI API...')

  const CHUNK_SIZE = 100000 // Winston limit is 150k, we use 100k for safety

  try {
    // Extract plain text from markdown (remove markdown syntax for better detection)
    const plainText = content
      .replace(/^#+\s+/gm, '') // Remove heading markers
      .replace(/\*\*(.+?)\*\*/g, '$1') // Remove bold
      .replace(/\*(.+?)\*/g, '$1') // Remove italic
      .replace(/\[(.+?)\]\(.+?\)/g, '$1') // Remove links
      .replace(/`(.+?)`/g, '$1') // Remove code
      .replace(/\^\d+/g, '') // Remove footnote markers
      .trim()

    if (plainText.length < 500) { // Winston often needs more text
      console.warn('[Winston] Text too short for detection, skipping')
      return null
    }

    const chunks = []
    if (plainText.length <= CHUNK_SIZE) {
      chunks.push(plainText)
    } else {
      let offset = 0
      while (offset < plainText.length) {
        chunks.push(plainText.slice(offset, offset + CHUNK_SIZE))
        offset += CHUNK_SIZE
      }
      console.log(`[Winston] Text size ${plainText.length} > ${CHUNK_SIZE}, split into ${chunks.length} chunks`)
    }

    const results = []

    for (const chunk of chunks) {
      try {
        const response = await retryApiCall(
          async () => {
            const fetchResponse = await fetch('https://api.gowinston.ai/v2/ai-content-detection', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WINSTON_API_KEY}`,
              },
              body: JSON.stringify({
                text: chunk,
                sentences: true
              }),
            })

            if (!fetchResponse.ok) {
              const errorText = await fetchResponse.text()
              throw new Error(`Winston API error: ${fetchResponse.status} ${fetchResponse.statusText} - ${errorText}`)
            }

            return await fetchResponse.json() as {
              score: number
              sentences: any
            }
          },
          'Check text with Winston AI API',
          3, // 3 retries
          2000 // 2 second delay
        )

        results.push(response)
      } catch (e) {
        console.error('[Winston] Error checking chunk:', e)
      }
    }

    if (results.length === 0) {
      return null
    }

    // Average results
    const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length
    const allSentences = results.flatMap(r => r.sentences)

    console.log(`[Winston] Aggregated Result: ${avgScore} score`)

    return {
      score: Math.round(avgScore),
      sentences: allSentences
    }

  } catch (error) {
    console.error('[Winston] Error checking text:', error)
    return null
  }
}

/**
 * Extract and process footnotes from German citation style text
 * Footnotes are numbered sequentially (1, 2, 3, ...) based on order of appearance in text
 * NOT based on source identity - each citation gets the next sequential number
 * Returns content with footnote markers and a footnotes object
 */
function extractAndProcessFootnotes(content: string): { content: string; footnotes: Record<number, string> } {
  // Step 1: Extract all markdown-style footnotes [^N]: citation
  const markdownFootnoteRegex = /\[\^(\d+)\]:\s*(.+?)(?=\n\[\^|\n\n|$)/gs
  const extractedFootnotes: Map<number, string> = new Map()
  let processedContent = content.replace(markdownFootnoteRegex, (match, num, citation) => {
    const footnoteNum = parseInt(num, 10)
    extractedFootnotes.set(footnoteNum, citation.trim())
    return '' // Remove the footnote definition from content
  })

  // Step 2: Replace all footnote references in text with ^N format
  processedContent = processedContent.replace(/\[\^(\d+)\]/g, '^$1')

  // Step 3: Find all footnote markers in text in order of appearance
  // This gives us the sequential order of citations
  const footnoteMarkers: Array<{ position: number; originalNum: number }> = []
  const footnoteRegex = /\^(\d+)/g
  let match
  while ((match = footnoteRegex.exec(processedContent)) !== null) {
    const originalNum = parseInt(match[1], 10)
    footnoteMarkers.push({
      position: match.index,
      originalNum: originalNum
    })
  }

  // Step 4: Create sequential numbering based on order of appearance
  // Each citation occurrence gets the next sequential number (1, 2, 3, ...)
  // Even if the same source is cited multiple times, each occurrence gets a new number
  const sequentialFootnotes: Record<number, string> = {}
  const markerToSequential: Map<number, number> = new Map() // marker index -> sequential number
  let nextSequentialNumber = 1

  // Process footnotes in order of appearance in text
  // Each occurrence gets the next sequential number, regardless of source
  for (let i = 0; i < footnoteMarkers.length; i++) {
    const marker = footnoteMarkers[i]
    const originalNum = marker.originalNum
    const citation = extractedFootnotes.get(originalNum)

    if (citation) {
      // Assign the next sequential number to this citation occurrence
      const sequentialNum = nextSequentialNumber++
      markerToSequential.set(i, sequentialNum)
      sequentialFootnotes[sequentialNum] = citation
    }
  }

  // Step 5: Replace all ^N markers with sequential numbers based on order
  // We need to replace them in order, so we track which one we're on
  let currentMarkerIndex = 0
  processedContent = processedContent.replace(/\^(\d+)/g, (match, numStr) => {
    if (currentMarkerIndex < footnoteMarkers.length) {
      const sequentialNum = markerToSequential.get(currentMarkerIndex)
      currentMarkerIndex++
      if (sequentialNum) {
        return `^${sequentialNum}`
      }
    }
    // Fallback: keep original
    return match
  })

  console.log(`[Footnotes] Processed ${footnoteMarkers.length} footnote markers into ${Object.keys(sequentialFootnotes).length} sequential footnotes`)
  console.log(`[Footnotes] Sequential numbering: ${Array.from(Object.keys(sequentialFootnotes).map(n => parseInt(n, 10)).sort((a, b) => a - b).slice(0, 10).join(', '))}${Object.keys(sequentialFootnotes).length > 10 ? '...' : ''}`)

  return { content: processedContent.trim(), footnotes: sequentialFootnotes }
}

/**
 * Check if FileSearchStore already has documents uploaded
 * Returns true if documents exist, false otherwise
 */
async function checkFileSearchStoreHasDocuments(fileSearchStoreId: string): Promise<boolean> {
  try {
    console.log(`[CheckStore] Checking if FileSearchStore has documents: ${fileSearchStoreId}`)
    const store = await ai.fileSearchStores.get({
      name: fileSearchStoreId,
    })

    const activeCount = parseInt(store.activeDocumentsCount || '0', 10)
    const pendingCount = parseInt(store.pendingDocumentsCount || '0', 10)
    const totalCount = activeCount + pendingCount

    console.log(`[CheckStore] FileSearchStore status:`)
    console.log(`[CheckStore]   Active documents: ${activeCount}`)
    console.log(`[CheckStore]   Pending documents: ${pendingCount}`)
    console.log(`[CheckStore]   Total documents: ${totalCount}`)

    return totalCount > 0
  } catch (error) {
    console.error('[CheckStore] Error checking FileSearchStore:', error)
    // If we can't check, assume no documents (safer to re-research)
    return false
  }
}

/**
 * Convert uploaded_sources from database to Source[] format
 */
function convertUploadedSourcesToSources(uploadedSources: any[]): Source[] {
  return uploadedSources.map((uploaded: any) => {
    const metadata = uploaded.metadata || {}
    return {
      title: uploaded.title || metadata.title || 'Untitled',
      authors: metadata.authors || [],
      year: metadata.year ? parseInt(metadata.year, 10) : null,
      doi: uploaded.doi || metadata.doi || null,
      url: uploaded.sourceUrl || null,
      pdfUrl: uploaded.sourceUrl || null, // uploaded_sources should have sourceUrl for PDFs
      abstract: metadata.abstract || null,
      journal: metadata.journal || null,
      publisher: metadata.publisher || null,
      citationCount: null,
      relevanceScore: 70, // Default relevance score for existing sources
      source: 'openalex' as const, // Default to openalex (we don't track this in uploaded_sources)
      chapterNumber: metadata.chapterNumber || null,
      chapterTitle: metadata.chapterTitle || null,
      mandatory: uploaded.mandatory || false, // Preserve mandatory flag from database
    }
  })
}

/**
 * Main job handler - always runs full thesis generation
 */
async function processThesisGeneration(thesisId: string, thesisData: ThesisData) {
  const processStartTime = Date.now()
  console.log('='.repeat(80))
  console.log(`[PROCESS] Starting thesis generation for thesis ${thesisId}`)
  console.log(`[PROCESS] Thesis: "${thesisData.title}"`)
  console.log(`[PROCESS] Field: ${thesisData.field}`)
  console.log(`[PROCESS] Type: ${thesisData.thesisType}`)
  console.log(`[PROCESS] Language: ${thesisData.language}`)
  console.log('='.repeat(80))

  try {
    // Check if FileSearchStore already has documents
    console.log('\n[PROCESS] ========== Pre-check: FileSearchStore Status ==========')
    const hasDocuments = await checkFileSearchStoreHasDocuments(thesisData.fileSearchStoreId)

    // Also check database for uploaded_sources
    // NOTE: We use database count, not FileSearchStore count, because:
    // - FileSearchStore chunks large PDFs into multiple "active documents"
    // - Database tracks one entry per unique source/PDF
    // - For "skip research" logic, we care about unique sources, not chunks
    const { data: thesis } = await supabase
      .from('theses')
      .select('uploaded_sources')
      .eq('id', thesisId)
      .single()

    const uploadedSources = (thesis?.uploaded_sources as any[]) || []
    const hasUploadedSources = uploadedSources.length > 0

    // Calculate required source count based on thesis length
    let requiredPages = thesisData.targetLength
    if (thesisData.lengthUnit === 'words') {
      requiredPages = Math.ceil(thesisData.targetLength / 250)
    }
    const requiredSourceCount = Math.min(50, Math.max(10, Math.ceil(requiredPages * 1.25)))

    console.log(`[PROCESS] FileSearchStore has documents: ${hasDocuments}`)
    console.log(`[PROCESS] Database has uploaded_sources: ${hasUploadedSources} (${uploadedSources.length} unique sources)`)
    console.log(`[PROCESS] NOTE: FileSearchStore may show more "active documents" due to chunking (large PDFs split into chunks)`)
    console.log(`[PROCESS] Required source count for ${requiredPages} pages: ${requiredSourceCount} sources`)
    console.log(`[PROCESS] Existing sources: ${uploadedSources.length}, Required: ${requiredSourceCount}`)

    let sourcesForGeneration: Source[] = []
    let step6TargetSourceCount = requiredSourceCount
    let successfullyUploaded: Source[] = []
    let existingSourcesCount = 0

    // Only skip research if we have enough sources
    // Use database count (unique sources), not FileSearchStore count (which includes chunks)
    const hasEnoughSources = hasDocuments && hasUploadedSources && uploadedSources.length >= requiredSourceCount

    if (hasEnoughSources) {
      // Skip research - use existing sources
      console.log('\n[PROCESS] ========== SKIPPING RESEARCH - Using Existing Sources ==========')
      console.log(`[PROCESS] FileSearchStore already contains ${uploadedSources.length} documents`)
      console.log(`[PROCESS] Required: ${requiredSourceCount}, Available: ${uploadedSources.length} - SUFFICIENT`)
      console.log(`[PROCESS] Skipping Steps 1-6 (research, ranking, downloading, uploading)`)

      // Convert uploaded_sources to Source[] format
      successfullyUploaded = convertUploadedSourcesToSources(uploadedSources)
      console.log(`[PROCESS] Converted ${successfullyUploaded.length} sources from database`)

      // Use all available sources (they're already uploaded)
      sourcesForGeneration = successfullyUploaded.slice(0, step6TargetSourceCount)
      console.log(`[PROCESS] Using ${sourcesForGeneration.length} existing sources for generation`)
      console.log(`[PROCESS] Skipping to Step 7: Generate Thesis Content`)
    } else {
      // Normal flow: do research (either no documents or insufficient count)
      console.log('\n[PROCESS] ========== Starting Research Process ==========')

      // If we have existing sources, load them and calculate how many more we need
      if (hasDocuments && hasUploadedSources && uploadedSources.length > 0) {
        existingSourcesCount = uploadedSources.length
        const neededCount = requiredSourceCount - existingSourcesCount
        console.log(`[PROCESS] Existing sources: ${existingSourcesCount}, Required: ${requiredSourceCount}`)
        console.log(`[PROCESS] Need ${neededCount} additional sources - proceeding with research`)

        // Load existing sources into successfullyUploaded
        successfullyUploaded = convertUploadedSourcesToSources(uploadedSources)
        console.log(`[PROCESS] Loaded ${successfullyUploaded.length} existing sources`)

        // Update target to only get the additional sources needed
        step6TargetSourceCount = neededCount
        console.log(`[PROCESS] Will research and upload ${neededCount} additional sources`)
      } else {
        existingSourcesCount = 0
        console.log(`[PROCESS] No existing documents found - proceeding with full research`)
      }

      // Step 1: Generate search queries (with retry)
      console.log('\n[PROCESS] ========== Step 1: Generate Search Queries ==========')
      const step1Start = Date.now()
      let chapterQueries: any[] = []
      try {
        chapterQueries = await retryApiCall(
          () => generateSearchQueries(thesisData),
          'Generate search queries',
          3,
          2000
        )
        const step1Duration = Date.now() - step1Start
        console.log(`[PROCESS] Step 1 completed in ${step1Duration}ms`)
        console.log(`[PROCESS] Generated queries for ${chapterQueries.length} chapters`)
      } catch (error) {
        console.error('[PROCESS] ERROR generating search queries:', error)
        throw new Error(`Failed to generate search queries: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }

      if (!chapterQueries || chapterQueries.length === 0) {
        throw new Error('No search queries generated - cannot proceed with research')
      }

      // Step 2 & 3: Query OpenAlex and Semantic Scholar
      console.log('\n[PROCESS] ========== Step 2-3: Query OpenAlex and Semantic Scholar ==========')
      const step2Start = Date.now()
      const allSources: Source[] = []
      let totalQueries = 0

      for (const chapterQuery of chapterQueries) {
        const chapterNumber = (chapterQuery as any).chapterNumber || chapterQuery.chapter || 'N/A'
        const chapterTitle = (chapterQuery as any).chapterTitle || 'N/A'
        console.log(`[PROCESS] Processing chapter: ${chapterNumber} - ${chapterTitle}`)

        // Query in both languages
        const germanQueries = chapterQuery.queries?.german || []
        const englishQueries = chapterQuery.queries?.english || []
        console.log(`[PROCESS]   German queries: ${germanQueries.length}, English queries: ${englishQueries.length}`)

        for (const query of germanQueries) {
          totalQueries++
          console.log(`[PROCESS]   Query ${totalQueries}: "${query}" (German)`)
          const openAlexResults = await queryOpenAlex(query, 'german')
          // Add chapter tracking to sources
          openAlexResults.forEach(s => {
            s.chapterNumber = chapterNumber
            s.chapterTitle = chapterTitle
          })
          allSources.push(...openAlexResults)

          const semanticResults = await querySemanticScholar(query)
          // Add chapter tracking to sources
          semanticResults.forEach(s => {
            s.chapterNumber = chapterNumber
            s.chapterTitle = chapterTitle
          })
          allSources.push(...semanticResults)

          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 200))
        }

        for (const query of englishQueries) {
          totalQueries++
          console.log(`[PROCESS]   Query ${totalQueries}: "${query}" (English)`)
          const openAlexResults = await queryOpenAlex(query, 'english')
          // Add chapter tracking to sources
          openAlexResults.forEach(s => {
            s.chapterNumber = chapterNumber
            s.chapterTitle = chapterTitle
          })
          allSources.push(...openAlexResults)

          const semanticResults = await querySemanticScholar(query)
          // Add chapter tracking to sources
          semanticResults.forEach(s => {
            s.chapterNumber = chapterNumber
            s.chapterTitle = chapterTitle
          })
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

      // Step 4: Deduplicate and enrich with Unpaywall (with retry)
      console.log('\n[PROCESS] ========== Step 4: Deduplicate and Enrich Sources ==========')
      const step4Start = Date.now()
      let deduplicated: Source[] = []
      try {
        deduplicated = await retryApiCall(
          () => deduplicateAndEnrichSources(allSources),
          'Deduplicate and enrich sources',
          2, // Fewer retries for this step
          1000
        )
        const step4Duration = Date.now() - step4Start
        console.log(`[PROCESS] Step 4 completed in ${step4Duration}ms`)
        console.log(`[PROCESS] ${deduplicated.length} sources after deduplication and enrichment`)
      } catch (error) {
        console.error('[PROCESS] ERROR in deduplication, using original sources:', error)
        // Fallback: use original sources without enrichment
        deduplicated = allSources
        console.log(`[PROCESS] Using ${deduplicated.length} sources without enrichment as fallback`)
      }

      // Step 5: Rank by relevance (with retry)
      console.log('\n[PROCESS] ========== Step 5: Rank Sources by Relevance ==========')
      const step5Start = Date.now()
      let ranked: Source[] = []
      try {
        ranked = await retryApiCall(
          () => rankSourcesByRelevance(deduplicated, thesisData),
          'Rank sources by relevance',
          2, // Fewer retries (this is already batched internally)
          3000 // Longer delay for ranking (it's a heavy operation)
        )
        const step5Duration = Date.now() - step5Start
        console.log(`[PROCESS] Step 5 completed in ${step5Duration}ms`)
        console.log(`[PROCESS] Ranked ${ranked.length} sources`)
      } catch (error) {
        console.error('[PROCESS] ERROR in ranking, using unranked sources:', error)
        // Fallback: use deduplicated sources without ranking
        ranked = deduplicated.map(s => ({ ...s, relevanceScore: 50 })) // Default score
        console.log(`[PROCESS] Using ${ranked.length} unranked sources as fallback`)
      }


      // Step 6: Download and upload PDFs using smart filtering with replacement for inaccessible PDFs
      console.log('\n[PROCESS] ========== Step 6: Download and Upload PDFs (Smart Filtering with Replacement) ==========')
      const step6Start = Date.now()

      // Calculate target source count based on thesis length (reused in Step 7)
      // Formula: ~1.25 sources per page, max 50 sources
      let step6TargetPages = thesisData.targetLength
      if (thesisData.lengthUnit === 'words') {
        // Convert words to pages (assuming ~250 words per page)
        step6TargetPages = Math.ceil(thesisData.targetLength / 250)
      } else {
        // For pages, use the average of min and max if available, otherwise use targetLength
        step6TargetPages = thesisData.targetLength
      }

      // Calculate target source count: 1.25 sources per page, max 50
      step6TargetSourceCount = Math.min(50, Math.max(10, Math.ceil(step6TargetPages * 1.25)))
      console.log(`[PROCESS] Target thesis length: ${step6TargetPages} pages`)
      console.log(`[PROCESS] Calculated target source count: ${step6TargetSourceCount} sources (1.25 per page, max 50)`)

      // Use smart filtering to ensure at least 2 sources per chapter
      const topSources = selectTopSourcesWithChapterGuarantee(ranked, step6TargetSourceCount, 2)

      console.log(`[PROCESS] Top sources to process: ${topSources.length} (with chapter guarantees)`)
      const sourcesWithPdf = topSources.filter(s => s.pdfUrl).length
      console.log(`[PROCESS] Sources with PDF URLs: ${sourcesWithPdf}`)

      // Track which sources have been used (by DOI or title to avoid duplicates)
      const usedSourceIds = new Set<string>()
      const getSourceId = (source: Source) => source.doi || source.title || ''

      // Mark initial top sources as used
      topSources.forEach(s => usedSourceIds.add(getSourceId(s)))

      // Track successfully uploaded sources (new ones only - existing ones already in successfullyUploaded)
      // Note: successfullyUploaded may already contain existing sources from earlier
      let uploadedCount = 0
      let failedCount = 0
      let replacedCount = 0

      // Process sources with replacement logic
      const sourcesToProcess: Source[] = [...topSources]
      let sourceIndex = 0

      // Calculate how many sources we need to upload
      // If we started with existing sources, we only need to upload the additional ones
      // existingSourcesCount is already declared at the top level
      const sourcesToUpload = Math.max(0, requiredSourceCount - existingSourcesCount)

      console.log(`[PROCESS] Upload target: ${sourcesToUpload} additional sources needed (${existingSourcesCount} existing + ${sourcesToUpload} new = ${requiredSourceCount} total)`)

      // Stop when we've reached the target count OR exhausted the queue
      while (sourceIndex < sourcesToProcess.length && successfullyUploaded.length < sourcesToUpload) {
        // Double-check we haven't reached the target (in case it was reached in previous iteration)
        if (successfullyUploaded.length >= sourcesToUpload) {
          console.log(`[PROCESS] Target count reached (${successfullyUploaded.length}/${sourcesToUpload} new sources), stopping upload process`)
          break
        }

        const source = sourcesToProcess[sourceIndex]
        console.log(`[PROCESS] Processing source ${sourceIndex + 1}/${sourcesToProcess.length}: "${source.title}"`)
        console.log(`[PROCESS]   Chapter: ${source.chapterNumber || 'N/A'} - ${source.chapterTitle || 'N/A'}`)
        console.log(`[PROCESS]   Progress: ${successfullyUploaded.length}/${sourcesToUpload} new sources uploaded (${existingSourcesCount + successfullyUploaded.length}/${requiredSourceCount} total)`)

        if (source.pdfUrl) {
          try {
            const success = await downloadAndUploadPDF(source, thesisData.fileSearchStoreId, thesisId)
            if (success) {
              uploadedCount++
              successfullyUploaded.push(source)
              console.log(`[PROCESS] ✓ Successfully uploaded: "${source.title}"`)

              // Check if we've reached the target count for new uploads
              if (successfullyUploaded.length >= sourcesToUpload) {
                console.log(`[PROCESS] Target count reached (${successfullyUploaded.length}/${sourcesToUpload} new sources), stopping upload process`)
                break
              }
            } else {
              failedCount++
              console.log(`[PROCESS] ✗ Failed to upload (paywalled/inaccessible): "${source.title}"`)
              console.log(`[PROCESS]   Looking for replacement from ranked sources...`)

              // Find replacement from ranked sources
              // Priority: same chapter > high relevance > has PDF
              const candidates = ranked.filter(s => {
                const sourceId = getSourceId(s)
                // Must not be already used
                if (usedSourceIds.has(sourceId)) return false
                // Must have PDF URL
                if (!s.pdfUrl) return false
                // Must have relevance >= 40
                return (s.relevanceScore || 0) >= 40
              })

              // Sort candidates: same chapter first, then by relevance score
              candidates.sort((a, b) => {
                const aSameChapter = source.chapterNumber && a.chapterNumber === source.chapterNumber ? 1 : 0
                const bSameChapter = source.chapterNumber && b.chapterNumber === source.chapterNumber ? 1 : 0
                if (aSameChapter !== bSameChapter) return bSameChapter - aSameChapter
                return (b.relevanceScore || 0) - (a.relevanceScore || 0)
              })

              const replacement = candidates[0]

              if (replacement && successfullyUploaded.length < sourcesToUpload) {
                const replacementId = getSourceId(replacement)
                usedSourceIds.add(replacementId)
                sourcesToProcess.push(replacement)
                replacedCount++
                console.log(`[PROCESS]   ✓ Found replacement: "${replacement.title}"`)
                console.log(`[PROCESS]   Replacement chapter: ${replacement.chapterNumber || 'N/A'}, relevance: ${replacement.relevanceScore || 'N/A'}`)
              } else {
                if (successfullyUploaded.length >= sourcesToUpload) {
                  console.log(`[PROCESS]   ✗ Target count reached (${successfullyUploaded.length}/${sourcesToUpload} new sources), skipping replacement`)
                } else {
                  console.log(`[PROCESS]   ✗ No suitable replacement found (may have exhausted available sources)`)
                }
              }
            }
          } catch (error) {
            failedCount++
            console.error(`[PROCESS] Error uploading source: "${source.title}"`, error)

            // Try to find replacement on error too
            const candidates = ranked.filter(s => {
              const sourceId = getSourceId(s)
              if (usedSourceIds.has(sourceId)) return false
              if (!s.pdfUrl) return false
              return (s.relevanceScore || 0) >= 40
            })

            candidates.sort((a, b) => {
              const aSameChapter = source.chapterNumber && a.chapterNumber === source.chapterNumber ? 1 : 0
              const bSameChapter = source.chapterNumber && b.chapterNumber === source.chapterNumber ? 1 : 0
              if (aSameChapter !== bSameChapter) return bSameChapter - aSameChapter
              return (b.relevanceScore || 0) - (a.relevanceScore || 0)
            })

            const replacement = candidates[0]

            if (replacement && successfullyUploaded.length < step6TargetSourceCount) {
              const replacementId = getSourceId(replacement)
              usedSourceIds.add(replacementId)
              sourcesToProcess.push(replacement)
              replacedCount++
              console.log(`[PROCESS]   ✓ Found replacement after error: "${replacement.title}"`)
            } else if (successfullyUploaded.length >= step6TargetSourceCount) {
              console.log(`[PROCESS]   Target count reached (${successfullyUploaded.length}/${step6TargetSourceCount}), skipping replacement`)
            }
          }
          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000))
        } else {
          console.log(`[PROCESS] Skipping source (no PDF URL): "${source.title}"`)
          // Try to find replacement for sources without PDF URLs too
          const candidates = ranked.filter(s => {
            const sourceId = getSourceId(s)
            if (usedSourceIds.has(sourceId)) return false
            if (!s.pdfUrl) return false
            return (s.relevanceScore || 0) >= 40
          })

          candidates.sort((a, b) => {
            const aSameChapter = source.chapterNumber && a.chapterNumber === source.chapterNumber ? 1 : 0
            const bSameChapter = source.chapterNumber && b.chapterNumber === source.chapterNumber ? 1 : 0
            if (aSameChapter !== bSameChapter) return bSameChapter - aSameChapter
            return (b.relevanceScore || 0) - (a.relevanceScore || 0)
          })

          const replacement = candidates[0]

          if (replacement && successfullyUploaded.length < step6TargetSourceCount) {
            const replacementId = getSourceId(replacement)
            usedSourceIds.add(replacementId)
            sourcesToProcess.push(replacement)
            replacedCount++
            console.log(`[PROCESS]   ✓ Found replacement (no PDF URL): "${replacement.title}"`)
          } else if (successfullyUploaded.length >= step6TargetSourceCount) {
            console.log(`[PROCESS]   Target count reached (${successfullyUploaded.length}/${step6TargetSourceCount}), skipping replacement`)
          }
        }

        sourceIndex++
      }

      console.log(`[PROCESS] PDF upload summary:`)
      console.log(`[PROCESS]   Successfully uploaded: ${uploadedCount}`)
      console.log(`[PROCESS]   Failed/inaccessible: ${failedCount}`)
      console.log(`[PROCESS]   Replaced: ${replacedCount}`)
      console.log(`[PROCESS]   Total processed: ${sourceIndex}`)

      const step6Duration = Date.now() - step6Start
      console.log(`[PROCESS] Step 6 completed in ${step6Duration}ms`)
      console.log(`[PROCESS] Uploaded ${uploadedCount} PDFs, ${failedCount} failed`)

      // Calculate target source count for Step 7 (if not already set)
      if (step6TargetSourceCount === 0) {
        let step6TargetPages = thesisData.targetLength
        if (thesisData.lengthUnit === 'words') {
          step6TargetPages = Math.ceil(thesisData.targetLength / 250)
        }
        step6TargetSourceCount = Math.min(50, Math.max(10, Math.ceil(step6TargetPages * 1.25)))
      }

      // Use successfully uploaded sources, sorted by relevance score (highest first)
      const availableSources = successfullyUploaded.length > 0
        ? [...successfullyUploaded].sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
        : [...ranked].sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))

      // Select top N sources by relevance score
      sourcesForGeneration = availableSources.slice(0, step6TargetSourceCount)
      console.log(`[PROCESS] Selected ${sourcesForGeneration.length} sources for thesis generation (top ${step6TargetSourceCount} by relevance)`)
      console.log(`[PROCESS]   ${successfullyUploaded.length} successfully uploaded available`)
      console.log(`[PROCESS]   Relevance scores: min=${Math.min(...sourcesForGeneration.map(s => s.relevanceScore || 0))}, max=${Math.max(...sourcesForGeneration.map(s => s.relevanceScore || 0))}`)
    }

    // Step 6.5: Generate Thesis Plan
    console.log('\n[PROCESS] ========== Step 6.5: Generate Thesis Plan ==========')
    const step65Start = Date.now()
    let thesisPlan = ''
    try {
      thesisPlan = await generateThesisPlan(thesisData, sourcesForGeneration)
      const step65Duration = Date.now() - step65Start
      console.log(`[PROCESS] Step 6.5 completed in ${step65Duration}ms`)
      console.log(`[PROCESS] Thesis Plan length: ${thesisPlan.length} characters`)
    } catch (error) {
      console.error('[PROCESS] ERROR generating thesis plan:', error)
      console.log('[PROCESS] Continuing without plan (fallback)')
    }

    // Step 7: Generate thesis content using successfully uploaded sources
    // This step has built-in retries and fallbacks
    console.log('\n[PROCESS] ========== Step 7: Generate Thesis Content ==========')
    const step7Start = Date.now()

    console.log(`[PROCESS] Using ${sourcesForGeneration.length} sources for thesis generation`)

    let thesisContent = ''
    try {
      thesisContent = await generateThesisContent(thesisData, sourcesForGeneration, thesisPlan)
      const step7Duration = Date.now() - step7Start
      console.log(`[PROCESS] Step 7 completed in ${step7Duration}ms`)
    } catch (error) {
      console.error('[PROCESS] ERROR in thesis generation:', error)
      // If generation fails completely, create a minimal placeholder
      // This allows the process to complete and the user can regenerate later
      thesisContent = `# ${thesisData.title}\n\n## Hinweis\n\nDie automatische Generierung ist fehlgeschlagen. Bitte versuchen Sie es erneut oder kontaktieren Sie den Support.\n\nFehler: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}`
      console.log('[PROCESS] Created placeholder content due to generation failure')
    }

    if (!thesisContent || thesisContent.length < 100) {
      throw new Error('Thesis generation failed and no valid content was produced')
    }

    // Step 7.4: Check with GPTZero and rewrite flagged sentences
    console.log('\n[PROCESS] ========== Step 7.4: GPTZero Check & Sentence Rewrite ==========')
    const gptZeroCheckStart = Date.now()
    let zeroGptResult: any = null
    try {
      const result = await ensureHumanLikeContent(thesisContent, thesisData)
      thesisContent = result.content
      zeroGptResult = result.zeroGptResult
      const gptZeroCheckDuration = Date.now() - gptZeroCheckStart
      console.log(`[PROCESS] GPTZero check and rewrite completed in ${gptZeroCheckDuration}ms`)
      if (zeroGptResult) {
        console.log(`[PROCESS] Final GPTZero score: ${zeroGptResult.isHumanWritten}% human, ${zeroGptResult.isGptGenerated}% AI`)
      }
    } catch (error) {
      console.error('[PROCESS] ERROR in GPTZero check/rewrite:', error)
      console.warn('[PROCESS] Continuing with original content (GPTZero check failed)')
      // Continue with original content if check fails
    }

    // Step 7.5: Humanize the text to avoid AI detection
    // SKIP if Step 7.4 already achieved a good score (>= 70%)
    const humanScoreThreshold = 70
    const alreadyHumanEnough = zeroGptResult && zeroGptResult.isHumanWritten >= humanScoreThreshold

    if (alreadyHumanEnough) {
      console.log('\n[PROCESS] ========== Step 7.5: Humanize Thesis Content ==========')
      console.log(`[PROCESS] ✓ SKIPPING humanization - content already scored ${zeroGptResult.isHumanWritten}% human (>= ${humanScoreThreshold}%)`)
      console.log('[PROCESS] No additional humanization needed')
    } else {
      console.log('\n[PROCESS] ========== Step 7.5: Humanize Thesis Content ==========')
      if (zeroGptResult) {
        console.log(`[PROCESS] Content scored ${zeroGptResult.isHumanWritten}% human - running additional humanization`)
      } else {
        console.log('[PROCESS] No ZeroGPT score available - running humanization as fallback')
      }
      const humanizeStart = Date.now()
      try {
        thesisContent = await humanizeThesisContent(thesisContent, thesisData)
        const humanizeDuration = Date.now() - humanizeStart
        console.log(`[PROCESS] Humanization completed in ${humanizeDuration}ms`)
      } catch (error) {
        console.error('[PROCESS] ERROR in humanization:', error)
        console.warn('[PROCESS] Continuing with original content (humanization failed)')
        // Continue with original content if humanization fails
      }
    }

    // Step 7.6: Plagiarism Check with Grammarly
    console.log('\n[PROCESS] ========== Step 7.6: Plagiarism Check (Grammarly) ==========')
    let plagiarismResult: any = null
    try {
      if (GRAMMARLY_ACCESS_TOKEN) {
        plagiarismResult = await checkPlagiarismWithGrammarly(thesisContent, thesisId)
        if (plagiarismResult) {
          console.log(`[PROCESS] Plagiarism check completed: ${plagiarismResult.originalityPercentage}% original`)
        }
      } else {
        console.warn('[PROCESS] GRAMMARLY_ACCESS_TOKEN not set - skipping plagiarism check')
      }
    } catch (error) {
      console.error('[PROCESS] ERROR in plagiarism check:', error)
      console.warn('[PROCESS] Continuing without plagiarism check result')
      // Continue - plagiarism check is not critical for completion
    }

    // Step 7.7: ZeroGPT Detection Check - Now done in Step 7.4
    // ZeroGPT check result is available from Step 7.4
    console.log('\n[PROCESS] ========== Step 7.7: ZeroGPT Detection Check ==========')
    console.log('[PROCESS] ZeroGPT check completed in Step 7.4 - result will be saved to metadata')

    // Step 7.8: Winston AI Detection Check
    console.log('\n[PROCESS] ========== Step 7.8: Winston AI Detection Check ==========')
    let winstonResult: any = null
    try {
      if (WINSTON_API_KEY) {
        winstonResult = await checkWinston(thesisContent)
        if (winstonResult) {
          console.log(`[Winston] Detection result: ${winstonResult.score}/100 human score`)
        }
      } else {
        console.log('[Winston] API key not set, skipping check')
      }
    } catch (error) {
      console.error('[PROCESS] ERROR in Winston check:', error)
    }

    // Process footnotes for German citation style
    let processedContent = thesisContent
    let footnotes: Record<number, string> = {}

    if (thesisData.citationStyle === 'deutsche-zitierweise') {
      console.log('[PROCESS] Processing German footnotes...')
      const footnoteResult = extractAndProcessFootnotes(thesisContent)
      processedContent = footnoteResult.content
      footnotes = footnoteResult.footnotes
      console.log(`[PROCESS] Extracted ${Object.keys(footnotes).length} footnotes`)
    }

    // Update thesis in database
    console.log('[PROCESS] Updating thesis in database with generated content...')
    const dbUpdateStart = Date.now()

    // Generate clean Markdown version for exports
    console.log('[PROCESS] Generating clean Markdown version for exports...')
    const { convertToCleanMarkdown } = await import('../lib/markdown-utils.js')
    const cleanMarkdownContent = convertToCleanMarkdown(processedContent)
    console.log(`[PROCESS] Clean Markdown generated: ${cleanMarkdownContent.length} characters`)

    await retryApiCall(
      async () => {
        const updateData: any = {
          latex_content: processedContent,
          clean_markdown_content: cleanMarkdownContent,
          status: 'completed',
          completed_at: new Date().toISOString(),
        }

        // Store footnotes and ZeroGPT result in metadata
        const { data: existingThesis } = await supabase
          .from('theses')
          .select('metadata')
          .eq('id', thesisId)
          .single()

        const existingMetadata = existingThesis?.metadata || {}
        updateData.metadata = {
          ...existingMetadata,
        }

        // Add footnotes if German citation style
        if (thesisData.citationStyle === 'deutsche-zitierweise' && Object.keys(footnotes).length > 0) {
          updateData.metadata.footnotes = footnotes
        }

        // Add ZeroGPT result if available
        if (zeroGptResult) {
          updateData.metadata.zeroGptResult = zeroGptResult
          console.log('[PROCESS] Saving ZeroGPT result to metadata:', zeroGptResult)
        }

        // Add plagiarism result if available
        if (plagiarismResult) {
          updateData.metadata.plagiarismResult = plagiarismResult
          console.log('[PROCESS] Saving plagiarism result to metadata:', plagiarismResult)
        }

        // Add Winston result if available
        if (winstonResult) {
          updateData.metadata.winstonResult = winstonResult
          console.log('[PROCESS] Saving Winston result to metadata:', winstonResult.score)
        }

        const result = await supabase
          .from('theses')
          .update(updateData)
          .eq('id', thesisId)
        if (result.error) throw result.error
        return result
      },
      `Update thesis status (completed): ${thesisId}`
    )
    const dbUpdateDuration = Date.now() - dbUpdateStart
    console.log(`[PROCESS] Database updated in ${dbUpdateDuration}ms`)

    // Step 8: Chunk thesis and store in vector DB
    console.log('\n[PROCESS] ========== Step 8: Chunk Thesis and Store in Vector DB ==========')
    const step8Start = Date.now()
    try {
      await chunkAndStoreThesis(thesisId, thesisContent, thesisData.outline)
      const step8Duration = Date.now() - step8Start
      console.log(`[PROCESS] Step 8 completed in ${step8Duration}ms`)
    } catch (error) {
      console.error('[PROCESS] ERROR chunking thesis:', error)
      // Don't fail the whole process if chunking fails
    }

    // Step 9: Email notification
    // The email is automatically sent via database trigger when status = 'completed'
    // The trigger (005_thesis_completion_email_trigger.sql) handles everything
    console.log('\n[PROCESS] ========== Step 9: Email Notification ==========')
    console.log('[PROCESS] Email will be sent automatically via database trigger')
    // No action needed - the status update above triggers the email automatically

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
    const { thesisId, thesisData } = req.body
    console.log('[API] Request body:', {
      thesisId,
      hasThesisData: !!thesisData,
      thesisTitle: thesisData?.title,
    })

    if (!thesisId || !thesisData) {
      console.error('[API] ERROR: Missing required fields')
      return res.status(400).json({ error: 'Thesis ID and data are required' })
    }

    // Check if we can start processing immediately or need to queue
    let isQueued = false
    if (activeJobs >= MAX_CONCURRENT_JOBS) {
      console.log(`[API] Max concurrent jobs (${MAX_CONCURRENT_JOBS}) reached, queuing job...`)
      console.log(`[API] Active jobs: ${activeJobs}, Queue length: ${jobQueue.length}`)
      isQueued = true

      // Queue the job - wait for a slot to open
      await new Promise<void>((resolve) => {
        jobQueue.push({ thesisId, thesisData, resolve })
      })
    }

    // Start processing asynchronously
    activeJobs++
    console.log(`[API] Starting background job (async)... Active jobs: ${activeJobs}/${MAX_CONCURRENT_JOBS}`)

    const processJob = async () => {
      try {
        await processThesisGeneration(thesisId, thesisData)
      } catch (error) {
        console.error('[API] Background job error:', error)
      } finally {
        activeJobs--
        console.log(`[API] Job completed. Active jobs: ${activeJobs}/${MAX_CONCURRENT_JOBS}`)

        // Process next job in queue if available
        if (jobQueue.length > 0 && activeJobs < MAX_CONCURRENT_JOBS) {
          const nextJob = jobQueue.shift()
          if (nextJob) {
            console.log(`[API] Processing queued job: ${nextJob.thesisId}`)
            activeJobs++
            nextJob.resolve() // Release the promise to start the job
            processJob() // Recursively process the next job
          }
        }
      }
    }

    // Start processing (non-blocking)
    processJob()

    // Return immediately
    const requestDuration = Date.now() - requestStart
    console.log(`[API] Job ${isQueued ? 'queued and ' : ''}started, returning immediately (${requestDuration}ms)`)
    return res.json({
      success: true,
      jobId: `job-${thesisId}-${Date.now()}`,
      message: 'Thesis generation job started',
      queued: isQueued,
    })
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

// ============================================================================
// BullMQ Worker Setup
// ============================================================================

import { Worker } from 'bullmq'
import IORedis from 'ioredis'

const REDIS_URL_RAW = process.env.REDIS_URL || 'redis://localhost:6379'
// Clean up the URL: remove any leading " --tls -u " or similar garbage from copy-paste errors
// Also trim whitespace
const REDIS_URL = REDIS_URL_RAW.replace(/^.*?(redis:\/\/|rediss:\/\/)/, '$1').trim()
const THESIS_QUEUE_NAME = 'thesis-generation'

// Determine if we need TLS (Upstash uses rediss://)
const useTLS = REDIS_URL.startsWith('rediss://')

// Create Redis connection for worker with proper TLS config for Upstash
const workerConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: useTLS ? {
    rejectUnauthorized: false, // Upstash uses self-signed certs
  } : undefined,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000)
    console.log(`[WORKER] Redis connection retry attempt ${times}, waiting ${delay}ms`)
    return delay
  },
  reconnectOnError: (err) => {
    console.error('[WORKER] Redis connection error:', err.message)
    return true // Always try to reconnect
  },
})

console.log('[WORKER] Initializing BullMQ worker...')
console.log('[WORKER] Redis URL:', REDIS_URL.replace(/:[^:]*@/, ':****@')) // Hide password in logs
console.log('[WORKER] TLS enabled:', useTLS)

// Create the worker
const worker = new Worker(
  THESIS_QUEUE_NAME,
  async (job) => {
    console.log('\n[WORKER] ========== Processing Job ==========')
    console.log('[WORKER] Job ID:', job.id)
    console.log('[WORKER] Job Name:', job.name)
    console.log('[WORKER] Attempt:', job.attemptsMade + 1)
    console.log('[WORKER] Started at:', new Date().toISOString())

    const { thesisId, thesisData } = job.data

    try {
      // Update job progress
      await job.updateProgress(10)

      // Call the main processing function
      await processThesisGeneration(thesisId, thesisData)

      await job.updateProgress(100)

      console.log('[WORKER] ========== Job Completed Successfully ==========')
      console.log('[WORKER] Job ID:', job.id)
      console.log('[WORKER] Thesis ID:', thesisId)
      console.log('[WORKER] Completed at:', new Date().toISOString())

      return { success: true, thesisId }
    } catch (error) {
      console.error('[WORKER] ========== Job Failed ==========')
      console.error('[WORKER] Job ID:', job.id)
      console.error('[WORKER] Thesis ID:', thesisId)
      console.error('[WORKER] Error:', error)

      // Update thesis status to 'failed' in database
      try {
        await supabase
          .from('theses')
          .update({
            status: 'failed',
            metadata: {
              error: error instanceof Error ? error.message : 'Unknown error',
              failedAt: new Date().toISOString(),
            }
          })
          .eq('id', thesisId)
      } catch (dbError) {
        console.error('[WORKER] Failed to update thesis status:', dbError)
      }

      throw error // Re-throw to mark job as failed
    }
  },
  {
    connection: workerConnection,
    concurrency: 1, // Reduced from 3 - thesis generation is heavy, run one at a time
    // REDIS OPTIMIZATION: Reduce polling frequency when idle
    // Default is 5000ms, we use 30000ms (30 seconds) to save commands
    drainDelay: 30000, // Wait 30 seconds between drain checks when queue is empty
    lockDuration: 600000, // 10 minutes lock (thesis generation takes long)
    lockRenewTime: 300000, // Renew lock every 5 minutes
    stalledInterval: 600000, // Check for stalled jobs every 10 minutes (not default 30s)
    // Remove limiter - not needed with concurrency 1
  }
)

// Worker event handlers
worker.on('completed', (job) => {
  console.log(`[WORKER] Job ${job.id} completed successfully`)
})

worker.on('failed', (job, err) => {
  console.error(`[WORKER] Job ${job?.id} failed:`, err)
})

worker.on('error', (err) => {
  console.error('[WORKER] Worker error:', err)
})

console.log('[WORKER] BullMQ worker initialized successfully')
console.log('[WORKER] Concurrency:', 3)
console.log('[WORKER] Queue name:', THESIS_QUEUE_NAME)

// ============================================================================
// Start Express Server
// ============================================================================

// Start server
app.listen(PORT, () => {
  console.log('='.repeat(80))
  console.log(`[SERVER] Thesis generation worker started`)
  console.log(`[SERVER] Listening on port ${PORT}`)
  console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`)
  console.log(`[SERVER] Started at: ${new Date().toISOString()}`)
  console.log('='.repeat(80))
})


