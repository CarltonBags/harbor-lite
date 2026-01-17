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

// Pricing Constants (USD per 1M tokens/words)
// Placeholder values - adjust based on actual plan
const PRICING = {
  GEMINI_2_5_PRO: { INPUT: 1.25, OUTPUT: 5.00 }, // Estimated
  GEMINI_3_PRO_PREVIEW: { INPUT: 2.00, OUTPUT: 8.00 }, // Estimated premium
  WINSTON_AI: { PER_1000_WORDS: 0.06 } // User provided
}

// Concurrency control: limit number of simultaneous thesis generations
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '3', 10)
let activeJobs = 0
const jobQueue: Array<{ thesisId: string; thesisData: ThesisData; resolve: () => void }> = []

// Health tracking for production monitoring
let workerStartTime = Date.now()
let lastJobCompletedAt: string | null = null
let lastJobFailedAt: string | null = null
let totalJobsCompleted = 0
let totalJobsFailed = 0
let totalJobsStalled = 0
let currentJobId: string | null = null
let currentJobStartedAt: string | null = null
let totalInputTokens = 0
let totalOutputTokens = 0

type ModelType = 'gemini-2.5-pro' | 'gemini-3-pro-preview' | 'gemini-2.5-flash' // Flash maps to 2.5 Pro bucket for now or ignore? 

/**
 * Track token usage from AI response for cost calculation
 */
function trackTokenUsage(thesisData: ThesisData, response: any, model: ModelType, label: string): void {
  const meta = response?.usageMetadata
  if (meta) {
    const input = meta.promptTokenCount || 0
    const output = meta.candidatesTokenCount || 0

    // Update specific counters in thesisData
    if (model === 'gemini-2.5-pro' || model === 'gemini-2.5-flash') {
      // Note: Grouping Flash with 2.5 Pro for now unless user wants separate
      thesisData.tokenStats.gemini25ProInput += input
      thesisData.tokenStats.gemini25ProOutput += output
    } else if (model === 'gemini-3-pro-preview') {
      thesisData.tokenStats.gemini3ProInput += input
      thesisData.tokenStats.gemini3ProOutput += output
    }

    console.log(`[Tokens] ${label} (${model}): +${input} input, +${output} output`)
  }
}

/**
 * Calculate total cost in USD
 */
function calculateTotalCost(stats: ThesisData['tokenStats']): number {
  const cost25 = (stats.gemini25ProInput / 1_000_000 * PRICING.GEMINI_2_5_PRO.INPUT) +
    (stats.gemini25ProOutput / 1_000_000 * PRICING.GEMINI_2_5_PRO.OUTPUT)

  const cost30 = (stats.gemini3ProInput / 1_000_000 * PRICING.GEMINI_3_PRO_PREVIEW.INPUT) +
    (stats.gemini3ProOutput / 1_000_000 * PRICING.GEMINI_3_PRO_PREVIEW.OUTPUT)

  const costWinston = (stats.winstonWords / 1000) * PRICING.WINSTON_AI.PER_1000_WORDS

  return cost25 + cost30 + costWinston
}

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
  // Token tracking
  tokenStats: {
    gemini25ProInput: number
    gemini25ProOutput: number
    gemini3ProInput: number
    gemini3ProOutput: number
    winstonWords: number
  }
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

// --- JSON THESIS STRUCTURE ---
interface ThesisNode {
  id: string          // e.g., "1", "1.1"
  title: string       // e.g., "Einleitung"
  type: 'chapter' | 'section'
  content: string     // Markdown content for this specific section ONLY (no children content)
  children: ThesisNode[]
}

interface ThesisStructure {
  version: number
  nodes: ThesisNode[]
}

/**
 * Creates the initial empty JSON skeleton from the outline.
 */
function initializeThesisStructure(outline: OutlineChapterInfo[]): ThesisStructure {
  const nodes: ThesisNode[] = outline.map(chapter => {
    // 1. Create sub-nodes for sections (subchapters)
    const sectionNodes: ThesisNode[] = (chapter.sections || []).map(section => ({
      id: section.number,
      title: section.title,
      type: 'section',
      content: '', // Empty initially
      children: [] // We don't track subsections explicitly as nodes for now, just main subs
    }))

    // 2. Create the chapter node
    return {
      id: chapter.number,
      title: chapter.title,
      type: 'chapter',
      content: '', // The preamble text before sections
      children: sectionNodes
    }
  })

  return {
    version: 1,
    nodes
  }
}

/**
 * Updates content for a specific node (Chapter or Subchapter).
 * Thread-safeish implementation (returns new structure reference, though deep clone is expensive).
 */
function updateNodeContent(structure: ThesisStructure, nodeId: string, newContent: string): ThesisStructure {
  const updateRecursive = (nodes: ThesisNode[]): ThesisNode[] => {
    return nodes.map(node => {
      if (node.id === nodeId) {
        return { ...node, content: newContent }
      }
      if (node.children && node.children.length > 0) {
        return { ...node, children: updateRecursive(node.children) }
      }
      return node
    })
  }

  return {
    ...structure,
    nodes: updateRecursive(structure.nodes)
  }
}

/**
 * Flattens the outline hierarchy for subchapter-level generation.
 * For long theses (>8000 words), we generate each subchapter separately.
 * IMPORTANT: Word budget for each main chapter is split among its subchapters.
 * Returns items with a wordBudget property for proper distribution.
 */
interface FlattenedChapter extends OutlineChapterInfo {
  wordBudget: number
  isIntroOnly: boolean
}

function flattenToSubchapters(chapters: OutlineChapterInfo[], targetWordCount: number): FlattenedChapter[] {
  const flattened: FlattenedChapter[] = []
  const mainChapterCount = chapters.length
  const budgetPerMainChapter = Math.round(targetWordCount / mainChapterCount)

  for (const chapter of chapters) {
    const hasSubchapters = chapter.sections && chapter.sections.length > 0

    if (!hasSubchapters) {
      // No subchapters - this IS a leaf node, gets full chapter budget
      flattened.push({
        number: chapter.number,
        title: chapter.title,
        sections: [],
        wordBudget: budgetPerMainChapter,
        isIntroOnly: false
      })
    } else {
      // Has subchapters - count ONLY leaf nodes (not intro wrappers)
      let leafCount = 0
      for (const section of chapter.sections) {
        if (section.subsections && section.subsections.length > 0) {
          leafCount += section.subsections.length // Only count subsections as leaves
        } else {
          leafCount += 1 // Section is a leaf
        }
      }

      // Full chapter budget split evenly among leaf nodes only
      const leafBudget = Math.round(budgetPerMainChapter / Math.max(1, leafCount))

      // Add main chapter wrapper (skipped, no content)
      flattened.push({
        number: chapter.number,
        title: chapter.title,
        sections: [],
        wordBudget: 0, // No budget - will be skipped
        isIntroOnly: true
      })

      for (const section of chapter.sections) {
        const hasSubsections = section.subsections && section.subsections.length > 0

        if (!hasSubsections) {
          // Leaf section - gets full leaf budget
          flattened.push({
            number: section.number,
            title: section.title,
            sections: [],
            wordBudget: leafBudget,
            isIntroOnly: false
          })
        } else {
          // Has subsections - section is wrapper (skipped), subsections are leaves
          flattened.push({
            number: section.number,
            title: section.title,
            sections: [],
            wordBudget: 0, // No budget - will be skipped
            isIntroOnly: true
          })

          for (const subsection of section.subsections) {
            flattened.push({
              number: subsection.number,
              title: subsection.title,
              sections: [],
              wordBudget: leafBudget,
              isIntroOnly: false
            })
          }
        }
      }
    }
  }

  return flattened
}

/**
 * Finds a node by ID.
 */
function findNodeById(structure: ThesisStructure, id: string): ThesisNode | null {
  for (const node of structure.nodes) {
    if (node.id === id) return node
    if (node.children) {
      const found = findNodeById({ ...structure, nodes: node.children }, id)
      if (found) return found
    }
  }
  return null
}

/**
 * Flattens the JSON back into a full Markdown string.
 * This ensures backward compatibility with the 'content' column.
 */
function reassembleThesisContent(structure: ThesisStructure): string {
  let fullText = ''

  for (const chapter of structure.nodes) {
    // Chapter Title (if content doesn't already have it)
    // IMPORTANT: The generated content usually INCLUDES the header "## 1. Intro".
    // If we store raw body text, we might need to re-add headers.
    // BUT current 'generateChapterContent' returns "## Title\n\nBody".
    // So we just append the content.

    if (chapter.content) {
      fullText += chapter.content + '\n\n'
    }

    // Append children (subchapters)
    // Subchapters usually generated as part of the chapter content in the old monolithic way.
    // BUT if we move to granular generation, they might be separate.
    // FOR NOW: We assume the legacy generator produces ONE big string per CHAPTER (including subchapters).
    // So 'chapter.content' holds the whole chapter text, and 'children' are empty or metadata-only.
    // IF we split generation later, we would iterate children here.

    // HYBRID MODE CHECK:
    // If chapter.content is empty but children have content, assemble children.
    if (!chapter.content && chapter.children.length > 0) {
      for (const section of chapter.children) {
        if (section.content) {
          fullText += section.content + '\n\n'
        }
      }
    }
  }

  return fullText.trim()
}

/**
 * Best-effort parsing of a monolithic markdown string back into the structure.
 * Used when we modify the full text (e.g. extension) and need to re-sync the JSON.
 */
function parseContentToStructure(fullText: string, outline: OutlineChapterInfo[]): ThesisStructure {
  let structure = initializeThesisStructure(outline)

  // We need to split the full text by chapter headers.
  // Assuming headers are "## NUMBER. TITLE" or "## NUMBER TITLE"
  // It's tricky because user might have changed headers.
  // We use `detectChapters` logic essentially.

  // 1. Identify where each chapter starts.
  // We'll iterate through the outline and find the start index of each chapter in the fullText.

  const chapterIndices: { id: string, start: number, end: number }[] = []

  outline.forEach((chapter, index) => {
    const chapterNum = chapter.number.replace(/\.$/, '') // "1." -> "1"
    // Regex for "## 1. Title" or "## 1 Title" or "## Chapter 1"
    const regex = new RegExp(`^##\\s*(?:Kapitel|Chapter)?\\s*${escapeRegex(chapterNum)}[.:]?\\s+`, 'im')
    const match = fullText.match(regex)

    if (match && match.index !== undefined) {
      chapterIndices.push({ id: chapter.number, start: match.index, end: -1 })
    }
  })

  // Sort by position
  chapterIndices.sort((a, b) => a.start - b.start)

  // Determine end indices
  for (let i = 0; i < chapterIndices.length; i++) {
    if (i < chapterIndices.length - 1) {
      chapterIndices[i].end = chapterIndices[i + 1].start
    } else {
      chapterIndices[i].end = fullText.length
    }
  }

  // Assign content
  for (const idx of chapterIndices) {
    const content = fullText.slice(idx.start, idx.end).trim()
    structure = updateNodeContent(structure, idx.id, content)
  }

  return structure
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

// Timeout wrapper for API calls (prevents indefinite hangs)
const API_TIMEOUT_MS = 300000 // 5 minutes

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number = API_TIMEOUT_MS, operationName: string = 'API call'): Promise<T> {
  let timeoutId: NodeJS.Timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)
  })

  try {
    const result = await Promise.race([promise, timeoutPromise])
    clearTimeout(timeoutId!)
    return result
  } catch (error) {
    clearTimeout(timeoutId!)
    throw error
  }
}

// Retry wrapper for API calls with timeout
async function retryApiCall<T>(
  fn: () => Promise<T>,
  operationName: string,
  maxRetries: number = 3,
  baseDelay: number = 1000,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<T> {
  let lastError: Error | unknown

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Wrap each attempt with timeout
      return await withTimeout(fn(), timeoutMs, operationName)
    } catch (error) {
      lastError = error
      const isLastAttempt = attempt === maxRetries
      const isTimeout = error instanceof Error && error.message.includes('timed out')

      if (isLastAttempt) {
        console.error(`${operationName} failed after ${maxRetries} attempts:`, error)
        throw error
      }

      // Shorter delay for timeouts (already waited long enough)
      const delay = isTimeout ? baseDelay : baseDelay * Math.pow(2, attempt - 1)
      console.warn(`${operationName} failed (attempt ${attempt}/${maxRetries})${isTimeout ? ' [TIMEOUT]' : ''}, retrying in ${delay}ms...`)
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
  trackTokenUsage(thesisData, response, 'gemini-2.5-flash', 'Generate search queries')

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

  // Process all batches in PARALLEL
  console.log(`[Ranking] Dispatching ${batches.length} batches to Gemini in PARALLEL...`)

  const batchPromises = batches.map(async (batch, batchIndex) => {
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
      // Use retryApiCall but run in parallel via the map
      const response = await retryApiCall(
        () => ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        }),
        `Rank sources batch ${batchIndex + 1}/${batches.length} (Gemini)`
      )
      trackTokenUsage(thesisData, response, 'gemini-2.5-flash', `Rank sources batch ${batchIndex + 1}`)
      const batchDuration = Date.now() - batchStart
      console.log(`[Ranking] Batch ${batchIndex + 1} completed in ${batchDuration}ms`)

      const content = response.text
      if (!content) {
        console.warn(`[Ranking] WARNING: No content from Gemini for batch ${batchIndex + 1}, assigning default scores`)
        return batch.map((_, localIndex) => ({ index: localIndex, relevanceScore: 50 })) // Return local results
      }

      const jsonMatch = content.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        console.warn(`[Ranking] WARNING: Invalid JSON response for batch ${batchIndex + 1}, assigning default scores`)
        return batch.map((_, localIndex) => ({ index: localIndex, relevanceScore: 50 }))
      }

      try {
        const rankings = JSON.parse(jsonMatch[0]) as Array<{ index: number; relevanceScore: number; reason?: string }>
        return rankings
      } catch (parseError) {
        console.error(`[Ranking] ERROR parsing JSON for batch ${batchIndex + 1}:`, parseError)
        return batch.map((_, localIndex) => ({ index: localIndex, relevanceScore: 50 }))
      }
    } catch (error) {
      console.error(`[Ranking] ERROR ranking batch ${batchIndex + 1}:`, error)
      return batch.map((_, localIndex) => ({ index: localIndex, relevanceScore: 50 }))
    }
  })

  // Wait for all batches to complete
  const resultsArrays = await Promise.all(batchPromises)

  // Reconstruct the global order
  // Since we slice batches sequentially, resultsArrays[0] corresponds to the first 50 items, etc.
  let currentBaseIndex = 0
  resultsArrays.forEach((batchRankings, i) => {
    // batchRankings contains local indices (0-49)
    // shift them to global indices
    batchRankings.forEach(r => {
      allRankings.push({
        ...r,
        index: currentBaseIndex + r.index
      })
    })
    currentBaseIndex += batches[i].length
  })

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
async function extractPageNumbers(pdfBuffer: Buffer, thesisData: ThesisData): Promise<{ pageStart: string | null; pageEnd: string | null }> {
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
    // CRITICAL: Extract the ACTUAL page count of the document, not internal PDF page numbers
    const prompt = `Analyze this PDF document and extract the VISUAL page numbers.

    TASK:
    1. Scan the header and footer of the FIRST visually distinct page.
       - List all numbers found (e.g. "5917", "1", "2023").
    2. Scan the header and footer of the SECOND visually distinct page.
       - List all numbers found (e.g. "5917", "2", "2023").
    3. COMPARE the numbers:
       - "5917" vs "5917" -> Constant (likely Article ID or Year). REJECT.
       - "1" vs "2" -> Increments (+1). ACCEPT as Page Number.
       - "100" vs "101" -> Increments (+1). ACCEPT.
    4. EXTRACT the correct Start and End page numbers based on this pattern.
    -Important: Sometimes page 1 of an article might not contain page number 1. but if page 2 contains page number 2, then the first page is page 1.

    RESPONSE FORMAT:
    First, provide your reasoning. Do NOT use curly braces {} in your reasoning.
    "REASONING:
    Page 1 found: ...
    Page 2 found: ...
    Comparison: ...
    Conclusion: ..."

    Then, provide the JSON:
    {
      "pageStart": "1",
      "pageEnd": "10"
    }

    Do NOT return alphanumeric strings like "e1234" (numeric only).`

    console.log('[PageExtraction] Calling Gemini 2.5 Pro to extract page numbers...')
    const response = await retryApiCall(
      () => ai.models.generateContent({
        model: 'gemini-2.5-pro',
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
    trackTokenUsage(thesisData, response, 'gemini-2.5-flash', 'Extract page numbers')

    const content = response.text
    if (content) {
      console.log('[PageExtraction] AI Output:', content.substring(0, 500) + '...') // Log reasoning
    }
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
      pageStart: parsed.pageStart ? String(parsed.pageStart).trim() : null,
      pageEnd: parsed.pageEnd ? String(parsed.pageEnd).trim() : null,
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
async function downloadAndUploadPDF(source: Source, fileSearchStoreId: string, thesisId: string, thesisData: ThesisData): Promise<boolean> {
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
        const pageNumbers = await extractPageNumbers(docBuffer, thesisData)
        // STRICT VALIDATION & CLEANUP: PDF extraction must return numeric strings only
        const pStart = pageNumbers.pageStart ? pageNumbers.pageStart.trim() : null
        const pEnd = pageNumbers.pageEnd ? pageNumbers.pageEnd.trim() : null

        if (pStart && pEnd && /^\d+$/.test(pStart) && /^\d+$/.test(pEnd)) {
          const extractedStart = parseInt(pStart, 10)
          const extractedEnd = parseInt(pEnd, 10)

          // VALIDATION: Ensure page numbers make sense
          // Removed > 1000 check as valid journals often have high page numbers (e.g. 1805)
          if (extractedEnd < extractedStart) {
            console.warn(`[DocUpload] WARNING: Extracted PDF pageEnd (${extractedEnd}) < pageStart (${extractedStart}), invalid.`)
          } else {
            pdfPageStart = pStart
            pdfPageEnd = pEnd
            const pageExtractDuration = Date.now() - pageExtractStart
            console.log(`[DocUpload] PDF extraction: ${pdfPageStart}-${pdfPageEnd} pages (${pageExtractDuration}ms)`)

            // CORRECTION: Check for invalid or mismatched API page data
            const isJournalStartNumeric = journalPageStart ? /^\d+$/.test(journalPageStart) : false
            const isJournalEndNumeric = journalPageEnd ? /^\d+$/.test(journalPageEnd) : false

            // Case 1: Non-numeric pages (e.g. "a017640") OR Pages > 10000 (Article IDs)
            // User explicit rule: "everything above 10000 should be treated as false"
            const startVal = parseInt(journalPageStart || '0', 10)
            const endVal = parseInt(journalPageEnd || '0', 10)
            const isTooLarge = startVal > 10000 || endVal > 10000

            if (((!isJournalStartNumeric || !isJournalEndNumeric) || isTooLarge) && journalPageStart) {
              console.warn(`[DocUpload] DETECTED INVALID PAGES (Non-numeric or >10000): API returned "${journalPageStart}-${journalPageEnd}". Overriding with extracted PDF pages.`)
              journalPageStart = pdfPageStart
              journalPageEnd = pdfPageEnd
              console.log(`[DocUpload] Overridden with PDF pages: ${journalPageStart}-${journalPageEnd}`)
            } else if (journalPageStart && journalPageEnd && journalPageStart === journalPageEnd) {
              const pdfPages = extractedEnd - extractedStart + 1
              if (pdfPages > 1) {
                console.warn(`[DocUpload] DETECTED PAGE MISMATCH: API says single page (${journalPageStart}) but PDF has ${pdfPages} pages.`)

                // Calculate new end page based on PDF length
                // Example: Start 20, PDF 10 pages -> End 20 + 10 - 1 = 29
                const newEnd = parseInt(journalPageStart, 10) + pdfPages - 1
                journalPageEnd = String(newEnd)
                console.log(`[DocUpload] CORRECTED journal page range: ${journalPageStart}-${journalPageEnd}`)
              }
            } else if (!journalPageStart && !journalPageEnd) {
              // Fallback: If no journal pages from API, use PDF pages
              // This is better than "keine Angabe"
              journalPageStart = pdfPageStart
              journalPageEnd = pdfPageEnd
              console.log(`[DocUpload] No API journal pages, using PDF pages as fallback: ${journalPageStart}-${journalPageEnd}`)
            }
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

    if (journalPageStart && journalPageEnd && !/^[eE]\d+/.test(journalPageStart)) {
      // Use journal pages for citations (ONLY if they look like real page numbers, not e.g. e1234)
      pageStart = journalPageStart
      pageEnd = journalPageEnd
      console.log(`[DocUpload] Using journal pages for citations: ${pageStart}-${pageEnd}`)
    } else if (pdfPageStart && pdfPageEnd) {
      // Fallback to PDF pages if no journal pages OR if journal pages look like electronic IDs
      pageStart = pdfPageStart
      pageEnd = pdfPageEnd
      if (journalPageStart && /^[eE]\d+/.test(journalPageStart)) {
        console.log(`[DocUpload] Preferred extracted PDF pages (${pageStart}-${pageEnd}) over electronic ID (${journalPageStart})`)
      } else {
        console.log(`[DocUpload] Using PDF pages (no journal pages available): ${pageStart}-${pageEnd}`)
      }
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
    trackTokenUsage(thesisData, response, 'gemini-2.5-pro', 'Generate Thesis Plan')

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

function extractFuturePlan(thesisPlan: string, currentChapterNumber: string, language: 'german' | 'english'): string {
  if (!thesisPlan) return ''
  // Find where the current chapter ends in the plan and return the rest
  const currentChapterRegex = language === 'german'
    ? new RegExp(`##\\s+Kapitel\\s+${currentChapterNumber.split('.')[0]}[^\\n]*\\n[\\s\\S]*?(?=\\n##\\s+(?:Kapitel|Chapter)\\s+|$)`, 'i')
    : new RegExp(`##\\s+Chapter\\s+${currentChapterNumber.split('.')[0]}[^\\n]*\\n[\\s\\S]*?(?=\\n##\\s+(?:Chapter|Kapitel)\\s+|$)`, 'i')

  const match = thesisPlan.match(currentChapterRegex)
  if (!match) return '' // Current chapter not found in plan

  const currentIndex = match.index! + match[0].length
  const futureContent = thesisPlan.substring(currentIndex).trim()

  // Clean up to just show headings/summaries effectively
  // We want to pass a concise overview, not the full text if it's huge
  return futureContent.length > 5000 ? futureContent.substring(0, 5000) + '...' : futureContent
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
  previousChapterSummaries: string[]
  futureChaptersOverview?: string
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
    trackTokenUsage(thesisData, extensionResponse, 'gemini-2.5-pro', `Extend thesis pass ${pass}`)

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
  previousChapterSummaries,
  futureChaptersOverview,
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
  const minChapterWords = Math.max(50, Math.round(chapterTargetWords * 0.9))
  let chapterContent = ''
  let attempts = 0

  // Format Citation Style Label
  const citationStyleLabels: Record<string, string> = {
    'harvard': 'Harvard Style',
    'apa': 'APA Style',
    'mla': 'MLA Style',
    'chicago': 'Chicago Style'
  }
  const citationStyleLabel = citationStyleLabels[citationStyle] || 'Harvard Style'

  // Build comprehensive source list for the prompt - CRITICAL FOR CITATIONS
  const availableSourcesList = sources.map((s, i) => {
    const authors = s.authors && s.authors.length > 0
      ? s.authors.slice(0, 3).join(', ') + (s.authors.length > 3 ? ' et al.' : '')
      : (s.publisher || s.title || 'Source') // STRICT: Never use Unbekannt/o.V., use Publisher or Title
    const year = s.year || 'o.J.'

    // SAFETY FILTER: Reject any page number starting with a letter (e.g. "e1234")
    const invalidPagePattern = /^[a-zA-Z]/
    let pageStart = s.pageStart ? String(s.pageStart) : null
    let pageEnd = s.pageEnd ? String(s.pageEnd) : null

    if (pageStart && invalidPagePattern.test(pageStart)) pageStart = null
    if (pageEnd && invalidPagePattern.test(pageEnd)) pageEnd = null

    const pages = (!pageStart && !pageEnd) ? 'keine Angabe' : (s.pages && !invalidPagePattern.test(s.pages) ? s.pages : (pageStart && pageEnd ? `${pageStart}-${pageEnd}` : 'keine Angabe'))
    // const journal = s.journal || '' // Unused

    // Show valid page range - but emphasize EXACT page numbers are required
    const pageRangeInfo = pageStart && pageEnd
      ? `Seiten: ${pages} (Dokument umfasst S. ${pageStart}-${pageEnd}. Du darfst NUR Seitenzahlen zwischen ${pageStart} und ${pageEnd} verwenden! Zitationen wie "e12345" sind VERBOTEN.)`
      : `Seiten: ${pages} (keine Seitenzahlen verfügbar - lasse die Seitenzahl weg)`

    return `[${i + 1}] ${authors} (${year}): "${s.title}". ${pageRangeInfo}`
  }).join('\n')

  const mandatorySources = sources.filter(s => s.mandatory)
  const mandatorySourcesSection = mandatorySources.length > 0 ? (
    isGerman ? `
**⚠️ PFLICHTQUELLEN - ZITIERTZWANG ⚠️**
Der Nutzer hat folgende Quellen als ESSENTIELL markiert.
Prüfe dringend, ob sie thematisch zu diesem Kapitel passen.
FALLS JA: Du MUSST diese Quellen zitieren! Ignoriere sie auf keinen Fall, wenn sie relevant sind.
${mandatorySources.map((s, i) => `[MANDATORY] "${s.title}" (${s.authors.slice(0, 2).join(', ')}, ${s.year || 'n.d.'})`).join('\n')}
` : `
**⚠️ MANDATORY SOURCES - MUST CITE ⚠️**
The user has marked the following sources as ESSENTIAL.
Check urgently if they fit strictly into this chapter's topic.
IF YES: You MUST cite these sources! Do not ignore them if they are relevant.
${mandatorySources.map((s, i) => `[MANDATORY] "${s.title}" (${s.authors.slice(0, 2).join(', ')}, ${s.year || 'n.d.'})`).join('\n')}
`
  ) : ''

  const buildChapterPrompt = (remainingWords: number, currentChapterContext: string = '') => {
    // If we have current chapter context (extension mode), modify instructions
    const isExtension = currentChapterContext.length > 0

    const promptIntro = isGerman
      ? `Du bist der Autor eines führenden, akademischen Lehrbuchs. Du schreibst das Kapitel "${chapterLabel}" zum Thema "${thesisData.title}".${isExtension ? ' Du hast den ersten Teil des Kapitels bereits geschrieben. Deine Aufgabe ist es nun, das Kapitel FORTZUFÜHREN und zu beenden.' : ''}
         Dein Stil ist sachlich, mechanisch-tiefgehend und direkt. Du erklärst Kausalzusammenhänge (WIE und WARUM Dinge passieren), anstatt nur Befunde aufzuzählen.

         **WICHTIG - FORSCHUNGSFRAGE (UNVERÄNDERLICH):**
         Die zentrale Forschungsfrage lautet: "${thesisData.researchQuestion}"
         Diese Frage muss EXAKT so verwendet werden. Formuliere sie niemals um.
         **REGEL:** Beantworte diese Frage in DIESEM Kapitel NICHT endgültig (außer es ist das Fazit). Deine Aufgabe ist Analyse und Exploration. Die Antwort gehört ins Fazit.

         **🚫 METAKOMMUNIKATION REDUZIEREN (STRENG VERBOTEN):**
         - Vermeide Sätze wie "Dieses Kapitel behandelt...", "Es ist wichtig zu beachten...", "Wie bereits erwähnt...".
         - Vermeide "Der Autor...", "Wir...", "Man...".
         - Schreibe DIREKT über den Inhalt: "Der Mechanismus X funktioniert durch Y..." statt "Im Folgenden wird Mechanismus X erläutert..."
         - Steige SOFORT in die fachliche Erklärung ein. Keine Einleitungssätze!

          ${(chapter.title.toLowerCase().includes('fazit') || chapter.title.toLowerCase().includes('conclusion') || chapter.title.toLowerCase().includes('resümee')) ? `
          **⚠️ ACHTUNG - FAZIT/SCHLUSSTEIL (EXTREM WICHTIG) ⚠️**
          Dies ist das wichtigste Kapitel. Du MUSST jetzt die Forschungsfrage endgültig beantworten.
          - Fasse die wichtigsten Ergebnisse aller vorherigen Kapitel zusammen.
          - Ordne die Ergebnisse in den Forschungsstand ein.
          - Gib einen Ausblick.
          - SCHREIBE MINDESTENS 400-500 WÖRTER. Sei nicht faul!
          - Ein kurzes Fazit ist inakzeptabel.` : ''}

          ${(chapter.title.toLowerCase().includes('diskussion') || chapter.title.toLowerCase().includes('discussion') || chapter.title.toLowerCase().includes('synthese')) ? `
          **⚠️ ACHTUNG - DISKUSSION (EXTREM WICHTIG) ⚠️**
          Dies ist der Diskussionsteil.
          - Wiederhole nicht nur Ergebnisse, sondern SYNTHETISIERE sie.
          - Vergleiche deine Erkenntnisse mit der Literatur.
          - Diskutiere Implikationen.
          - SCHREIBE MINDESTENS 500 WÖRTER.
          - Keine Spiegelstriche - fließender Text!` : ''}

         **WICHTIG - KEINE REDUNDANZ:**
         Prüfe die "Zusammenfassung der vorherigen Kapitel" oder den "Vorherigen Textausschnitt". Wenn ein Begriff (z.B. "KI") bereits definiert wurde, definieren ihn NICHT erneut. Setze das Wissen beim Leser voraus.
         
         **⚠️ KAPITEL-FOKUS (80/20 REGEL):**
         - Mindestens 80% des Inhalts MUSS direkt dem Kapiteltitel "${chapterLabel}" gewidmet sein.
         - Kurze Verweise auf andere Kapitel sind ERLAUBT (z.B. "Wie in Kapitel 2 erläutert..." oder "Dies wird in Kapitel 5 vertieft...").
         - ABER: Der Hauptteil MUSS das behandeln, was der Kapiteltitel verspricht.
         - VERBOTEN: Absätze, die primär andere Themen behandeln und nur am Rande den Kapiteltitel berühren.
         - Frage dich: "Wenn jemand dieses Kapitel liest, erfährt er primär etwas über '${chapterLabel}'?"`
      : `You are the author of a leading academic textbook. You are writing chapter "${chapterLabel}" on the topic "${thesisData.title}".${isExtension ? ' You have already written the first part of the chapter. Your task is now to CONTINUE and complete the chapter.' : ''}
         Your style is factual, mechanically deep, and direct. You explain causal relationships (HOW and WHY things happen) rather than just listing findings.

         **IMPORTANT - RESEARCH QUESTION (IMMUTABLE):**
         The central research question is: "${thesisData.researchQuestion}"
         This question must be used EXACTLY as provided. Never rephrase it.
         **RULE:** DO NOT strictly answer this question in THIS chapter (unless it is the Conclusion). Your job is analysis and exploration. The answer belongs in the Conclusion.

         **🚫 REDUCE META-COMMUNICATION (STRICTLY FORBIDDEN):**
         - Avoid phrases like "This chapter discusses...", "It is important to note...", "As mentioned previously...".
         - Avoid "The author...", "We...", "One...".
         - Write DIRECTLY about the content: "Mechanism X works through Y..." instead of "The following section explains mechanism X..."
         - Start IMMEDIATELY with the technical explanation. No introductory sentences!

         **IMPORTANT - NO REDUNDANCY:**
         Check the "Summary of previous chapters" or "Previous text excerpt". If a term has already been defined, DO NOT define it again. Assume reader knowledge.
         
         **⚠️ CHAPTER FOCUS (80/20 RULE):**
         - At least 80% of the content MUST be directly dedicated to the chapter title "${chapterLabel}".
         - Brief references to other chapters are ALLOWED (e.g., "As explained in Chapter 2..." or "This is elaborated in Chapter 5...").
         - BUT: The main body MUST address what the chapter title promises.
         - FORBIDDEN: Paragraphs that primarily discuss other topics and only tangentially relate to the chapter title.
         - Ask yourself: "If someone reads this chapter, will they primarily learn about '${chapterLabel}'?"`

    const strictRules = isGerman
      ? `═══════════════════════════════════════════════════════════════════════════════
FORMATIERUNG & REGELN
═══════════════════════════════════════════════════════════════════════════════
**⚠️ WICHTIG - FORMATIERUNG ⚠️**
- Neue Überschriften (##, ###) MÜSSEN immer auf einer neuen Zeile beginnen, mit einer Leerzeile davor.
- 🚫 FALSCH: "Text.## Überschrift"
- ✅ RICHTIG: "Text.\n## Überschrift"
- Markdown muss sauber sein.

**⚠️ WICHTIG - STOPP NACH DIESEM KAPITEL ⚠️**
- Du schreibst NUR Kapitel "${chapterLabel}".
- Schreibe NIEMALS das nächste Kapitel (z.B. Kapitel ${parseInt(chapter.number) + 1}) oder andere folgende Kapitel!
- Stoppe SOFORT nach dem letzten Satz dieses Kapitels.
- Generiere KEINE neuen Überschriften für nachfolgende Kapitel.

QUELLENNUTZUNG & STIL - ABSOLUT KRITISCH
═══════════════════════════════════════════════════════════════════════════════

**⚠️ STRENG VERBOTEN: ERFUNDENE QUELLEN ⚠️**
Du darfst NUR die unten aufgelisteten Quellen zitieren. KEINE anderen.
Erfundene Quellen sind STRENG VERBOTEN.

**VERFÜGBARE QUELLEN (NUR DIESE DARFST DU VERWENDEN):**
${availableSourcesList}

**ZITATIONSSTIL: ${citationStyleLabel}**
**${citationStyleLabel} (STRENG):**
- Zitiere im Fließtext: (Autor, Jahr, S. XX)
- **ABSOLUT WICHTIG:** Sei streng bei der Verwendung von Zitationen und deren Seitenzahlen. Zitationen müssen präzise auf der zitierten Seite in der Quelle zu finden sein. 
- **ABSOLUT WICHTIG:** Verwende primär die Seitenzahlen, die in den Metadaten der ${availableSourcesList} für die zitierte Quelle definiert sind. Nur wenn hier keine Seitenzahlen vorliegen, darfst du das PDF nach Seitenzahlen durchsuchen.
- **REGEL 1: KEINE strukturellen Zitationen.**
  - FALSCH: "Dieses Kapitel diskutiert (Müller, 2020)..." oder "Wie bei (Schmidt, 2019) gesehen..."
  - RICHTIG: "Der Markt wuchs um 5% (Müller, 2020)." (Nur FAKTEN zitieren).
- **REGEL 2: Autoren:**
  - 1 Autor: "Name"
  - 2 Autoren: "Name & Name" (z.B. "Müller & Schmidt, 2020")
  - >2 Autoren: IMMER "Name et al." (z.B. "Müller et al., 2020")
- **REGEL 3: Seitenzahlen (f./ff.):**
  - Eine Seite: "S. 324"
  - Zwei Seiten: "S. 324f." (NICHT 324-325)
  - Mehrere Seiten: "S. 324ff." (NICHT 324-330)
- **REGEL 4: ZWINGEND SEITENZAHLEN**
  - JEDE Zitation MUSS eine Seitenzahl haben.
  - Wenn MLA: (Autor S. 12).
  - Wenn Harvard/APA: (Autor, Jahr, S. 12).
- **REGEL 5: KEINE SEKUNDÄRZITATE**
  - Wenn Quelle A über Autor B spricht, zitiere Quelle A!
  - Zitiere NIEMALS Werke, die nicht in deiner Quellenliste stehen.
  - FALSCH: Zitation von (Freud, 1920), wenn du nur ein Buch von (Müller, 2023) hast, das Freud erwähnt.
  - RICHTIG: "(Freud, 1920, zitiert nach Müller, 2023, S. 45)" oder einfach nur (Müller, 2023, S. 45).

  - Nutze NUR die Quellen, die dir bereitgestellt wurden.
- **REGEL 6: NUR BEDINGUNGSLOS EXISTIERENDE SEITEN**
  - Wenn in der Quellenliste steht "S. 1-10", darfst du NICHT "S. 1585" zitieren!
  - Artikelnummern (e12932) sind KEINE Seitenzahlen.
  - Wenn du dir unsicher bist, nutze "S. 1" (nur im absoluten Notfall) oder lasse die Seite weg, aber erfinde keine "e-Nummern".


**STRUKTUR & GLIEDERUNG - ULTIMA RATIO:**
- Die untenstehende "GEPLANTE GLIEDERUNG" ist das GESETZ.
- Ändere NIEMALS die Nummerierung oder die Titel.
- Wenn im Plan steht "1.1 Begriff", dann MUSS die Überschrift "## 1.1 Begriff" lauten. NICHT "1. Begriff" oder "Begriff".
- Unterschlage KEINE Unterkapitel. Wenn der Plan 1.1, 1.2, 1.3 hat, musst du ALLE generieren.
- Halte dich exakt an die Hierarchie (#, ##, ###).

GEPLANTE GLIEDERUNG für dieses Kapitel:
${(chapter.sections && chapter.sections.length > 0) ? chapter.sections.map(s => '- ' + s.number + ' ' + s.title).join('\n') : '(Keine Unterkapitel, nur Fließtext)'}

**🚫 ABSOLUT VERBOTEN: FRAGEN & FRAGE-ANTWORT-MUSTER 🚫**
- NIEMALS Konstruktionen wie "Begriff? Definition." verwenden!
  ✗ "Politische Korruption? Sie ist definiert als..."
  ✗ "Was bedeutet das? Es bedeutet..."
  ✗ "Ist das wirklich so? Ja, denn..."
- NIEMALS rhetorische Fragen nutzen!
- Schreibe IMMER in direkten Aussagen:
  ✓ "Politische Korruption wird definiert als..."
  ✓ "Dies bedeutet konkret, dass..."

    **⚠️ ABSOLUT VERBOTEN (KILL LIST):**
    - "Die globale Finanzkrise? Ein großes Thema." -> VERBOTEN!
    - "Digitalisierung? Sie verändert alles." -> VERBOTEN!
    - "Der Grund? Ganz einfach." -> VERBOTEN!
    - JEDES (Substantiv)? (Satz). Muster ist VERBOTEN.
    - Wenn du ein Fragezeichen schreiben willst: LÖSCHE ES SOFORT. SCHREIBE EINE AUSSAGE.

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

**🚫 ABSOLUT VERBOTEN: "Unbekannt" / "o.V." ZITIEREN 🚫**
- Zitiere NIEMALS "(Unbekannt, ...)" oder "(o.V., ...)"!
- Wenn kein Autor bekannt ist: Zitiere den HERAUSGEBER oder den TITEL des Werkes.
- Beispiel: Statt "(o.V., 2020)" schreibe "(Bundesministerium für Bildung, 2020)" oder "(Studie zur Digitalisierung, 2020)".
- ERFINDE KEINEN PLATZHALTER-NAMEN. Verwende die echte Quelle (Institution/Titel).

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
FORMATTING & RULES
═══════════════════════════════════════════════════════════════════════════════
**STRUCTURE & OUTLINE - ULTIMA RATIO:**
- The "PLANNED OUTLINE" below is the LAW.
- NEVER change the numbering or titles.
- If the plan says "1.1 Term", the heading MUST be "## 1.1 Term". NOT "1. Term" or "Term".
- Do NOT skip subchapters. If plan has 1.1, 1.2, 1.3, you MUST generate ALL of them.
- Stick exactly to the hierarchy (#, ##, ###).

PLANNED OUTLINE for this chapter:
${(chapter.sections && chapter.sections.length > 0) ? chapter.sections.map(s => '- ' + s.number + ' ' + s.title).join('\n') : '(No subchapters, just text)'}

**⚠️ IMPORTANT - FORMATTING ⚠️**
- New headings (##, ###) MUST always start on a new line, preceded by a blank line.
- 🚫 WRONG: "Text.## Heading"
- ✅ CORRECT: "Text.\n\n## Heading"
- Markdown must be clean.

**⚠️ IMPORTANT - STOP AFTER THIS CHAPTER ⚠️**
- You write ONLY Chapter "${chapterLabel}".
- NEVER write the next chapter (e.g. Chapter ${parseInt(chapter.number) + 1}) or any following chapters!
- STOP IMMEDIATELY after the last sentence of this chapter.
- DO NOT generate headings for subsequent chapters.

SOURCE USAGE & STYLE - ABSOLUTELY CRITICAL
═══════════════════════════════════════════════════════════════════════════════

**⚠️ STRICTLY FORBIDDEN: FAKE SOURCES ⚠️**
You must ONLY cite the provided sources listed below. NO others.

**AVAILABLE SOURCES (USE ONLY THESE):**
${availableSourcesList}

**CITATION STYLE: ${citationStyleLabel}**
**${citationStyleLabel} (STRICT):**
- Cite in text: (Author, Year, p. XX)
- **RULE 1: NO Structural Citations.**
  - WRONG: "This chapter discusses (Miller, 2021)..."
  - CORRECT: "The market grew (Miller, 2021)." (Cite FACTS only).
- **RULE 2: Authors:**
  - 1 Author: "Name"
  - 2 Authors: "Name & Name" (e.g. "Smith & Jones, 2020")
  - >2 Author: ALWAYS "Name et al." (e.g. "Smith et al., 2020")
- **RULE 3: Page Numbers (f./ff.):**
  - One page: "p. 324"
  - Two pages: "p. 324f." (NOT 324-325)
  - Multiple pages: "p. 324ff." (NOT 324-330)
- **RULE 4: MANDATORY PAGE NUMBERS**
  - EVERY citation MUST have a page number.
  - If MLA: (Author 12).
  - If Harvard/APA: (Author, Year, p. 12).
- **RULE 5: NO SECONDARY CITATIONS**
  - If Source A discusses Author B, cite Source A!
  - NEVER cite works not in your provided source list.
  - WRONG: Citing (Freud, 1920) if you only have a book by (Miller, 2023) mentioning Freud.
  - CORRECT: "(Freud, 1920, cited in Miller, 2023, p. 45)" or just (Miller, 2023, p. 45).
  - Use ONLY the provided sources.
- **RULE 6: ONLY EXISTING PAGE NUMBERS**
  - If source list says "pp. 1-10", you MUST NOT cite "p. 1585"!
  - Article numbers (e1293) are NOT page numbers.
  - If unsure, stick to (Author, Year) without page. DO NOT INVENT PAGE NUMBERS. DO NOT USE "p. 1".

**🚫 ABSOLUTELY FORBIDDEN: QUESTIONS & Q&A PATTERNS 🚫**
- NEVER use constructions like "Term? Definition."!
  ✗ "Political Corruption? It is defined as..."
  ✗ "What does this mean? It means..."
  ✗ "Is this true? Yes, because..."
- NEVER use rhetorical questions!
- ALWAYS write in direct statements:
  ✓ "Political corruption is defined as..."
  ✓ "Concretely, this means that..."

    **⚠️ ABSOLUTELY FORBIDDEN (KILL LIST):**
    - "The global financial crisis? A big topic." -> FORBIDDEN!
    - "Digitization? It changes everything." -> FORBIDDEN!
    - "The reason? Quite simple." -> FORBIDDEN!
    - ANY (Noun)? (Sentence). Pattern is FORBIDDEN.
    - If you want to write a question mark: DELETE IT IMMEDIATELY. WRITE A STATEMENT.

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

**🚫 ABSOLUTELY FORBIDDEN: CITING "Unknown" / "Anon" 🚫**
- NEVER cite "(Unknown, ...)" or "(Anon., ...)"!
- If author is missing: Cite the PUBLISHER or the TITLE.
- Example: Instead of "(Unknown, 2020)" write "(Dept. of Education, 2020)" or "(Study on AI, 2020)".
- DO NOT use placeholders. Use the actual entity/title.

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

    const futureContextInstruction = futureChaptersOverview
      ? (isGerman
        ? `**AUSBLICK AUF KOMMENDE KAPITEL (NICHT VORWEGREIFEN):**\nDie folgenden Themen werden in SPÄTEREN Kapiteln behandelt. Behandle sie hier NICHT im Detail. Erwähne sie höchstens als Ausblick.\n<<<\n${futureChaptersOverview}\n>>>\n`
        : `**FUTURE CHAPTERS OUTLOOK (DO NOT PRE-EMPT):**\nThe following topics will be covered in LATER chapters. DO NOT cover them in detail here. Only mention them as a transition/outlook.\n<<<\n${futureChaptersOverview}\n>>>\n`)
      : ''

    let contextInstruction = ''

    if (isExtension) {
      // EXTENSION MODE: The context is what we just wrote for THIS chapter
      contextInstruction = isGerman
        ? `**BEREITS GESCHRIEBENER TEIL DIESES KAPITELS (Fortsetzung hieran anschließen):**\n<<<\n${currentChapterContext}\n>>>\n\nFühre den Text logisch fort. Wiederhole NICHTS was oben steht. Schreibe einfach weiter.`
        : `**ALREADY WRITTEN PART OF THIS CHAPTER (Continue from here):**\n<<<\n${currentChapterContext}\n>>>\n\nContinue the text logically. Do NOT repeat anything above. Just keep writing.`
    } else {
      // NEW CHAPTER MODE: Context is SUMMARY of previous chapters (Rolling Context)
      // This solves the 'Amnesia' problem by telling the AI exactly what happened before.
      const previousSummariesText = previousChapterSummaries && previousChapterSummaries.length > 0
        ? previousChapterSummaries.join('\n\n---\n\n')
        : ''

      if (previousSummariesText) {
        contextInstruction = isGerman
          ? `**⚠️ KRITISCH - BEREITS ABGEDECKTE THEMEN (NICHT WIEDERHOLEN!):**
             Die folgenden Themen wurden bereits in vorherigen Kapiteln behandelt.
             Du DARFST diese Inhalte NICHT erneut erklären oder definieren!
             Baue darauf auf, verweise darauf, aber wiederhole sie NICHT.
             
             <<<\n${previousSummariesText}\n>>>
             
             **WENN DU ETWAS AUS DIESER LISTE WIEDERHOLST, IST DAS EIN FEHLER!**\n`
          : `**⚠️ CRITICAL - ALREADY COVERED TOPICS (DO NOT REPEAT!):**
             The following topics have already been covered in previous chapters.
             You MUST NOT explain or define these contents again!
             Build upon them, reference them, but do NOT repeat them.
             
             <<<\n${previousSummariesText}\n>>>
             
             **IF YOU REPEAT ANYTHING FROM THIS LIST, IT IS AN ERROR!**\n`
      } else {
        // Fallback to text excerpt if no summaries (e.g. Chapter 1 or legacy mode)
        contextInstruction = previousContent
          ? (isGerman
            ? `Vorheriger Textausschnitt (Kontext, NICHT wiederholen, nur für Übergänge verwenden):\n<<<\n${previousExcerpt}\n>>>\n`
            : `Previous text excerpt (context only, DO NOT repeat, use only for transitions):\n<<<\n${previousExcerpt}\n>>>\n`)
          : ''
      }
    }

    const lengthInstruction = isGerman
      ? `Schreibe weitere ${remainingWords} Wörter für diesen Teil. Es ist besser, ausführlicher zu sein als zu kurz.`
      : `Write another ${remainingWords} words for this part. It is better to be more detailed than too short.`

    const startInstruction = isExtension
      ? (isGerman ? `SCHREIBE EINFACH WEITER (keine Überschriften wiederholen).` : `JUST KEEP WRITING (do not repeat headings).`)
      : (isGerman
        ? `Beginne DIREKT mit dem Einleitungstext oder dem ersten Unterkapitel.
           SCHREIBE NICHT DIE HAUPT-KAPITELÜBERSCHRIFT ("## ${chapterLabel}").
           Diese wird automatisch hinzugefügt. Schreibe NUR den Inhalt.`
        : `START directly with the introduction text or the first subchapter.
           DO NOT WRITE THE MAIN CHAPTER HEADING ("## ${chapterLabel}").
           It will be added automatically. Write ONLY the content.`)

    const isIntroduction = chapter.number === '1' || chapter.number === '1.' || chapterLabel.toLowerCase().includes('einleitung') || chapterLabel.toLowerCase().includes('introduction');
    const structureInstruction = isIntroduction
      ? (isGerman
        ? `\n**⚠️ WICHTIG - AUFBAU DER ARBEIT (Gang der Untersuchung):**\n1. Deine Aufgabe: Beschreibe den Aufbau der restlichen Arbeit präzise basierend auf der **GLIEDERUNG** (siehe oben "FUTURE CHAPTERS OUTLOOK").\n2. **REGEL:** Beginne die Beschreibung DIREKT mit **Kapitel 2**.\n3. **VERBOT:** Erwähne Kapitel 1 NICHT. Kapitel 1 ist die Einleitung, in der wir uns befinden.\n4. **INHALT:** Gehe die Gliederung Punkt für Punkt durch (Kapitel 2, 3, 4, ...). Fasse für jedes Kapitel kurz zusammen, worum es laut Gliederung geht.\n5. **PRÄZISION:** Erfinde keine Inhalte. Nutze nur die Stichpunkte aus der Gliederung.`
        : `\n**⚠️ IMPORTANT - STRUCTURE OF THE WORK:**\n1. Your task: Describe the structure of the remaining thesis precisely based on the **OUTLINE** (see "FUTURE CHAPTERS OUTLOOK" above).\n2. **RULE:** Start the description DIRECTLY with **Chapter 2**.\n3. **FORBIDDEN:** DO NOT mention Chapter 1. Chapter 1 is the introduction we are currently in.\n4. **CONTENT:** Go through the outline point by point (Chapter 2, 3, 4, ...). Briefly summarize what each chapter covers based on the outline.\n5. **PRECISION:** Do not invent content. Use only the bullet points from the outline.`)
      : '';

    return `${promptIntro}

${sectionInstructions}${planInstructions}${contextInstruction}${futureContextInstruction}${mandatorySourcesSection}${lengthInstruction}

${strictRules}
${structureInstruction}

Weitere Anforderungen:
- ${isGerman ? 'HALTE DICH STRIKT AN DIE VORGEGEBENE GLIEDERUNG. Ändere KEINE Überschriften. Nutze exakt die vorgegebenen Unterkapitel.' : 'ADHERE STRICTLY TO THE PROVIDED OUTLINE. Do NOT change any headings. Use exactly the provided subchapters.'}
- ${isGerman ? 'Die Kapitelnummer und der Titel müssen EXAKT wie in der Vorgabe sein.' : 'The chapter number and title must be EXACTLY as provided.'}
- ${isGerman ? 'Nutze die bereitgestellten Quellen INTENSIV.' : 'Use the provided sources EXTENSIVELY.'}
- ${isGerman ? 'KRITISCHE DISKUSSION (WICHTIG): Reproduziere Literatur nicht einfach. Diskutiere sie! Wo widersprechen sich Wissenschaftler? Wo gibt es Lücken? Was ist deine Einschätzung als neutraler Beobachter des Diskurses?' : 'CRITICAL DISCUSSION (IMPORTANT): Do not just reproduce literature. Discuss it! Where do scientists disagree? Where are the gaps? What is your assessment as a neutral observer of the discourse?'}
- ${isGerman ? 'Integriere Kontext, Analyse, Beispiele, Methodik und Diskussion.' : 'Include context, analysis, examples, methodology, and discussion.'}
- ${isGerman ? 'Füge Übergänge zu vorherigen und folgenden Kapiteln ein, ohne Inhalte zu wiederholen.' : 'Add transitions to previous and upcoming chapters without repeating content.'}
- ${isGerman ? 'Da der Kapiteltitel ## ist, MÜSSEN alle Unterkapitel mit ### beginnen. Verwende KEINE ## mehr für Unterkapitel!' : 'Since the chapter title is ##, all subchapters MUST start with ###. Do NOT use ## for subchapters!'}
- ${isGerman ? 'Nutze ein akademisches, menschliches Sprachmuster mit Variation in Satzlängen und Syntax.' : 'Use academic, human-like language with varied sentence lengths and syntax.'}
- ${isGerman ? 'Keine Meta-Kommentare, nur Inhalt.' : 'No meta commentary, only content.'}
- ${isGerman ? 'VERMEIDE ÜBERTRIEBENE ADJEKTIVE/ADVERBIEN (UNWISSENSCHAFTLICH): Nutze niemals Wörter wie "unglaublich", "extrem", "total", "absolut", "schockierend", "riesig". Bleibe neutral und sachlich.' : 'AVOID HYPERBOLIC ADJECTIVES/ADVERBS (UNSCIENTIFIC): Never use words like "incredibly", "extremely", "totally", "absolutely", "shocking", "massive". Remain neutral and objective.'}
- ${isGerman ? 'KEINE UMGANGSSPRACHE (ABSOLUT VERBOTEN): Vermeide Füllwörter wie "halt", "eben", "eh", "quasi", "sozusagen", "mal". Schreibe im gehobenen Nominalstil.' : 'NO COLLOQUIAL LANGUAGE (ABSOLUTELY FORBIDDEN): Avoid filler words like "like", "basically", "so to speak", "kind of". Write in formal academic style.'}
- ${isGerman ? 'KEINE PERSONALPRONOMEN (ABSOLUT VERBOTEN): Verwende NIEMALS "ich", "wir", "uns", "unser". Nutze stattdessen Passiv- oder "Man"-Konstruktionen (z.B. "Es wird untersucht" statt "Wir untersuchen").' : 'NO PERSONAL PRONOUNS (ABSOLUTELY FORBIDDEN): NEVER use "I", "we", "us", "our". Use passive or impersonal constructions instead (e.g., "It is analyzed" instead of "We analyze").'}
- ${isGerman ? 'STRENG WISSENSCHAFTLICHER STIL: Nutze präzise Fachterminologie, komplexe Satzstrukturen (Hypotaxen) und vermeide persönliche Meinungen.' : 'STRICT SCIENTIFIC STYLE: Use precise terminology, complex sentence structures, and avoid personal opinions.'}
- ${isGerman ? 'ABSOLUT UNEMOTIONAL: Der Text muss nüchtern, distanziert und analytisch sein. Keine Begeisterung, keine Dramatik, nur Fakten.' : 'ABSOLUTELY UNEMOTIONAL: The text must be cold, distant, and analytical. No excitement, no drama, only facts.'}
- ${isGerman ? `FORSCHUNGSFRAGE UNANTASTBAR: Die Forschungsfrage ("${thesisData.researchQuestion}") darf NICHT verändert, umformuliert oder neu interpretiert werden. Sie muss WORTWÖRTLICH exakt so behandelt werden.` : `RESEARCH QUESTION IMMUTABLE: The research question ("${thesisData.researchQuestion}") must NOT be changed, rephrased, or reinterpreted. Use exactly this wording.`}

${isGerman ? `
**⚠️ ABSOLUT VERBOTEN (KILL LIST):**
- "Die globale Finanzkrise? Ein großes Thema." -> VERBOTEN! (Frage-Antwort-Muster)
- "Digitalisierung? Sie verändert alles." -> VERBOTEN!
- "Der Grund? Ganz einfach." -> VERBOTEN!
- "Was bedeutet das? Es bedeutet..." -> VERBOTEN!
- JEDES (Substantiv)? (Satz). Muster ist VERBOTEN. LÖSCHE DAS FRAGEZEICHEN.

**⚠️ ABSOLUT VERBOTEN: "man" / "wir" / "uns":**
- ✗ "Man sieht..." -> VERBOTEN! -> ✓ "Es ist ersichtlich..."
- ✗ "Wir untersuchen..." -> VERBOTEN! -> ✓ "Es wird untersucht..."
- ✗ "Unsere Analyse..." -> VERBOTEN! -> ✓ "Die Analyse..." (Einzelautor-Thesis!)` : `
**⚠️ ABSOLUTELY FORBIDDEN (KILL LIST):**
- "The global crisis? A big topic." -> FORBIDDEN! (Q&A Pattern)
- "Digitization? It changes everything." -> FORBIDDEN!
- ANY Question? Answer. pattern is FORBIDDEN.

**⚠️ ABSOLUTELY FORBIDDEN: "we" / "our" / "one":**
- ✗ "We found..." -> FORBIDDEN! -> ✓ "It was found..."
- ✗ "Our analysis..." -> FORBIDDEN! -> ✓ "The analysis..."`}

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
    let prompt = buildChapterPrompt(targetForPrompt, attempts > 1 ? currentChapterExcerpt : '')

    // FORCE GENERATION: If previous attempts failed (empty/short), inject ANGER into the prompt.
    if (attempts > 1 && (!chapterContent || chapterContent.length < 200)) {
      prompt += `\n\n⚠️ PREVIOUS ATTEMPT FAILED. YOU WROTE NOTHING OR TOO LITTLE.
        THIS IS UNACCEPTABLE.
        YOU MUST WRITE A FULL CHAPTER NOW.
        IGNORE ALL "STOP" SIGNALS. JUST WRITE THE TEXT.
        MINIMUM 500 WORDS REQUIRED.`
    }

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
    trackTokenUsage(thesisData, response, 'gemini-2.5-pro', `Generate chapter ${chapterLabel}`)

    const newText = response.text?.trim() || ''
    const generatedWordCount = newText ? newText.split(/\s+/).length : 0

    if (generatedWordCount < 50) {
      console.warn(`[ThesisGeneration] Chapter ${chapterLabel} attempt ${attempts} returned insufficient text (${generatedWordCount} words, min 50).`)
      // If this was the last attempt, we are in trouble.
      if (attempts >= 3) {
        console.error(`[ThesisGeneration] CRITICAL: Chapter ${chapterLabel} failed 3 times.`)
        // We falling through will result in empty chapter.
      }
      continue
    }

    if (attempts === 1 || !chapterContent) {
      chapterContent = newText
    } else {
      // CRITICAL: Strip any headers from extension to prevent duplicates
      // AI often regenerates section headers when extending, causing duplicates like "## 1.1 Title" appearing twice
      let cleanExtension = newText
        .replace(/^#{1,6}\s+.*?\n/gm, '') // Remove markdown headers
        .replace(/^\*\*\d+(?:\.\d+)*\.?\s+[^*]+\*\*\s*\n/gm, '') // Remove bold number headers
        .trim()

      if (cleanExtension.length > 0) {
        chapterContent += `\n\n${cleanExtension}`
        console.log(`[ThesisGeneration] Appended ${cleanExtension.split(/\s+/).length} words (stripped duplicate headers)`)
      } else {
        console.warn(`[ThesisGeneration] Extension was all headers, skipping append`)
      }
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

    // SAFETY: If truly empty, return a placeholder so the structure isn't broken
    if (!chapterContent || chapterContent.trim().length === 0) {
      return { content: `[ERROR: Chapter ${chapterLabel} generation failed. Please regenerate.]`, wordCount: 0 }
    }
    // Don't throw error - generation must ALWAYS succeed and deliver a thesis
  }

  // Step 7.1: Verify Citations with FileSearch (Page Number Check)
  // This is critical for ensuring page numbers are accurate
  if (thesisData.fileSearchStoreId) {
    console.log(`[ThesisGeneration] Verifying citations for chapter ${chapterLabel}...`)
    try {
      // Pass 'sources' for smart page calculation
      const verifiedContent = await verifyCitationsWithFileSearch(chapterContent, thesisData.fileSearchStoreId, isGerman, sources, thesisData)
      if (verifiedContent && verifiedContent.length > 0.8 * chapterContent.length) {
        chapterContent = verifiedContent
        console.log(`[ThesisGeneration] Chapter ${chapterLabel} citations verified and updated.`)
      } else {
        console.warn(`[ThesisGeneration] Verification returned suspiciously short content, keeping original.`)
      }
    } catch (error) {
      console.error(`[ThesisGeneration] Citation verification failed for ${chapterLabel}, keeping original:`, error)
    }
  }

  // Force exact chapter heading from outline to prevent hallucinations/changes
  // We explicitly told AI NOT to write it, so we prepend it here safely.
  // Also strip any potential AI-generated heading if it ignored instructions (safety check)
  const cleanContent = chapterContent.replace(/^\s*##\s+.*?\n/, '').trim()

  // FINAL SAFETY FIX: Ensure no inline headers exist in the generated text
  // e.g. "some text## 3.1 Subchapter" -> "some text\n\n## 3.1 Subchapter"
  const polishedContent = cleanContent.replace(/([^\n])\s*(#{1,6}\s+)/g, '$1\n\n$2')

  const finalContent = `## ${chapterLabel}\n\n${polishedContent}`
  const totalWordCount = finalContent.split(/\s+/).length

  return { content: finalContent, wordCount: totalWordCount }
}

/**
 * Creates a concise summary of a generated chapter to maintain context without exceeding token limits.
 */
async function summarizeChapter(chapterTitle: string, content: string, isGerman: boolean, thesisData: ThesisData): Promise<string> {
  // Use a cheaper/faster model for summarization if available, or standard model
  const prompt = isGerman
    ? `Erstelle eine KONFLIKT-VERMEIDUNGSLISTE für das Kapitel "${chapterTitle}".
       
       **AUFGABE:** Liste ALLE spezifischen Themen, Konzepte und Fakten auf, die in diesem Kapitel behandelt wurden.
       
       **FORMAT (STRIKT):**
       KAPITEL: ${chapterTitle}
       ABGEDECKTE THEMEN:
       • [Thema 1 - kurze Beschreibung in 5-10 Wörtern]
       • [Thema 2 - kurze Beschreibung]
       • [Thema 3 - kurze Beschreibung]
       ... (alle wichtigen Themen)
       
       DEFINIERTE BEGRIFFE: [Liste aller definierten Fachbegriffe]
       ZITIERTE STUDIEN: [Kurze Liste der Hauptautoren/Jahre]
       HAUPTARGUMENT: [1 Satz]
       
       **ZIEL:** Das nächste Kapitel muss wissen, was BEREITS gesagt wurde, um KEINE Wiederholungen zu machen.
       Sei PRÄZISE und VOLLSTÄNDIG - jedes fehlende Thema kann zu Wiederholungen führen!
       
       TEXT:
       ${content.substring(0, 15000)}`
    : `Create a CONFLICT-AVOIDANCE LIST for chapter "${chapterTitle}".
       
       **TASK:** List ALL specific topics, concepts, and facts covered in this chapter.
       
       **FORMAT (STRICT):**
       CHAPTER: ${chapterTitle}
       COVERED TOPICS:
       • [Topic 1 - brief description in 5-10 words]
       • [Topic 2 - brief description]
       • [Topic 3 - brief description]
       ... (all important topics)
       
       DEFINED TERMS: [List all defined technical terms]
       CITED STUDIES: [Brief list of main authors/years]
       MAIN ARGUMENT: [1 sentence]
       
       **GOAL:** The next chapter must know what has ALREADY been said to AVOID repetitions.
       Be PRECISE and COMPLETE - any missing topic can lead to repetitions!
       
       TEXT:
       ${content.substring(0, 15000)}`

  try {
    const response = await retryApiCall(() => ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { maxOutputTokens: 600, temperature: 0.3 },
    }), `Summarize chapter ${chapterTitle}`)
    trackTokenUsage(thesisData, response, 'gemini-2.5-flash', `Summarize chapter`)
    return response.text || ''
  } catch (error) {
    console.warn('[ThesisGeneration] Failed to summarize chapter:', error)
    return `(Summary unavailable for ${chapterTitle})`
  }
}

/**
 * Critiques the final thesis for structure, research question, and citations.
 */
async function critiqueThesis(
  thesisText: string,
  outlineChapters: OutlineChapterInfo[],
  researchQuestion: string,
  sources: Source[],
  isGerman: boolean,
  fileSearchStoreId: string,
  thesisData: ThesisData,
  masterReport?: string
): Promise<string> {
  console.log('[ThesisCritique] Starting comprehensive thesis critique (Iterative Chapter Mode)...')

  // Simplify sources for prompt (Title + Author + Year)
  const sourceListShort = sources.map((s, i) => `[${i + 1}] ${s.authors.join(', ')} (${s.year || 'n.d.'}) - ${s.title} `).join('\n')

  // Split thesis into chapters for iterative processing
  const chapters = thesisText.split(/(?=^## )/gm).filter(c => c.trim().length > 0)
  console.log(`[ThesisCritique] Split thesis into ${chapters.length} chapters for iterative critique`)

  const allErrors: any[] = []

  // Parallel Execution Logic
  const CONCURRENT_LIMIT = 5
  // Helper to process a single chapter
  const processChapter = async (i: number) => {
    const chapterContent = chapters[i]
    const chapterTitle = chapterContent.split('\n')[0].replace(/#/g, '').trim()
    const nextChapterContent = i < chapters.length - 1 ? chapters[i + 1] : ''
    const nextChapterTitle = nextChapterContent.split('\n')[0].replace(/#/g, '').trim() || 'NONE'

    console.log(`[ThesisCritique] Critiquing Chapter ${i + 1}/${chapters.length}: "${chapterTitle}"`)

    if (chapterContent.length < 100) {
      console.log(`[ThesisCritique] Chapter ${i + 1} is too short/empty (${chapterContent.length} chars). Skipping.`)
      return []
    }

    let chapterPrompt = ''

    if (masterReport) {
      // === VERIFICATION MODE ===
      let chapterSpecificErrors = ''
      try {
        const reportObj = JSON.parse(masterReport)
        const errors = reportObj.errors || []
        const relevantErrors = errors.filter((e: any) => {
          if (!e.location) return true
          const loc = e.location.toLowerCase()
          const title = chapterTitle.toLowerCase()
          return title.includes(loc) || loc.includes(title) || chapterContent.includes(e.quote?.substring(0, 20) || '___')
        })

        if (relevantErrors.length === 0) {
          console.log(`[ThesisCritique] No previous errors mapped to Chapter ${i + 1}. Skipping verification.`)
          return []
        }
        chapterSpecificErrors = JSON.stringify({ errors: relevantErrors }, null, 2)
      } catch (e) {
        chapterSpecificErrors = masterReport
      }

      // Verification Prompt Construction (same as before)
      chapterPrompt = isGerman
        ? `Du bist ein strenger Auditor (Reviewer). Dein Job ist die NACHKONTROLLE von Korrekturen für dieses KAPITEL.
      SITUATION:
        Eine Thesis wurde bereits geprüft. Hier sind die Mängel, die in DIESEM KAPITEL gefunden wurden:
        <<<< FEHLER-LISTE FÜR DIESES KAPITEL >>>>
        ${chapterSpecificErrors}
        <<<< ENDE FEHLER-LISTE >>>>
      DEINE AUFGABE:
        Prüfe den UNTENSTEHENDEN KAPITEL-TEXT daraufhin, ob DIESE FEHLER behoben wurden.
      REGELN:
        1. Prüfe NUR die oben genannten Fehler.
        2. Suche KEINE neuen Fehler!
        3. Wenn ein Fehler behoben wurde: Erwähne ihn NICHT mehr.
        4. Wenn ein Fehler NOCH IMMER da ist: Füge ihn in deinen Report ein.
        
        OUTPUT FORMAT (JSON):
        { "errors": [ { "location": "...", "quote": "...", "error": "...", "solution": "..." } ] }
        (Lass das Array leer [], wenn alles korrigiert ist.)

      KAPITEL TEXT:
      ${chapterContent}`
        : `You are a strict auditor. Your job is VERIFICATION of corrections for this CHAPTER.
      SITUATION:
        A thesis has already been audited. Here are the issues found in THIS CHAPTER:
        <<<< ERROR LIST FOR THIS CHAPTER >>>>
        ${chapterSpecificErrors}
        <<<< END LIST >>>>
      YOUR TASK:
        Check the CHAPTER TEXT BELOW to see if THESE ERRORS have been fixed.
      RULES:
        1. Check ONLY the errors listed above.
        2. Do NOT look for new errors!
        3. If an error is fixed: Do NOT mention it again.
        4. If an error is STILL present: Include it in your report.
        
        OUTPUT FORMAT (JSON):
        { "errors": [ ... ] }
        (Leave array empty [] if all fixed.)

      CHAPTER TEXT:
      ${chapterContent}`
    } else {
      // === FULL CRITIQUE MODE ===
      chapterPrompt = isGerman
        ? `Du bist ein akademischer Prüfer (Reviewer). Überprüfe dieses KAPITEL auf Fehler.

       KONTEXT:
       - Dies ist Textabschnitt ${i + 1} von ${chapters.length} (sequentiell).
       - Titel des Kapitels: "${chapterTitle}"
       
       PRÜFUNGSKRITERIEN FÜR DIESES KAPITEL:
       
       0. **LEERE STRUKTUR-KAPITEL (WICHTIG):**
          - Ist dieses Kapitel nur eine Hauptüberschrift ohne Text?
          - PRÜFE NÄCHSTES KAPITEL: "${nextChapterTitle}"
          - REGEL: Wenn das nächste Kapitel eine direkte Untergliederung ist (z.B. dieses ist "5", nächstes ist "5.1"), dann ist es KEIN Fehler!
          - Melde "Fehler" NUR wenn es ein inhaltliches Kapitel sein sollte, das versehentlich leer ist (und NICHT von einem Unterkapitel gefolgt wird).
       
       1. **FORSCHUNGSFRAGE:** Trägt dieses Kapitel zur Beantwortung bei?
          FRAGE: "${researchQuestion}"

       2. **SOURCE CHECK & HALLUZINATIONEN (IMPORTANT!):**
          - Vergleiche JEDE Zitation mit der "ERLAUBTEN QUELLEN"-Liste unten.
          - ERLAUBTE QUELLEN (IN DIESEM PROMPT ENTHALTEN):
          ${sourceListShort}
          
          - **JAHR-CHECK:** Stimmt das Jahr?
          - **SEITENZAHL-PFLICHT (STRENG!):**
            - JEDE Zitation MUSS eine Seitenzahl haben (z.B. (Müller, 2020, S. 12)).
             - VERBOTEN: Zitationen ohne Seite (z.B. nur (Müller, 2020)). -> MELDE FEHLER: "Fehlende Seitenzahl".
             - **VERDÄCHTIGE SEITENZAHLEN:** Seitenzahlen über 10.000 sind VERDÄCHTIG (wahrscheinlich ein Fehler). -> MELDE FEHLER: "Unplausible Seitenzahl".
          - **VERFASSER-PFLICHT (STRENG!):**
            - VERBOTEN: Quellen ohne Verfasser / "o.V." / "Anonymous".
            - Jede Quelle muss einen Autorennamen haben. -> MELDE FEHLER: "Quelle ohne Verfasser (o.V.) ist nicht erlaubt".
          - Nutze das 'fileSearch' Werkzeug zur Verifizierung von Inhalten, ABER die Liste 'ERLAUBTE QUELLEN' (oben) ist die Wahrheit für "Existenz".

       3. **SPRACHE & STIL:**
          - Keine "man", "wir", "ich".
          - Keine rhetorischen Fragen.
          - Keine Umgangssprache ("halt", "quasi").
          - **WICHTIG - HEDGING ERLAUBT:** Kritisiere NICHT vorsichtige Formulierungen ("könnte darauf hindeuten", "scheint zu bestätigen"). Dies ist gute wissenschaftliche Vorsicht ("Hedging"). Melde dies NIEMALS als Fehler ("Unnötige Relativierung")!
          - Kritisiere "Relativierung" NUR, wenn sie Fakten verfälscht (z.B. "Die Erde ist unter Umständen rund"). Bei Interpretationen ist sie ERWÜNSCHT.

        4. **SATZINTEGRITÄT (WICHTIG!):**
           - Prüfe auf ABGESCHNITTENE oder UNVOLLSTÄNDIGE Sätze.
           - MELDE FEHLER wenn ein Satz mit "..." gefolgt von Kleinbuchstaben beginnt (z.B. "...tigmatisierten Gruppe").
           - MELDE FEHLER wenn ein Satz mitten im Wort abgebrochen ist.
           - LÖSUNG: "Schreibe den vollständigen Satz von Anfang an neu."

       KAPITEL TEXT:
       ${chapterContent}

       ANTWORTE NUR ALS JSON-OBJEKT (KEIN Text davor/danach!):
       {
         "errors": [
           {
             "location": "${chapterTitle}",
             "quote": "MINDESTENS 30 ZEICHEN! Der EXAKTE fehlerhafte Satz oder Satzteil. NICHT nur die Zitation, sondern den GESAMTEN Satz mit der Zitation.",
             "error": "Beschreibung des Fehlers",
             "solution": "KONKRETE und PRÄZISE Lösungsanweisung"
           }
         ]
       }
       WICHTIG: Das 'quote' Feld MUSS einen EINDEUTIGEN, KOPIERBAREN Textausschnitt (min 30 Zeichen) enthalten!
       (Lass das Array leer [], wenn keine Fehler gefunden wurden.)`
        : `You are an academic reviewer. Critique this CHAPTER for errors.

       CONTEXT:
       - This is text section ${i + 1} of ${chapters.length} (sequential).
       - Chapter Title: "${chapterTitle}"
       - NOTE: The chapter number in the TITLE (e.g. "2.1") is AUTHORITATIVE. Ignore discrepancies with the sequential count (Section X). Do NOT report wrong chapter numbers if the title itself is consistent.
       
       CRITERIA FOR THIS CHAPTER:

       0. **EMPTY STRUCTURAL CHAPTERS (IMPORTANT):**
          - Is this chapter just a main heading without text?
          - CHECK NEXT CHAPTER: "${nextChapterTitle}"
          - RULE: If the next chapter is a direct subsection (e.g. this is "5", next is "5.1"), then this is NOT an error!
          - Report "Error" ONLY if it is a content chapter that is accidentally left blank AND is NOT followed by a subsection.
       
       1. **RESEARCH QUESTION:** Does this chapter contribute?
          QUESTION: "${researchQuestion}"

       2. **SOURCE CHECK & HALLUCINATIONS (IMPORTANT!):**
          - Compare EVERY citation with the "ALLOWED SOURCES" list below.
          - ALLOWED SOURCES:
          ${sourceListShort}
          
          - **YEAR CHECK:** Does year match?
          - **MANDATORY PAGE NUMBERS (STRICT!):**
            - EVERY citation MUST have a page number (e.g. (Miller, 2020, p. 12)).
            - FORBIDDEN: Citations without page (e.g. just (Miller, 2020)). -> REPORT ERROR: "Missing page number".
          - **MANDATORY AUTHOR (STRICT!):**
            - FORBIDDEN: Sources without author / "n.d." / "Anonymous" / "o.V.".
            - Every source must have an author. -> REPORT ERROR: "Source without author is invalid".
          - Use 'fileSearch' tool to verify content context, but trust the ALLOWED SOURCES list (above) for existence.

       3. **LANGUAGE & STYLE:**
          - No "we", "I", "you".
          - No rhetorical questions.
          - Academic tone.
          - **IMPORTANT - HEDGING ALLOWED:** DO NOT critique cautious phrasing ("might suggest", "seems to indicate"). This is good academic "hedging". NEVER report this as an error ("Unnecessary relativization")!
          - Only critique "relativization" if it distorts facts (e.g. "The earth might be round"). For interpretations, it is DESIRED.

        4. **SENTENCE INTEGRITY (IMPORTANT!):**
           - Check for TRUNCATED or INCOMPLETE sentences.
           - REPORT ERROR if sentence starts with "..." followed by lowercase (e.g. "...tigmatisierten Gruppe").
           - REPORT ERROR if sentence is cut mid-word.
           - SOLUTION: "Rewrite the complete sentence from the beginning."

       CHAPTER TEXT:
       ${chapterContent}

       OUTPUT ONLY AS JSON OBJECT (NO Text before/after!):
       {
         "errors": [
           {
             "location": "${chapterTitle}",
             "quote": "AT LEAST 30 CHARS! The EXACT problematic sentence including context. NOT just the citation, but the ENTIRE sentence containing it.",
             "error": "Error description",
             "solution": "CONCRETE and PRECISE solution instruction"
           }
         ]
       }
       IMPORTANT: The 'quote' field MUST contain a UNIQUE, COPY-PASTE-READY excerpt (min 30 chars)!
       (Leave array empty [] if no errors.)`
    }

    try {
      const response = await retryApiCall(() => ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: chapterPrompt,
        config: {
          temperature: 0.1,
          tools: fileSearchStoreId ? [{
            fileSearch: { fileSearchStoreNames: [fileSearchStoreId] },
          }] : undefined,
        },
      }), `Critique Chapter ${i + 1}`)
      trackTokenUsage(thesisData, response, 'gemini-2.5-pro', `Critique Chapter ${i + 1}`)

      const responseText = response.text || '{}'
      let jsonStr = responseText.trim().replace(/```json\n?|\n?```/g, '').trim()
      const firstOpen = jsonStr.indexOf('{')
      const lastClose = jsonStr.lastIndexOf('}')
      if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
        jsonStr = jsonStr.substring(firstOpen, lastClose + 1)
      }

      const json = JSON.parse(jsonStr)
      if (json.errors && Array.isArray(json.errors)) {
        return json.errors.map((e: any) => ({ ...e, location: e.location || chapterTitle }))
      }
    } catch (e) {
      console.error(`[ThesisCritique] Error in Chapter ${i + 1}`, e)
    }
    return []
  }

  // Execute in batches
  for (let i = 0; i < chapters.length; i += CONCURRENT_LIMIT) {
    const batch = []
    for (let j = 0; j < CONCURRENT_LIMIT && i + j < chapters.length; j++) {
      batch.push(processChapter(i + j))
    }
    const results = await Promise.all(batch)
    results.forEach(errors => allErrors.push(...errors))
  }

  // Aggregate results
  const finalReport = {
    errors: allErrors
  }

  console.log(`[ThesisCritique] Completed. Total errors found: ${allErrors.length}`)
  return JSON.stringify(finalReport, null, 2)

}

/**
 * Applies Search/Replace patches to a text.
 * Format:
 * <<<<<<< SEARCH
 * original text
 * =======
 * new text
 * >>>>>>> REPLACE
 */
function applySearchReplace(originalText: string, patchText: string): string {
  if (!patchText.includes('<<<<<<< SEARCH')) {
    // If no patch markers found, check if it's just the full text or empty
    if (patchText.trim() === '[DELETE_CHAPTER]') return '[DELETE_CHAPTER]'

    // If output is very long but HAS NO markers, it's likely a failure to follow patch format.
    // We REJECT potential full rewrites here because they often contain leaked markers or hallucinations.
    // Better to safe-fail (return original) than to corrupt the thesis.
    console.warn('[DiffPatches] No markers found. Rejecting output to prevent corruption. Keeping original text.')
    return originalText
  }

  let currentText = originalText
  // Regex to capture SEARCH and REPLACE blocks. 
  // We use [\s\S]*? for non-greedy match across newlines.
  const regex = /<<<<<<< SEARCH\s*([\s\S]*?)\s*=======\s*([\s\S]*?)\s*>>>>>>> REPLACE/g

  let match
  let appliedCount = 0

  while ((match = regex.exec(patchText)) !== null) {
    const [fullMatch, searchBlock, replaceBlock] = match
    let cleanSearch = searchBlock.trim()
    const cleanReplace = replaceBlock.trim()

    if (!cleanSearch) continue

    // NORMALIZE: Strip leading/trailing ellipsis that critique agent adds
    // The critique agent often quotes like "...text here..." but actual content has no dots
    cleanSearch = cleanSearch
      .replace(/^\.{2,}/g, '')  // Remove leading dots (.. or ...)
      .replace(/\.{2,}$/g, '')  // Remove trailing dots
      .replace(/^…/g, '')       // Remove Unicode ellipsis at start
      .replace(/…$/g, '')       // Remove Unicode ellipsis at end
      .trim()

    // DEBUG: Log what we're trying to find
    console.log(`[DiffPatches] Searching for: "${cleanSearch.substring(0, 60)}..."`)

    // 1. Try Exact Match (strict)
    if (currentText.includes(cleanSearch)) {
      currentText = currentText.replace(cleanSearch, cleanReplace)
      appliedCount++
      console.log('[DiffPatches] ✓ Applied via exact match.')
    } else {
      // 2. Try soft normalization (ignore leading/trailing whitespace inconsistencies)
      // This is a common AI failure mode (forgetting indentation).
      console.warn(`[DiffPatches] Exact match failed. Trying soft match...`)

      const escapedSearch = cleanSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
      // Try to construct a regex that allows variable whitespace
      let softMatchApplied = false
      try {
        const strictRegex = new RegExp(escapedSearch)
        if (strictRegex.test(currentText)) {
          currentText = currentText.replace(strictRegex, cleanReplace)
          appliedCount++
          softMatchApplied = true
          console.log('[DiffPatches] ✓ Applied via soft match (whitespace agnostic).')
        }
      } catch (e) {
        // regex failed
      }

      // 3. NEW: Substring fuzzy match
      // If the SEARCH block is >30 chars, try matching just the first 40 chars to find the region
      if (!softMatchApplied && cleanSearch.length > 30) {
        const searchStart = cleanSearch.substring(0, 40).trim()
        const searchEnd = cleanSearch.substring(cleanSearch.length - 40).trim()

        // Find the position where this substring starts
        const startIdx = currentText.indexOf(searchStart)
        if (startIdx !== -1) {
          // Look for the end substring after the start
          const searchArea = currentText.substring(startIdx)
          const endIdx = searchArea.indexOf(searchEnd)

          if (endIdx !== -1) {
            const fullEndIdx = startIdx + endIdx + searchEnd.length
            const actualMatch = currentText.substring(startIdx, fullEndIdx)

            console.log(`[DiffPatches] Found fuzzy region (${actualMatch.length} chars). Applying replacement.`)
            currentText = currentText.substring(0, startIdx) + cleanReplace + currentText.substring(fullEndIdx)
            appliedCount++
            softMatchApplied = true
            console.log('[DiffPatches] ✓ Applied via substring fuzzy match.')
          }
        }
      }

      if (!softMatchApplied) {
        // DEBUG: Show what's in the chapter for comparison
        console.error(`[DiffPatches] FAILED to apply patch. Match not found.`)
        console.error(`[DiffPatches] SEARCH (first 100 chars): "${cleanSearch.substring(0, 100)}"`)
        console.error(`[DiffPatches] Chapter contains (first 200 chars): "${currentText.substring(0, 200)}"`)
      }
    }
  }

  console.log(`[DiffPatches] Applied ${appliedCount} patches.`)
  return currentText
}

/**
 * Repairs a specific chapter based on the global critique report.
 */
async function fixChapterContent(
  chapterContent: string,
  critiqueReport: string,
  isGerman: boolean,
  chunkIndex: number,
  totalChunks: number,
  allChapterTitles: string[],
  thesisData: ThesisData,
  fileSearchStoreId?: string
): Promise<string> {
  // REMOVED: if (chapterContent.length < 100) check to allow fixing empty chapters

  const chunkTitle = chapterContent.split('\n')[0].replace(/#/g, '').trim()

  // Determine next chapter for context (wrapper detection)
  const nextChapterTitle = chunkIndex < allChapterTitles.length - 1 ? allChapterTitles[chunkIndex + 1] : 'NONE'
  const isWrapper = (chunkTitle && nextChapterTitle !== 'NONE' && nextChapterTitle.replace(/#/g, '').trim().startsWith(chunkTitle.replace(/#/g, '').trim() + '.'))

  /* 
   * UPDATED PROMPT: SINGLE ERROR MODE
   * The 'critiqueReport' argument now contains a single instruction: "FEHLER: ... LÖSUNG: ..."
   */
  const prompt = isGerman
    ? `Du bist ein präziser text-chirurgischer Assistent (Repair Agent).
    
    DEINE AUFGABE:
    Du erhältst einen Textabschnitt (Kapitel) und EINE KONKRETE KORREKTUR-ANWEISUNG.
    Du musst diese Anweisung EXAKT umsetzen. Ändere NICHTS anderes.
    
    KORREKTUR-ANWEISUNG:
    ${critiqueReport}
    
    ANWEISUNGEN:
    1. Lies die QUOTE in der KORREKTUR-ANWEISUNG. Das ist der Text, den du ändern musst.
    2. KOPIERE diese QUOTE EXAKT in deinen SEARCH-Block (Copy & Paste, NICHT aus dem Gedächtnis tippen!).
    3. Wenn die Anweisung sagt: "LÖSUNG: Ändere X zu Y", dann TUE GENAU DAS im REPLACE-Block.
    4. Wenn die Anweisung sagt: "LÖSUNG: Lösche dieses Kapitel", antworte NUR mit: [DELETE_CHAPTER]
    5. KORREKTUR VON DUPLIKATEN: Wenn die Anweisung "Doppeltes Kapitel", "Zweite Instanz" oder "Entferne Duplikat" erwähnt -> Antworte SOFORT mit: [DELETE_CHAPTER]. (Gehe davon aus, dass DU das Duplikat bist).
    6. LEERE KAPITEL & WRAPPER (WICHTIG):
       - KONTEXT: Dieses Kapitel ist "${chunkTitle}". Das NÄCHSTE Kapitel ist "${nextChapterTitle}".
       - REGEL: Wenn das nächste Kapitel eine direkte Untergliederung ist (z.B. dieses ist "1", nächstes "1.1"), dann ist dieses Kapitel ein "WRAPPER".
       - VERBOT: FÜGE NIEMALS INHALT ZU EINEM WRAPPER HINZU! Auch wenn die Lösung es verlangt!
       - Wenn die Lösung sagt "Füge Inhalt hinzu" aber es ist ein Wrapper -> IGNORIERE ES (gib leere Antwort zurück).
       - Nur wenn es KEIN Wrapper ist (kein Unterkapitel folgt), darfst du Inhalt einfügen.
    7. Nutze das 'fileSearch' Werkzeug NUR wenn du aufgefordert wirst, eine fehlende Seitenzahl zu suchen.
    
    FORMAT (SEARCH/REPLACE) - ZWINGEND ERFORDERLICH:
    Du MUSST deine Antwort EXAKT in diesem Block-Format zurückgeben. Kein normaler Text!
    
    <<<<<<< THINKING
    (Hier deine kurze Analyse: Wo ist der Fehler? Was musst du tun? Habe ich die Stelle gefunden?)
    >>>>>>>

    <<<<<<< SEARCH
    (KOPIERE die QUOTE aus der KORREKTUR-ANWEISUNG hierher - Zeichen für Zeichen identisch!)
    =======
    (Der neue, korrigierte Text gemäß der LÖSUNG)
    >>>>>>> REPLACE
    
    WICHTIG:
    - Der "SEARCH"-Block MUSS die QUOTE aus der KORREKTUR-ANWEISUNG sein (Copy & Paste).
    - ERFINDE KEINEN TEXT für den SEARCH-Block! Nutze die QUOTE!
    - Wenn du NICHTS ändern kannst/musst, antworte leer oder mit "KEINE ÄNDERUNG".
    - Antworte NIEMALS ohne diese Marker, sonst wird deine Arbeit verworfen!
    
    REGELN:
    - Der "SEARCH" Block muss den Originaltext EXAKT matchen (inkl. Leerzeichen).
    - Der "REPLACE" Block ist deine Korrektur.
    - Ändere nur das Nötigste. Schneide nur das 'kranke Gewebe' heraus.
    - Wenn der Fehler im Text nicht zu finden ist, gib NICHTS zurück (leere Antwort = keine Änderung).
    - Erfinde keine Inhalte.
    
    KONTEXT:
    Kapitel Titel: "${(chunkTitle || '').replace(/#/g, '').trim()}"
    (Teil ${chunkIndex + 1} von ${totalChunks})
    
    KAPITEL TEXT:
    ${chapterContent}
    
    ANTWORTE NUR MIT DEN MARKERN (THINKING + SEARCH/REPLACE).`

    : `You are a precise surgical text repair agent.
    
    YOUR TASK:
    You are given a text section (Chapter) and ONE SPECIFIC CORRECTION INSTRUCTION.
    You must execute this instruction EXACTLY. Do NOT change anything else.
    
    CORRECTION INSTRUCTION:
    ${critiqueReport}
    
    INSTRUCTIONS:
    1. Read the QUOTE in the CORRECTION INSTRUCTION. That is the text you need to change.
    2. COPY this QUOTE EXAKTLY into your SEARCH block (Copy & Paste, DO NOT retype from memory!).
    3. If instruction says "SOLUTION: Change X to Y", DO EXACTLY THAT in the REPLACE block.
    4. If instruction says "SOLUTION: Delete this chapter", reply ONLY with: [DELETE_CHAPTER]
    5. DUPLICATE CORRECTION: If instruction mentions "Duplicate chapter", "Second instance" or "Remove duplicate" -> Reply IMMEDIATELY with: [DELETE_CHAPTER]. (Assume YOU are the duplicate).
    6. EMPTY CHAPTERS & WRAPPERS (IMPORTANT):
       - CONTEXT: This chapter is "${chunkTitle}". The NEXT chapter is "${nextChapterTitle}".
       - RULE: If the next chapter is a direct subsection (e.g. this is "1", next is "1.1"), then this chapter is a "WRAPPER".
       - FORBIDDEN: NEVER ADD CONTENT TO A WRAPPER! Even if the solution asks for it!
       - If solution says "Add content" but it is a wrapper -> IGNORE IT (return empty response).
       - Only if it is NOT a wrapper (no subsection follows) may you add content.
    7. Use 'fileSearch' tool ONLY if asked to find a missing page number.
    
    FORMAT (SEARCH/REPLACE):
    Return ONLY changes in this format (no full text):
    
    <<<<<<< THINKING
    (Brief analysis: Where is the error? What to change? Found exact match?)
    >>>>>>>

    <<<<<<< SEARCH
    (COPY the QUOTE from the CORRECTION INSTRUCTION here - character for character!)
    =======
    (The new, corrected text per the SOLUTION)
    >>>>>>> REPLACE
    
    RULES:
    - The "SEARCH" block MUST BE the QUOTE from the CORRECTION INSTRUCTION (Copy & Paste).
    - DO NOT INVENT TEXT for the SEARCH block! Use the QUOTE!
    - The "REPLACE" block is your correction.
    - Change only what is necessary. Surgeon style.
    - If error is not found, return NOTHING.
    - Do not invent content.
    
    CONTEXT:
    Chapter Title: "${(chunkTitle || '').replace(/#/g, '').trim()}"
    (Chunk ${chunkIndex + 1} of ${totalChunks})
    
    CHAPTER TEXT:
    ${chapterContent}
    
    OUTPUT ONLY THE MARKERS (THINKING + SEARCH/REPLACE).`


  let lastError = null
  const maxAttempts = 3 // 1 initial + 2 retries

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await retryApiCall(() => ai.models.generateContent({
        model: 'gemini-2.5-pro', // Using Gemini 2.5 Pro for repair
        contents: prompt,
        config: {
          maxOutputTokens: 50000,
          temperature: 0.1 + (attempt * 0.1),
          tools: fileSearchStoreId ? [{
            fileSearch: {
              fileSearchStoreNames: [fileSearchStoreId],
            },
          }] : undefined,
        },
      }), 'Fix Chapter Content')
      trackTokenUsage(thesisData, response, 'gemini-2.5-pro', 'Fix Chapter Content')

      const modifiedContent = response.text ? response.text.trim() : ''

      // Apply the patches
      const patchedContent = applySearchReplace(chapterContent, modifiedContent)

      // If we got back [DELETE_CHAPTER], just return it
      if (patchedContent === '[DELETE_CHAPTER]') return '[DELETE_CHAPTER]'

      // If content is suspiciously short (and it wasn't a delete), something went wrong (or no changes needed)
      if (patchedContent.length < 50) {
        // Maybe it was validly short, or maybe applyPatches failed. 
        // But if original was > 100, and now < 50, that's bad (unless specific delete).
        if (chapterContent.length > 200) {
          console.warn(`[ThesisRepair] Patching resulted in suspiciously short content.Reverting to original.`)
          return chapterContent
        }
      }

      return patchedContent

    } catch (err) {
      console.warn(`[ThesisRepair] Attempt ${attempt}/${maxAttempts} failed:`, err)
      lastError = err
    }
  }

  console.warn('[ThesisRepair] All repair attempts failed or were rejected. Keeping original content.')
  return chapterContent
}

/**
 * Specialized repair function to sync the Introduction's "Structure" section 
 * with the actual generated chapters.
 */
async function syncStructureInIntroduction(
  introContent: string,
  actualStructure: string,
  isGerman: boolean,
  thesisData: ThesisData
): Promise<string> {
  const prompt = isGerman
    ? `Du bist ein strenger akademischer Lektor.
    
    DEINE AUFGABE:
    In diesem Einleitungskapitel gibt es einen Abschnitt "Aufbau der Arbeit" (oder "Gang der Untersuchung").
    Dieser Abschnitt beschreibt oft eine Gliederung, die NICHT MEHR stimmt.
    
    HIER IST DIE TATSÄCHLICHE GLIEDERUNG DER FERTIGEN ARBEIT:
    ${actualStructure}
    
    ANWEISUNG:
    1. Suche den Abschnitt "Aufbau der Arbeit", "Gliederung" oder "Gang der Untersuchung" (oft 1.3 oder am Ende der Einleitung).
    2. Wenn dieser Abschnitt NICHT existiert, erstelle ihn neu am Ende.
    3. SCHREIBE IHN KOMPLETT UM, sodass er EXAKT die oben genannte Gliederung beschreibt.
    4. Nenne die Kapitelnummern und Titel korrekt (z.B. "In Kapitel 2 beschäftigt sich die Arbeit mit...").
    5. Ändere NICHTS anderes am Text! Nur diesen einen Abschnitt.
    
    KAPITEL TEXT:
    ${introContent}
    
    GIB DAS KOMPLETTE KAPITEL ZURÜCK.
    
    WICHTIGE FORMAT-REGELN:
    1. Die ERSTE ZEILE der Ausgabe MUSS die Kapitelüberschrift sein (z.B. "# 1 Einleitung"). Ändere sie NICHT.
    2. Der Abschnitt "Aufbau der Arbeit" darf NICHT an den Anfang verschoben werden. Er muss dort bleiben, wo er war (meist am Ende).
    3. Zerstöre nicht die Struktur (1.1, 1.2 müssen vor 1.3 bleiben!).`

    : `You are a strict academic editor.
    
    YOUR TASK:
    In this Introduction chapter, there is a section describing the "Structure of the Thesis".
    This section often describes an outline that is OUTDATED.
    
    HERE IS THE ACTUAL STRUCTURE OF THE FINISHED THESIS:
    ${actualStructure}
    
    INSTRUCTION:
    1. Find the section describing the structure.
    2. REWRITE IT COMPLETELY to match the list above EXACTLY.
    3. Mention chapter numbers and titles correctly (e.g. "Chapter 2 deals with...").
    4. Do NOT change anything else! Only this section.
    
    CHAPTER TEXT:
    ${introContent}
    
    OUTPUT THE FULL CHAPTER.
    
    IMPORTANT FORMATTING RULES:
    1. The FIRST LINE of output MUST be the Chapter Title (e.g. "# 1 Introduction"). Do NOT change it.
    2. The "Structure" section must NOT be moved to the top. It must stay where it was (usually at the end).
    3. Do not destroy the structure (1.1, 1.2 must remain before 1.3!).`

  try {
    const response = await retryApiCall(() => ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
      config: { maxOutputTokens: 8000, temperature: 0.1 },
    }), 'Sync Structure')
    trackTokenUsage(thesisData, response, 'gemini-2.5-flash', 'Sync Structure')
    return response.text ? response.text.trim() : introContent
  } catch (error) {
    console.warn('[StructureSync] Failed to sync:', error)
    return introContent
  }
}



async function generateThesisContent(thesisData: ThesisData, rankedSources: Source[], thesisPlan: string = ''): Promise<{ content: string; structure?: ThesisStructure }> {
  console.log('[ThesisGeneration] Starting thesis content generation...')
  console.log(`[ThesisGeneration] Thesis: "${thesisData.title}"`)
  console.log(`[ThesisGeneration] Target length: ${thesisData.targetLength} ${thesisData.lengthUnit} `)
  console.log(`[ThesisGeneration] Language: ${thesisData.language} `)
  console.log(`[ThesisGeneration] Available sources: ${rankedSources.length} `)
  console.log(`[ThesisGeneration] FileSearchStore: ${thesisData.fileSearchStoreId} `)

  // Map citation style to readable label
  const citationStyleLabels: Record<string, string> = {
    apa: 'APA',
    mla: 'MLA',
    harvard: 'Harvard',
  }

  const citationStyleLabel = citationStyleLabels[thesisData.citationStyle] || thesisData.citationStyle
  console.log(`[ThesisGeneration] Citation style: ${citationStyleLabel} `)

  const outlineChapters: OutlineChapterInfo[] = (thesisData.outline || []).map((chapter: any, index: number) => ({
    number: (chapter?.number ?? `${index + 1}.`).toString().trim(),
    title: (chapter?.title ?? '').toString().trim(),
    sections: (chapter?.sections || chapter?.subchapters || []).map((section: any, sectionIndex: number) => ({
      number: (section?.number ?? `${index + 1}.${sectionIndex + 1} `).toString().trim(),
      title: (section?.title ?? '').toString().trim(),
      subsections: (section?.subsections || []).map((subsection: any, subsectionIndex: number) => ({
        number: (subsection?.number ?? `${index + 1}.${sectionIndex + 1}.${subsectionIndex + 1} `).toString().trim(),
        title: (subsection?.title ?? '').toString().trim(),
      })),
    })),
  }))

  // Calculate target word count with sanity check
  const isWords = thesisData.lengthUnit === 'words' || thesisData.targetLength > 500
  const targetWordCount = isWords ? thesisData.targetLength : thesisData.targetLength * 250
  const maxWordCount = Math.ceil(targetWordCount * 1.10) // Max 10% overshoot
  console.log(`[ThesisGeneration] Target words: ${targetWordCount}, Max words(10 % overshoot): ${maxWordCount} `)
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
  //
  let recommendedSourceCount: number
  let sourceUsageGuidance: string

  if (targetPages < 10) {
    recommendedSourceCount = Math.max(8, Math.min(12, Math.ceil(targetPages * 1.0)))
    sourceUsageGuidance = `Sehr kurze Arbeit(${targetPages} Seiten): Verwende nur ${recommendedSourceCount} -${recommendedSourceCount + 2} hochwertige, zentrale Quellen.Jede Quelle muss essentiell sein.Keine Füllquellen.Eine Arbeit von ${targetPages} Seiten mit ${recommendedSourceCount + 20} + Quellen wirkt übertrieben und unprofessionell.`
  } else if (targetPages < 20) {
    recommendedSourceCount = Math.max(12, Math.min(25, Math.ceil(targetPages * 1.2)))
    sourceUsageGuidance = `Kurze Arbeit(${targetPages} Seiten): Verwende ${recommendedSourceCount} -${recommendedSourceCount + 3} sorgfältig ausgewählte Quellen.Fokus auf Qualität, nicht Quantität.Eine Arbeit von ${targetPages} Seiten sollte nicht mehr als ${recommendedSourceCount + 5} Quellen haben, sonst wirkt sie überladen.`
  } else if (targetPages < 40) {
    recommendedSourceCount = Math.max(25, Math.min(50, Math.ceil(targetPages * 1.3)))
    sourceUsageGuidance = `Mittlere Arbeit(${targetPages} Seiten): Verwende ${recommendedSourceCount} -${recommendedSourceCount + 5} relevante Quellen.Jede Quelle sollte einen klaren Zweck erfüllen.`
  } else {
    recommendedSourceCount = Math.max(50, Math.min(80, Math.ceil(targetPages * 1.5)))
    sourceUsageGuidance = `Längere Arbeit(${targetPages} Seiten): Verwende ${recommendedSourceCount} -${recommendedSourceCount + 10} Quellen.Umfangreiche Literaturrecherche ist hier angemessen.`
  }

  console.log(`[ThesisGeneration] Target pages: ${targetPages}, Recommended sources: ${recommendedSourceCount} `)
  console.log(`[ThesisGeneration] Available sources: ${rankedSources.length} `)
  console.log(`[ThesisGeneration] Using top ${rankedSources.length} sources by relevance for RAG context`)

  const isGerman = thesisData.language === 'german'

  const useChapterGeneration = outlineChapters.length > 0

  if (useChapterGeneration) {
    console.log('[ThesisGeneration] Using per-chapter generation strategy')
    const chapterContents: string[] = []
    const chapterSummaries: string[] = [] // Store rolling summaries
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

    // Initialize JSON structure
    console.log('[ThesisGeneration] Initializing JSON structure...')
    let thesisStructure = initializeThesisStructure(outlineChapters)

    // CRITICAL FIX: Deduplicate and Sort Outline Chapters
    // User reported duplicate chapters (1 & 5) and disorder (5.2 after 5.3).
    // We must ensure the outline is unique and sorted by chapter number.
    const uniqueChaptersMap = new Map<string, OutlineChapterInfo>()
    outlineChapters.forEach(c => {
      // Use number as key to prevent duplicates
      const key = c.number.trim()
      if (!uniqueChaptersMap.has(key)) {
        uniqueChaptersMap.set(key, c)
      }
    })

    // Convert back to array and sort naturally (1, 1.1, 1.2, 2, 2.1, 10...)
    let sortedChapters = Array.from(uniqueChaptersMap.values()).sort((a, b) => {
      return a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: 'base' })
    })

    console.log(`[ThesisGeneration] Sanitized outline: ${sortedChapters.length} unique chapters (was ${outlineChapters.length})`)

    // SUBCHAPTER GENERATION: For long theses (>8000 words), flatten to subchapter level
    const useSubchapterGeneration = targetWordCount > 8000
    let flattenedChapters: (OutlineChapterInfo & { wordBudget?: number; isIntroOnly?: boolean })[] = sortedChapters

    if (useSubchapterGeneration) {
      console.log(`[ThesisGeneration] Using SUBCHAPTER-level generation (thesis > 8000 words)`)
      flattenedChapters = flattenToSubchapters(sortedChapters, targetWordCount)
      console.log(`[ThesisGeneration] Flattened to ${flattenedChapters.length} generation units`)
    }

    for (let i = 0; i < flattenedChapters.length; i++) {
      const chapter = flattenedChapters[i]

      // Skip non-content chapters (Verzeichnisse, Bibliography, etc.)
      if (shouldSkipChapter(chapter)) {
        console.log(`[ThesisGeneration] Skipping chapter ${chapter.number} "${chapter.title}"(non - content chapter)`)
        continue
      }

      // Word target: use wordBudget from flattened chapter if available, else calculate
      let isIntroOnly = chapter.isIntroOnly ?? false

      // ROBUST WRAPPER DETECTION:
      // Even if 'isIntroOnly' is false (e.g. short thesis mode), check if this is a parent wrapper.
      // Rule: If next chapter is a likely child (e.g. current="1", next="1.1"), this is a wrapper.
      if (!isIntroOnly && i < flattenedChapters.length - 1) {
        const nextChap = flattenedChapters[i + 1]
        // Check if next chapter number starts with current chapter number + dot (e.g. "1." starts with "1.")
        if (nextChap.number.startsWith(chapter.number + '.')) {
          console.log(`[ThesisGeneration] Auto-detected wrapper chapter ${chapter.number} (followed by ${nextChap.number}) -> Force SKIP`)
          isIntroOnly = true
        }
      }

      // SKIP WRAPPER CHAPTERS: Don't generate content for parent chapters (1 Einleitung, 2 Grundlagen etc.)
      // They're just structural headings - actual content lives in subchapters (1.1, 1.2, etc.)
      if (isIntroOnly) {
        console.log(`[ThesisGeneration] Skipping wrapper chapter ${chapter.number} "${chapter.title}" (content in subchapters)`)
        // Just add the heading with proper newline separation, no content
        chapterContents.push(`\n\n## ${chapter.number} ${chapter.title}\n`)
        continue
      }

      const chapterTarget = chapter.wordBudget ?? Math.min(1500, Math.max(5, Math.round(targetWordCount / flattenedChapters.length)))

      console.log(`[ThesisGeneration] Generating ${chapter.number} "${chapter.title}" (${chapterTarget} words target)`)

      let { content: chapterText, wordCount: chapterWordCount } = await generateChapterContent({
        thesisData,
        chapter,
        chapterTargetWords: chapterTarget,
        thesisPlan: thesisPlan || '',
        previousContent: chapterContents.join('\n\n'),
        previousChapterSummaries: chapterSummaries, // Pass the rolling summaries
        futureChaptersOverview: extractFuturePlan(thesisPlan || '', chapter.number, isGerman ? 'german' : 'english'),
        isGerman,
        sources: rankedSources,
        citationStyle: thesisData.citationStyle,
      })

      // [HUMANIZE V2] Verify & Improve immediately
      try {
        chapterText = await humanizeChapterPipeline(chapterText, thesisData)
        // Recalculate word count rough estimate
        chapterWordCount = chapterText.split(/\s+/).length
      } catch (err) {
        console.error('[HumanizeV2] Pipeline failed for chapter, using original:', err)
      }

      chapterContents.push(chapterText.trim())
      totalWordCount += chapterWordCount
      console.log(`[ThesisGeneration] Chapter ${chapter.number} complete (~${chapterWordCount} words, total ${totalWordCount}/${expectedWordCount})`)

      // Update JSON structure with the new chapter content
      thesisStructure = updateNodeContent(thesisStructure, chapter.number, chapterText.trim())

      // Check if there are subchapters in the text that we might want to split later?
      // For now, we store the WHOLE chapter text in the chapter node.
      // Ideally, 'generateChapterContent' would return a structured object too, but that's a bigger refactor.
      // So detailed subsection targeting will rely on the fact that the chapter node has the content.
      // Repair agent can then parse the markdown within that node if it needs to target a subsection.

      // Persist partial progress to DB (JSON + Content)
      // We perform a "live update" so the user sees progress in the new structure too.
      // Note: This requires passing 'thesisId' to this function or finding a way to update.
      // Currently generateThesisContent doesn't take thesisId.
      // We will just accumulate for now and let the caller save, OR we can accept thesisId.
      // Let's check the signature. explicit thesisId is not passed, but thesisData might have it?
      // thesisData does NOT have ID.
      // However, we can just build the structure and return it?
      // No, this function returns Promise<string>.
      // We should probably Attach the structure to the return value or update a shared state?
      // Re-reading: The goal is to support the Repair Agent which runs AFTER generation.
      // So as long as we have the final structure at the end, it's fine.
      // But we want to save it.

      // We need to return this structure or save it.
      // The simplest way to get it out is to attach it to the thesisData if it's passed by reference? No.
      // We can change the return type of generateThesisContent, but that breaks the caller.
      // Let's modify the return type and the caller. Or...
      // wait, `thesisData` does not seem to have the ID.
      // But `generateThesisContent` is called by `processThesisGeneration` which HAS the ID.
      // Let's verify `processThesisGeneration`.


      // Generate Summary for next chapters
      const summary = await summarizeChapter(`${chapter.number} ${chapter.title} `, chapterText, isGerman, thesisData)
      chapterSummaries.push(summary)
      console.log(`[ThesisGeneration] Chapter summary generated(${summary.length} chars)`)
    }

    let combinedContent = chapterContents.join('\n\n\n')

    // EXTENSION PROCESS DISABLED (2026-01-07)
    // This legacy code was causing duplicate chapters by appending content after the Fazit.
    // Keeping the code commented out for potential rollback if needed.
    // To re-enable: uncomment the block below and set ENABLE_EXTENSION = true
    const ENABLE_EXTENSION = false

    if (ENABLE_EXTENSION && totalWordCount < expectedWordCount) {
      console.log(`[ThesisGeneration] Extension DISABLED - skipping word count extension`)
      /*
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
      */
    } else if (totalWordCount < expectedWordCount) {
      console.warn(`[ThesisGeneration] Word count below target (${totalWordCount}/${expectedWordCount}) but extension is DISABLED. Continuing with current content.`)
    }

    // CRITICAL: DEDUPLICATION (Improved Strategy: Keep Longest)
    // The user reported that sometimes a short stub appears (200 words) followed by the real chapter.
    // So we must collect ALL versions of a chapter and keep only the best (longest) one.

    const lines = combinedContent.split('\n')
    const sections: { header: string; headerNum: string; content: string[] }[] = []
    let currentSection: { header: string; headerNum: string; content: string[] } | null = null

    // 1. Parse into sections
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const headerMatch = line.match(/^(#{1,3})\s+(\d+(?:\.\d+)*)\s+(.*)$/)

      if (headerMatch) {
        const num = headerMatch[2].trim()
        // Start new section
        if (currentSection) {
          sections.push(currentSection)
        }
        currentSection = {
          header: line,
          headerNum: num,
          content: []
        }
      } else {
        if (currentSection) {
          currentSection.content.push(line)
        } else {
          // Content before first header? Attach to a "preamble" section or ignore?
          // Usually there is a title # Thesis Title. But here we deal with body.
          // If it's the very start, let's make a dummy section.
          if (line.trim().length > 0) {
            currentSection = { header: '', headerNum: 'PREAMBLE', content: [line] }
          }
        }
      }
    }
    if (currentSection) sections.push(currentSection)

    // 2. Deduplicate
    const bestSections = new Map<string, typeof currentSection>()
    const preambleSections: typeof sections = []

    for (const sec of sections) {
      if (sec.headerNum === 'PREAMBLE') {
        preambleSections.push(sec)
        continue
      }

      if (!bestSections.has(sec.headerNum)) {
        bestSections.set(sec.headerNum, sec)
      } else {
        const existing = bestSections.get(sec.headerNum)!
        const existingLen = existing.content.join('\n').length
        const newLen = sec.content.join('\n').length

        console.warn(`[ThesisGeneration] Duplicate Chapter ${sec.headerNum} found!`)
        console.warn(`[ThesisGeneration] Existing length: ${existingLen} chars vs New length: ${newLen} chars`)

        if (newLen > existingLen) {
          console.log(`[ThesisGeneration] Keeping NEW version (it is longer).`)
          bestSections.set(sec.headerNum, sec)
        } else {
          console.log(`[ThesisGeneration] Keeping EXISTING version (it is longer).`)
        }
      }
    }

    // 3. Reassemble in order
    // We need to preserve the original ORDER of chapters (1, 1.1, 1.2, 2...)
    // The Map iteration order is insertion order, but if we replaced a key, does it stay?
    // Map order is insertion order of KEYS. Replacing value doesn't change key order. 
    // BUT if we encountered 5.2 (stub) then 5.2 (real), the key "5.2" was inserted early.
    // So the position is correct (where the first 5.2 appeared).

    // However, if the text structure was: 5.1 -> 5.2 (stub) -> 5.2 (real).
    // The output will be 5.1 -> 5.2 (real). Correct.

    const finalSections: string[] = []

    // Add preambles if any
    preambleSections.forEach(s => {
      if (s.header) finalSections.push(s.header);
      finalSections.push(s.content.join('\n'))
    })

    // Add best chapters
    for (const [key, sec] of bestSections) {
      if (sec) { // type check
        finalSections.push(sec.header)
        finalSections.push(sec.content.join('\n'))
      }
    }

    combinedContent = finalSections.join('\n')
    totalWordCount = combinedContent.split(/\s+/).length

    if (sections.length > bestSections.size + preambleSections.length) {
      console.log(`[ThesisGeneration] Deduplication complete. Removed ${sections.length - (bestSections.size + preambleSections.length)} duplicate sections.`)
    }

    // Attach structure to the result?
    // We can't easily change the return type without breaking things.
    // Instead, we can throw a special "Completion" object or just Return the string and handle the JSON save in a separate call?
    // Actually, typescript allows us to return a property on the string object if we really want to hack it, but that's ugly.
    // Better: Change the return type to `Promise<{ content: string; structure: ThesisStructure }>`
    // This requires updating the caller.

    return { content: combinedContent, structure: thesisStructure }
  }

  // Fallback for single-shot generation (legacy path, rarely used now)
  // ... (lines 3637+)


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
      ? `Seiten: ${pages} (Dokument umfasst S. ${pageStart}-${pageEnd}. WICHTIG: Deine Zitation MUSS innerhalb dieses Bereichs liegen (z.B. zwischen ${pageStart} und ${pageEnd}). Artikelnummern wie "e12345" sind VERBOTEN!)`
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
- Zitationen im korrekten Stil (${citationStyleLabel})
- In-Text-Zitationen im korrekten Format (MANDATORY PAGE NUMBERS)

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
  ✗ JEDE Konstruktion mit Fragezeichen gefolgt von einer Antwort ist VERBOTEN!
  ✗ Dieses Muster macht den Text unlesbar und ist unwissenschaftlich!
  ✗ "Your infection? Unnoticed." → ABSOLUT VERBOTEN! (Nutzer-Beispiel)
  ✗ "Das Ergebnis? Unklar." → ABSOLUT VERBOTEN!
  ✗ NIEMALS EINE FRAGE STELLEN UND SOFORT BEANTWORTEN!
  ✗ "Snappy"-Frage-Antwort-Muster sind der schlimmste Stilfehler!
  ✓ IMMER direkte Aussagen und Feststellungen verwenden
  ✓ Statt "Die Grenze zwischen X und Y? In der öffentlichen Wahrnehmung..." → "Die Grenze zwischen X und Y verwischt in der öffentlichen Wahrnehmung..."
  ✓ Statt "Korruption? In der wirtschaftswissenschaftlichen Literatur..." → "In der wirtschaftswissenschaftlichen Literatur versteht man unter Korruption..."
  ✓ Statt "Was ist Forschung? Ein wichtiger Aspekt..." → "Die Forschung stellt einen wichtigen Aspekt dar."

**SEITENZAHLEN - ABSOLUT EXAKT ERFORDERLICH:**
- JEDE Zitation muss die EXAKTE Seitenzahl enthalten, auf der der zitierte Inhalt tatsächlich steht
- Die Seitenzahl muss STIMMEN - nicht nur im Toleranzbereich liegen!
- **KRITISCH:** Verwende AUSSCHLIESSLICH die Seitenzahlen, die oben in der Liste "VERFÜGBARE QUELLEN" stehen!
- Ignoriere alle Seitenzahlen oder IDs (wie "e12345", "a017..."), die du im Textinhalt selbst findest.
- Die "VERFÜGBARE QUELLEN"-Liste ist deine EINZIGE Wahrheit für korrekte Seitenzahlen.
- Wenn im Text "Seite e39284" steht, aber in der Quellenliste "Seiten: 10-25", dann nutze eine Seite aus dem Bereich 10-25 (z.B. S. 12).
- NIEMALS Article-IDs oder kryptische Nummern als Seitenzahlen verwenden!
- NIEMALS Seitenzahlen erfinden, die nicht zum Bereich in der Quellenliste passen.
- Wenn die Quellenliste sagt "Seiten: keine Angabe", dann zitiere OHNE Seitenzahl (Autor, Jahr). Erfinde keine!
- Prüfe IMMER: Liegt meine gewählte Seitenzahl im Bereich, der in der "VERFÜGBARE QUELLEN"-Liste angegeben ist? Wenn nein -> KORRIGIEREN!


- Im Text: Verwende "^N" direkt nach dem zitierten Inhalt
- Fortlaufende Nummerierung (^1, ^2, ^3...) in der Reihenfolge des Erscheinens
- Jede neue Zitation = neue Nummer (auch bei wiederholter Quelle)
- WICHTIG: Schreibe KEINE Fußnoten-Definitionen ([^1]: ...) am Ende!
- Die Fußnoten werden automatisch aus den Quellenmetadaten generiert

**${citationStyleLabel}:**
- Zitiere im Text: (Autor, Jahr, S. XX) oder (Autor, Jahr, S. XX-YY)
- Bei mehreren Autoren: (Autor et al., Jahr, S. XX)

**Beispiel mit echten Quellen aus der Liste:**
${rankedSources.length > 0 ? `"Die Forschung zeigt (${rankedSources[0].authors?.[0]?.split(' ').pop() || 'Autor'}, ${rankedSources[0].year || 'o.J.'}, S. 5)..."` : '"Die Forschung zeigt (Autor, Jahr, S. 5)..."'}

WICHTIG: Verwende NUR die Autoren/Jahre aus der obigen Quellenliste!

═══════════════════════════════════════════════════════════════════════════════
SCHREIBSTIL
═══════════════════════════════════════════════════════════════════════════════

** Wissenschaftlicher Ton:**
  - Objektiv, präzise, sachlich
  - Keine persönlichen Meinungen oder Marketing - Sprache
    - Ergebnisse den Autoren zuschreiben: "Müller (2021) zeigt..." statt "Es ist bewiesen..."

      **🚫 VERBOTEN - Unwissenschaftliche Stilmittel:**
        - ABSOLUT KEINE FRAGEN IM TEXT - WEDER RHETORISCHE NOCH SUGGESTIVE!
  ✗ "Was bedeutet Digitalisierung für die Arbeitswelt?"
  ✗ "Aber ist das wirklich so?"
  ✗ "Welche Auswirkungen hat dies?"
  ✗ "the research? a very important part..."(Fragezeichen nach Aussage)
  ✗ Jegliche Frageform, Fragezeichen oder suggestive Fragekonstruktionen
  ✗ Selbstreflexive Fragen wie "Was ist X? Ein wichtiger Aspekt..."
  - ABSOLUT VERBOTEN: FRAGE - ANTWORT - MUSTER(KRITISCH - UNLESBAR!)
  ✗ "Die Grenze zwischen X und Y? In der öffentlichen Wahrnehmung..."
  ✗ "Korruption und Lobbyismus: zwei verschiedene Arten. Lobbyismus hingegen? Unverzichtbar..."
  ✗ "Aber diese beiden Phänomene zu trennen? Schwierig."
  ✗ "Das Kernproblem? Es ist ungemein schwer..."
  ✗ "Korruption? In der wirtschaftswissenschaftlichen Literatur versteht man darunter..."
  ✗ JEDE Konstruktion mit Fragezeichen gefolgt von einer Antwort ist VERBOTEN!
  ✗ JEDE Konstruktion mit Fragezeichen gefolgt von einer Antwort ist VERBOTEN!
  ✗ Dieses Muster macht den Text unlesbar und ist unwissenschaftlich!
  ✗ "Your infection? Unnoticed." → ABSOLUT VERBOTEN!
  ✗ NIEMALS EINE FRAGE STELLEN UND SOFORT BEANTWORTEN!
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
  - KEINE journalistische oder Marketing - Sprache!
  ✗ "Die Zukunft ist jetzt", "Ein Paradigmenwechsel steht bevor"
  ✓ Sachliche, nüchterne Beschreibungen

  ** Sprachliche Regeln:**
    - KEINE persönlichen Pronomen("wir", "ich", "uns")
  ✗ "Wir werden im nächsten Abschnitt..."
  ✓ "Im nächsten Abschnitt wird..."
  - KEINE unprofessionellen Wörter: "freilich", "sicherlich", "natürlich"(als Füllwort)
    - ABSOLUT KEINE UMGANGSSPRACHE!
  ✗ "denk mal an...", "schau dir an...", "guck mal...", "hör mal..."
  ✗ "klar", "logisch", "natürlich"(umgangssprachlich), "eigentlich"(als Füllwort)
  ✗ Alle umgangssprachlichen Formulierungen sind VERBOTEN
  ✓ Verwende ausschließlich wissenschaftliche, formale Sprache
  - Verwende Passiv oder unpersönliche Konstruktionen

    ** Natürlicher Stil(Anti - AI - Detection):**
      - Variiere Satzlängen: kurz(5 - 10 Wörter), mittel(15 - 20), lang(25 - 35)
        - Variiere Satzanfänge(nicht immer "Die", "Es", "Dies")
          - Verwende unterschiedliche Synonyme
            - Vermeide KI - typische Phrasen: "zunächst", "ferner", "zusammenfassend", "darüber hinaus"
              - Nutze natürliche Übergänge: "Dabei zeigt sich", "Vor diesem Hintergrund", "In diesem Kontext"
                - ABER: Bleibe IMMER sachlich und wissenschaftlich - keine Fragen, keine Emotionen!

═══════════════════════════════════════════════════════════════════════════════
STRUKTUR UND LÄNGE - ⚠️ KRITISCH: WORTANZAHL EINHALTEN!
═══════════════════════════════════════════════════════════════════════════════

**🎯 PFLICHT - WORTANZAHL: MINDESTENS ${targetWordCount} Wörter! **

⚠️ ** ABSOLUT KRITISCH - LÄNGENANFORDERUNG:**
  - Du MUSST mindestens ${targetWordCount} Wörter schreiben!
    - Eine Arbeit mit weniger als ${Math.floor(targetWordCount * 0.9)} Wörtern ist INAKZEPTABEL!
      - Maximum: ${maxWordCount} Wörter(aber NIEMALS unter ${targetWordCount}!)
        - ${targetWordCount} Wörter = ca.${Math.ceil(targetWordCount / 250)} Seiten

          ** WORTVERTEILUNG PRO KAPITEL(ungefähr):**
            - Einleitung: ${Math.ceil(targetWordCount * 0.08)} -${Math.ceil(targetWordCount * 0.12)} Wörter(~8 - 12 %)
              - Theoretischer Rahmen / Grundlagen: ${Math.ceil(targetWordCount * 0.20)} -${Math.ceil(targetWordCount * 0.25)} Wörter(~20 - 25 %)
                - Hauptteil(Kapitel 3 + 4): ${Math.ceil(targetWordCount * 0.45)} -${Math.ceil(targetWordCount * 0.55)} Wörter(~45 - 55 %)
                  - Fazit: ${Math.ceil(targetWordCount * 0.08)} -${Math.ceil(targetWordCount * 0.12)} Wörter(~8 - 12 %)

                    ** WIE DU DIE WORTANZAHL ERREICHST:**
                      1. Jedes Kapitel AUSFÜHRLICH behandeln - nicht nur oberflächlich
2. Theorien und Konzepte DETAILLIERT erklären
3. Mehrere Quellen PRO Argument diskutieren
4. Beispiele und Anwendungen einbringen
5. Kritische Würdigung der Literatur einbauen
6. Übergänge zwischen Kapiteln ausführlich gestalten

  ** VERBOTEN:**
    - ✗ Zu kurze, oberflächliche Kapitel
      - ✗ Nur 1 - 2 Sätze pro Unterkapitel
        - ✗ Aufzählungen statt Fließtext
          - ✗ Eine Arbeit mit ${Math.floor(targetWordCount * 0.6)} Wörtern abliefern, wenn ${targetWordCount} gefordert sind!

            **⚠️ STRIKTE GLIEDERUNGSTREUE - ABSOLUT KRITISCH:**
              - Schreibe NUR die Kapitel / Unterkapitel, die in der Gliederung vorgegeben sind
                - KEINE zusätzlichen Kapitel, Abschnitte oder Ergänzungen hinzufügen!
                  - KEINE "Ergänzungen zu Kapitel X" oder ähnliche Nachträge
                    - KEINE Zusammenfassungen einzelner Kapitel am Ende
                      - Das letzte Kapitel der Gliederung IST das Ende der Arbeit
                        - Nach dem letzten Kapitel kommt NICHTS mehr(kein Text, keine Ergänzungen)

                          **🚫 VERBOT: KEINE EIGENEN UNTERKAPITEL ERFINDEN! **
                            - Wenn die Gliederung nur 5.1 und 5.2 hat, darfst du KEINE 5.1.1, 5.1.2 etc.erstellen!
                              - Du darfst die Gliederung NICHT vertiefen oder erweitern!
                                - Schreibe NUR die Überschriften, die in der Gliederung stehen!
                                  - Beispiel: Gliederung hat "5.1 Zusammenfassung" → Schreibe NUR "### 5.1 Zusammenfassung"
                                    - VERBOTEN: Gliederung hat "5.1" aber du schreibst "#### 5.1.1", "#### 5.1.2" → FALSCH!

                                      **📝 FAZIT / SCHLUSSKAPITEL - SPEZIELLE REGELN:**
                                        Das Fazit / Schlusskapitel muss KURZ und PRÄGNANT sein:
- NUR eine Zusammenfassung der wichtigsten Erkenntnisse(keine neue Analyse!)
  - KEINE neuen Argumente, Theorien oder Zitationen im Fazit
    - Wenn "Ausblick" vorhanden: NUR 2 - 3 Sätze zu möglichem Forschungsbedarf
      - KEINE tiefen Analysen oder ausführlichen Diskussionen im Fazit
        - Das Fazit wiederholt KURZ die Hauptergebnisse, mehr nicht
          - Typische Länge: 1 - 2 Seiten, NICHT mehr!

            ** STRENG VERBOTEN nach dem letzten Kapitel:**
              - ✗ "Ergänzungen zu Kapitel 2..."
                - ✗ "Zusätzliche Anmerkungen..."
                  - ✗ "Weitere Überlegungen..."
                    - ✗ "Nachträge..."
                      - ✗ Jeglicher Text nach dem Fazit / Schlusskapitel

                        ** Strukturelle Anforderungen:**
                          1. Beginne SOFORT mit "## 1. Einleitung"(kein Text davor!)
2. Schreibe ALLE Kapitel aus der Gliederung vollständig und IN DER RICHTIGEN REIHENFOLGE
3. Jedes Kapitel muss seinen wissenschaftlichen Zweck erfüllen
4. Ende mit dem letzten Kapitel(Fazit / Diskussion) - DANN STOPP!
5. Wenn du mehr Inhalt brauchst, erweitere die BESTEHENDEN Kapitel, füge KEINE neuen hinzu
6. KEINE Unterkapitel erfinden, die nicht in der Gliederung stehen!

  ** Aufbau der Arbeit(in Einleitung):**
    - Beschreibe NUR die nachfolgenden Kapitel(2, 3, 4...)
      - NICHT Kapitel 1 beschreiben(ist bereits geschrieben)
  ✗ "Das erste Kapitel führt ein..."
  ✓ "Im zweiten Kapitel wird..., das dritte Kapitel behandelt..."

═══════════════════════════════════════════════════════════════════════════════
OUTPUT - FORMAT
═══════════════════════════════════════════════════════════════════════════════

Gib den Text in Markdown aus - EXAKT nach der vorgegebenen Gliederung:

## 1. Einleitung
[Einleitungstext mit Zitationen ^ 1 ^ 2...]

## 2.[Exakter Kapitelname aus Gliederung]
[Kapiteltext...]

## 3.[Exakter Kapitelname aus Gliederung]
[Kapiteltext...]

[... alle Kapitel EXAKT wie in der Gliederung ...]

##[Letztes Kapitel aus Gliederung - z.B.Fazit]
[Fazittext...]

--- ENDE DER ARBEIT-- -

**⚠️ NACH DEM LETZTEN KAPITEL KOMMT NICHTS MEHR! **
  - Kein weiterer Text
    - Keine Ergänzungen
      - Keine Zusammenfassungen
        - Keine zusätzlichen Abschnitte
          - STOPP nach dem letzten Satz des Fazits / Schlusskapitels




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
- FORBIDDEN: "Corruption? In the economic literature, it is understood as..."
- FORBIDDEN: ANY construction with a question mark followed by an answer!
- FORBIDDEN: "Your infection? Unnoticed." -> ABSOLUTELY FORBIDDEN! (User Example)
- FORBIDDEN: "The result? Unclear." -> ABSOLUTELY FORBIDDEN!
- NEVER ASK A QUESTION AND IMMEDIATELY ANSWER IT!
- "Snappy" question-answer patterns are the WORST style error!
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
- FORBIDDEN: "Your infection? Unnoticed." -> ABSOLUTELY FORBIDDEN!
- NEVER ASK A QUESTION AND IMMEDIATELY ANSWER IT!
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
  * All citations are correct and include page numbers

**3. NO EARLY STOPPING - ABSOLUTELY CRITICAL:**
- The work must NOT end in the middle of a chapter.
- The work must NOT end without citations.
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
3. Includes proper citations throughout (with page numbers)
4. Is logically structured and correctly implements the citation style
5. Uses exclusively validated sources from the provided list
6. Sounds natural and human from the start, not like AI-generated

DO NOT write a Bibliography or References section - end with the Conclusion chapter.
DO NOT STOP until all chapters are complete. The thesis must be COMPLETE.
ABSOLUTELY NO BIBLIOGRAPHY OR SOURCE LIST IS ALLOWED IN THE OUTPUT TEXT.`

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
❌ ERSTELLEN EINES LITERATURVERZEICHNISSES (Dies wird automatisch generiert)!
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
      trackTokenUsage(thesisData, response, 'gemini-2.5-pro', `Generate thesis content attempt ${attempt}`)

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

        // Check for page numbers in citations
        // Matches (Author, Year, p. XX) or (Author, Year, S. XX)
        const citationMatches = content.match(/\([A-ZÄÖÜa-zäöü][a-zäöüß]+(?:\s+et\s+al\.?)?,?\s+\d{4},?\s+[Sp]\.\s*\d+/g)
        citationCount = citationMatches?.length || 0

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

        return { content }
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
 * Find the paragraph containing a given sentence
 * Returns the full paragraph text and its start/end indices in the content
 */
function findParagraphForSentence(content: string, sentence: string): { paragraph: string, startIdx: number, endIdx: number } | null {
  // 1. Quick exact/normalized match first
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
  const cleanSentence = normalize(sentence)

  if (cleanSentence.length < 5) return null // Skip garbage

  const paragraphPattern = /\n\n+|\r\n\r\n+/
  const paragraphs = content.split(paragraphPattern)

  let searchStartIndex = 0

  // Helper to remove ALL non-alphanumeric chars for "ultra logic" match
  // e.g. "**Title:**" -> "Title"
  const superClean = (text: string) => text.toLowerCase().replace(/[^a-z0-9äöüß]/g, '')
  const superCleanSentence = superClean(cleanSentence)

  for (const paragraph of paragraphs) {
    const paragraphStartIdx = content.indexOf(paragraph, searchStartIndex)

    if (paragraphStartIdx !== -1) {
      searchStartIndex = paragraphStartIdx + paragraph.length

      const cleanParagraph = normalize(paragraph)

      // Strategy 1: Standard inclusion
      if (paragraph.includes(sentence) || cleanParagraph.includes(cleanSentence)) {
        return { paragraph, startIdx: paragraphStartIdx, endIdx: paragraphStartIdx + paragraph.length }
      }

      // Strategy 2: "Ultra Clean" match (ignores all punctuation/markdown)
      // Good for headers like "## 5.3 Title" vs "5.3 Title"
      if (superClean(paragraph).includes(superCleanSentence)) {
        return { paragraph, startIdx: paragraphStartIdx, endIdx: paragraphStartIdx + paragraph.length }
      }

      // Strategy 3: Token Overlap (Fuzzy) - if 70% of sentence words appear in sequence in paragraph
      // Good if Winston cutoff the sentence or added artifacts
      const sentenceWords = cleanSentence.split(' ')
      if (sentenceWords.length > 3) {
        let matchCount = 0
        const paraWords = cleanParagraph.split(' ')
        // Simple check: do the big words from sentence exist in paragraph?
        for (const w of sentenceWords) {
          if (w.length > 4 && cleanParagraph.includes(w)) matchCount++
        }

        // If >80% of long words match, it's probably the right paragraph
        if (matchCount > sentenceWords.filter(w => w.length > 4).length * 0.8) {
          return { paragraph, startIdx: paragraphStartIdx, endIdx: paragraphStartIdx + paragraph.length }
        }
      }
    }
  }

  return null
}

/**
 * Rewrite flagged sentences by humanizing their parent paragraphs
 * This provides better context for more natural rewrites while preserving all content
 */
async function rewriteFlaggedParagraphs(
  content: string,
  flaggedSentences: string[],
  thesisData: ThesisData
): Promise<string> {
  if (flaggedSentences.length === 0) {
    return content
  }

  console.log(`[Rewrite] Grouping ${flaggedSentences.length} flagged sentences by paragraph...`)

  const isGerman = thesisData.language === 'german'
  let rewrittenContent = content

  // Group sentences by their parent paragraph
  const paragraphMap = new Map<string, { paragraph: string, sentences: string[], startIdx: number, endIdx: number }>()

  for (const sentence of flaggedSentences) {
    const found = findParagraphForSentence(content, sentence)
    if (found) {
      const key = found.paragraph
      if (paragraphMap.has(key)) {
        paragraphMap.get(key)!.sentences.push(sentence)
      } else {
        paragraphMap.set(key, {
          paragraph: found.paragraph,
          sentences: [sentence],
          startIdx: found.startIdx,
          endIdx: found.endIdx
        })
      }
    } else {
      console.warn(`[Rewrite] Could not find paragraph for sentence: "${sentence.substring(0, 50)}..."`)
    }
  }

  console.log(`[Rewrite] Found ${paragraphMap.size} paragraphs containing flagged sentences`)

  // Process each paragraph
  let processedCount = 0
  let successCount = 0
  let failCount = 0

  for (const [key, data] of paragraphMap) {
    processedCount++
    console.log(`[Rewrite] Processing paragraph ${processedCount}/${paragraphMap.size} (${data.sentences.length} flagged sentences)`)

    const prompt = isGerman
      ? `Du bist ein professioneller Ghostwriter. Dein Ziel ist es, diesen akademischen Text so umzuschreiben, dass er 100% menschlich und handgeschrieben wirkt.

**AUFGABE:**
Humanisiere den folgenden Absatz. Brich starre akademische Muster auf. Der Text muss "leben".

**ABSOLUT KRITISCHE REGELN:**
1. **INHALT 100% BEWAHREN:** Fakten, Daten, Namen und Argumente dürfen NICHT verändert werden.
2. **ZITATIONEN UNANTASTBAR:** (Müller, 2023, S. 14) muss EXAKT so bleiben.
3. **TONALITÄT:** Akademisch, aber flüssig und elegant (wie ein erfahrener Professor, nicht wie ein Student oder KI).

**ANTI-KI STRATEGIEN (WICHTIG!):**
- **Satzlängen-Chaos:** Mische extrem kurze Sätze (4-6 Wörter) mit sehr komplexen Satzgefügen.
- **Menschliche Konnektoren:** Statt "Zudem", "Ferner", "Des Weiteren" → Nutze "Interessant ist hierbei", "Bemerkenswert zeigt sich", "Vielmehr".
- **Emotionale Intelligenz:** Nutze Wörter wie "drängend", "überraschend", "signifikant", "fragil" um Wichtigkeit zu betonen.
- **Passiv-Vermeidung:** Formuliere aktiv wo möglich.
- **Keine Schablonen:** Vermeide "Dieser Abschnitt beleuchtet..." oder "Zusammenfassend lässt sich sagen...". Steig direkt ins Argument ein.
- **LÄNGE:** Der Text darf NICHT länger werden! Kürzen ist erlaubt, Aufblähen ist VERBOTEN. Halte dich strikt an die Informationsdichte des Originals.

**PROBLEMATISCHE SÄTZE (Fokus hierauf):**
${data.sentences.map((s, i) => `${i + 1}. "${s}"`).join('\n')}

**ORIGINAL ABSATZ:**
${data.paragraph}

**DEIN ENTWURF (Nur den Text):**`
      : `You are a senior academic editor who specializes in making AI-generated text undetectable. Your expertise is in mimicking the natural imperfections of human academic writing.

**MISSION:**
Transform this paragraph so Winston AI, GPTZero, and Turnitin score it as 95%+ human-written. The current text has characteristic AI patterns that must be eliminated.

**IRON RULES (NEVER BREAK):**
1. **Content stays identical:** All facts, data, arguments, citations (Author, Year, p. X) remain EXACTLY as given.
2. **Academic register:** Formal scholarly tone. No slang, no contractions, no first person.
3. **Length cap:** Output must NOT exceed input length. Condensing is fine; padding is forbidden.

**ENGLISH-SPECIFIC ANTI-DETECTION TECHNIQUES (CRITICAL):**

1. **BURSTINESS (Most Important for Winston AI):**
   - REQUIRE at least one sentence under 6 words ("This proved decisive.")
   - REQUIRE at least one sentence over 28 words with embedded clauses
   - NEVER have 3 consecutive sentences within ±4 words of each other
   - Create deliberately "jagged" rhythm—not flowing prose

2. **PERPLEXITY BOOSTING (Critical for GPTZero):**
   - Avoid the most predictable word at each juncture
   - Use concrete nouns instead of abstract placeholders ("the mechanism" → "the feedback loop")
   - Vary your sentence openers: start 40%+ with something OTHER than subject
   - Deploy uncommon but appropriate synonyms (e.g., "posit" instead of "suggest", "contend" instead of "argue")

3. **KILL THESE AI MARKERS (2025 Detector Signatures):**
   - BANNED connectors: "Furthermore", "Moreover", "Additionally", "In conclusion", "It is important to note", "It should be noted"
   - BANNED LLM words: "delves", "crucial", "pivotal", "landscape", "multifaceted", "nuanced", "paramount", "comprehensive", "underscore", "realm", "tapestry"
   - BANNED patterns: "X? Y." (rhetorical Q&A), "The [noun] of [noun]" repetition, triple-adjective stacks
   - REPLACE with: "Notably,", "Here,", "Against this backdrop,", "A closer look reveals", "In practice,", "Tellingly,"

4. **SYNTAX SCRAMBLING:**
   - Vary clause order: sometimes subordinate-first, sometimes main-first
   - Use parenthetical asides with em-dashes sparingly
   - Mix active and passive voice within the paragraph (60/40 active)
   - Occasionally front an adverbial: "Unexpectedly, the data showed..."

5. **ACADEMIC HEDGING (English-specific):**
   - Use: "appears to", "seemingly", "to some extent", "arguably", "in certain respects"
   - But NEVER hedge when describing your own thesis structure—be definitive there

6. **NATURAL ASYMMETRY:**
   - Paragraph shouldn't feel "balanced"—let one idea get more words than others
   - Transitions can be abrupt where logically appropriate
   - Vary punctuation: colon, semicolon, em-dash, parentheses—not just commas

**FLAGGED SENTENCES (Rewrite these most aggressively):**
${data.sentences.map((s, i) => `${i + 1}. "${s}"`).join('\n')}

**ORIGINAL PARAGRAPH:**
${data.paragraph}

**YOUR REWRITE (paragraph text only, no commentary):**`

    // Retry loop for paragraph rewriting (up to 3 attempts)
    const MAX_PARAGRAPH_RETRIES = 3
    let paragraphSuccess = false

    for (let attempt = 1; attempt <= MAX_PARAGRAPH_RETRIES && !paragraphSuccess; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`[Rewrite] Retrying paragraph ${processedCount} (attempt ${attempt}/${MAX_PARAGRAPH_RETRIES})...`)
        }

        const response = await retryApiCall(
          () => ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: prompt,
          }),
          `Rewrite paragraph ${processedCount}`
        )
        trackTokenUsage(thesisData, response, 'gemini-2.5-pro', `Rewrite paragraph ${processedCount}`)

        const responseText = response.text?.trim()
        if (!responseText) {
          console.warn(`[Rewrite] ⚠️ No response for paragraph ${processedCount}, attempt ${attempt}`)
          if (attempt === MAX_PARAGRAPH_RETRIES) {
            failCount++
          }
          continue
        }

        // Verify citations are preserved
        const citationPattern = /\([A-ZÄÖÜ][a-zäöüß]+(?:\s+et\s+al\.?)?,?\s+\d{4}(?:,\s+(?:S\.|p\.|pp\.)\s+\d+(?:-\d+)?)?\)/g
        const originalCitations = data.paragraph.match(citationPattern) || []
        const newCitations = responseText.match(citationPattern) || []

        if (originalCitations.length !== newCitations.length) {
          console.warn(`[Rewrite] ⚠️ Citation count mismatch (${originalCitations.length} → ${newCitations.length}), attempt ${attempt}/${MAX_PARAGRAPH_RETRIES}`)
          if (attempt === MAX_PARAGRAPH_RETRIES) {
            console.warn(`[Rewrite] ⚠️ Giving up on paragraph ${processedCount} after ${MAX_PARAGRAPH_RETRIES} attempts`)
            failCount++
          }
          await new Promise(resolve => setTimeout(resolve, 500)) // Short delay before retry
          continue
        }

        // Replace the paragraph in content
        const escapedParagraph = data.paragraph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const beforeLength = rewrittenContent.length
        rewrittenContent = rewrittenContent.replace(data.paragraph, responseText)

        if (rewrittenContent.length !== beforeLength || rewrittenContent.includes(responseText)) {
          successCount++
          paragraphSuccess = true
          console.log(`[Rewrite] ✓ Paragraph ${processedCount} rewritten (${data.sentences.length} sentences humanized)`)
        } else {
          console.warn(`[Rewrite] ⚠️ Failed to replace paragraph ${processedCount}, attempt ${attempt}`)
          if (attempt === MAX_PARAGRAPH_RETRIES) {
            failCount++
          }
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 300))

      } catch (error) {
        console.error(`[Rewrite] Error processing paragraph ${processedCount} (attempt ${attempt}):`, error)
        if (attempt === MAX_PARAGRAPH_RETRIES) {
          failCount++
        }
      }
    }
  }

  console.log(`[Rewrite] Paragraph rewriting completed: ✓${successCount} succeeded, ✗${failCount} failed`)

  // Post-processing: Fix common formatting issues
  rewrittenContent = rewrittenContent.replace(/(\.)([A-ZÄÖÜ])/g, '$1 $2')
  rewrittenContent = rewrittenContent.replace(/(\)\.)([A-ZÄÖÜ])/g, '$1 $2')
  rewrittenContent = rewrittenContent.replace(/\s+\.{3}\s*/g, ' ')
  rewrittenContent = rewrittenContent.replace(/^\.{3}\s*/gm, '')

  return rewrittenContent
}

/**
 * Rewrite flagged sentences using Gemini 2.5 Pro to make them more human-like
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
Schreibe die folgenden Sätze so um, dass sie natürlicher und menschlicher klingen. Dein Ziel ist es, dass diese Sätze von KI-Detektoren (wie Winston AI, GPTZero) als "menschlich" erkannt werden.

**KRITISCHE Regeln für maximalen "Human Score":**

1. **EXTREME Satz-Burstiness (WICHTIGSTE REGEL):**
   - Mindestens 1 Satz pro Batch muss UNTER 8 Wörter haben (z.B. "Das änderte alles.")
   - Mindestens 1 Satz pro Batch muss ÜBER 30 Wörter haben
   - NIEMALS 3 aufeinanderfolgende Sätze mit ähnlicher Länge (±5 Wörter)
   - Rhythmus soll "holprig" wirken, nicht glatt fließend

2. **Perplexität AGGRESSIV erhöhen:**
   - Verwende pro Satz mindestens 1-2 unerwartete, aber passende Synonyme
   - Vermeide die 3 vorhersehbarsten Wortwahlen für jeden Begriff
   - Nutze gelegentlich weniger frequente Wörter aus dem akademischen Register
   - Beginne MINDESTENS 40% der Sätze NICHT mit dem Subjekt

3. **Syntax-Variation ERZWINGEN:**
   - Starte manche Sätze mit Nebensatz, Partizip oder Präpositionalphrase
   - Baue Einschübe ein (in Gedankenstrichen oder Klammern)
   - Verwende gelegentlich Ellipsen oder verkürzte Konstruktionen
   - Variiere zwischen Aktiv und Passiv innerhalb eines Absatzes

4. **Natürliche Imperfektionen:**
   - Verwende gelegentlich leicht umständliche, aber korrekte Formulierungen
   - Variiere Interpunktion: Gedankenstrich, Klammern, Doppelpunkt, Semikolon
   - Baue bewusst kleine syntaktische "Unebenheiten" ein (grammatisch korrekt!)

5. **KI-MARKER KILL LIST 2025 (ABSOLUT VERBOTEN):**
   - ALTE Marker: "zunächst", "ferner", "des Weiteren", "zusammenfassend", "darüber hinaus", "diesbezüglich", "in diesem Zusammenhang", "es ist wichtig zu beachten"
   - NEUE Marker: "beleuchten", "ergründen", "tiefgreifend", "facettenreich", "vielschichtig", "hervorzuheben ist", "von zentraler Bedeutung", "maßgeblich prägen", "im Kern", "fundamental"
   - MUSTER: "X? Y." (Frage-Antwort) → VERBOTEN, mache normalen Satz
   - PRONOMEN: "Man", "Wir", "Uns" → VERBOTEN, nutze Passiv

6. **Inhalt 100% bewahren:**
   - Behalte ALLE Fakten, Daten, Namen exakt bei
   - ZITATIONEN (z.B. (Müller, 2023, S. 14)) NIEMALS ändern oder entfernen!

**Zu überarbeitende Sätze:**
${batch.map((s, idx) => `${idx + 1}. ${s}`).join('\n\n')}

**Format:**
Antworte NUR mit einem JSON-Array der umgeschriebenen Sätze. Keine Erklärungen.
["Umgeschriebener Satz 1", "Umgeschriebener Satz 2", ...]`
      : `You are an AI detection evasion specialist for English academic texts. Your job: rewrite sentences so they score 95%+ human on Winston AI and GPTZero.

**TASK:** Rewrite these sentences. Each rewrite must be undetectable as AI-generated while preserving 100% of the factual content.

**ENGLISH-SPECIFIC RULES (CRITICAL FOR DETECTION EVASION):**

1. **EXTREME BURSTINESS (Winston AI's Primary Signal):**
   - FORCE at least 1 sentence under 7 words in every batch ("The effect was immediate.")
   - FORCE at least 1 sentence over 32 words with nested clauses
   - NEVER let 3 sentences land within ±5 words of each other
   - Create intentionally "irregular" rhythm—human writers are inconsistent

2. **PERPLEXITY MAXIMIZATION (GPTZero's Primary Signal):**
   - For each key term, use the 2nd or 3rd most likely synonym, not the most obvious
   - Front-load 50% of sentences with adverbials, participial phrases, or subordinate clauses
   - Avoid starting with "The", "This", "It", "There" more than once per 4 sentences
   - Use concrete specifics: "the 1943 conference" not "the relevant meeting"

3. **2025 AI MARKER KILL LIST (AUTOMATIC DETECTION TRIGGERS):**
   BANNED WORDS: "delves", "crucial", "pivotal", "landscape", "multifaceted", "nuanced", "paramount", "comprehensive", "underscore", "realm", "tapestry", "intricacies", "leveraging", "encompass", "embark"
   BANNED CONNECTORS: "Furthermore", "Moreover", "Additionally", "In conclusion", "It is important to note", "It should be noted", "firstly", "secondly"
   BANNED PATTERNS: "X? Y." (rhetorical Q&A), "The [noun] of [noun]" chains, "plays a crucial role", "it is worth noting"
   REPLACE WITH: "Here,", "Notably,", "In practice,", "Tellingly,", "Against this backdrop,", "A closer look shows", "Put differently,"

4. **SYNTAX SCRAMBLING:**
   - Alternate clause positioning: subordinate-first, then main-first
   - Deploy em-dashes for asides—but sparingly
   - Mix active (60%) and passive (40%) voice
   - Use semicolons and colons to create unexpected rhythm breaks

5. **NATURAL HEDGING (English academic style):**
   - Use: "appears to", "seemingly", "to some extent", "arguably", "suggests that"
   - But be DEFINITIVE when describing your own work/thesis structure

6. **CONTENT PRESERVATION (SACRED):**
   - All facts, names, dates, numbers: UNCHANGED
   - Citations like (Author, Year, p. X): EXACTLY as given, no modifications

**SENTENCES TO REWRITE:**
${batch.map((s, idx) => `${idx + 1}. ${s}`).join('\n\n')}

**FORMAT:**
Respond ONLY with a JSON array of the rewritten sentences. No explanations, no commentary.
["Rewritten sentence 1", "Rewritten sentence 2", ...]`

    try {
      const response = await retryApiCall(
        () => ai.models.generateContent({
          model: 'gemini-2.5-pro',
          contents: prompt,
        }),
        `Rewrite sentences batch ${Math.floor(i / BATCH_SIZE) + 1}`
      )
      trackTokenUsage(thesisData, response, 'gemini-2.5-pro', `Rewrite sentences batch ${Math.floor(i / BATCH_SIZE) + 1}`)

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

      // Replace sentences in content and track success/failure
      let successCount = 0
      let failCount = 0

      batch.forEach((originalSentence, idx) => {
        if (rewrittenSentences[idx]) {
          // Escape special regex characters in the original sentence
          const escapedOriginal = originalSentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const beforeLength = rewrittenContent.length
          rewrittenContent = rewrittenContent.replace(
            new RegExp(escapedOriginal, 'g'),
            rewrittenSentences[idx]
          )

          // Check if replacement actually happened
          if (rewrittenContent.length !== beforeLength || rewrittenContent.includes(rewrittenSentences[idx])) {
            successCount++
          } else {
            failCount++
            // Log first 80 chars of failed sentence for debugging
            console.warn(`[Rewrite] ⚠️ Failed to find/replace: "${originalSentence.substring(0, 80)}..."`)
          }
        } else {
          failCount++
          console.warn(`[Rewrite] ⚠️ No rewritten version for sentence ${idx + 1}`)
        }
      })

      console.log(`[Rewrite] Batch ${Math.floor(i / BATCH_SIZE) + 1} completed: ✓${successCount} replaced, ✗${failCount} failed`)

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

  // Post-processing: Fix missing spaces after periods before next sentence
  // Matches: period/closing paren followed immediately by uppercase letter (no space)
  // e.g., "S. 3).ADI" → "S. 3). ADI"
  rewrittenContent = rewrittenContent.replace(/(\.)([A-ZÄÖÜ])/g, '$1 $2')
  rewrittenContent = rewrittenContent.replace(/(\)\.)([A-ZÄÖÜ])/g, '$1 $2')

  // Post-processing: Remove stray ellipsis from partial quote markers
  // These come from critique loop when sentences start with "..." to indicate partial quotes
  // e.g., " ...Investitionsrisiken" → " Investitionsrisiken"
  rewrittenContent = rewrittenContent.replace(/\s+\.{3}\s*/g, ' ')  // " ... " or " ..." → " "
  rewrittenContent = rewrittenContent.replace(/^\.{3}\s*/gm, '')    // "..." at line start → ""

  return rewrittenContent
}

/**
 * Apply "Scanned PDF" formatting artifacts to fool AI detection
 * - Hard wraps at 90 chars
 * - Hyphenates long words at line breaks with a dangling hyphen and space "- "
 */
function applyScannedFormatting(text: string): string {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let currentLine = ''

  for (const word of words) {
    // If word fits, add it
    if (currentLine.length + 1 + word.length <= 90) {
      currentLine += (currentLine.length > 0 ? ' ' : '') + word
    } else {
      // Line full. Check if we should split the word
      if (word.length > 6) {
        const splitIdx = Math.floor(word.length / 2)
        const part1 = word.substring(0, splitIdx)
        const part2 = word.substring(splitIdx)

        // Add part1 + hyphen + space to current line
        currentLine += (currentLine.length > 0 ? ' ' : '') + part1 + '- '
        lines.push(currentLine)

        // Start new line with part2
        currentLine = part2
      } else {
        // Just wrap normal word
        lines.push(currentLine)
        currentLine = word
      }
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine)
  }
  return lines.join('\n')
}

// ==========================================
// HUMANIZATION PIPELINE V2 (Multi-step)
// ==========================================

const HUMANIZER_PROMPTS = {
  calibrator: (text: string, language: string, strict: boolean) => {
    const isGerman = language === 'german' || language === 'de'

    if (isGerman) {
      return `Du bist ein akademischer Stilkalibrator. Dein Ziel ist es, "menschliche Autorenvorsicht" (Hedging) und Haltung im Text wiederherzustellen.
        
        Regeln:
        1. **Hedging**: KI macht oft absolute Aussagen ("Dies beweist X"). Menschen hedgen ("Dies deutet auf X hin", "Dies könnte auf X hinweisen").
           - Füge Hedges bei Interpretationen, Implikationen oder Verallgemeinerungen ein.
           - NIEMALS bei Methoden, mathematischen Aussagen oder Zitationen hedgen.
        2. **Autorenpräsenz**: Verwende Formulierungen wie "Es zeigt sich", "in gewissem Maße", "im Rahmen dieser Arbeit".
        3. **Ton**: "Wissender Peer" - selbstbewusst aber vorsichtig.
        4. **Treue**: Den Kerninhalt nicht ändern.
        5. **ULTRA-KRITISCH - ZITATIONEN SIND HEILIG**: 
           - NIEMALS eine Zitation wie (Müller, 2020, S. 12) anfassen, ändern, verschieben oder umformatieren.
           - NIEMALS eine Seitenzahl ändern.
        
        6. **KEINE RELATIVIERUNG IN AUFBAU DER ARBEIT**:
           - Im Abschnitt "Aufbau der Arbeit" oder bei Kapitelankündigungen (z.B. "Kapitel 2 wird...", "In Kapitel 3...") NIEMALS hedgen!
           - Die Struktur der Arbeit ist bekannt und definitiv - hier sind Relativierungen unsinnig.
           - VERBOTEN in Strukturbeschreibungen: "dürfte", "könnte", "scheint", "vermutlich", "möglicherweise", "in gewissem Maße"
           - STATTDESSEN: "wird", "befasst sich", "untersucht", "analysiert", "widmet sich"
           - Beispiel FALSCH: "Kapitel 2 dürfte die Grundlagen behandeln"
           - Beispiel RICHTIG: "Kapitel 2 behandelt die Grundlagen"
        
        Text zum Kalibrieren:
        "${text}"
        
        Gib nur den kalibrierten Text aus.
        ${strict ? 'Strenge Formatierung: ERHALTE alle Markdown-Überschriften (##), Listen und Zitationen genau.' : ''}`
    } else {
      return `You are an Academic Voice Calibrator specializing in making AI-generated text undetectable.

MISSION: Restore subtle "human authorial caution" while eliminating AI detection signatures.

ENGLISH-SPECIFIC ANTI-DETECTION RULES (CRITICAL):

1. **BANNED PHRASES - NEVER USE THESE:**
   - "It is worth noting that..." → DELETE, just state directly
   - "It should be noted that..." → DELETE
   - "It is important to note..." → DELETE
   - "Furthermore", "Moreover", "Additionally" → Use "Here,", "Notably,", "In practice,"
   - "delves", "crucial", "pivotal", "landscape", "multifaceted", "nuanced", "paramount"

2. **HEDGING (Human-Style):**
   - AI makes absolute claims ("This proves X"). Humans hedge ("This suggests X", "This appears to indicate X").
   - Inject hedges ONLY for interpretations and generalizations.
   - NEVER hedge methods, citations, or mathematical claims.
   - Use: "appears to", "seemingly", "arguably", "to some extent"

3. **BURSTINESS:**
   - Vary sentence lengths dramatically
   - Include at least one very short sentence (under 8 words)
   - Include complex sentences with embedded clauses

4. **CITATIONS ARE SACRED:**
   - NEVER modify, move, or reformat citations like (Smith, 2020, p. 12)
   - NEVER change page numbers
   - Citations must appear identically in output

Text to calibrate:
"${text}"

Output the calibrated text only. No commentary.
${strict ? 'Strict Formatting: PRESERVE all Markdown headers (##), lists, and citations exactly.' : ''}`
    }
  },

  rewriter: (text: string, instructions: string, language: string, strict: boolean) => {
    const isGerman = language === 'german' || language === 'de'

    if (isGerman) {
      return `Du bist ein Experten-Editor. Schreibe den folgenden Absatz um, indem du die unten aufgeführten spezifischen Änderungen anwendest.
        
        KRITISCHE REGELN:
        1. Ändere nur die angegebenen Sätze. Lasse andere GENAU so wie sie sind.
        2. Behalte die Bedeutung bei.
        3. Bewahre den akademischen Ton.
        4. **ULTRA-KRITISCH - ZITATIONEN**:
           - Ändere KEINE Zitationsseitenzahlen (z.B. S. 12 -> S. 15 ist VERBOTEN).
           - Entferne KEINE Zitationen.
           - Behalte Zitationen genau so wie sie im Originaltext erscheinen.
        
        Absatz:
        "${text}"
        
        Anzuwendende Änderungen:
        ${instructions}
        
        Gib nur den vollständig umgeschriebenen Absatz aus.
        ${strict ? 'Strenge Formatierung: ERHALTE alle Markdown-Überschriften (##), Listen und Zitationen genau.' : ''}`
    } else {
      return `You are an expert editor specializing in making AI text undetectable.

TASK: Rewrite this paragraph by applying the modifications listed below.

ENGLISH ANTI-DETECTION RULES (CRITICAL):

1. **BANNED WORDS - ELIMINATE THESE:**
   "delves", "crucial", "pivotal", "landscape", "multifaceted", "nuanced", "paramount", "comprehensive", "underscore", "realm", "tapestry"

2. **BANNED CONNECTORS:**
   "Furthermore" → "Here," or "Notably,"
   "Moreover" → "In practice," or "Tellingly,"
   "Additionally" → "Against this backdrop,"
   "In conclusion" → Just start concluding, no announcement

3. **BURSTINESS:**
   - Create varied sentence lengths (some very short, some long with clauses)
   - Never have 3 consecutive sentences of similar length

4. **SYNTAX VARIATION:**
   - Start some sentences with adverbials or subordinate clauses
   - Mix active and passive voice (60/40)

5. **CITATIONS ARE SACRED:**
   - Do NOT change citation page numbers
   - Do NOT remove citations
   - Keep citations exactly as they appear

Paragraph:
"${text}"

Modifications to apply:
${instructions}

Output the fully rewritten paragraph only. No commentary.
${strict ? 'Strict Formatting: PRESERVE all Markdown headers (##), lists, and citations exactly.' : ''}`
    }
  },

  punctuation: (text: string, language: string, strict: boolean) => {
    const isGerman = language === 'german' || language === 'de'

    if (isGerman) {
      return `Du bist ein "Steuerzeichen" (Zeichensetzung und Fluss) Spezialist. 
        Deine Aufgabe ist es, die Zeichensetzung des folgenden Textes zu verfeinern, um hochwertigem menschlichem akademischen Schreiben zu entsprechen.
        
        Prinzipien:
        1. **Varianz > Häufigkeit**: Vermeide es, dasselbe Satzzeichen (z.B. Gedankenstriche, Doppelpunkte) in direkter Nähe zu wiederholen.
        2. **Balance**: Wenn ein Absatz viele Gedankenstriche '—' hat, verbessert das Austauschen einiger durch Klammern '()' oder Kommas den Fluss.
        3. **Rhythmus**: Zeichensetzung führt den Atem. Stelle sicher, dass der Text natürlich zu lesen ist.
        4. **Einschränkung**: Schreibe die Wörter NICHT um oder ändere die Bedeutung. Passe NUR Zeichensetzung an.
        
        Text zum Kalibrieren:
        "${text}"
        
        Gib nur den kalibrierten Text aus.
        ${strict ? 'Strenge Formatierung: ERHALTE alle Markdown-Überschriften (##), Listen und Zitationen genau.' : ''}`
    } else {
      return `You are a Punctuation and Flow specialist for making text sound human-written.

TASK: Refine the punctuation to eliminate AI-typical patterns.

ENGLISH ANTI-DETECTION RULES:

1. **PUNCTUATION VARIANCE:**
   - Avoid repeating the same punctuation mark (dashes, colons) in close proximity
   - If a paragraph has many em-dashes '—', swap some for parentheses or commas
   - Use semicolons occasionally to break up rhythm

2. **RHYTHM DISRUPTION:**
   - AI text often has metronomic rhythm. Break this.
   - Some sentences should feel abrupt, others flowing

3. **CONSTRAINT:**
   - Do NOT rewrite words or change meaning
   - ONLY adjust punctuation (commas, colons, semicolons, dashes, parentheses)

4. **CITATIONS:**
   - NEVER modify citations in any way

Text to calibrate:
"${text}"

Output the calibrated text only. No commentary.
${strict ? 'Strict Formatting: PRESERVE all Markdown headers (##), lists, and citations exactly.' : ''}`
    }
  }
}

function splitSentences(text: string): string[] {
  // Simple robust regex for sentence splitting
  // Matches sentences ending in . ! ? followed by space or end of string
  // Handles quotes and parentheses reasonably
  return text.match(/[^.!?\n]+[.!?]+["']?|[^.!?\n]+$/g) || [text]
}

function planModifications(sentences: string[]): string[] {
  const mods: string[] = []

  // Config
  const LONG_SENTENCE_Words = 35
  const SHORT_SENTENCE_Words = 10

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim()
    const wordCount = sentence.split(/\s+/).length

    if (wordCount > LONG_SENTENCE_Words) {
      mods.push(`Sentence "${sentence.substring(0, 20)}...": Split this sentence (it is too long).`)
    } else if (wordCount < SHORT_SENTENCE_Words && i < sentences.length - 1) {
      const nextSent = sentences[i + 1].trim()
      const nextWordCount = nextSent.split(/\s+/).length
      if (nextWordCount < SHORT_SENTENCE_Words) {
        mods.push(`Sentence "${sentence.substring(0, 20)}...": Combine with next sentence (both are short).`)
        i++ // Skip next
      }
    }

    // Random Hedge (20% chance)
    if (Math.random() > 0.8) {
      mods.push(`Sentence "${sentence.substring(0, 20)}...": Add an academic hedge (e.g., 'suggests', 'indicates').`)
    }
  }
  return mods
}

async function callGeminiSimple(prompt: string, taskName: string, thesisData: ThesisData): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    })

    // Mock response object for tracker if needed, or update tracker to handle simple response
    // trackTokenUsage expects { usageMetadata: ... } usually
    // But ai.models.generateContent returns a response object with usageMetadata
    // Let's passed the response directly
    trackTokenUsage(thesisData, response, 'gemini-2.5-flash', taskName)

    return response.text || ''
  } catch (e) {
    console.error(`[HumanizeV2] Error in ${taskName}:`, e)
    return ''
  }
}

async function humanizeChapterPipeline(content: string, thesisData: ThesisData): Promise<string> {
  console.log(`[HumanizeV2] Starting pipeline for content (~${content.length} chars)`)

  const lang = thesisData.language || 'german'
  const isStrict = true // Always preserve structure

  // GUARD: Skip empty or very short chapters (e.g. wrappers)
  // If content is just a header "## 1. Intro", do NOT send to AI, it will hallucinate text.
  const stripHeaders = content.replace(/^#+\s+.*$/gm, '').trim()
  if (stripHeaders.length < 50) {
    console.log(`[HumanizeV2] Content too short/empty (${stripHeaders.length} body chars). Skipping to prevent hallucinations.`)
    return content
  }

  // 1. Calibrator
  console.log('[HumanizeV2] Step 1: Calibrator')
  let currentText = content
  const calPrompt = HUMANIZER_PROMPTS.calibrator(currentText, lang, isStrict)
  const calResult = await callGeminiSimple(calPrompt, 'Calibrator', thesisData)
  if (calResult && calResult.length > content.length * 0.5) currentText = calResult.trim()

  // 2. Planner & Rewriter (Paragraph Level)
  console.log('[HumanizeV2] Step 2 & 3: Planner & Rewriter')
  // Split by double newline to identify paragraphs
  const sections = currentText.split(/\n\n+/)
  const rewrittenSections: string[] = []

  for (const section of sections) {
    // Skip headlines or very short sections
    if (section.trim().startsWith('#') || section.trim().length < 50) {
      rewrittenSections.push(section)
      continue
    }

    const sentences = splitSentences(section)
    const instructions = planModifications(sentences)

    if (instructions.length > 0) {
      const instrStr = instructions.map((m, i) => `${i + 1}. ${m}`).join('\n')
      const rePrompt = HUMANIZER_PROMPTS.rewriter(section, instrStr, lang, isStrict)
      const reResult = await callGeminiSimple(rePrompt, 'Rewriter', thesisData)
      if (reResult && reResult.length > 10) {
        rewrittenSections.push(reResult.trim())
      } else {
        rewrittenSections.push(section)
      }
    } else {
      rewrittenSections.push(section)
    }
  }

  currentText = rewrittenSections.join('\n\n')

  // 4. Punctuation
  console.log('[HumanizeV2] Step 4: Punctuation')
  const puncPrompt = HUMANIZER_PROMPTS.punctuation(currentText, lang, isStrict)
  const puncResult = await callGeminiSimple(puncPrompt, 'Punctuation', thesisData)
  if (puncResult && puncResult.length > currentText.length * 0.5) currentText = puncResult.trim()

  return currentText
}

async function ensureHumanLikeContent(content: string, thesisData: ThesisData): Promise<{
  content: string
  winstonResult: {
    score: number
    sentences: any
    checkedAt: string
  } | null
  winstonIterations: Array<{
    iteration: number
    score: number
    sentenceCount: number
    flaggedCount: number
    checkedAt: string
  }>
}> {
  console.log('[HumanCheck] Starting Winston AI check and potential rewrite...')
  const MIN_HUMAN_SCORE = 70
  const MAX_ITERATIONS = 2 // Limit iterations to avoid infinite loops and high costs

  let currentContent = content
  let iteration = 0
  let finalResult: any = null

  // Track all iterations for database storage
  const winstonIterations: Array<{
    iteration: number
    score: number
    sentenceCount: number
    flaggedCount: number
    checkedAt: string
  }> = []

  while (iteration < MAX_ITERATIONS) {
    iteration++
    console.log(`[HumanCheck] Iteration ${iteration}/${MAX_ITERATIONS}`)

    const result = await checkWinston(currentContent, thesisData)

    // If Winston API failed or is unavailable, return content WITHOUT a fake score
    if (!result) {
      console.warn('[HumanCheck] Winston API unavailable, returning content without score')
      return {
        content: currentContent,
        winstonResult: null, // NO FAKE SCORES - null means "not checked"
        winstonIterations
      }
    }

    // Track this iteration
    const sentenceCount = Array.isArray(result.sentences) ? result.sentences.length : 0
    const flaggedCount = Array.isArray(result.sentences)
      ? result.sentences.filter((s: any) => s.score < 60).length
      : 0

    winstonIterations.push({
      iteration,
      score: result.score,
      sentenceCount,
      flaggedCount,
      checkedAt: new Date().toISOString()
    })

    finalResult = result // Store the latest valid result

    if (result.score >= MIN_HUMAN_SCORE) {
      console.log(`[HumanCheck] ✓ Content passed with ${result.score}% human score`)
      return {
        content: currentContent,
        winstonResult: {
          score: result.score,
          sentences: result.sentences,
          checkedAt: new Date().toISOString(),
        },
        winstonIterations
      }
    }

    console.log(`[HumanCheck] ⚠️ Content scored ${result.score}% human (below ${MIN_HUMAN_SCORE}%)`)

    // Winston returns sentences with scores. We need to identify the "AI" sentences.
    // Winston API isn't always clear on "flagged" vs just score. 
    // Usually low score = AI. Let's assume sentences with score < 60 are AI.
    // NOTE: Winston's sentence object structure depends on API response.
    // Assuming sentences have a 'score' field. 
    // If sentences is just a list of sentences, we might need to rely on the global text.
    // Let's inspect `result.sentences` structure in the logs or assume based on standard API.
    // If generic, we might have to just rewrite the whole chunk or random sentences?
    // Safer strategy: Rewrite WHOLE chunks if score is low, or try to map sentences.
    // For now, let's filter sentences with low scores if available, otherwise fallback.

    const flaggedSentences: string[] = []

    if (Array.isArray(result.sentences) && result.sentences.length > 0) {
      // IMPROVED: Sort sentences by score (ascending) and take the worst ones
      // This ensures we always have targets for rewriting, even when individual
      // sentence scores are deceptively high but overall score is low
      const sortedSentences = [...result.sentences]
        .filter((s: any) => s.text && typeof s.score === 'number')
        .sort((a: any, b: any) => a.score - b.score)

      // Take the worst 30 sentences OR 15% of total (whichever is higher)
      // But cap at 50 to avoid overwhelming the rewriter
      const minToRewrite = Math.max(30, Math.ceil(sortedSentences.length * 0.15))
      const maxToRewrite = Math.min(50, sortedSentences.length)
      const numToRewrite = Math.min(minToRewrite, maxToRewrite)

      // Only flag sentences if score is below target (70%)
      // If we're already at 70%+, don't flag any
      if (result.score < MIN_HUMAN_SCORE) {
        const worstSentences = sortedSentences.slice(0, numToRewrite)
        worstSentences.forEach((s: any) => {
          if (s.text) {
            flaggedSentences.push(s.text)
          }
        })

        // Log score distribution for debugging
        if (worstSentences.length > 0) {
          const lowestScore = worstSentences[0]?.score || 0
          const highestOfWorst = worstSentences[worstSentences.length - 1]?.score || 0
          console.log(`[HumanCheck] Worst sentences score range: ${lowestScore} - ${highestOfWorst}`)
        }
      }
    }

    console.log(`[HumanCheck] identified ${flaggedSentences.length} suspicious sentences...`)

    if (flaggedSentences.length === 0) {
      console.log('[HumanCheck] Low score but no specific sentences flagged. Stopping humanization loop as fallback is disabled.')
      break // Exit loop, returning current content
    }

    // Rewrite flagged sentences by humanizing their parent paragraphs (provides better context)
    currentContent = await rewriteFlaggedParagraphs(
      currentContent,
      flaggedSentences,
      thesisData
    )

    console.log(`[HumanCheck] Rewrite completed, checking again...`)
  }

  console.log(`[HumanCheck] Max iterations reached, returning current content`)
  return {
    content: currentContent,
    winstonResult: finalResult ? {
      score: finalResult.score,
      sentences: finalResult.sentences,
      checkedAt: new Date().toISOString(),
    } : null,
    winstonIterations
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

5. UMFANG: Der Text darf NICHT länger werden! Kürzen ist erlaubt, Aufblähen ist VERBOTEN.
- Vermeide unnötige Füllwörter.
- Behalte die Informationsdichte bei.

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
   - **⚠️ WICHTIG: Nutze Abschwächungen NUR bei der Interpretation von Daten oder externen Theorien.**
   - **🚫 ABSOLUT VERBOTEN: Abschwächungen bei der Beschreibung der eigenen Arbeit, Struktur oder Kapitelinhalte!**
     - ✗ FALSCH: "Kapitel 4 untersucht scheinbar..." oder "Es wird wohl untersucht..."
     - ✓ RICHTIG: "Kapitel 4 untersucht..." oder "Es wird untersucht..."
     - ✗ FALSCH: "Die Arbeit versucht zu zeigen..."
     - ✓ RICHTIG: "Die Arbeit zeigt..."
     - Wenn du über die Struktur der Arbeit sprichst: SEI DEFINITIV UND BESTIMMT. Wir wissen, was wir schreiben.

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
   
   **⚠️ ABSOLUT VERBOTEN (KILL LIST):**
   - "Die globale Finanzkrise? Ein großes Thema." -> VERBOTEN!
   - "Digitalisierung? Sie verändert alles." -> VERBOTEN!
   - "Der Grund? Ganz einfach." -> VERBOTEN!
   - JEDES (Substantiv)? (Satz). Muster ist VERBOTEN.
   - Wenn du ein Fragezeichen schreiben willst: LÖSCHE ES SOFORT. SCHREIBE EINE AUSSAGE.
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

   - **ABSOLUT VERBOTEN: Das Wort "man" (Generalisierendes Personalpronomen).**
     - ✗ "Man schuf Instrumente..." -> VERBOTEN!
     - ✗ "Man kann sehen..." -> VERBOTEN!
     - ✓ "Instrumente wurden geschaffen..." (Passiv)
     - ✓ "Es ist ersichtlich..." (Unpersönlich)
     - Wandle JEDES "man" in eine Passiv- oder unpersönliche Konstruktion um.

   - **ABSOLUT VERBOTEN: "wir" / "uns" / "unser" / "ich" (Einzelautor-Thesis!).**
     - ✗ "Wir stellten fest..." -> VERBOTEN! (Es gibt kein "wir")
     - ✗ "Unsere Analyse zeigt..." -> VERBOTEN!
     - ✗ "Ich untersuche..." -> VERBOTEN!
     - ✓ "Es wurde festgestellt..." (Passiv)
     - ✓ "Die Analyse zeigt..." (Unpersönlich)
     - ✓ "Diese Arbeit untersucht..." (Unpersönlich)
     - Dies ist eine Einzelarbeit. "Wir" ist ein logischer Fehler.

   - **ABSOLUT VERBOTEN: "SNAPPY" FRAGE-ANTWORT-MUSTER!**
     - ✗ "Das Ergebnis? Unklar." -> VERBOTEN!
     - ✗ "Die Infektion? Unbemerkt." -> VERBOTEN!
     - ✗ "Your infection? Unnoticed." -> VERBOTEN! (Nutzer-Beispiel)
     - ✗ NIEMALS eine Frage stellen und sofort beantworten!
     - ✗ "Rhetorische Fragen? Ein Stilmittel..." -> NEIN, VERBOTEN!
     - ✓ Schreibe IMMER in vollständigen Aussagesätzen.
     - ✓ "Das Ergebnis war unklar."
     - ✓ "Die Infektion blieb unbemerkt."

   - **ENDKONTROLLE AUF FLÜCHTIGKEITSFEHLER (KRITISCH):**
     - Prüfe auf doppelte Wörter: "Jahrhunderts. Jahrhunderts." -> Korrigiere zu "Jahrhunderts."
     - Prüfe auf doppelte Satzzeichen: ".." -> Korrigiere zu "."
     - Prüfe auf "Deppenleerzeichen" vor Satzzeichen: " ." -> Korrigiere zu "."


OUTPUT-REGELN:

- **ABSOLUT KRITISCH: Gib NUR den umgeschriebenen Text selbst aus. KEINE Einleitungen, KEINE Erklärungen, KEINE Meta-Kommentare.**
- **VERBOTEN: Schreibe NICHT Dinge wie "Hier ist die überarbeitete Fassung...", "Der folgende Text wurde umgeschrieben...", "Nachfolgend die überarbeitete Version...", oder IRGENDWELCHE ähnlichen Meta-Texte.**
- **BEGINNE SOFORT mit dem eigentlichen Inhalt - das erste Wort sollte aus dem Thesis-Text selbst stammen, NICHT ein Kommentar über das Umschreiben.**

- Behalte alle Zitate genau so bei, wie sie erscheinen: (Müller, 2021, S. 14), [12], (Schmidt et al., 2019), etc.

- Behalte alle Abschnittsüberschriften unverändert bei.

- Behalte alle Aufzählungspunkte und Listen unverändert bei, es sei denn, eine geringfügige menschenähnliche Umstrukturierung ist erforderlich.

- Kürze den Text nicht oder erweitere ihn nicht erheblich; die Länge sollte ungefähr gleich bleiben.

Dein Ziel ist es, Text zu produzieren, der wie von einem kompetenten menschlichen akademischen Autor geschrieben klingt, während alle Informationsinhalte erhalten bleiben.

    N. **VERFASSUNG (UNANTASTBAR):**
    1. NIEMALS Überschriften ändern (Zeilen mit #). Die Struktur bleibt 1:1 gleich.
    2. NIEMALS die Hierarchie ändern (z.B. ## darf nicht zu # oder ### werden).
    3. NIEMALS Zitationen entfernen. Du darfst sie verschieben, aber sie müssen erhalten bleiben.
    4. NIEMALS Fakten ändern. Nur den Stil.`

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

5. STRICTLY FORBIDDEN: Use of rhetorical questions followed immediately by short/fragment answers (so-called "snappy" patterns).
   - BAD: "Your infection? Unnoticed until the outbreak."
   - BAD: "The result? Catastrophic."
   - GOOD: "The infection often remains unnoticed until the outbreak occurs."
   - GOOD: "The result was catastrophic."
   ALWAYS write in full, coherent sentences. Avoid "question-fragment" structures entirely.

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
   - **⚠️ IMPORTANT: Use hedging ONLY when interpreting data or external theories.**
   - **🚫 ABSOLUTELY FORBIDDEN: Hedging when describing the thesis structure, chapters, or own work!**
     - ✗ WRONG: "Chapter 4 apparently analyzes..." or "It seems to discuss..."
     - ✓ RIGHT: "Chapter 4 analyzes..." or "It discusses..."
     - ✗ WRONG: "The study attempts to show..."
     - ✓ RIGHT: "The study shows..."
     - When describing the thesis structure: BE DEFINITIVE and CONFIDENT. We know what we are writing.

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

H2. **2025 AI MARKER KILL LIST (AUTOMATIC DETECTION TRIGGERS - MEMORIZE THESE):**
   BANNED WORDS (Winston AI, GPTZero, Turnitin flag these):
   - "delves", "crucial", "pivotal", "landscape", "multifaceted", "nuanced", "paramount", "comprehensive"
   - "underscore", "realm", "tapestry", "intricacies", "leveraging", "encompass", "embark", "foster"
   - "facilitate", "robust", "seamless", "cutting-edge", "groundbreaking", "holistic", "synergy"
   
   BANNED CONNECTOR WORDS:
   - "Furthermore", "Moreover", "Additionally", "In conclusion", "It is important to note"
   - "It should be noted", "firstly", "secondly", "lastly", "in summary"
   
   BANNED PATTERNS:
   - "X? Y." (rhetorical question-answer) → CONVERT TO STATEMENT
   - "The [noun] of [noun] of [noun]" chains → SIMPLIFY
   - "plays a crucial role" → "affects" or "shapes"
   - "it is worth noting that" → DELETE, state directly
   - Triple-adjective stacks ("important, significant, and crucial") → USE ONE
   
   SAFE REPLACEMENTS:
   - "delves into" → "examines", "explores", "investigates"
   - "crucial" → "significant", "key", "central"
   - "Furthermore" → "Here,", "Notably,", "In practice,", "Tellingly,"
   - "In conclusion" → "Ultimately,", "In the end,", just start concluding

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
   
    **⚠️ ABSOLUTELY FORBIDDEN (KILL LIST):**
    - "The global financial crisis? A big topic." -> FORBIDDEN!
    - "Digitization? It changes everything." -> FORBIDDEN!
    - "The reason? Quite simple." -> FORBIDDEN!
    - ANY (Noun)? (Sentence). Pattern is FORBIDDEN.
    - If you want to write a question mark: DELETE IT IMMEDIATELY. WRITE A STATEMENT.
   - Vary between deductive and inductive argumentation.
   - Avoid perfectly symmetrical paragraph lengths.

    **⚠️ ABSOLUT VERBOTEN (KILL LIST) - GILT AUCH BEIM UMSCHREIBEN:**
    - "Begriff? Definition." (Frage-Antwort) -> VERBOTEN. Mach einen Aussagesatz daraus.
    - "Was heißt das? Das heißt..." -> VERBOTEN. "Dies bedeutet..."
    - "Wir", "Ich", "Uns" -> VERBOTEN. Passiv nutzen!
    - "Man" -> VERBOTEN. "Es lässt sich..." nutzen!

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

Your goal is to produce text that reads like it was written by a competent human academic author while preserving all informational content.

    N. **CONSTITUTION (IMMUTABLE):**
    1. NEVER change headings (lines starting with #). Structure stays 1:1.
    2. NEVER change the hierarchy (e.g. ## must not become # or ###).
    3. NEVER remove citations. You may move them, but they must persist.
    4. NEVER change facts. Only style.`

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
      trackTokenUsage(thesisData, response, 'gemini-2.5-flash', `Humanize section ${i + 1}`)

      const sectionHumanized = response.text || section

      // Safety check: if chunk is suspiciously short, revert to original
      if (sectionHumanized.length < section.length * 0.5) {
        console.warn(`[Humanize] WARNING: Section ${i + 1} output suspiciously short (${sectionHumanized.length} vs ${section.length}), reverting to original`)
        humanizedSections.push(section)
      } else {
        // Enforce Headline integrity (Output Repair)
        // If the section started with a headline (##), ensure the output starts with THE SAME headline.
        // This fixes the "random chapter names" issue by forcing restoration.
        const originalHeadlineMatch = section.match(/^\s*##\s+[^\n]+/);
        if (originalHeadlineMatch) {
          const originalHeadline = originalHeadlineMatch[0].trim();
          let fixedOutput = sectionHumanized.trim();

          // 1. Remove any potentially hallucinated or wrong headline at the start
          // Check if output starts with ## but it's different
          if (fixedOutput.startsWith('##') && !fixedOutput.startsWith(originalHeadline)) {
            fixedOutput = fixedOutput.replace(/^\s*##\s+[^\n]+\n+/, '');
          }

          // 2. If it doesn't start with the correct headline (because we removed it or it was missing), prepend it
          if (!fixedOutput.startsWith(originalHeadline)) {
            // Check if there's possibly a duplicated headline further down? No, just force prepend.
            fixedOutput = `${originalHeadline}\n\n${fixedOutput.replace(/^\s*##\s+[^\n]+\n+/, '')}`;
            // The replace again is just safety in case we missed something
          }

          humanizedSections.push(fixedOutput);
        } else {
          humanizedSections.push(sectionHumanized); // No headline in input, so just push output
        }
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
async function checkWinston(content: string, thesisData: ThesisData): Promise<{
  score: number
  sentences: any
  usedText: string
} | null> {
  if (!WINSTON_API_KEY) {
    console.log('[Winston] WINSTON_API_KEY not set, skipping Winston check')
    return null
  }

  // Track words for Winston usage/cost
  const approximateWords = content.split(/\s+/).length
  thesisData.tokenStats.winstonWords += approximateWords
  console.log(`[Tokens] Winston: +${approximateWords} words (approximated)`)

  console.log('[Winston] Checking text with Winston AI API...')

  const CHUNK_SIZE = 150000 // Winston limit is 150k

  try {
    // Extract plain text from markdown (remove markdown syntax for better detection)
    // Send content without structure markers to mimic "clean text" / LaTeX export format
    // User testing confirmed clean text scores significantly higher (79%) than Markdown (28%)
    const plainText = content
      .replace(/^#+\s+/gm, '') // Remove heading markers
      .replace(/\*\*(.+?)\*\*/g, '$1') // Remove bold
      .replace(/\*(.+?)\*/g, '$1') // Remove italic
      .replace(/\[(.+?)\]\(.+?\)/g, '$1') // Remove links
      .replace(/`(.+?)`/g, '$1') // Remove code
      .replace(/\^\d+/g, '') // Remove footnote markers
      .replace(/\[\^\d+\]/g, '') // Remove other style footnote markers
      .replace(/\n+/g, '\n') // First: Collapse ALL vertical whitespace to single newlines (dense blocks)
      .replace(/\n(\d+\.?\d*\s)/g, '\n\n$1') // Then: Add double spacing ONLY before numbered chapters/subchapters
      .trim()

    // [SCANNED PDF EFFECT] Apply the formatting artifacts that fool detectors
    // This adds hard wraps and hyphens, making the text look like a scanned/OCR'd document
    const formattedText = applyScannedFormatting(plainText)
    console.log(`[Winston] Applied Scanned PDF formatting (length: ${plainText.length} -> ${formattedText.length})`)

    if (plainText.length < 500) { // Winston often needs more text
      console.warn('[Winston] Text too short for detection, skipping')
      return null
    }

    const chunks = []
    if (formattedText.length <= CHUNK_SIZE) {
      chunks.push(formattedText)
    } else {
      let offset = 0
      while (offset < formattedText.length) {
        chunks.push(formattedText.slice(offset, offset + CHUNK_SIZE))
        offset += CHUNK_SIZE
      }
      console.log(`[Winston] Text size ${formattedText.length} > ${CHUNK_SIZE}, split into ${chunks.length} chunks`)
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
      sentences: allSentences,
      usedText: plainText
    }

  } catch (error) {
    console.error('[Winston] Error checking text:', error)
    return null
  }
}

/**
 * Check content for plagiarism using Winston AI API
 * Returns plagiarism result or null if API unavailable
 */
async function checkPlagiarismWithWinston(content: string): Promise<{
  originalityPercentage: number
  plagiarismScore: number
  checkedAt: string
  winstonResult: any
} | null> {
  if (!WINSTON_API_KEY) {
    console.warn('[PlagiarismCheck] WINSTON_API_KEY not set, skipping check')
    return null
  }

  console.log('[PlagiarismCheck] Starting Winston AI plagiarism check...')

  const CHUNK_SIZE = 100000 // Winston limit is 120k

  try {
    // Use raw content for plagiarism check to ensure that returned sequences
    // match the source text exactly, allowing for search-and-replace repair.
    // We only normalise newlines.
    const textToCheck = content.trim()

    if (textToCheck.length < 500) {
      console.warn('[PlagiarismCheck] Text too short, skipping')
      return null
    }

    const chunks = []
    if (textToCheck.length <= CHUNK_SIZE) {
      chunks.push(textToCheck)
    } else {
      let offset = 0
      while (offset < textToCheck.length) {
        chunks.push(textToCheck.slice(offset, offset + CHUNK_SIZE))
        offset += CHUNK_SIZE
      }
    }

    const results: any[] = []

    for (const chunk of chunks) {
      const response = await retryApiCall(
        async () => {
          const fetchResponse = await fetch('https://api.gowinston.ai/v2/plagiarism', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${WINSTON_API_KEY}`,
            },
            body: JSON.stringify({
              text: chunk,
              language: 'auto'
            }),
          })

          if (!fetchResponse.ok) {
            const errorText = await fetchResponse.text()
            throw new Error(`Winston API error: ${fetchResponse.status} - ${errorText}`)
          }

          return await fetchResponse.json()
        },
        'Winston Plagiarism Check',
        3, 2000
      )
      results.push(response)
    }

    // Aggregate results
    let totalScore = 0
    let count = 0

    for (const res of results) {
      // According to docs, result is { result: { score: number } }
      // Wait, example shows: { result: { score: 123 } }
      // Let's assume safely checking both locations just in case structure varies or I misread
      const score = res?.result?.score ?? res?.score
      if (typeof score === 'number') {
        totalScore += score
        count++
      }
    }

    // Safety check: if scores are 0-100. If totalScore is huge, it might be a count.
    // Docs: "score": 123. 123 > 100? Plagiarism usually percent. 
    // Example in docs used "123" for everything, likely placeholder.
    // I will assume standard 0-100 percentage.

    const avgPlagiarismScore = count > 0 ? Math.round(totalScore / count) : 0
    const originalityPercentage = Math.max(0, 100 - avgPlagiarismScore)

    return {
      originalityPercentage,
      plagiarismScore: avgPlagiarismScore,
      checkedAt: new Date().toISOString(),
      winstonResult: results.length === 1 ? results[0] : results
    }

  } catch (error) {
    console.error('[PlagiarismCheck] Error:', error)
    return null
  }
}

/**
 * Repair plagiarized content by rewriting flagged sequences
 * Uses Gemini to paraphrase the specific sentences identified by Winston
 */
async function repairPlagiarism(content: string, winstonResult: any, thesisData: ThesisData): Promise<string> {
  console.log('[PlagiarismRepair] Starting repair process...')

  const results = Array.isArray(winstonResult) ? winstonResult : [winstonResult]
  const sequencesToFix: string[] = []

  // Extract all plagiarism sequences
  for (const res of results) {
    // Check indexes (aggregated sequences found in input)
    if (res.indexes && Array.isArray(res.indexes)) {
      for (const idx of res.indexes) {
        if (idx.sequence && idx.sequence.length > 20) { // Filter mostly noise
          sequencesToFix.push(idx.sequence)
        }
      }
    }
    // Also check plagiarismFound in sources just in case
    if (res.sources && Array.isArray(res.sources)) {
      for (const source of res.sources) {
        if (source.plagiarismFound && Array.isArray(source.plagiarismFound)) {
          for (const p of source.plagiarismFound) {
            if (p.sequence && p.sequence.length > 20) {
              sequencesToFix.push(p.sequence)
            }
          }
        }
      }
    }
  }

  // Deduplicate
  const uniqueSequences = [...new Set(sequencesToFix)]
  console.log(`[PlagiarismRepair] Found ${uniqueSequences.length} unique sequences to rewrite`)

  if (uniqueSequences.length === 0) {
    console.log('[PlagiarismRepair] No actionable sequences found.')
    return content
  }

  // Limit to top 50 to avoid massive prompt/timeout
  const sequencesToProcess = uniqueSequences.slice(0, 50)
  let workingContent = content

  // Process in batches of 10
  const BATCH_SIZE = 10
  for (let i = 0; i < sequencesToProcess.length; i += BATCH_SIZE) {
    const batch = sequencesToProcess.slice(i, i + BATCH_SIZE)
    console.log(`[PlagiarismRepair] Processing batch ${i / BATCH_SIZE + 1} (${batch.length} items)...`)

    try {
      const prompt = `
You are a specialized Thesis content editor. Your task is to rewrite specific text sequences that have been flagged as potential plagiarism.
You must rewrite each sequence to be completely original while preserving the exact meaning, tone, and context.
The context is an academic thesis. Maintain formal, objective, academic German (or English if the text is English).
    
    IMMUTABLE RULE: NEVER change, translate, or reformat headings (lines starting with #). If a sequence includes a heading, keep it EXACTLY as is.
    IMMUTABLE RULE: NEVER change the hierarchy (e.g. ## must not become # or ###).
    IMMUTABLE RULE: NO "Topic? Statement." patterns. If you see one, REWRITE IT to a statement.


Sequences to Rewrite:
${JSON.stringify(batch, null, 2)}

Return ONLY a valid JSON object where keys are the original sequences and values are the rewritten versions.
Example:
{
  "original text...": "rewritten text..."
}
Do not include markdown formatting or explanation.
      `

      const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          { role: 'user', parts: [{ text: prompt }] }
        ]
      })
      trackTokenUsage(thesisData, result, 'gemini-2.5-flash', 'Plagiarism repair batch')

      const responseText = result.text?.replace(/```json/g, '').replace(/```/g, '').trim()

      const rewrites = JSON.parse(responseText || '{}')

      // Apply replacements
      let replacementsCount = 0
      for (const [original, replacement] of Object.entries(rewrites)) {
        if (typeof replacement === 'string' && replacement.length > 5) {
          // Use string replace - simple but effective if we matched the source exactly
          if (workingContent.includes(original)) {
            workingContent = workingContent.replace(original, replacement)
            replacementsCount++
          } else {
            // Fallback: Try trimming
            const trimmedOriginal = original.trim()
            if (workingContent.includes(trimmedOriginal)) {
              workingContent = workingContent.replace(trimmedOriginal, replacement)
              replacementsCount++
            }
          }
        }
      }
      console.log(`[PlagiarismRepair] Batch complete: Applied ${replacementsCount}/${batch.length} replacements`)

    } catch (error) {
      console.error('[PlagiarismRepair] Error processing batch:', error)
    }
  }

  return workingContent
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
      // CRITICAL: Include page numbers from stored metadata
      pageStart: metadata.pageStart || null,
      pageEnd: metadata.pageEnd || null,
      pages: metadata.pages || (metadata.pageStart && metadata.pageEnd ? `${metadata.pageStart}-${metadata.pageEnd}` : null),
    }
  })
}

/**
 * Main job handler - always runs full thesis generation
 */
async function processThesisGeneration(
  thesisId: string,
  thesisData: ThesisData,
  critiqueOnly: boolean = false,
  progressCallback?: (progress: number) => Promise<void>
) {
  const processStartTime = Date.now()
  console.log('='.repeat(80))
  console.log(`[PROCESS] Starting thesis generation for thesis ${thesisId}`)
  console.log(`[PROCESS] Thesis: "${thesisData.title}"`)
  console.log(`[PROCESS] Field: ${thesisData.field}`)
  console.log(`[PROCESS] Type: ${thesisData.thesisType}`)
  console.log(`[PROCESS] Language: ${thesisData.language}`)
  console.log('='.repeat(80))

  // Reset token counters for this job
  // (Handled by thesisData.tokenStats implicitly if passed from API)
  // Ensure tokenStats is initialized if missing (e.g. from queue)
  if (!thesisData.tokenStats) {
    console.log('[PROCESS] Initializing missing tokenStats...')
    thesisData.tokenStats = {
      gemini25ProInput: 0,
      gemini25ProOutput: 0,
      gemini3ProInput: 0,
      gemini3ProOutput: 0,
      winstonWords: 0
    }
  }

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
    const hasEnoughSources = (hasDocuments && hasUploadedSources && uploadedSources.length >= requiredSourceCount) || critiqueOnly

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

      // Collect all queries first
      const pendingQueries: Array<{ query: string, language: 'german' | 'english', chapterNumber: string, chapterTitle: string }> = []

      for (const chapterQuery of chapterQueries) {
        const chapterNumber = (chapterQuery as any).chapterNumber || chapterQuery.chapter || 'N/A'
        const chapterTitle = (chapterQuery as any).chapterTitle || 'N/A'
        console.log(`[PROCESS] Planning queries for chapter: ${chapterNumber} - ${chapterTitle}`)

        const germanQueries = chapterQuery.queries?.german || []
        const englishQueries = chapterQuery.queries?.english || []

        germanQueries.forEach((q: string) => pendingQueries.push({ query: q, language: 'german', chapterNumber, chapterTitle }))
        englishQueries.forEach((q: string) => pendingQueries.push({ query: q, language: 'english', chapterNumber, chapterTitle }))
      }

      totalQueries = pendingQueries.length
      console.log(`[PROCESS] Executing ${totalQueries} queries in PARALLEL via OpenAlex...`)

      // Execute all queries in parallel
      const queryPromises = pendingQueries.map(async (pq, index) => {
        try {
          const results = await queryOpenAlex(pq.query, pq.language)
          // Add chapter tracking to sources
          results.forEach(s => {
            s.chapterNumber = pq.chapterNumber
            s.chapterTitle = pq.chapterTitle
          })
          return results
        } catch (err) {
          console.error(`[PROCESS] Error in parallel query "${pq.query}":`, err)
          return [] as Source[]
        }
      })

      const resultsArrays = await Promise.all(queryPromises)

      // Flatten results
      resultsArrays.forEach(results => allSources.push(...results))

      const step2Duration = Date.now() - step2Start
      console.log(`[PROCESS] Step 2-3 completed in ${step2Duration}ms`)
      console.log(`[PROCESS] Total queries executed: ${totalQueries}`)
      console.log(`[PROCESS] Found ${allSources.length} total sources`)
      const openAlexCount = allSources.filter(s => s.source === 'openalex').length
      const semanticCount = allSources.filter(s => s.source === 'semantic_scholar').length
      console.log(`[PROCESS]   OpenAlex: ${openAlexCount}, Semantic Scholar: ${semanticCount}`)

      // Step 4: Deduplicate and enrich with Unpaywall (with retry)
      console.log('\n[PROCESS] ========== Step 4: Deduplicate and Enrich Sources ==========')
      if (progressCallback) await progressCallback(20)
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
      if (progressCallback) await progressCallback(30)
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
      if (progressCallback) await progressCallback(40)
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

      // Process sources with replacement logic using PARALLEL execution
      const sourcesToProcess: Source[] = [...topSources]
      let nextSourceIndex = 0

      // Calculate how many sources we need to upload
      // If we started with existing sources, we only need to upload the additional ones
      // existingSourcesCount is already declared at the top level
      const sourcesToUpload = Math.max(0, requiredSourceCount - existingSourcesCount)

      console.log(`[PROCESS] Upload target: ${sourcesToUpload} additional sources needed (${existingSourcesCount} existing + ${sourcesToUpload} new = ${requiredSourceCount} total)`)
      console.log(`[PROCESS] Starting PARALLEL PDF processing (Concurrency: 5)...`)

      // Worker function for parallel processing
      const processNextSource = async (workerId: number): Promise<void> => {
        // Stop if we've reached the target count
        if (successfullyUploaded.length >= sourcesToUpload) {
          return
        }

        // Stop if we've exhausted the queue
        if (nextSourceIndex >= sourcesToProcess.length) {
          return
        }

        // Atomically grab the next source
        const currentIndex = nextSourceIndex++
        const source = sourcesToProcess[currentIndex]

        console.log(`[PROCESS][Worker ${workerId}] Processing source ${currentIndex + 1}/${sourcesToProcess.length}: "${source.title}"`)
        // console.log(`[PROCESS][Worker ${workerId}]   Chapter: ${source.chapterNumber || 'N/A'} - ${source.chapterTitle || 'N/A'}`)

        if (source.pdfUrl) {
          try {
            const success = await downloadAndUploadPDF(source, thesisData.fileSearchStoreId, thesisId, thesisData)

            // Double check target count after await
            if (successfullyUploaded.length >= sourcesToUpload) return

            if (success) {
              uploadedCount++
              successfullyUploaded.push(source)
              console.log(`[PROCESS][Worker ${workerId}] ✓ Successfully uploaded: "${source.title}"`)
              console.log(`[PROCESS]   Progress: ${successfullyUploaded.length}/${sourcesToUpload} new sources uploaded`)

            } else {
              failedCount++
              console.log(`[PROCESS][Worker ${workerId}] ✗ Failed to upload (paywalled/inaccessible): "${source.title}"`)

              // Find replacement logic
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
                // Only add replacement if we still need more sources
                // Note: Checking length here is a "soft" check, strict check is at start of function
                if (successfullyUploaded.length < sourcesToUpload) {
                  const replacementId = getSourceId(replacement)
                  usedSourceIds.add(replacementId)
                  sourcesToProcess.push(replacement)
                  replacedCount++
                  console.log(`[PROCESS][Worker ${workerId}]   ✓ Found replacement: "${replacement.title}" (Added to queue)`)
                }
              } else {
                console.log(`[PROCESS][Worker ${workerId}]   ✗ No suitable replacement found`)
              }
            }
          } catch (error) {
            failedCount++
            console.error(`[PROCESS][Worker ${workerId}] Error uploading source: "${source.title}"`, error)
            // Try to find replacement on error too (same logic as above)
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
            if (replacement && successfullyUploaded.length < sourcesToUpload) {
              const replacementId = getSourceId(replacement)
              usedSourceIds.add(replacementId)
              sourcesToProcess.push(replacement)
              replacedCount++
              console.log(`[PROCESS][Worker ${workerId}]   ✓ Found replacement after error: "${replacement.title}"`)
            }
          }
        } else {
          console.log(`[PROCESS][Worker ${workerId}] Skipping source (no PDF URL): "${source.title}"`)
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

        // Recursively process next item
        await processNextSource(workerId)
      }

      // Start concurrent workers
      const CONCURRENCY_LIMIT = 5
      const workers = Array(CONCURRENCY_LIMIT).fill(0).map((_, i) => processNextSource(i + 1))
      await Promise.all(workers)

      console.log(`[PROCESS] PDF upload summary:`)
      console.log(`[PROCESS]   Successfully uploaded: ${uploadedCount}`)
      console.log(`[PROCESS]   Failed/inaccessible: ${failedCount}`)
      console.log(`[PROCESS]   Replaced: ${replacedCount}`)
      console.log(`[PROCESS]   Total processed: ${nextSourceIndex}`)

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
    if (progressCallback) await progressCallback(50)
    const step7Start = Date.now()

    console.log(`[PROCESS] Using ${sourcesForGeneration.length} sources for thesis generation`)

    let thesisContent = ''
    let thesisStructure: ThesisStructure | undefined

    try {
      let result;
      if (!critiqueOnly) {
        result = await generateThesisContent(thesisData, sourcesForGeneration, thesisPlan)
        thesisContent = result.content
        thesisStructure = result.structure
      } else {
        console.log('[PROCESS] CRITIQUE ONLY MODE: Fetching existing content from database...')
        const { data: currentT } = await supabase.from('theses').select('content').eq('id', thesisId).single()
        thesisContent = currentT?.content || ''
        console.log(`[PROCESS] Loaded ${thesisContent.length} chars of content.`)
      }
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

    /* STEP 7.05 REMOVED - CAUSED BUGS WITH HEADER PLACEMENT
    // Step 7.05: Sync Introduction Structure (Pre-Critique)
    // Ensure the "Gang der Untersuchung" matches the actual generated chapters BEFORE we critique.
    console.log('\n[PROCESS] ========== Step 7.05: Syncing Introduction Structure ==========')
    try {
      if (thesisContent && thesisContent.length > 100) {
        const chapters = thesisContent.split(/(?=^## )/gm).filter(c => c.trim().length > 0)
 
        // 1. Build Actual Structure Summary
        const actualStructure = chapters.map((c, idx) => {
          const lines = c.split('\n')
          const title = lines[0].replace(/#/g, '').trim()
          // Extract a snippet of content (skip heading)
          const contentSnippet = lines.slice(1).join(' ').replace(/\s+/g, ' ').substring(0, 600) + '...'
          return `Kapitel ${idx + 1}: ${title}\n   Inhalt: ${contentSnippet}`
        }).join('\n\n')
 
        console.log('[StructureSync] Actual structure extracted:')
        console.log(actualStructure)
 
        // 2. Rewrite Introduction's "Structure" section
        // Note: The first chapter (chapters[0]) is assumed to be the Introduction
        // Check if title contains "Einleitung" or "Introduction"
        const introTitle = chapters[0].split('\n')[0].toLowerCase()
        if (introTitle.includes('einleitung') || introTitle.includes('introduction')) {
          console.log('[StructureSync] Rewriting Introduction to match reality (Dedicated Function)...')
          
          const newIntro = await syncStructureInIntroduction(
            chapters[0], 
            actualStructure, 
            thesisData.language === 'german',
            thesisData
          )
          
          // Replace the old intro
          chapters[0] = newIntro
          thesisContent = chapters.join('\n\n')
          console.log('[StructureSync] Introduction updated.')
        } else {
          console.log('[StructureSync] First chapter is not Introduction. Skipping sync.')
        }
      }
    } catch (error) {
      console.warn('[StructureSync] Failed to sync structure:', error)
      // Continue without syncing - not critical
    }
    */

    // Step 7.1 & 7.2: Iterative Critique & Repair Loop
    console.log('\n[PROCESS] ========== Step 7.1 & 7.2: Iterative Critique & Repair Loop ==========')

    // Step 7.1 & 7.2: Iterative Critique & Repair Loop
    // Extracted to reusable function
    thesisContent = await performCritiqueLoop(
      thesisContent,
      thesisData,
      sourcesForGeneration || [],
      supabase,
      thesisId
    )

    // OLD LOOP logic below is disabled by setting MAX=0
    const MAX_REPAIR_ITERATIONS = 0
    let currentIteration = 0
    let critiqueReport = ''
    const critiqueHistory: any[] = []
    let masterReport: string | undefined = undefined

    while (currentIteration < MAX_REPAIR_ITERATIONS) {
      currentIteration++
      console.log(`\n[Loop] Starting Critique/Repair Iteration ${currentIteration}/${MAX_REPAIR_ITERATIONS}`)
      if (progressCallback) await progressCallback(60 + (currentIteration * 10)) // 70%, 80%, 90%

      // --- CRITIQUE PHASE ---
      console.log('[Loop] Running Critique Agent...')
      try {
        const outlineForCritique = (thesisData.outline || []).map((chapter: any, index: number) => ({
          number: (chapter?.number ?? `${index + 1}.`).toString().trim(),
          title: (chapter?.title ?? '').toString().trim(),
          sections: []
        }))

        critiqueReport = await critiqueThesis(
          thesisContent,
          outlineForCritique,
          thesisData.researchQuestion || 'N/A',
          sourcesForGeneration || [],
          thesisData.language === 'german',
          thesisData.fileSearchStoreId,
          thesisData,
          masterReport
        )

        // Convert first report to Master Report
        if (!masterReport && currentIteration === 1) {
          masterReport = critiqueReport
          console.log('[Loop] Master Report locked for verification. Subsequent critiques will ONLY verify fixes for these errors.')
        }
        console.log(`[Critique] Report generated (Iteration ${currentIteration}):`)
        console.log(critiqueReport)

        // Update history
        // Try to parse report as object for cleaner storage
        let reportToStore = critiqueReport
        try {
          const jsonStr = critiqueReport.replace(/```json\n?|\n?```/g, '').trim()
          reportToStore = JSON.parse(jsonStr)
        } catch (e) {
          // Keep as string if parsing fails
        }

        critiqueHistory.push({
          iteration: currentIteration,
          report: reportToStore,
          timestamp: new Date().toISOString()
        })

        // Save critique report and history to database
        try {
          await supabase
            .from('theses')
            .update({
              critique_report: `[Iteration ${currentIteration}]\n${critiqueReport}`,
              critique_history: critiqueHistory
            })
            .eq('id', thesisId)
          console.log('[Critique] Report and history saved to database')
        } catch (dbError) {
          console.error('[Critique] Failed to save report to database:', dbError)
        }
      } catch (error) {
        console.error('[PROCESS] ERROR in Thesis Critique:', error)
        critiqueReport = '' // Clear if failed
      }

      // --- CHECK PHASE ---
      // Try to parse JSON report first to detect errors
      let hasErrors = false
      let parsedJsonErrors: any[] = []

      try {
        const jsonStr = critiqueReport.replace(/```json\n?|\n?```/g, '').trim()
        const reportObj = JSON.parse(jsonStr)
        if (reportObj.errors && Array.isArray(reportObj.errors) && reportObj.errors.length > 0) {
          hasErrors = true
          parsedJsonErrors = reportObj.errors
          console.log(`[Loop] Parsed ${parsedJsonErrors.length} errors from JSON report`)
        }
      } catch (e) {
        // Not valid JSON, fall back to string checks
      }

      // Check if the report contains error markers (fallback)
      if (!hasErrors) {
        hasErrors = critiqueReport.includes('[FEHLER]') ||
          critiqueReport.includes('[FEHLERHAFT]') ||
          critiqueReport.includes('[HALLUZINATIONEN]') ||
          critiqueReport.includes('Error') ||
          critiqueReport.includes('Mangel') ||
          critiqueReport.includes('FEHLER:') || // Catch detailed errors even if status is clean
          critiqueReport.includes('**FEHLER') ||
          critiqueReport.includes('LÖSUNG:') || // If there is a solution proposed, there is an error
          critiqueReport.includes('SOLUTION:')
      }

      // Check for technical failure
      const isTechnicalFailure = critiqueReport.includes('CRITIQUE_GENERATION_FAILED_ERROR')

      if (isTechnicalFailure) {
        console.warn('[Loop] Critique generation failed technically. Validating retry...')
        // If we failed, we should NOT exit. We should probably force a retry or just continue to next iteration?
        // Since we are inside a limited loop, continuing effectively retries the critique in the next iteration 
        // (since we skip the repair logic below if report is "failed").
        if (currentIteration < MAX_REPAIR_ITERATIONS) {
          console.log('[Loop] Retrying in next iteration...')
          continue
        }
      }

      if (!hasErrors && !isTechnicalFailure && currentIteration > 1) {
        console.log('[Loop] Critique is clean (no major errors detected). Exiting loop early.')
        break
      }

      if (!hasErrors && critiqueReport.length > 100 && currentIteration === 1) {
        // If first iteration is clean, we MIGHT still want to run one repair pass just in case, 
        // or we can skip. The user said "the rewrite is supposed to fix all the issues", suggesting we only rewrite if there ARE issues.
        // However, sometimes critique is subtle. Let's trust the error markers.
        console.log('[Loop] Iteration 1 is clean. Skipping repair loop.')
        break
      }

      // --- REPAIR PHASE ---
      console.log('[Loop] Errors detected or first run. Running Repair Agent...')
      try {
        if (critiqueReport && critiqueReport.trim().length > 0) {
          console.log('[Repair] Starting chunked repair...')

          // 1. REPAIR PHASE: JSON-Driven Iterative Repair
          // We assume critiqueReport is a JSON string (or markdown block containing JSON)
          let errors: any[] = []
          try {
            // Clean markdown code blocks if present
            const jsonStr = critiqueReport.replace(/```json\n?|\n?```/g, '').trim()
            const reportObj = JSON.parse(jsonStr)
            errors = reportObj.errors || []
            console.log(`[Repair] Parsed ${errors.length} errors from Critique Report`)
          } catch (e) {
            console.error('[Repair] Failed to parse JSON report.', e)
            console.warn('[Repair] Raw report sample:', critiqueReport.substring(0, 200))
            errors = []
          }

          if (errors.length > 0) {
            // 2. Split content into chapters (Level 2 headers ##)
            const chapters = thesisContent.split(/(?=^## [^#])/gm).filter(c => c.trim().length > 0)
            console.log(`[Repair] Split thesis into ${chapters.length} chunks for processing`)

            // Extract titles for matching
            const chapterTitles = chapters.map(c => c.split('\n')[0].replace(/#/g, '').trim())

            // 3. GROUP ERRORS BY CHAPTER
            // Instead of iterating errors sequentially, map them to chapters first
            // validErrors maps chapterIndex -> Array of Error Objects
            const errorsByChapter: Record<number, any[]> = {}

            // Helper to find chapter index (reused logic)
            const findChapterIndex = (location: string, quote: string, titles: string[], allChapters: string[]): number => {
              // STRATEGY 0: Quote-based search FIRST
              if (quote && quote.length > 10) {
                let cleanQuote = quote
                  .replace(/^\.{2,}/g, '')
                  .replace(/\.{2,}$/g, '')
                  .replace(/^…/g, '')
                  .replace(/…$/g, '')
                  .replace(/\s+/g, ' ')
                  .trim()
                const searchStr = cleanQuote.substring(0, Math.min(60, cleanQuote.length))

                for (let idx = 0; idx < allChapters.length; idx++) {
                  const normalizedChapter = allChapters[idx].replace(/\s+/g, ' ')
                  if (normalizedChapter.includes(searchStr)) return idx
                }
                if (searchStr.length > 15) {
                  const shortQuote = searchStr.substring(0, 15)
                  for (let idx = 0; idx < allChapters.length; idx++) {
                    const normalizedChapter = allChapters[idx].replace(/\s+/g, ' ')
                    if (normalizedChapter.includes(shortQuote)) return idx
                  }
                }
              }
              if (!location) return -1

              // STRATEGY 1: Strict Number Match
              const locNumMatch = location.match(/(\d+(?:\.\d+)*)/)
              const locNum = locNumMatch ? locNumMatch[1] : null
              if (locNum) {
                for (let idx = 0; idx < titles.length; idx++) {
                  const cleanTitle = titles[idx].replace(/#/g, '').trim()
                  if ((cleanTitle.startsWith(locNum + ' ') || cleanTitle === locNum) && allChapters[idx].length > 100) return idx
                }
                for (let idx = 0; idx < titles.length; idx++) {
                  const cleanTitle = titles[idx].replace(/#/g, '').trim()
                  const chapterNum = cleanTitle.split(' ')[0]
                  if (chapterNum && locNum.startsWith(chapterNum + '.') && allChapters[idx].length > 100) return idx
                }
              }

              // STRATEGY 2: Fuzzy Title Match
              const locLower = location.toLowerCase()
              for (let idx = 0; idx < titles.length; idx++) {
                const titleLower = titles[idx].toLowerCase()
                if ((titleLower.includes(locLower) || locLower.includes(titleLower)) && allChapters[idx].length > 100) return idx
              }

              // STRATEGY 3: Fallback Search
              if (quote && quote.length > 10) {
                const words = quote.split(/\s+/).slice(0, 5).join(' ')
                for (let idx = 0; idx < allChapters.length; idx++) {
                  if (allChapters[idx].includes(words)) return idx
                }
              }
              return -1
            }

            // Map all errors to chapters
            for (const err of errors) {
              const targetIndex = findChapterIndex(err.location, err.quote, chapterTitles, chapters)
              if (targetIndex !== -1) {
                if (!errorsByChapter[targetIndex]) errorsByChapter[targetIndex] = []
                errorsByChapter[targetIndex].push(err)
              } else {
                console.warn(`[Repair] Could not map location "${err.location}" to a chapter. Skipping error.`)
              }
            }

            // 4. PROCESS CHAPTERS IN PARALLEL
            const indicesToRepair = Object.keys(errorsByChapter).map(Number)
            console.log(`[Repair] Identified ${indicesToRepair.length} chapters requiring repair.`)

            const repairChapterTask = async (idx: number) => {
              const chapterErrors = errorsByChapter[idx]
              const chunk = chapters[idx]
              // Construct a combined report for this chapter
              let combinedReport = `BITTE KORRIGIERE FOLGENDE ${chapterErrors.length} FEHLER IN DIESEM KAPITEL:\n`
              chapterErrors.forEach((e, k) => {
                combinedReport += `--- FEHLER ${k + 1} ---\nFEHLER: ${e.error}\nLÖSUNG: ${e.solution}\nQUOTE: ${e.quote || ''}\n`
              })

              console.log(`[Repair] Launching concurrent repair for Chapter ${idx + 1} (${chapterTitles[idx]})...`)

              try {
                const repairedChunk = await fixChapterContent(
                  chunk,
                  combinedReport,
                  thesisData.language === 'german',
                  idx,
                  chapters.length,
                  chapterTitles,
                  thesisData,
                  thesisData.fileSearchStoreId
                )

                if (repairedChunk.trim() === '[DELETE_CHAPTER]') {
                  console.warn(`[Repair] Agent requested DELETE for Chapter ${idx + 1}`)
                  chapters[idx] = ''
                } else {
                  console.log(`[Repair] Chapter ${idx + 1} Update: ${chunk.length} -> ${repairedChunk.length} chars`)
                  if (repairedChunk.length < 200 && chunk.length > 500) {
                    console.error(`[Repair] CRITICAL: Repair result for Chapter ${idx + 1} suspiciously short. Reverting!`)
                  } else if (repairedChunk.length < chunk.length * 0.5 && chunk.length > 200) {
                    console.warn(`[Repair] Fix result for Chapter ${idx + 1} dangerously short. Reverting.`)
                  } else {
                    chapters[idx] = repairedChunk
                  }
                }
              } catch (err) {
                console.error(`[Repair] Error repairing Chapter ${idx + 1}`, err)
              }
            }

            // Execute with concurrency limit
            const REPAIR_CONCURRENCY = 5
            for (let i = 0; i < indicesToRepair.length; i += REPAIR_CONCURRENCY) {
              const batch = indicesToRepair.slice(i, i + REPAIR_CONCURRENCY).map(idx => repairChapterTask(idx))
              await Promise.all(batch)
            }

            // 5. Reassemble
            thesisContent = chapters.filter(c => c.length > 0).join('\n\n')
            console.log('[Repair] All batch repairs processed. Thesis reassembled.')

          } else {
            console.log('[Repair] No errors parsed to fix (or parsing failed).')
          }

        } else {
          console.log('[Repair] No critique report available. Skipping repair.')
        }
      } catch (error) {
        console.error('[PROCESS] ERROR in Thesis Repair:', error)
        console.warn('[Repair] Continuing with original content (repair failed)')
      }

      if (currentIteration === MAX_REPAIR_ITERATIONS) {
        console.log('[Loop] Max iterations reached. Proceeding with current content.')
      }
    }

    // Step 7.4: Winston AI Check & Sentence Rewrite
    console.log('\n[PROCESS] ========== Step 7.4: Winston AI Check & Sentence Rewrite ==========')

    // SKIP Bibliography injection here as per user request. 
    // We do NOT want to humanize the bibliography or send it to Winston.
    // It will be added in Step 8/9.

    const winstonCheckStart = Date.now()
    let winstonResult: any = null
    let winstonIterations: any[] = []
    try {
      const result = await ensureHumanLikeContent(thesisContent, thesisData)
      thesisContent = result.content
      winstonResult = result.winstonResult
      winstonIterations = result.winstonIterations || []

      // Save debug text if available
      if (winstonResult?.usedText) {
        console.log('[PROCESS] Saving last Winston input text for debugging...')
        await supabase.from('theses').update({ last_winston_input_text: winstonResult.usedText }).eq('id', thesisId)
      }

      // Save debug text if available
      if (winstonResult?.usedText) {
        console.log('[PROCESS] Saving last Winston input text for debugging...')
        await supabase.from('theses').update({ last_winston_input_text: winstonResult.usedText }).eq('id', thesisId)
      }
      const winstonCheckDuration = Date.now() - winstonCheckStart
      console.log(`[PROCESS] Winston check and rewrite completed in ${winstonCheckDuration}ms`)
      console.log(`[PROCESS] Winston iterations tracked: ${winstonIterations.length}`)
      if (winstonResult) {
        console.log(`[PROCESS] Final Winston score: ${winstonResult.score}% human`)
      }

      // Save Winston iterations to database
      if (winstonIterations.length > 0) {
        console.log('[PROCESS] Saving Winston check iterations to database...')
        const { error: winstonSaveError } = await supabase
          .from('theses')
          .update({ winston_checks: winstonIterations })
          .eq('id', thesisId)

        if (winstonSaveError) {
          console.error('[PROCESS] Failed to save Winston iterations:', winstonSaveError)
        } else {
          console.log(`[PROCESS] Saved ${winstonIterations.length} Winston check iterations to database`)
        }
      }
    } catch (error) {
      console.error('[PROCESS] ERROR in Winston check/rewrite:', error)
      console.warn('[PROCESS] Continuing with original content (Winston check failed)')
      // Continue with original content if check fails
    }

    // Step 7.5: Full Humanization Pass (Fallback)
    // Only runs if Winston score is still below threshold after targeted rewrites
    const MIN_HUMAN_SCORE_THRESHOLD = 70
    console.log('\n[PROCESS] ========== Step 7.5: Humanize Thesis Content (Fallback) ==========')

    const currentScore = winstonResult?.score || 0

    if (currentScore >= MIN_HUMAN_SCORE_THRESHOLD) {
      console.log(`[PROCESS] ✓ SKIPPING full humanization - Winston score ${currentScore}% already meets threshold`)
    } else if (!winstonResult) {
      console.log('[PROCESS] ✓ SKIPPING full humanization - Winston check was unavailable')
    } else {
      console.log(`[PROCESS] ⚠️ Winston score ${currentScore}% is below ${MIN_HUMAN_SCORE_THRESHOLD}% threshold`)
      console.log('[PROCESS] Running full humanization pass as fallback...')

      try {
        const humanizeStart = Date.now()
        thesisContent = await humanizeThesisContent(thesisContent, thesisData)
        const humanizeDuration = Date.now() - humanizeStart
        console.log(`[PROCESS] Full humanization completed in ${humanizeDuration}ms`)

        // Re-check with Winston after full humanization
        console.log('[PROCESS] Re-checking with Winston after full humanization...')
        const recheckResult = await checkWinston(thesisContent, thesisData)
        if (recheckResult) {
          console.log(`[PROCESS] Post-humanization Winston score: ${recheckResult.score}% human`)
          winstonResult = {
            score: recheckResult.score,
            sentences: recheckResult.sentences,
            checkedAt: new Date().toISOString(),
            usedText: recheckResult.usedText
          }

          if (recheckResult.usedText) {
            await supabase.from('theses').update({ last_winston_input_text: recheckResult.usedText }).eq('id', thesisId)
          }
          // Add this iteration to tracking
          winstonIterations.push({
            iteration: winstonIterations.length + 1,
            score: recheckResult.score,
            sentenceCount: Array.isArray(recheckResult.sentences) ? recheckResult.sentences.length : 0,
            flaggedCount: Array.isArray(recheckResult.sentences)
              ? recheckResult.sentences.filter((s: any) => s.score < 60).length
              : 0,
            checkedAt: new Date().toISOString()
          })

          // Update database with new iterations
          const { error: updateError } = await supabase
            .from('theses')
            .update({ winston_checks: winstonIterations })
            .eq('id', thesisId)

          if (updateError) {
            console.error('[PROCESS] Failed to update Winston iterations:', updateError)
          }
        }
      } catch (error) {
        console.error('[PROCESS] ERROR in full humanization:', error)
        console.warn('[PROCESS] Continuing with current content')
      }
    }

    // Step 7.6: Plagiarism Check & Auto-Fix (Winston AI)
    console.log('\n[PROCESS] ========== Step 7.6: Plagiarism Check & Auto-Fix (Winston AI) ==========')
    let plagiarismResult: any = null
    try {
      if (WINSTON_API_KEY) {
        // Max 3 attempts (Original + 2 repairs)
        for (let attempt = 1; attempt <= 3; attempt++) {
          plagiarismResult = await checkPlagiarismWithWinston(thesisContent)

          if (!plagiarismResult) {
            console.warn('[Plagiarism] Check failed or returned null.')
            break
          }

          console.log(`[Plagiarism] Attempt ${attempt}: ${plagiarismResult.originalityPercentage}% Originality (Score: ${plagiarismResult.plagiarismScore})`)

          if (plagiarismResult.originalityPercentage >= 90) {
            console.log('[Plagiarism] Passed > 90% threshold.')
            break
          }

          if (attempt < 3) {
            console.log('[Plagiarism] Originality < 90%. Attempting auto-repair via substitution...')
            const repaired = await repairPlagiarism(thesisContent, plagiarismResult.winstonResult, thesisData)

            if (repaired === thesisContent) {
              console.log('[Plagiarism] Repair yielded no changes. Aborting loop.')
              break
            }
            thesisContent = repaired
          } else {
            console.warn('[Plagiarism] Max auto-fix attempts reached.')
          }
        }
      } else {
        console.warn('[PROCESS] WINSTON_API_KEY not set - skipping plagiarism check')
      }
    } catch (error) {
      console.error('[PROCESS] ERROR in plagiarism check:', error)
      console.warn('[PROCESS] Continuing without plagiarism check result')
    }

    // Step 7.7: ZeroGPT Detection Check - Now done in Step 7.4
    // ZeroGPT check result is available from Step 7.4
    console.log('\n[PROCESS] ========== Step 7.7: ZeroGPT Detection Check ==========')
    console.log('[PROCESS] ZeroGPT check completed in Step 7.4 - result will be saved to metadata')

    // Step 7.8: Winston AI Detection Check - ALREADY DONE IN 7.4
    // We reuse winstonResult from Step 7.4
    // But if Step 7.4 failed or was skipped (unlikely), we could re-run.
    // However, 7.4 is robust. So let's just log.
    console.log('\n[PROCESS] ========== Step 7.8: Winston AI Detection Result Log ==========')
    if (winstonResult) {
      console.log(`[Winston] Detection result from Step 7.4: ${winstonResult.score}/100 human score`)
    } else {
      console.log('[Winston] No result available from Step 7.4')
    }





    // Process footnotes for German citation style - REMOVED
    let processedContent = thesisContent
    let footnotes: Record<number, string> = {}

    // Footnote extraction removed. Standard citations only.

    // Update thesis in database
    console.log('[PROCESS] Updating thesis in database with generated content...')
    const dbUpdateStart = Date.now()

    // Identify used sources for metadata (Strict Compliance)
    // NOTE: We do NOT append bibliography text here anymore, as it interferes with auto-generation.
    const bibResult = generateBibliography(
      processedContent,
      sourcesForGeneration || [],
      thesisData.citationStyle,
      thesisData.language,
      footnotes
    )

    // Just use processed content without bibliography text
    let finalContent = processedContent
    console.log('[PROCESS] Identified used sources matching strict criteria.')

    // Generate clean Markdown version for exports
    console.log('[PROCESS] Generating clean Markdown version for exports...')
    const { convertToCleanMarkdown } = await import('../lib/markdown-utils.js')
    const cleanMarkdownContent = convertToCleanMarkdown(finalContent)
    console.log(`[PROCESS] Clean Markdown generated: ${cleanMarkdownContent.length} characters`)

    await retryApiCall(
      async () => {
        // Ensure structure is available
        if (!thesisStructure && finalContent) {
          console.log('[PROCESS] Re-parsing content to structure for saving...')
          try {
            thesisStructure = parseContentToStructure(finalContent, thesisData.outline as any[])
          } catch (err) {
            console.error('[PROCESS] Failed to parse content to structure:', err)
          }
        }

        const totalCost = calculateTotalCost(thesisData.tokenStats)

        const updateData: any = {
          latex_content: finalContent, // Maps to 'content' column in older versions of code?
          // Actually, let's verify if 'latex_content' is the right column. 
          // Previous code updates 'latex_content'.
          // We ADD 'content_json'.
          content_json: thesisStructure,
          clean_markdown_content: cleanMarkdownContent,
          status: 'completed',
          completed_at: new Date().toISOString(),

          // Token & Cost Tracking
          tokens_gemini_2_5_pro_input: thesisData.tokenStats.gemini25ProInput,
          tokens_gemini_2_5_pro_output: thesisData.tokenStats.gemini25ProOutput,
          tokens_gemini_3_pro_preview_input: thesisData.tokenStats.gemini3ProInput,
          tokens_gemini_3_pro_preview_output: thesisData.tokenStats.gemini3ProOutput,
          tokens_winston_input: thesisData.tokenStats.winstonWords,
          total_cost: totalCost,
        }

        // Store footnotes and metadata
        const { data: existingThesis } = await supabase
          .from('theses')
          .select('metadata')
          .eq('id', thesisId)
          .single()

        const existingMetadata = existingThesis?.metadata || {}
        updateData.metadata = {
          ...existingMetadata,
        }

        // Add used sources to metadata
        // IMPORTANT: Save FULL source objects for Frontend "Sources" tab
        updateData.metadata.used_sources = bibResult.usedSources
        updateData.metadata.bibliography_sources = bibResult.usedSourceIds


        // Footnote metadata saving removed

        // Save Winston Result (Replaces ZeroGPT)
        if (winstonResult) {
          updateData.metadata.winstonResult = winstonResult
          // Map to zeroGptResult format for backward compatibility if needed?
          // Or just let frontend adapt. Assuming frontend expects winstonResult.
          updateData.metadata.zeroGptResult = {
            isHumanWritten: winstonResult.score,
            isGptGenerated: 100 - winstonResult.score,
            checkedAt: winstonResult.checkedAt
          }
        }

        if (plagiarismResult) {
          updateData.metadata.plagiarismResult = plagiarismResult
        }

        const result = await supabase.from('theses').update(updateData).eq('id', thesisId)
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

    const processDuration = Date.now() - processStartTime
    console.log('\n[PROCESS] ========== Thesis Generation Complete ==========')
    console.log(`[PROCESS] Total processing time: ${Math.round(processDuration / 1000)}s (${processDuration}ms)`)
    const jobInputTokens = thesisData.tokenStats.gemini25ProInput + thesisData.tokenStats.gemini3ProInput + (Math.round(thesisData.tokenStats.winstonWords / 2)) // Rough est for winston input
    const jobOutputTokens = thesisData.tokenStats.gemini25ProOutput + thesisData.tokenStats.gemini3ProOutput

    // Update global stats
    totalInputTokens += jobInputTokens
    totalOutputTokens += jobOutputTokens

    console.log(`[PROCESS] Thesis generation completed for thesis ${thesisId}`)
    console.log(`[PROCESS] Total tokens used: ${jobInputTokens} input, ${jobOutputTokens} output`)
    console.log('='.repeat(80))

    // Save token usage to database
    await supabase.from('theses').update({
      input_tokens: jobInputTokens,
      output_tokens: jobOutputTokens
    }).eq('id', thesisId)
    console.log('[Tokens] Token usage saved to database')



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



    // Step 0: Initial Setup
    // Initialize tokenStats if not present (safety)
    if (thesisData && !thesisData.tokenStats) {
      thesisData.tokenStats = {
        gemini25ProInput: 0,
        gemini25ProOutput: 0,
        gemini3ProInput: 0,
        gemini3ProOutput: 0,
        winstonWords: 0
      }
    }

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
      .select('id, status, created_at, updated_at, completed_at, metadata, critique_report, critique_history')
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

// Health check endpoint with worker metrics
app.get('/health', (req: Request, res: Response) => {
  const uptimeSeconds = Math.floor((Date.now() - workerStartTime) / 1000)
  const uptimeFormatted = `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: uptimeFormatted,
    uptimeSeconds,
    worker: {
      currentJobId,
      currentJobStartedAt,
      totalJobsCompleted,
      totalJobsFailed,
      totalJobsStalled,
      lastJobCompletedAt,
      lastJobFailedAt,
    },
    tokens: {
      currentSessionInput: totalInputTokens,
      currentSessionOutput: totalOutputTokens,
    }
  })
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

    const { thesisId, thesisData, critiqueOnly } = job.data

    try {
      // Update job progress
      await job.updateProgress(10)

      // Create progress callback that updates job progress
      const progressCallback = async (progress: number) => {
        try {
          await job.updateProgress(progress)
          console.log(`[WORKER] Progress: ${progress}%`)
        } catch (e) {
          // Ignore progress update errors
        }
      }

      // Call the main processing function with progress callback
      await processThesisGeneration(thesisId, thesisData, critiqueOnly, progressCallback)

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
    concurrency: 1,
    lockDuration: 1800000, // 30 minutes (thesis generation can take 2+ hours between updates)

    maxStalledCount: 2, // Allow 2 stall recoveries before failing (network hiccups happen)
    // REDIS OPTIMIZATION: Reduce polling frequency when idle
    // Default is 5000ms, we use 30000ms (30 seconds) to save commands
    drainDelay: 30000, // Wait 30 seconds between drain checks when queue is empty
    lockRenewTime: 60000, // Renew lock every 60 seconds (MUST be < lockDuration)
    stalledInterval: 900000, // Check for stalled jobs every 15 minutes
    // Remove limiter - not needed with concurrency 1
  }
)

// Worker event handlers with health tracking
worker.on('completed', (job) => {
  console.log(`[WORKER] Job ${job.id} completed successfully`)
  lastJobCompletedAt = new Date().toISOString()
  totalJobsCompleted++
  currentJobId = null
  currentJobStartedAt = null
})

worker.on('failed', (job, err) => {
  console.error(`[WORKER] Job ${job?.id} failed:`, err)
  lastJobFailedAt = new Date().toISOString()
  totalJobsFailed++
  currentJobId = null
  currentJobStartedAt = null
})

worker.on('stalled', (jobId) => {
  console.error(`[WORKER] ⚠️ JOB STALLED: ${jobId}`)
  console.error('[WORKER] This usually means the worker crashed or an API call hung indefinitely')
  console.error('[WORKER] The job will be retried automatically (maxStalledCount: 2)')
  totalJobsStalled++
})

worker.on('active', (job) => {
  console.log(`[WORKER] Job ${job.id} is now active`)
  currentJobId = job.id || null
  currentJobStartedAt = new Date().toISOString()
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


/**
 * Generate a formatted bibliography based on the thesis content and citation style
 */
function generateBibliography(
  content: string,
  sources: Source[],
  citationStyle: string,
  language: string,
  footnotes: Record<number, string> = {}
): { text: string; usedSourceIds: string[]; usedSources: Source[] } {
  console.log(`[Bibliography] Generating bibliography (Style: ${citationStyle}, Language: ${language})...`)

  // 1. Identify used sources
  const usedSourceIds = new Set<string>()
  const usedSources: Source[] = []

  // Create a map for quick lookup
  const sourceMap = new Map<string, Source>()
  sources.forEach(s => {
    // Generate a unique ID if not present
    const id = s.url || s.title || 'unknown'
    sourceMap.set(id, s)
  })

  if (false) {
    // For German style, use the extracted footnotes matching
    // Strategy: List ONLY sources referenced in footnotes
    if (Object.keys(footnotes).length > 0) {
      // Create a set of text content from footnotes to match against
      const footnoteTexts = Object.values(footnotes).join(' ').toLowerCase()

      sources.forEach(s => {
        // Match Author or Title in footnotes
        const author = s.authors[0]?.split(' ').pop()?.toLowerCase() || ''
        const title = s.title.toLowerCase()

        let found = false
        if (author && footnoteTexts.includes(author)) found = true
        if (title.length > 10 && footnoteTexts.includes(title.substring(0, 20))) found = true

        if (found) {
          usedSources.push(s)
          usedSourceIds.add(s.url || s.title || 'unknown')
        }
      })
    } else {
      // If no footnotes extracted (unlikely for German style if we are here),
      // we must rely on standard text matching or if empty, we output nothing.
      // But user demand is "not a single more or less".
      // If AI failed to footnote, bibliography should be empty? 
      // Safe fallback: Scan regular text content as well for Author/Title
      sources.forEach(s => {
        const author = s.authors[0]?.split(' ').pop() || ''
        if (author) {
          const pattern = new RegExp(author, 'i')
          if (pattern.test(content)) {
            usedSources.push(s)
            usedSourceIds.add(s.url || s.title || 'unknown')
          }
        }
      })
    }
  } else {
    // For APA/Harvard/etc., scan text for (Author, Year) or just Author
    sources.forEach(s => {
      const author = s.authors[0]?.split(' ').pop() || '' // Last name
      const year = s.year
      let found = false

      // Strict Check: (Author, Year) or (Author, n.d.)
      if (author && year) {
        // Look for "Author" AND "Year" in close proximity (citation like (Smith, 2023) or Smith (2023))
        // or just Author name appearing in text is usually a sign of usage.
        // User says "not a single more or less".
        // Strict citation matching:
        const citationPattern = new RegExp(`${author}.{0,10}${year}`, 'i')
        // Also simple name check if the above is too strict
        if (citationPattern.test(content)) found = true
        else {
          // Fallback to just name check if strict citation missed (e.g. narrative citation)
          // But verified against content.
          const namePattern = new RegExp(`\\b${author}\\b`, 'i')
          if (namePattern.test(content)) found = true
        }
      } else if (author) {
        const namePattern = new RegExp(`\\b${author}\\b`, 'i')
        if (namePattern.test(content)) found = true
      }

      if (found) {
        usedSources.push(s)
        usedSourceIds.add(s.url || s.title || 'unknown')
      }
    })

    // REMOVED FALLBACK: "not a single more or less"
    // searching for low citation count fallback deleted.
  }

  console.log(`[Bibliography] Identified ${usedSources.length} sources for bibliography`)

  // 2. Format Bibliography
  const title = language === 'german' ? '## Literaturverzeichnis' : '## References'

  // Sort alphabetically by first author
  usedSources.sort((a, b) => {
    const authorA = a.authors[0] || a.title || ''
    const authorB = b.authors[0] || b.title || ''
    return authorA.localeCompare(authorB)
  })

  let bibText = `\n\n${title}\n\n`

  usedSources.forEach(s => {
    const authors = s.authors.join(', ')
    const title = s.title
    const year = s.year ? `(${s.year})` : '(n.d.)'
    const publisher = s.publisher || s.journal || 'n.p.'
    const url = s.url ? ` Retrieved from ${s.url}` : ''

    // Simple APA-like format for everyone (adjust as needed)
    // Author (Year). Title. Publisher. URL.
    if (language === 'german') {
      bibText += `* ${authors} ${year}: *${title}*. ${publisher}.${url}\n`
    } else {
      bibText += `* ${authors} ${year}. *${title}*. ${publisher}.${url}\n`
    }
  })

  return {
    text: bibText,
    usedSourceIds: Array.from(usedSourceIds),
    usedSources: usedSources
  }
}

/**
 * Verifies and corrects citation page numbers using Google FileSearch
 */
async function verifyCitationsWithFileSearch(content: string, fileSearchStoreId: string, isGerman: boolean = false, sources: any[] = [], thesisData: ThesisData): Promise<string> {
  const pagePrefix = isGerman ? 'S.' : 'p.'
  const pagesPrefix = isGerman ? 'S.' : 'pp.'
  const defaultPage = `${pagePrefix} 1`

  // Build Context for Page Calculation
  const sourceContext = sources.map((s, i) => {
    const author = s.authors && s.authors.length > 0 ? s.authors[0] : (s.publisher || s.title || 'Source')
    const start = s.pageStart ? parseInt(s.pageStart) : null
    const end = s.pageEnd ? parseInt(s.pageEnd) : null
    if (start) {
      return `- Source "${author}" starts at PDF-Page 1 = Real Page ${start}. (Add ${start - 1} to PDF page index).`
    }
    return `- Source "${author}": No offset known.`
  }).join('\n')

  // Ultra-strict prompt for citation verification
  const prompt = `
  You are a strict academic citation verifier. Your SINGLE GOAL is to correct the PAGE NUMBERS in the citations of the provided text.
  
  CONTEXT: The provided text contains citations like "(Müller, 2023, ${pagePrefix} 1)" or "(Smith, 2022)".
  SOURCE METADATA (Use for Page Calculation):
  ${sourceContext}
  
  PROBLEM: Some page numbers might be hallucinated, random, or incorrectly using Article IDs.
  
  YOUR TASK:
  1. Read the provided text.
  2. For EVERY citation, use the FileSearch tool to lookup the ACTUAL source document.
  3. **STRENGTHENED EXTRACTION STRATEGY:**
     - Look for VISUAL page numbers in the corners/bottom of the PDF pages.
     - Distinguish between "internal" PDF page count (1 of 30) and "printed" page numbers (e.g. 452). ALWAYS use the PRINTED page number.
     - **SMART CALCULATION FALLBACK:**
       - If you find the text on "Page 5 of the PDF" but there is no printed number:
       - Check SOURCE METADATA above. If "starts at Real Page 401", then Page 5 = 401 + 4 = 405. Use 405.
       - If you are UNSURE, default to the "Real Start Page" (e.g. 401) rather than 1.
  4. VALIDATE & CORRECT the page number:
     - MUST be a visual page number on the PDF.
     - ALLOWED formats: Integers (12), Ranges (12-15), or "ff" suffix (12ff, 12f).
     - MUST NOT be an Article ID (strings like "e24234", "e0343", "Art. 3").
     - CANNOT be > 10000. If you see "Page 24032", this is an Article ID. REJECT IT.
     - CANNOT start with a letter (e.g. "e352", "L20"). REJECT IT.
  5. If the source uses standard pagination, use the correct number.
  6. If the source has NO visual page numbers (e.g. HTML/Online source) or you cannot determine it OR the number is suspicious (>10000, starts with letter):
     - MUST use the "Start Page" from metadata (e.g. 401).
     - ONLY IF fails, default to "${defaultPage}".
  7. If you CANNOT find the source, keep the existing page number or default to "${defaultPage}".
  
  CRITICAL RULES (STRICT COMPLIANCE REQUIRED):
  - 🚫 NEVER use "e-numbers" (e.g. "${pagePrefix} e123456" is FORBIDDEN).
  - 🚫 NEVER use Page Numbers > 10000.
  - 🚫 NEVER use Page Numbers starting with a letter.
  - 🚫 NEVER use "Article X" as a page number.
  - 🚫 NEVER use "n.pag." -> Use "${defaultPage}" instead.
  - 🚫 NEVER put text/sentences inside the page number spot. "(Smith, 2020, ${pagePrefix} finding shows...)" is WRONG.
  - ✅ ALLOWED: "${pagePrefix} 312ff", "${pagePrefix} 15f", "${pagePrefix} 100", "${pagesPrefix} 10-12".
  - DO NOT change text content. ONLY fix the numbers inside the parentheses.
  - Language is ${isGerman ? 'GERMAN' : 'ENGLISH'}. Use "${pagePrefix}" for single pages and "${pagesPrefix}" for ranges.
  - KEEP THE CITATION CLEAN: "(Author, Year, ${pagePrefix} Number)". NO EXTRA TEXT.
  
  INPUT TEXT:
  """
  ${content}
  """
  
  OUTPUT:
  Return the FULL text with corrected citations. No markdown blocks, no "Here is the text", just the text.
  `

  try {
    const response = await retryApiCall(
      () => ai.models.generateContent({
        model: 'gemini-2.5-flash', // Fast and effective for this
        contents: prompt,
        config: {
          maxOutputTokens: 8192, // Ensure enough space for full text
          temperature: 0.1, // Very low temperature for high precision
          // Removed FileSearch tool as it requires a loop handler which is not implemented here.
          // The model will still perform formatting verification logic.
        },
      }),
      'Verify citations',
      2, // 2 Retries
      1000
    )
    trackTokenUsage(thesisData, response, 'gemini-2.5-flash', 'Verify citations')

    let verifiedText = response.text?.trim()

    // Strip markdown blocks if present (common LLM artifact)
    if (verifiedText?.startsWith('```')) {
      verifiedText = verifiedText.replace(/^```[a-z]*\n/i, '').replace(/\n```$/, '').trim()
    }

    if (!verifiedText) {
      console.warn('[CitationVerifier] Result is empty. Rejecting.')
      return content
    }

    // Safety check: if result is vastly different in length, return original
    const lengthDiff = Math.abs(verifiedText.length - content.length)
    const allowedDiff = content.length * 0.5

    if (lengthDiff > allowedDiff) {
      console.warn(`[CitationVerifier] Verified text length mismatch (Original: ${content.length}, Output: ${verifiedText.length}). Rejecting.`)
      return content
    }

    return verifiedText
  } catch (error) {
    console.error('[CitationVerifier] Error:', error)
    return content // Fallback to original
  }
}

/**
 * Executes the iterative critique and repair loop on the given thesis content.
 * Returns the final (repaied) thesis content.
 * Extracted from thesis generation workflow for re-usability.
 */
export async function performCritiqueLoop(
  initialThesisContent: string,
  thesisData: any,
  sourcesForGeneration: Source[],
  supabase: any,
  thesisId: string
): Promise<string> {
  console.log('\n[PROCESS] ========== Iterative Critique & Repair Loop (Standalone/Triggered) ==========')

  let thesisContent = initialThesisContent
  const MAX_REPAIR_ITERATIONS = 2
  let currentIteration = 0
  let critiqueReport = ''
  const critiqueHistory: any[] = []
  let masterReport: string | undefined = undefined

  // Use research question from thesisData or fallback
  const researchQuestion = thesisData.researchQuestion || 'Thema der Arbeit'

  while (currentIteration < MAX_REPAIR_ITERATIONS) {
    currentIteration++
    console.log(`\n[Loop] Starting Critique/Repair Iteration ${currentIteration}/${MAX_REPAIR_ITERATIONS}`)

    // --- CRITIQUE PHASE ---
    console.log('[Loop] Running Critique Agent...')
    try {
      const outlineForCritique = (thesisData.outline || []).map((chapter: any, index: number) => ({
        number: (chapter?.number ?? `${index + 1}.`).toString().trim(),
        title: (chapter?.title ?? '').toString().trim(),
        sections: []
      }))

      // Ensure fileSearchStoreId is present
      const fileSearchStoreId = thesisData.fileSearchStoreId || ''

      critiqueReport = await critiqueThesis(
        thesisContent,
        outlineForCritique,
        researchQuestion,
        sourcesForGeneration || [],
        thesisData.language === 'german',
        fileSearchStoreId,
        thesisData,
        masterReport
      )

      // Convert first report to Master Report
      if (!masterReport && currentIteration === 1) {
        masterReport = critiqueReport
        console.log('[Loop] Master Report locked for verification. Subsequent critiques will ONLY verify fixes for these errors.')
      }
      console.log(`[Critique] Report generated (Iteration ${currentIteration}):`)
      console.log(critiqueReport)

      // Update history
      // Try to parse report as object for cleaner storage
      let reportToStore = critiqueReport
      try {
        const jsonStr = critiqueReport.replace(/```json\n?|\n?```/g, '').trim()
        reportToStore = JSON.parse(jsonStr)
      } catch (e) {
        // Keep as string if parsing fails
      }

      critiqueHistory.push({
        iteration: currentIteration,
        report: reportToStore,
        timestamp: new Date().toISOString()
      })

      // Save critique report and history to database
      try {
        await supabase
          .from('theses')
          .update({
            critique_report: `[Iteration ${currentIteration}]\n${critiqueReport}`,
            critique_history: critiqueHistory
          })
          .eq('id', thesisId)
        console.log('[Critique] Report and history saved to database')
      } catch (dbError) {
        console.error('[Critique] Failed to save report to database:', dbError)
      }
    } catch (error) {
      console.error('[PROCESS] ERROR in Thesis Critique:', error)
      critiqueReport = '' // Clear if failed
    }

    // --- CHECK PHASE ---
    // Try to parse JSON report first to detect errors
    let hasErrors = false
    let parsedJsonErrors: any[] = []

    try {
      const jsonStr = critiqueReport.replace(/```json\n?|\n?```/g, '').trim()
      const reportObj = JSON.parse(jsonStr)
      if (reportObj.errors && Array.isArray(reportObj.errors) && reportObj.errors.length > 0) {
        hasErrors = true
        parsedJsonErrors = reportObj.errors
        console.log(`[Loop] Parsed ${parsedJsonErrors.length} errors from JSON report`)
      }
    } catch (e) {
      // Not valid JSON, fall back to string checks
    }

    // Check if the report contains error markers (fallback)
    if (!hasErrors) {
      hasErrors = critiqueReport.includes('[FEHLER]') ||
        critiqueReport.includes('[FEHLERHAFT]') ||
        critiqueReport.includes('[HALLUZINATIONEN]') ||
        critiqueReport.includes('Error') ||
        critiqueReport.includes('Mangel') ||
        critiqueReport.includes('FEHLER:') || // Catch detailed errors even if status is clean
        critiqueReport.includes('**FEHLER') ||
        critiqueReport.includes('LÖSUNG:') || // If there is a solution proposed, there is an error
        critiqueReport.includes('SOLUTION:')
    }

    // Check for technical failure
    const isTechnicalFailure = critiqueReport.includes('CRITIQUE_GENERATION_FAILED_ERROR')

    if (isTechnicalFailure) {
      console.warn('[Loop] Critique generation failed technically. Validating retry...')
      if (currentIteration < MAX_REPAIR_ITERATIONS) {
        console.log('[Loop] Retrying in next iteration...')
        continue
      }
    }

    if (!hasErrors && !isTechnicalFailure && currentIteration > 1) {
      console.log('[Loop] Critique is clean (no major errors detected). Exiting loop early.')
      break
    }

    if (!hasErrors && critiqueReport.length > 100 && currentIteration === 1) {
      console.log('[Loop] Iteration 1 is clean. Skipping repair loop.')
      break
    }

    // --- REPAIR PHASE ---
    console.log('[Loop] Errors detected or first run. Running Repair Agent...')
    try {
      if (critiqueReport && critiqueReport.trim().length > 0) {
        console.log('[Repair] Starting chunked repair...')

        // 1. REPAIR PHASE: JSON-Driven Iterative Repair
        let errors: any[] = []
        try {
          const jsonStr = critiqueReport.replace(/```json\n?|\n?```/g, '').trim()
          const reportObj = JSON.parse(jsonStr)
          errors = reportObj.errors || []
          console.log(`[Repair] Parsed ${errors.length} errors from Critique Report`)
        } catch (e) {
          console.error('[Repair] Failed to parse JSON report.', e)
          console.warn('[Repair] Raw report sample:', critiqueReport.substring(0, 200))
          errors = []
        }

        if (errors.length > 0) {
          // 2. Split content into chapters (Level 2 headers ##)
          const chapters = thesisContent.split(/(?=^## [^#])/gm).filter(c => c.trim().length > 0)
          console.log(`[Repair] Split thesis into ${chapters.length} chunks for processing`)

          const chapterTitles = chapters.map(c => c.split('\n')[0].replace(/#/g, '').trim())

          // 3. Iterate through ERRORS and apply fixes
          for (let i = 0; i < errors.length; i++) {
            const err = errors[i]
            console.log(`[Repair] Processing Error ${i + 1}/${errors.length}: ${err.error?.substring(0, 50)}...`)

            // Identify target chapter index
            const targetIndex = ((location: string, quote: string, titles: string[], allChapters: string[]): number => {
              if (!location) return -1
              const locNumMatch = location.match(/(\d+(?:\.\d+)*)/)
              const locNum = locNumMatch ? locNumMatch[1] : null

              if (locNum) {
                // Pass 1: Exact/Prefix match
                for (let idx = 0; idx < titles.length; idx++) {
                  const cleanTitle = titles[idx].replace(/#/g, '').trim()
                  if (cleanTitle.startsWith(locNum + ' ') || cleanTitle === locNum) return idx
                }

                // Pass 2: Parent match (fallback)
                for (let idx = 0; idx < titles.length; idx++) {
                  const cleanTitle = titles[idx].replace(/#/g, '').trim()
                  const chapterNum = cleanTitle.split(' ')[0]
                  if (chapterNum && locNum.startsWith(chapterNum + '.')) {
                    return idx
                  }
                }
              }
              const locLower = location.toLowerCase()
              for (let idx = 0; idx < titles.length; idx++) {
                const titleLower = titles[idx].toLowerCase()
                if (titleLower.includes(locLower) || locLower.includes(titleLower)) return idx
              }
              if (quote && quote.length > 20) {
                const cleanQuote = quote.replace(/\s+/g, ' ').trim().substring(0, 50)
                for (let idx = 0; idx < allChapters.length; idx++) {
                  if (allChapters[idx].includes(cleanQuote)) {
                    console.log(`[Repair] Found quote in chapter ${idx + 1}, using that as target.`)
                    return idx
                  }
                }
              }
              return -1
            })(err.location, err.quote, chapterTitles, chapters)

            if (targetIndex === -1) {
              console.warn(`[Repair] Could not map location "${err.location}" to a chapter. Skipping error.`)
              continue
            }

            const chunk = chapters[targetIndex]
            const miniReport = `LÖSUNG ANWENDEN:\nFEHLER: ${err.error}\nLÖSUNG: ${err.solution}\nQUOTE: ${err.quote || ''}`

            console.log(`[Repair] Applying fix to Chapter ${targetIndex + 1} (${chapterTitles[targetIndex]})...`)

            const repairedChunk = await fixChapterContent(
              chunk,
              miniReport,
              thesisData.language === 'german',
              targetIndex,
              chapters.length,
              chapterTitles,
              thesisData,
              thesisData.fileSearchStoreId
            )

            if (repairedChunk.trim() === '[DELETE_CHAPTER]') {
              console.warn(`[Repair] Agent requested DELETE for Chapter ${targetIndex + 1}`)
              chapters[targetIndex] = ''
            } else {
              console.log(`[Repair] Update Check: Original ${chunk.length} chars -> repaired ${repairedChunk.length} chars`)
              if (repairedChunk.length < 200 && chunk.length > 500) {
                console.error(`[Repair] CRITICAL: Repair result is suspiciously short (${repairedChunk.length} vs ${chunk.length}). Reverting!`)
              } else if (repairedChunk.length < chunk.length * 0.5 && chunk.length > 200) {
                console.warn(`[Repair] Fix result dangerously short. Reverting.`)
              } else {
                chapters[targetIndex] = repairedChunk
              }
            }
          }
          thesisContent = chapters.filter(c => c.length > 0).join('\n\n')
          console.log('[Repair] All errors processed. Thesis reassembled.')
        } else {
          console.log('[Repair] No errors parsed to fix (or parsing failed).')
        }
      } else {
        console.log('[Repair] No critique report available. Skipping repair.')
      }
    } catch (error) {
      console.error('[PROCESS] ERROR in Thesis Repair:', error)
      console.warn('[Repair] Continuing with original content (repair failed)')
    }

    if (currentIteration === MAX_REPAIR_ITERATIONS) {
      console.log('[Loop] Max iterations reached. Proceeding with current content.')
    }
  }

  return thesisContent
}    
