import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      )
    }

    if (!env.GEMINI_KEY) {
      return NextResponse.json(
        { error: 'GEMINI_KEY is not configured' },
        { status: 500 }
      )
    }

    // Convert file to buffer for Gemini
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const mimeType = file.type || 'application/pdf'

    // Initialize Google Gen AI SDK
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_KEY })

    // Upload file to Gemini Files API first
    let fileData
    try {
      // Create a Blob from the buffer
      const blob = new Blob([buffer], { type: mimeType })
      fileData = await ai.files.upload({
        file: blob,
      })
      console.log('File uploaded successfully:', fileData.name, fileData.uri)
    } catch (uploadError) {
      console.error('Error uploading file to Gemini:', uploadError)
      throw new Error(`Failed to upload file: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`)
    }

    // Wait a bit for file to be processed
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Extract metadata using Gemini
    const prompt = `Du bist ein Experte für wissenschaftliche Literaturanalyse. Analysiere dieses Dokument und extrahiere alle bibliographischen Informationen für ein Literaturverzeichnis.

Extrahiere folgende Informationen:
- Titel (title)
- Autoren (authors) - als Array von Strings
- Erscheinungsjahr (year)
- Zeitschrift/Journal (journal) - falls vorhanden
- Verlag/Publisher (publisher) - falls vorhanden
- DOI (doi) - falls vorhanden
- ISBN (isbn) - falls vorhanden
- URL (url) - falls vorhanden
- Erste Seite (pageStart) - z.B. "123"
- Letzte Seite (pageEnd) - z.B. "145"
- Seitenzahlen (pages) - z.B. "123-145" (kann aus pageStart und pageEnd konstruiert werden)
- Band/Volume (volume) - falls vorhanden
- Ausgabe/Issue (issue) - falls vorhanden
- Abstract (abstract) - falls vorhanden
- Schlagwörter/Keywords (keywords) - als Array, falls vorhanden
- Vollständige Zitation (citation) - im APA-Format

Antworte NUR mit einem JSON-Objekt im folgenden Format:
{
  "title": "Titel des Dokuments",
  "authors": ["Autor 1", "Autor 2"],
  "year": "2024",
  "journal": "Journal Name",
  "publisher": "Publisher Name",
  "doi": "10.1234/example.doi",
  "isbn": "978-3-123456-78-9",
  "url": "https://example.com",
  "pageStart": "123",
  "pageEnd": "145",
  "pages": "123-145",
  "volume": "42",
  "issue": "3",
  "abstract": "Abstract Text",
  "keywords": ["Keyword1", "Keyword2"],
  "citation": "Vollständige APA-Zitation"
}

Wenn eine Information nicht gefunden werden kann, lasse das Feld weg oder setze es auf null.`

    let response
    try {
      // Use the correct format for file data with Gemini SDK
      // The contents should be an array of content objects, each with parts
      response = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: [
          {
            parts: [
              {
                fileData: {
                  mimeType: mimeType,
                  fileUri: fileData.uri,
                },
              },
              {
                text: prompt,
              },
            ],
          },
        ],
      })
      console.log('Content generated successfully')
    } catch (genError) {
      console.error('Error generating content:', genError)
      // Log the full error for debugging
      if (genError instanceof Error) {
        console.error('Error message:', genError.message)
        console.error('Error stack:', genError.stack)
      }
      throw new Error(`Failed to generate content: ${genError instanceof Error ? genError.message : String(genError)}`)
    }

    const content = response.text

    if (!content) {
      throw new Error('No content received from Gemini API')
    }

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('Invalid JSON response from Gemini')
    }

    const metadata = JSON.parse(jsonMatch[0])

    // VALIDATION: Forbid page numbers starting with a letter due to AI hallucinations (e.g. "a006841")
    const invalidPagePattern = /^[a-zA-Z]/

    if (metadata.pageStart && invalidPagePattern.test(metadata.pageStart)) {
      console.warn(`Blocked invalid pageStart: ${metadata.pageStart}`)
      metadata.pageStart = null
      metadata.pages = null // Invalidate combined field too
    }

    if (metadata.pageEnd && invalidPagePattern.test(metadata.pageEnd)) {
      console.warn(`Blocked invalid pageEnd: ${metadata.pageEnd}`)
      metadata.pageEnd = null
      // pages might be valid if only end is invalid? Unlikely. Safety first.
      metadata.pages = null
    }

    // Also check combined string if it wasn't nullified yet
    if (metadata.pages && invalidPagePattern.test(metadata.pages)) {
      console.warn(`Blocked invalid pages: ${metadata.pages}`)
      metadata.pages = null
    }

    // Clean up the uploaded file (optional, or keep for later use)
    // await ai.files.delete({ name: fileData.name })

    return NextResponse.json({
      metadata,
      fileUri: fileData.uri,
      fileName: file.name,
      fileSize: file.size,
      mimeType: mimeType,
    })
  } catch (error) {
    console.error('Error extracting file metadata:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : undefined
    console.error('Error details:', { errorMessage, errorStack, error })
    return NextResponse.json(
      {
        error: errorMessage,
        details: errorStack,
        fullError: error instanceof Error ? error.toString() : String(error)
      },
      { status: 500 }
    )
  }
}

