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

import express from 'express'
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
const OPENALEX_EMAIL = process.env.OPENALEX_EMAIL || '[email protected]'

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

// Middleware for API key authentication
const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
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
1. Spezifisch und präzise sein
2. Fachbegriffe und relevante Konzepte enthalten
3. Für wissenschaftliche Datenbanken (OpenAlex, Semantic Scholar) geeignet sein
4. Verschiedene Aspekte des Kapitels abdecken

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

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: prompt,
  })

  const content = response.text
  if (!content) {
    throw new Error('No content from Gemini API')
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('Invalid JSON response from Gemini')
  }

  const parsed = JSON.parse(jsonMatch[0])
  return parsed.queries || []
}

/**
 * Step 2: Query OpenAlex API
 */
async function queryOpenAlex(query: string, language: 'german' | 'english'): Promise<Source[]> {
  const searchQuery = language === 'english' ? query : query // OpenAlex works best with English
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(searchQuery)}&per-page=20&sample=20&mailto=${OPENALEX_EMAIL}`
  
  try {
    const response = await fetch(url)
    if (!response.ok) {
      console.error(`OpenAlex API error: ${response.status} ${response.statusText}`)
      return []
    }

    const data = await response.json() as any
    const works = data.results || []

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
    console.error('Error querying OpenAlex:', error)
    return []
  }
}

/**
 * Step 3: Query Semantic Scholar API
 */
async function querySemanticScholar(query: string): Promise<Source[]> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=10&fields=title,authors,year,doi,url,openAccessPdf,abstract,venue,citationCount`
  
  try {
    const response = await fetch(url, {
      headers: {
        'x-api-key': process.env.SEMANTIC_SCHOLAR_API_KEY || '',
      },
    })

    if (!response.ok) {
      console.error(`Semantic Scholar API error: ${response.status} ${response.statusText}`)
      return []
    }

    const data = await response.json() as any
    const papers = data.data || []

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
    console.error('Error querying Semantic Scholar:', error)
    return []
  }
}

/**
 * Step 4: Deduplicate sources by DOI and prioritize PDF URLs
 */
function deduplicateSources(sources: Source[]): Source[] {
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

  return Array.from(seen.values())
}

/**
 * Step 5: Rank sources by relevance using Gemini
 */
async function rankSourcesByRelevance(sources: Source[], thesisData: ThesisData): Promise<Source[]> {
  const prompt = `Du bist ein Experte für wissenschaftliche Literaturbewertung. Bewerte die Relevanz der folgenden Quellen für diese Thesis:

**Thesis-Informationen:**
- Titel/Thema: ${thesisData.title}
- Fachbereich: ${thesisData.field}
- Forschungsfrage: ${thesisData.researchQuestion}
- Gliederung: ${JSON.stringify(thesisData.outline, null, 2)}

**Quellen:**
${JSON.stringify(sources.map(s => ({
  title: s.title,
  authors: s.authors,
  year: s.year,
  abstract: s.abstract,
  journal: s.journal,
})), null, 2))}

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
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
    })

    const content = response.text
    if (!content) {
      return sources // Return unranked if ranking fails
    }

    const jsonMatch = content.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      return sources
    }

    const rankings = JSON.parse(jsonMatch[0]) as Array<{ index: number; relevanceScore: number; reason?: string }>
    
    // Apply relevance scores
    const rankedSources = sources.map((source, index) => {
      const ranking = rankings.find(r => r.index === index)
      return {
        ...source,
        relevanceScore: ranking?.relevanceScore || 50,
      }
    })

    // Sort by relevance score (descending)
    return rankedSources.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
  } catch (error) {
    console.error('Error ranking sources:', error)
    return sources // Return unranked if ranking fails
  }
}

/**
 * Step 6: Download PDF and upload to FileSearchStore
 */
async function downloadAndUploadPDF(source: Source, fileSearchStoreId: string, thesisId: string): Promise<boolean> {
  if (!source.pdfUrl) {
    console.log(`No PDF URL for source: ${source.title}`)
    return false
  }

  try {
    // Use URL directly if SDK supports it, otherwise download first
    let fileSource: Blob | string = source.pdfUrl
    
    // Try using URL directly first (more efficient)
    // If SDK doesn't support URL strings, we'll download
    try {
      // Test if URL is accessible
      const testResponse = await fetch(source.pdfUrl, { method: 'HEAD' })
      if (!testResponse.ok) {
        throw new Error('URL not accessible')
      }
    } catch (error) {
      // If URL doesn't work, download the PDF
      console.log(`Downloading PDF for ${source.title}...`)
      const pdfResponse = await fetch(source.pdfUrl)
      if (!pdfResponse.ok) {
        console.error(`Failed to download PDF: ${pdfResponse.status}`)
        return false
      }

      const pdfBuffer = await pdfResponse.buffer()
      // Create a Blob from Buffer for SDK compatibility
      // In Node.js 18+, we can use the global Blob constructor
      fileSource = new Blob([pdfBuffer], { type: 'application/pdf' })
    }

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

    // Upload to FileSearchStore
    const operation = await ai.fileSearchStores.uploadToFileSearchStore({
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
    })

    // Poll until complete
    const maxWaitTime = 300000 // 5 minutes
    const pollInterval = 2000 // 2 seconds
    const startTime = Date.now()

    while (!operation.done) {
      if (Date.now() - startTime > maxWaitTime) {
        console.error('Upload operation timeout')
        return false
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval))
      const updatedOperation = await ai.operations.get({ operation })
      Object.assign(operation, updatedOperation)
    }

    if (operation.error) {
      console.error('Upload operation failed:', operation.error)
      return false
    }

    // Update database
    const { data: thesis } = await supabase
      .from('theses')
      .select('uploaded_sources')
      .eq('id', thesisId)
      .single()

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
      },
      sourceType: 'url' as const,
      sourceUrl: source.pdfUrl,
    }

    existingSources.push(newSource)

    await supabase
      .from('theses')
      .update({ uploaded_sources: existingSources })
      .eq('id', thesisId)

    return true
  } catch (error) {
    console.error('Error downloading/uploading PDF:', error)
    return false
  }
}

/**
 * Step 7: Generate thesis content using Gemini Pro
 */
async function generateThesisContent(thesisData: ThesisData, rankedSources: Source[]): Promise<string> {
  const prompt = `Du bist ein Experte für wissenschaftliches Schreiben. Erstelle den vollständigen Text für diese Thesis.

**Thesis-Informationen:**
- Titel/Thema: ${thesisData.title}
- Fachbereich: ${thesisData.field}
- Art: ${thesisData.thesisType}
- Forschungsfrage: ${thesisData.researchQuestion}
- Zitationsstil: ${thesisData.citationStyle}
- Ziel-Länge: ${thesisData.targetLength} ${thesisData.lengthUnit}
- Sprache: ${thesisData.language}

**Gliederung:**
${JSON.stringify(thesisData.outline, null, 2)}

**Verfügbare Quellen:**
${JSON.stringify(rankedSources.slice(0, 50).map(s => ({
  title: s.title,
  authors: s.authors,
  year: s.year,
  doi: s.doi,
  abstract: s.abstract,
  journal: s.journal,
})), null, 2))}

**Aufgabe:**
Erstelle den vollständigen Thesis-Text entsprechend der Gliederung. Der Text sollte:
1. Wissenschaftlich präzise und gut strukturiert sein
2. Alle Kapitel und Abschnitte der Gliederung abdecken
3. Die Forschungsfrage beantworten
4. Quellen korrekt zitieren (${thesisData.citationStyle} Stil)
5. Die Ziel-Länge erreichen
6. In ${thesisData.language === 'german' ? 'Deutsch' : 'Englisch'} verfasst sein

**Format:**
Erstelle den Text direkt, ohne zusätzliche Formatierung. Verwende die korrekte Nummerierung für Kapitel und Abschnitte.`

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: prompt,
    config: {
      tools: [{
        fileSearch: {
          fileSearchStoreNames: [thesisData.fileSearchStoreId],
        },
      }],
    },
  })

  return response.text || ''
}

/**
 * Main job handler
 */
async function processThesisGeneration(thesisId: string, thesisData: ThesisData) {
  try {
    console.log(`Starting thesis generation for thesis ${thesisId}`)

    // Step 1: Generate search queries
    console.log('Step 1: Generating search queries...')
    const chapterQueries = await generateSearchQueries(thesisData)
    console.log(`Generated queries for ${chapterQueries.length} chapters`)

    // Step 2 & 3: Query OpenAlex and Semantic Scholar
    console.log('Step 2-3: Querying OpenAlex and Semantic Scholar...')
    const allSources: Source[] = []

    for (const chapterQuery of chapterQueries) {
      // Query in both languages
      for (const query of chapterQuery.queries.german) {
        const openAlexResults = await queryOpenAlex(query, 'german')
        allSources.push(...openAlexResults)
        
        const semanticResults = await querySemanticScholar(query)
        allSources.push(...semanticResults)
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200))
      }

      for (const query of chapterQuery.queries.english) {
        const openAlexResults = await queryOpenAlex(query, 'english')
        allSources.push(...openAlexResults)
        
        const semanticResults = await querySemanticScholar(query)
        allSources.push(...semanticResults)
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    console.log(`Found ${allSources.length} total sources`)

    // Step 4: Deduplicate
    console.log('Step 4: Deduplicating sources...')
    const deduplicated = deduplicateSources(allSources)
    console.log(`${deduplicated.length} sources after deduplication`)

    // Step 5: Rank by relevance
    console.log('Step 5: Ranking sources by relevance...')
    const ranked = await rankSourcesByRelevance(deduplicated, thesisData)
    console.log(`Ranked ${ranked.length} sources`)

    // Step 6: Download and upload PDFs (top 50 most relevant, exclude low relevance)
    console.log('Step 6: Downloading and uploading PDFs...')
    // Filter out sources with relevance score < 40 and take top 50
    const topSources = ranked
      .filter(s => s.relevanceScore && s.relevanceScore >= 40)
      .slice(0, 50)
    let uploadedCount = 0

    for (const source of topSources) {
      if (source.pdfUrl) {
        const success = await downloadAndUploadPDF(source, thesisData.fileSearchStoreId, thesisId)
        if (success) {
          uploadedCount++
        }
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    console.log(`Uploaded ${uploadedCount} PDFs`)

    // Step 7: Generate thesis content
    console.log('Step 7: Generating thesis content...')
    const thesisContent = await generateThesisContent(thesisData, ranked)

    // Update thesis in database
    await supabase
      .from('theses')
      .update({
        latex_content: thesisContent,
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', thesisId)

    console.log(`Thesis generation completed for thesis ${thesisId}`)
    return { success: true }
  } catch (error) {
    console.error('Error in thesis generation:', error)
    
    // Update thesis status to draft on error
    await supabase
      .from('theses')
      .update({ status: 'draft' })
      .eq('id', thesisId)

    throw error
  }
}

// API endpoint to start thesis generation job
app.post('/jobs/thesis-generation', authenticate, async (req, res) => {
  try {
    const { thesisId, thesisData } = req.body

    if (!thesisId || !thesisData) {
      return res.status(400).json({ error: 'Thesis ID and data are required' })
    }

    // Start processing asynchronously
    processThesisGeneration(thesisId, thesisData).catch(error => {
      console.error('Background job error:', error)
    })

    // Return immediately
    res.json({
      success: true,
      jobId: `job-${thesisId}-${Date.now()}`,
      message: 'Thesis generation job started',
    })
  } catch (error) {
    console.error('Error starting job:', error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Start server
app.listen(PORT, () => {
  console.log(`Thesis generation worker listening on port ${PORT}`)
})

