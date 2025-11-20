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
// Support both NEXT_PUBLIC_SUPABASE_URL (for compatibility) and SUPABASE_URL
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const WORKER_API_KEY = process.env.THESIS_WORKER_API_KEY
const OPENALEX_EMAIL = process.env.OPENALEX_EMAIL || 'moontoolsinc@proton.me'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY // Optional: for generating embeddings
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-ada-002' // Default to ada-002 (1536 dims)

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

**WICHTIG:** Quellen mit einem Relevanz-Score unter 40 sollten ausgeschlossen werden, da sie nicht relevant genug sind.

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
  const highRelevance = sorted.filter((s: Source) => (s.relevanceScore || 0) >= 70).length
  const mediumRelevance = sorted.filter((s: Source) => (s.relevanceScore || 0) >= 40 && (s.relevanceScore || 0) < 70).length
  const lowRelevance = sorted.filter((s: Source) => (s.relevanceScore || 0) < 40).length
  const topScore = sorted[0]?.relevanceScore || 0
  const avgScore = sorted.reduce((sum, s) => sum + (s.relevanceScore || 0), 0) / sorted.length
  
  console.log(`[Ranking] Ranking complete:`)
  console.log(`[Ranking]   Total sources: ${sorted.length}`)
  console.log(`[Ranking]   Ranked sources: ${rankedSources.length}`)
  console.log(`[Ranking]   Unranked sources (default score 30): ${unrankedSources.length}`)
  console.log(`[Ranking]   High relevance (>=70): ${highRelevance}`)
  console.log(`[Ranking]   Medium relevance (40-69): ${mediumRelevance}`)
  console.log(`[Ranking]   Low relevance (<40): ${lowRelevance}`)
  console.log(`[Ranking]   Top score: ${topScore}, Average score: ${avgScore.toFixed(1)}`)
  
  return sorted
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
      .filter(s => s.relevanceScore && s.relevanceScore >= 40) // Only consider relevant sources
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
        return !usedSources.has(key) && s.relevanceScore && s.relevanceScore >= 40
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
    const fileSizeKB = pdfBuffer.length / 1024
    const fileSizeMB = fileSizeKB / 1024
    console.log(`[PDFUpload] PDF buffer created: ${fileSizeKB.toFixed(2)} KB (${fileSizeMB.toFixed(2)} MB)`)
    
    // Validate PDF before processing
    // Check 1: File size - Google FileSearchStore has a 20MB limit per file
    const MAX_FILE_SIZE_MB = 20
    if (fileSizeMB > MAX_FILE_SIZE_MB) {
      console.error(`[PDFUpload] ERROR: PDF too large (${fileSizeMB.toFixed(2)} MB > ${MAX_FILE_SIZE_MB} MB limit)`)
      return false
    }
    
    // Check 2: Minimum size - ensure it's not empty or corrupted
    const MIN_FILE_SIZE_KB = 1
    if (fileSizeKB < MIN_FILE_SIZE_KB) {
      console.error(`[PDFUpload] ERROR: PDF too small (${fileSizeKB.toFixed(2)} KB < ${MIN_FILE_SIZE_KB} KB) - likely corrupted or empty`)
      return false
    }
    
    // Check 3: Validate PDF header - should start with %PDF
    const pdfHeader = pdfBuffer.subarray(0, 4).toString('ascii')
    if (pdfHeader !== '%PDF') {
      console.error(`[PDFUpload] ERROR: Invalid PDF format (header: "${pdfHeader}", expected: "%PDF")`)
      return false
    }
    console.log(`[PDFUpload] PDF validation passed: valid PDF format, size OK`)
    
    // Extract page numbers using Gemini 2.5 Flash
    console.log(`[PDFUpload] Extracting page numbers...`)
    const pageExtractStart = Date.now()
    let pageStart: string | null = null
    let pageEnd: string | null = null
    try {
      const pageNumbers = await extractPageNumbers(pdfBuffer)
      pageStart = pageNumbers.pageStart
      pageEnd = pageNumbers.pageEnd
      const pageExtractDuration = Date.now() - pageExtractStart
      console.log(`[PDFUpload] Page extraction completed (${pageExtractDuration}ms)`)
    } catch (error) {
      console.warn(`[PDFUpload] WARNING: Page number extraction failed, using fallback estimation:`, error)
      // Fallback: Estimate page count from PDF size
      // Average academic PDF page is ~50-75 KB, use conservative 50 KB per page
      const estimatedPages = Math.max(1, Math.ceil(fileSizeKB / 50))
      pageStart = "1"
      pageEnd = estimatedPages.toString()
      console.log(`[PDFUpload] Using fallback: estimated ${estimatedPages} pages based on file size (${fileSizeKB.toFixed(2)} KB / 50 KB per page)`)
    }
    
    // Ensure we have page numbers (fallback if extraction returned null)
    if (!pageStart || !pageEnd) {
      console.warn(`[PDFUpload] WARNING: Page extraction returned null, using fallback estimation`)
      const estimatedPages = Math.max(1, Math.ceil(fileSizeKB / 50))
      pageStart = "1"
      pageEnd = estimatedPages.toString()
      console.log(`[PDFUpload] Using fallback: estimated ${estimatedPages} pages based on file size`)
    }
    
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
    // Add chapter information for relevance tracking
    if (source.chapterNumber) {
      customMetadata.push({ key: 'chapterNumber', stringValue: source.chapterNumber.substring(0, 256) })
    }
    if (source.chapterTitle) {
      customMetadata.push({ key: 'chapterTitle', stringValue: source.chapterTitle.substring(0, 256) })
    }

    // Upload to FileSearchStore
    console.log(`[PDFUpload] Uploading to FileSearchStore...`)
    console.log(`[PDFUpload]   File size: ${fileSizeMB.toFixed(2)} MB`)
    console.log(`[PDFUpload]   Metadata fields: ${customMetadata.length}`)
    console.log(`[PDFUpload]   Display name: ${source.title.substring(0, 100) || 'Untitled'}`)
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
      console.log(`[PDFUpload] Upload operation started, polling for completion...`)
    } catch (error: any) {
      // Handle specific 500 errors from Google API
      if (error?.status === 500) {
        console.error(`[PDFUpload] ERROR: Google API returned 500 Internal Server Error`)
        console.error(`[PDFUpload]   This usually means the PDF is corrupted, too large, or in an invalid format`)
        console.error(`[PDFUpload]   File size: ${fileSizeMB.toFixed(2)} MB`)
        console.error(`[PDFUpload]   PDF header validated: Yes`)
        console.error(`[PDFUpload]   Error details:`, error.message || error)
        return false
      }
      // Re-throw other errors
      throw error
    }

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

  const prompt = `Du bist ein wissenschaftlicher Assistent, der akademische Texte ausschließlich auf Basis der bereitgestellten, indexierten Quellen (RAG / File Search) schreibt.

**WICHTIG - Forschungs- und Quellenkontext:**
- Du hast die Quellen SELBST recherchiert und ausgewählt - du bist sowohl Autor als auch Forscher dieser Thesis.
- Die bereitgestellten Quellen sind das Ergebnis deiner eigenen Literaturrecherche und wurden von dir als relevant und ausreichend für diese Thesis bewertet.
- Es ist NICHT angemessen, im Text zu erwähnen, dass "die bereitgestellten Quellen unzureichend sind" oder dass "weitere Quellen benötigt werden".
- Wenn bestimmte Aspekte nicht vollständig abgedeckt werden können, formuliere dies wissenschaftlich neutral (z.B. "Weitere Forschung wäre wünschenswert" oder "Dieser Aspekt bedarf weiterer Untersuchung"), aber NIE als Kritik an der eigenen Quellenauswahl.
- Du schreibst als Forscher, der seine Quellen selbst ausgewählt hat - daher sind die vorhandenen Quellen per Definition ausreichend für die Thesis.

**Thesis-Informationen:**
- Titel/Thema: ${thesisData.title}
- Fachbereich: ${thesisData.field}
- Art: ${thesisData.thesisType}
- Forschungsfrage: ${thesisData.researchQuestion}
- Zitationsstil: ${citationStyleLabel}
- Ziel-Länge: ${thesisData.targetLength} ${thesisData.lengthUnit} (ca. ${targetPages} Seiten)
- Sprache: ${thesisData.language}

**Gliederung:**
${JSON.stringify(thesisData.outline, null, 2)}

**Quellenverwendung (KRITISCH - strikt befolgen):**
- Nutze ausschließlich die im Kontext bereitgestellten Quellen (File Search / RAG).
- Verwende nur Informationen, die eindeutig in diesen Quellen enthalten sind.
- Keine erfundenen Seitenzahlen, keine erfundenen Zitate, keine erfundenen Quellen.
- Wenn Seitenzahlen fehlen → nur Autor + Jahr verwenden.
- Wenn bestimmte Aspekte nicht vollständig in den Quellen abgedeckt sind, formuliere dies wissenschaftlich neutral (z.B. "Dieser Aspekt bedarf weiterer Untersuchung" oder "Weitere Forschung wäre wünschenswert"), aber NIE als Kritik an der eigenen Quellenauswahl oder als Hinweis auf "unzureichende Quellen".

**QUELLENANZAHL - ABSOLUT WICHTIG:**
${sourceUsageGuidance}

**Konkrete Anweisungen zur Quellenverwendung:**
- Verwende maximal ${recommendedSourceCount} Quellen im gesamten Text.
- Jede Quelle muss einen klaren, essentiellen Beitrag leisten.
- Keine "Füllquellen" - keine Quellen nur um die Anzahl zu erhöhen.
- Bei kurzen Arbeiten: Weniger ist mehr. ${targetPages < 15 ? `Eine ${targetPages}-Seiten-Arbeit mit 30+ Quellen wirkt unprofessionell und übertrieben.` : ''}
- Qualität über Quantität: Lieber 10 hochwertige, relevante Quellen als 30 oberflächliche.
- Die Quellenanzahl muss zur Länge der Arbeit passen. Eine kurze Hausarbeit sollte nicht wie eine Dissertation zitiert werden.
- Im Literaturverzeichnis NUR die tatsächlich im Text zitierten Quellen aufführen (maximal ${recommendedSourceCount}).

**Menschlicher Stil:**
- Verwende einen menschlichen, natürlichen Ton.
- Achte darauf, dass nicht zu häufig wiederholende Formulierungen verwendet werden. Sei Facettenreich in deiner Formulierung.
- Der Text darf NICHT als maschinell formuliert erkannt werden.

**Wissenschaftlicher Stil (${thesisData.language === 'german' ? 'deutsch' : 'englisch'}):**
- Objektiv, präzise, sachlich.
- Keine Meinungen, kein Marketing, keine Füllsätze.
- Klare Struktur, klarer roter Faden.
- Saubere Definitionen, methodische Klarheit, kritische Reflexion.

**Struktur:**
- Verwende das vorgegebene Outline.
- Nimm nur minimale Anpassungen vor, wenn sie die logische Struktur verbessern.
- Jeder Abschnitt muss einen klaren wissenschaftlichen Zweck erfüllen.

**Zitationsstil:**
- Halte dich exakt an den vorgegebenen Zitationsstil (${citationStyleLabel}).
- Der Zitationsstil MUSS ebenfalls im Fließtext berücksichtigt werden. Dort wo eine Quelle verwendet wird, ist dies im entsprechenden Zitationsstil zu kennzeichnen.
- Im Text und im Literaturverzeichnis strikt korrekt formatieren.
- Wenn der Stil Seitenzahlen verlangt, aber die Quelle keine liefert → Seitenzahl weglassen, niemals raten.
${thesisData.citationStyle === 'deutsche-zitierweise' ? `
**KRITISCH - Deutsche Zitierweise (Fußnoten) - ABSOLUT WICHTIG:**

**WANN Fußnoten verwenden:**
- JEDE Verwendung einer Quelle im Text MUSS sofort mit einer Fußnote markiert werden.
- JEDE Information, die aus einer Quelle stammt, MUSS eine Fußnote haben - auch indirekte Zitate, Paraphrasen, Fakten, Statistiken, Definitionen.
- JEDE Quelle, die im Literaturverzeichnis steht, MUSS mindestens einmal im Text mit einer Fußnote zitiert werden.
- Wenn du Informationen aus mehreren Quellen kombinierst, verwende mehrere Fußnoten: "Text^1^2" oder "Text^1,^2".
- Wenn du 8 Quellen im Literaturverzeichnis hast, müssen ALLE 8 Quellen auch im Text mit Fußnoten zitiert werden.
- Jede Stelle im Text, wo Informationen aus einer Quelle verwendet werden, MUSS eine Fußnote haben - KEINE Ausnahmen.

**FORMAT - Exakt befolgen:**
- Im Text: Verwende IMMER das Format "^N" direkt nach dem Wort/Satz, wo die Quelle verwendet wird.
  Beispiel: "Künstliche Intelligenz wird zunehmend eingesetzt^1. Die Technologie ermöglicht^2..."
  NICHT: "Künstliche Intelligenz wird zunehmend eingesetzt [^1]" oder "Künstliche Intelligenz wird zunehmend eingesetzt (^1)"
  RICHTIG: "Künstliche Intelligenz wird zunehmend eingesetzt^1"
  
- Fußnoten-Definitionen: Am Ende des Dokuments (vor dem Literaturverzeichnis) oder am Ende jedes Absatzes als:
  [^1]: Autor, Vorname. Titel. Ort: Verlag, Jahr, S. XX.
  [^2]: Autor, Vorname. "Artikel-Titel." Zeitschrift, Jahr, S. XX-YY.
  
- Jede Quelle bekommt eine fortlaufende Nummer (1, 2, 3, 4, ...) in der Reihenfolge, wie sie im Text erscheinen.
- Die Fußnoten müssen vollständig sein: Autor, Titel, Jahr, Seitenzahl (wenn verfügbar), Verlag/Journal.

**BEISPIEL für korrektes Format:**
Text: "Die Forschung zeigt^1, dass KI-Systeme^2 in der Medizin^3 zunehmend eingesetzt werden^4."

Fußnoten:
[^1]: Müller, J. (2023). KI in der Medizin. Berlin: Verlag, S. 45.
[^2]: Schmidt, A. (2022). "KI-Systeme." Journal, 12(3), S. 67-89.
[^3]: Weber, M. (2024). Medizinische Anwendungen. München: Verlag, S. 12.
[^4]: Becker, K. (2023). "Einsatz von KI." Zeitschrift, 5(2), S. 23-34.

**WICHTIG:**
- Stelle sicher, dass der Text vollständig ist und nicht abgebrochen wird - auch wenn viele Fußnoten verwendet werden.
- Jede Quelle im Literaturverzeichnis MUSS mindestens eine Fußnote im Text haben.
- Wenn du Informationen aus einer Quelle verwendest, MUSS sofort eine Fußnote folgen.` : ''}

**Literaturverzeichnis:**
- Am Ende des Dokuments ein vollständiges, korrekt formatiertes Literaturverzeichnis ausgeben.
- Nur tatsächlich zitierte Quellen aufnehmen.
- Alphabetisch sortiert.
- Format entsprechend dem Zitationsstil (${citationStyleLabel}).
- DOI, URL und Journal-Metadaten verwenden, sofern vorhanden.
- Keine doppelten Einträge.

**RAG-Nutzung:**
- Nutze aktiv die Inhalte der bereitgestellten Quellen (File Search / Embeddings).
- Extrahiere relevante Aussagen und verarbeite sie wissenschaftlich.
- Keine Inhalte außerhalb der bereitgestellten Daten außer allgemein anerkanntes Basiswissen (Definitionen, Methodik).

**WICHTIG - Inhaltsverzeichnis:**
- ERSTELLE KEIN Inhaltsverzeichnis (Table of Contents / Inhaltsverzeichnis) im generierten Text.
- Das Inhaltsverzeichnis wird automatisch aus der Gliederung generiert und separat angezeigt.
- Beginne direkt mit dem ersten Kapitel (z.B. "## Einleitung" oder "## 1. Einleitung").
- Keine Überschrift "Inhaltsverzeichnis" oder "Table of Contents" im Text.

**Output-Format:**
- Gib die komplette Arbeit in Markdown mit klaren Überschriften aus.
- Strukturbeispiel:
  # Titel
  ## Abstract
  ## Einleitung
  ...
  ## Fazit
  ## Literaturverzeichnis
- BEGINNE direkt mit dem ersten Kapitel - KEIN Inhaltsverzeichnis.

**Ziel:**
Erstelle eine vollständige, zitierfähige, wissenschaftlich fundierte Arbeit, die logisch aufgebaut ist, den Zitationsstil korrekt umsetzt, ausschließlich validierte Quellen nutzt und die vorgegebene Länge einhält.`

  console.log('[ThesisGeneration] Calling Gemini Pro to generate thesis content...')
  console.log('[ThesisGeneration] Using FileSearchStore for RAG context')
  console.log('[ThesisGeneration] FileSearchStore ID:', thesisData.fileSearchStoreId)
  const generationStart = Date.now()
  
  // Retry with SAME config (FileSearchStore + Gemini Pro) - 3 total attempts
  let content = ''
  let lastError: Error | unknown = null
  const maxAttempts = 3
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[ThesisGeneration] Attempt ${attempt}/${maxAttempts}: Full generation with FileSearchStore + Gemini Pro`)
      console.log(`[ThesisGeneration]   Model: gemini-2.5-pro`)
      console.log(`[ThesisGeneration]   FileSearchStore: ${thesisData.fileSearchStoreId}`)
      
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
        `Generate thesis content (Gemini Pro + FileSearchStore) - Attempt ${attempt}`,
        1, // Single retry per attempt (we're doing 3 attempts total)
        3000 // 3 second delay between attempts
      )
      
      content = response.text || ''
      const contentLength = content.length
      const wordCount = content.split(/\s+/).length
      const expectedWordCount = thesisData.lengthUnit === 'words' 
        ? thesisData.targetLength 
        : thesisData.targetLength * 250 // ~250 words per page
      
      if (content && content.length > 100) {
        const generationDuration = Date.now() - generationStart
        console.log(`[ThesisGeneration] ✓ Thesis generation completed successfully on attempt ${attempt} (${generationDuration}ms)`)
        console.log(`[ThesisGeneration] Generated content: ${contentLength} characters, ~${wordCount} words`)
        console.log(`[ThesisGeneration] Expected word count: ~${expectedWordCount} words`)
        
        // Warn if content is significantly shorter than expected
        if (wordCount < expectedWordCount * 0.5) {
          console.warn(`[ThesisGeneration] ⚠️ WARNING: Generated content is much shorter than expected!`)
          console.warn(`[ThesisGeneration]   Expected: ~${expectedWordCount} words, Got: ~${wordCount} words`)
          console.warn(`[ThesisGeneration]   This might indicate truncation or incomplete generation`)
          console.warn(`[ThesisGeneration]   Citation style: ${thesisData.citationStyle}`)
          if (thesisData.citationStyle === 'deutsche-zitierweise') {
            console.warn(`[ThesisGeneration]   German footnotes might have caused issues - checking...`)
          }
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
 * Extract and process footnotes from German citation style text
 * Returns content with footnote markers replaced and a footnotes object
 */
function extractAndProcessFootnotes(content: string): { content: string; footnotes: Record<number, string> } {
  const footnotes: Record<number, string> = {}
  let footnoteCounter = 1
  
  // Pattern 1: Markdown footnotes [^1]: citation text
  // Pattern 2: Inline footnotes like "text^1" or "text[^1]"
  // Pattern 3: Footnotes at end of line or paragraph
  
  // First, extract markdown-style footnotes [^N]: citation
  const markdownFootnoteRegex = /\[\^(\d+)\]:\s*(.+?)(?=\n\[\^|\n\n|$)/gs
  let processedContent = content.replace(markdownFootnoteRegex, (match, num, citation) => {
    const footnoteNum = parseInt(num, 10)
    footnotes[footnoteNum] = citation.trim()
    return '' // Remove the footnote definition from content
  })
  
  // Replace all footnote references in text with ^N format
  // Handle both [^N] and ^N formats
  processedContent = processedContent.replace(/\[\^(\d+)\]/g, '^$1')
  
  // If we have inline footnotes like "text^1" that aren't in our footnotes object,
  // try to extract them from the text
  const inlineFootnoteRegex = /\^(\d+)/g
  const foundFootnotes = new Set<number>()
  processedContent.replace(inlineFootnoteRegex, (match, num) => {
    foundFootnotes.add(parseInt(num, 10))
    return match
  })
  
  // If we found footnote markers but no definitions, try to extract from common patterns
  if (foundFootnotes.size > 0 && Object.keys(footnotes).length === 0) {
    // Try to find footnotes in various formats at the end of paragraphs or lines
    const footnotePatterns = [
      /\n(\d+)\.\s+(.+?)(?=\n\d+\.|\n\n|$)/g, // Numbered list format
      /\n\[(\d+)\]\s+(.+?)(?=\n\[\d+\]|\n\n|$)/g, // Bracket format
    ]
    
    for (const pattern of footnotePatterns) {
      processedContent.replace(pattern, (match, num, citation) => {
        const footnoteNum = parseInt(num, 10)
        if (foundFootnotes.has(footnoteNum) && !footnotes[footnoteNum]) {
          footnotes[footnoteNum] = citation.trim()
        }
        return '' // Remove from content
      })
    }
  }
  
  // Ensure all footnote markers have corresponding entries
  // If a marker exists but no definition, create a placeholder
  for (const num of foundFootnotes) {
    if (!footnotes[num]) {
      footnotes[num] = `[Fußnote ${num} - Zitation fehlt]`
    }
  }
  
  return { content: processedContent.trim(), footnotes }
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
    const step6TargetSourceCount = Math.min(50, Math.max(10, Math.ceil(step6TargetPages * 1.25)))
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
    
    // Track successfully uploaded sources
    const successfullyUploaded: Source[] = []
    let uploadedCount = 0
    let failedCount = 0
    let replacedCount = 0

    // Process sources with replacement logic
    const sourcesToProcess: Source[] = [...topSources]
    let sourceIndex = 0
    
    while (sourceIndex < sourcesToProcess.length && successfullyUploaded.length < step6TargetSourceCount) {
      const source = sourcesToProcess[sourceIndex]
      console.log(`[PROCESS] Processing source ${sourceIndex + 1}/${sourcesToProcess.length}: "${source.title}"`)
      console.log(`[PROCESS]   Chapter: ${source.chapterNumber || 'N/A'} - ${source.chapterTitle || 'N/A'}`)
      console.log(`[PROCESS]   Progress: ${successfullyUploaded.length}/${step6TargetSourceCount} uploaded`)
      
      if (source.pdfUrl) {
        try {
          const success = await downloadAndUploadPDF(source, thesisData.fileSearchStoreId, thesisId)
          if (success) {
            uploadedCount++
            successfullyUploaded.push(source)
            console.log(`[PROCESS] ✓ Successfully uploaded: "${source.title}"`)
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
            
            if (replacement) {
              const replacementId = getSourceId(replacement)
              usedSourceIds.add(replacementId)
              sourcesToProcess.push(replacement)
              replacedCount++
              console.log(`[PROCESS]   ✓ Found replacement: "${replacement.title}"`)
              console.log(`[PROCESS]   Replacement chapter: ${replacement.chapterNumber || 'N/A'}, relevance: ${replacement.relevanceScore || 'N/A'}`)
            } else {
              console.log(`[PROCESS]   ✗ No suitable replacement found (may have exhausted available sources)`)
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
          
          if (replacement) {
            const replacementId = getSourceId(replacement)
            usedSourceIds.add(replacementId)
            sourcesToProcess.push(replacement)
            replacedCount++
            console.log(`[PROCESS]   ✓ Found replacement after error: "${replacement.title}"`)
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
        
        if (replacement) {
          const replacementId = getSourceId(replacement)
          usedSourceIds.add(replacementId)
          sourcesToProcess.push(replacement)
          replacedCount++
          console.log(`[PROCESS]   ✓ Found replacement (no PDF URL): "${replacement.title}"`)
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

    // Step 7: Generate thesis content using successfully uploaded sources
    // This step has built-in retries and fallbacks
    console.log('\n[PROCESS] ========== Step 7: Generate Thesis Content ==========')
    const step7Start = Date.now()
    
    // Reuse the target source count calculated in Step 6
    const step7TargetSourceCount = step6TargetSourceCount
    console.log(`[PROCESS] Using target source count: ${step7TargetSourceCount} sources (calculated in Step 6)`)
    
    // Use successfully uploaded sources, sorted by relevance score (highest first)
    const availableSources = successfullyUploaded.length > 0 
      ? [...successfullyUploaded].sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
      : [...ranked].sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
    
    // Select top N sources by relevance score
    const sourcesForGeneration = availableSources.slice(0, step7TargetSourceCount)
    console.log(`[PROCESS] Selected ${sourcesForGeneration.length} sources for thesis generation (top ${step7TargetSourceCount} by relevance)`)
    console.log(`[PROCESS]   ${successfullyUploaded.length} successfully uploaded available`)
    console.log(`[PROCESS]   Relevance scores: min=${Math.min(...sourcesForGeneration.map(s => s.relevanceScore || 0))}, max=${Math.max(...sourcesForGeneration.map(s => s.relevanceScore || 0))}`)
    
    let thesisContent = ''
    try {
      thesisContent = await generateThesisContent(thesisData, sourcesForGeneration)
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
    await retryApiCall(
      async () => {
        const updateData: any = {
          latex_content: processedContent,
          status: 'completed',
          completed_at: new Date().toISOString(),
        }
        
        // Store footnotes in metadata if German citation style
        if (thesisData.citationStyle === 'deutsche-zitierweise' && Object.keys(footnotes).length > 0) {
          const { data: existingThesis } = await supabase
            .from('theses')
            .select('metadata')
            .eq('id', thesisId)
            .single()
          
          const existingMetadata = existingThesis?.metadata || {}
          updateData.metadata = {
            ...existingMetadata,
            footnotes: footnotes,
          }
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

// Start server
app.listen(PORT, () => {
  console.log('='.repeat(80))
  console.log(`[SERVER] Thesis generation worker started`)
  console.log(`[SERVER] Listening on port ${PORT}`)
  console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`)
  console.log(`[SERVER] Started at: ${new Date().toISOString()}`)
  console.log('='.repeat(80))
})

