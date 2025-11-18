import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'

interface OutlineChapter {
  title: string
  number: string
  sections?: Array<{
    title: string
    number: string
    subsections?: Array<{
      title: string
      number: string
    }>
  }>
}

export async function POST(request: Request) {
  try {
    const requestData = await request.json()
    const { thesisTitle, topic, field, researchQuestion, outline } = requestData

    console.log('Generate search queries request:', {
      hasOutline: !!outline,
      outlineType: typeof outline,
      outlineIsArray: Array.isArray(outline),
      outlineLength: Array.isArray(outline) ? outline.length : 'N/A',
    })

    if (!outline || !Array.isArray(outline)) {
      console.error('Invalid outline:', outline)
      return NextResponse.json(
        { error: 'Outline is required and must be an array' },
        { status: 400 }
      )
    }

    if (!env.GEMINI_KEY) {
      return NextResponse.json(
        { error: 'GEMINI_KEY is not configured' },
        { status: 500 }
      )
    }

    // Initialize Google Gen AI SDK
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_KEY })

    // Build a comprehensive prompt for generating search queries
    const prompt = `Du bist ein Experte für wissenschaftliche Literaturrecherche. Erstelle für jede Sektion der folgenden Thesis-Gliederung 3 präzise Suchanfragen, die bei der Recherche wissenschaftlicher Literatur helfen.

**Thesis-Informationen:**
- Titel/Thema: ${thesisTitle || topic || 'Nicht angegeben'}
- Fachbereich: ${field || 'Nicht angegeben'}
- Forschungsfrage: ${researchQuestion || 'Nicht angegeben'}

**Gliederung:**
${JSON.stringify(outline, null, 2)}

**Aufgabe:**
Erstelle für JEDE Sektion (Kapitel, Abschnitt, Unterabschnitt) der Gliederung genau 3 Suchanfragen. Die Suchanfragen sollten:
1. Spezifisch und präzise sein
2. Fachbegriffe und relevante Konzepte enthalten
3. Für wissenschaftliche Datenbanken (PubMed, Google Scholar, etc.) geeignet sein
4. Verschiedene Aspekte des Themas abdecken
5. Auf Deutsch oder Englisch formuliert sein (je nach Fachbereich)

**Format:**
Antworte NUR mit einem JSON-Objekt im folgenden Format:
{
  "queries": [
    {
      "sectionNumber": "1",
      "sectionTitle": "Einleitung",
      "queries": [
        "Suchanfrage 1",
        "Suchanfrage 2",
        "Suchanfrage 3"
      ]
    },
    {
      "sectionNumber": "1.1",
      "sectionTitle": "Hintergrund",
      "queries": [
        "Suchanfrage 1",
        "Suchanfrage 2",
        "Suchanfrage 3"
      ]
    },
    ...
  ]
}

Wichtig: Erstelle Suchanfragen für ALLE Sektionen (Kapitel, Abschnitte UND Unterabschnitte) der Gliederung.`

    // Call Gemini API using the SDK
    console.log('Calling Gemini API to generate search queries...')
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
    })

    const content = response.text
    console.log('Gemini response received, length:', content?.length || 0)

    if (!content) {
      console.error('No content from Gemini API')
      throw new Error('No content from Gemini API')
    }

    // Parse JSON from response (handle potential markdown code blocks)
    let jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      // Try to find JSON array
      jsonMatch = content.match(/\[[\s\S]*\]/)
    }

    if (!jsonMatch) {
      console.error('Could not find JSON in response. Content preview:', content.substring(0, 500))
      throw new Error('Invalid JSON response from Gemini')
    }

    let parsedData
    try {
      parsedData = JSON.parse(jsonMatch[0])
    } catch (parseError) {
      console.error('JSON parse error:', parseError)
      console.error('JSON string:', jsonMatch[0].substring(0, 1000))
      throw new Error(`Failed to parse JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
    }

    // Validate structure
    if (!parsedData.queries || !Array.isArray(parsedData.queries)) {
      throw new Error('Invalid queries format from Gemini')
    }

    // Ensure each query object has the required structure
    const validatedQueries = parsedData.queries.map((item: any) => ({
      sectionNumber: item.sectionNumber || '',
      sectionTitle: item.sectionTitle || '',
      queries: Array.isArray(item.queries) ? item.queries.slice(0, 3) : [],
    }))

    return NextResponse.json({ queries: validatedQueries })
  } catch (error) {
    console.error('Error generating search queries:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : String(error)
    console.error('Error details:', errorStack)
    return NextResponse.json(
      { 
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? errorStack : undefined
      },
      { status: 500 }
    )
  }
}

