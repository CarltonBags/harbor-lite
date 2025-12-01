import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File
    const topic = formData.get('topic') as string
    const field = formData.get('field') as string
    const thesisType = formData.get('thesisType') as string
    const researchQuestion = formData.get('researchQuestion') as string
    const language = (formData.get('language') as string) || 'german'

    if (!file) {
      return NextResponse.json(
        { error: 'File is required' },
        { status: 400 }
      )
    }

    if (!env.GEMINI_KEY) {
      return NextResponse.json(
        { error: 'GEMINI_KEY is not configured' },
        { status: 500 }
      )
    }

    const thesisTypeLabels: Record<string, string> = {
      hausarbeit: 'Hausarbeit',
      seminararbeit: 'Seminararbeit',
      bachelor: 'Bachelorarbeit',
    }

    // Initialize Google Gen AI SDK
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_KEY })

    // Upload file to Gemini Files API
    const buffer = await file.arrayBuffer()
    const blob = new Blob([buffer], { type: file.type || 'application/pdf' })
    
    let uploadedFile
    try {
      uploadedFile = await ai.files.upload({
        file: blob,
      })
    } catch (error) {
      console.error('Error uploading file to Gemini:', error)
      return NextResponse.json(
        { error: 'Failed to upload file to Gemini' },
        { status: 500 }
      )
    }

    // Get length information from form data if available
    const lengthUnit = (formData.get('lengthUnit') as string) || 'pages'
    const lengthMin = formData.get('lengthMin') as string
    const lengthMax = formData.get('lengthMax') as string
    const lengthWords = formData.get('lengthWords') as string
    
    let avgPages: number
    if (lengthUnit === 'pages' && lengthMin && lengthMax) {
      avgPages = Math.round((parseInt(lengthMin) + parseInt(lengthMax)) / 2)
    } else if (lengthUnit === 'words' && lengthWords) {
      // Convert words to pages (words / 320) for display purposes
      const minWords = parseInt(lengthWords) || 0
      const maxWords = Math.round(minWords * 1.05) // 5% more
      avgPages = Math.round((minWords + maxWords) / 2 / 320)
    } else {
      avgPages = 50 // Default assumption
    }

    const langText = language === 'german' ? 'Deutsch' : 'English'
    const langInstruction = language === 'german'
      ? 'KRITISCH WICHTIG: Die gesamte Gliederung MUSS ausschließlich auf Deutsch sein. Alle Kapitel-Titel, Abschnitts-Titel und Unterabschnitts-Titel müssen auf Deutsch verfasst werden. KEINE englischen Begriffe verwenden, es sei denn, es handelt sich um Fachbegriffe, die üblicherweise auf Englisch verwendet werden. Wenn die hochgeladene Gliederung auf Englisch ist, übersetze ALLE Titel ins Deutsche. Die gesamte Kommunikation und alle Titel müssen auf Deutsch sein.'
      : 'CRITICALLY IMPORTANT: The entire outline MUST be exclusively in English. All chapter titles, section titles, and subsection titles must be written in English. DO NOT use German terms unless they are technical terms commonly used in German. If the uploaded outline is in German, translate ALL titles to English. All communication and all titles must be in English.'

    // Determine detail level based on thesis length
    let detailLevelInstruction = ''
    if (avgPages < 20) {
      detailLevelInstruction = language === 'german'
        ? 'WICHTIG: Diese Thesis ist sehr kurz (unter 20 Seiten). Vereinfache die Gliederung wenn nötig: Entferne zu tiefe Verschachtelungen (1.1.1.1 oder tiefer) und reduziere auf maximal Kapitel und Abschnitte. KEINE Unterabschnitte wenn nicht absolut notwendig.'
        : 'IMPORTANT: This thesis is very short (under 20 pages). Simplify the outline if necessary: Remove deep nesting (1.1.1.1 or deeper) and reduce to maximum chapters and sections. NO subsections unless absolutely necessary.'
    } else if (avgPages < 40) {
      detailLevelInstruction = language === 'german'
        ? 'WICHTIG: Diese Thesis ist relativ kurz (20-40 Seiten). Vereinfache die Gliederung wenn nötig: Entferne zu tiefe Verschachtelungen (1.1.1.1 oder tiefer) und behalte nur wichtige Unterabschnitte.'
        : 'IMPORTANT: This thesis is relatively short (20-40 pages). Simplify the outline if necessary: Remove deep nesting (1.1.1.1 or deeper) and keep only important subsections.'
    } else if (avgPages < 80) {
      detailLevelInstruction = language === 'german'
        ? 'WICHTIG: Diese Thesis hat einen mittleren Umfang (40-80 Seiten). Entferne zu tiefe Verschachtelungen (1.1.1.1 oder tiefer) wenn vorhanden.'
        : 'IMPORTANT: This thesis has a medium length (40-80 pages). Remove deep nesting (1.1.1.1 or deeper) if present.'
    } else {
      detailLevelInstruction = language === 'german'
        ? 'WICHTIG: Diese Thesis ist lang (über 80 Seiten). Tiefere Verschachtelung ist erlaubt, sollte aber sparsam verwendet werden. Entferne unnötig tiefe Ebenen (1.1.1.1.1 oder tiefer).'
        : 'IMPORTANT: This thesis is long (over 80 pages). Deeper nesting is allowed but should be used sparingly. Remove unnecessarily deep levels (1.1.1.1.1 or deeper).'
    }

    // Build prompt in the selected language
    const prompt = language === 'german'
      ? `Du bist ein akademischer Berater. Analysiere das hochgeladene Dokument, das eine Gliederung für eine ${thesisTypeLabels[thesisType] || 'Bachelorarbeit'} im Fachbereich ${field} zum Thema "${topic}" enthält.

Forschungsfrage: "${researchQuestion}"
Umfang: ca. ${avgPages} Seiten
Sprache: ${langText}

${langInstruction}

${detailLevelInstruction}

Extrahiere die Gliederung aus dem Dokument und konvertiere sie in das folgende JSON-Format. Stelle sicher, dass die Nummerierung korrekt ist (1, 2, 3 für Kapitel; 1.1, 1.2 für Abschnitte; 1.1.1, 1.1.2 für Unterabschnitte). Passe die Detailtiefe dem Umfang an. WICHTIG: Wenn die Gliederung im Dokument auf Englisch ist, übersetze ALLE Titel ins Deutsche.

Antworte NUR mit einem JSON-Array im folgenden Format (ALLE Titel müssen auf Deutsch sein):
[
  {
    "number": "1",
    "title": "Einleitung",
    "sections": [
      {
        "number": "1.1",
        "title": "Hintergrund und Problemstellung",
        "subsections": [
          {
            "number": "1.1.1",
            "title": "Aktueller Forschungsstand"
          }
        ]
      }
    ]
  }
]

WICHTIG:
- SPRACHE: Alle Titel MÜSSEN auf Deutsch sein. Wenn die ursprüngliche Gliederung auf Englisch ist, übersetze ALLE Titel ins Deutsche. Keine Ausnahmen.
- Verwende immer korrekte Nummerierung
- Die Detailtiefe MUSS dem Umfang entsprechen: Bei kurzen Thesen (unter 20 Seiten) KEINE oder nur wenige Unterabschnitte
- Jedes Kapitel sollte mindestens 2-3 Abschnitte haben (bei sehr kurzen Thesen können es auch weniger sein)
- KEINE Verschachtelung tiefer als 3 Ebenen (Kapitel > Abschnitt > Unterabschnitt) - niemals 1.1.1.1 oder tiefer
- Wenn die ursprüngliche Gliederung zu detailliert ist, vereinfache sie entsprechend dem Umfang
- Die Struktur sollte der ursprünglichen Gliederung im Dokument entsprechen, aber in unserem Format sein und dem Umfang angemessen sein

**ENTFERNE aus der Gliederung (werden automatisch hinzugefügt):**
- KEIN "Literaturverzeichnis", "Quellenverzeichnis", "Bibliography" oder "References"
- KEIN "Inhaltsverzeichnis" oder "Table of Contents"
- KEIN "Abbildungsverzeichnis", "Tabellenverzeichnis" oder "Abkürzungsverzeichnis"
- KEIN "Anhang", "Appendix" oder "Anlagen"
- KEIN "Deckblatt", "Titelseite" oder "Title Page"
- KEIN "Eidesstattliche Erklärung" oder "Declaration"
Diese Elemente werden AUTOMATISCH vom System hinzugefügt und dürfen NICHT in der Gliederung erscheinen! Entferne sie aus der hochgeladenen Gliederung.`
      : `You are an academic advisor. Analyze the uploaded document that contains an outline for a ${thesisTypeLabels[thesisType] || 'Bachelorarbeit'} in the field of ${field} on the topic "${topic}".

Research Question: "${researchQuestion}"
Length: approx. ${avgPages} pages
Language: ${langText}

${langInstruction}

${detailLevelInstruction}

Extract the outline from the document and convert it to the following JSON format. Ensure the numbering is correct (1, 2, 3 for chapters; 1.1, 1.2 for sections; 1.1.1, 1.1.2 for subsections). Adjust the level of detail to match the length. IMPORTANT: If the outline in the document is in German, translate ALL titles to English.

Respond ONLY with a JSON array in the following format (ALL titles must be in English):
[
  {
    "number": "1",
    "title": "Introduction",
    "sections": [
      {
        "number": "1.1",
        "title": "Background and Problem Statement",
        "subsections": [
          {
            "number": "1.1.1",
            "title": "Current State of Research"
          }
        ]
      }
    ]
  }
]

IMPORTANT:
- LANGUAGE: All titles MUST be in English. If the original outline is in German, translate ALL titles to English. No exceptions.
- Always use correct numbering
- The level of detail MUST match the length: For short theses (under 20 pages) NO or only a few subsections
- Each chapter should have at least 2-3 sections (for very short theses it can be fewer)
- NO nesting deeper than 3 levels (Chapter > Section > Subsection) - never 1.1.1.1 or deeper
- If the original outline is too detailed, simplify it according to the length
- The structure should match the original outline in the document, but be in our format and appropriate for the length

**REMOVE from the outline (added automatically by system):**
- NO "Bibliography", "References", "Works Cited", or "Literaturverzeichnis"
- NO "Table of Contents" or "Inhaltsverzeichnis"
- NO "List of Figures", "List of Tables", or "List of Abbreviations"
- NO "Appendix", "Appendices", or "Anhang"
- NO "Title Page", "Cover Page", or "Deckblatt"
- NO "Declaration", "Statutory Declaration", or "Eidesstattliche Erklärung"
These elements are AUTOMATICALLY added by the system and must NOT appear in the outline! Remove them from the uploaded outline.`

    // Call Gemini API with file
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [
        {
          parts: [
            {
              fileData: {
                mimeType: uploadedFile.mimeType || file.type || 'application/pdf',
                fileUri: uploadedFile.uri,
              },
            },
            {
              text: prompt,
            },
          ],
        },
      ],
    })

    const content = response.text

    if (!content) {
      throw new Error('No content from Gemini API')
    }

    // Parse JSON from response (handle potential markdown code blocks)
    const jsonMatch = content.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      throw new Error('Invalid JSON response from Gemini')
    }

    const outline = JSON.parse(jsonMatch[0])

    if (!Array.isArray(outline) || outline.length === 0) {
      throw new Error('Invalid outline format')
    }

    // Filter out forbidden chapters (Verzeichnisse, Anhang, etc.)
    const forbiddenTitles = [
      'literaturverzeichnis', 'quellenverzeichnis', 'bibliography', 'references', 'works cited',
      'inhaltsverzeichnis', 'table of contents',
      'abbildungsverzeichnis', 'tabellenverzeichnis', 'abkürzungsverzeichnis',
      'list of figures', 'list of tables', 'list of abbreviations',
      'anhang', 'appendix', 'appendices', 'anlagen',
      'deckblatt', 'titelseite', 'title page', 'cover page',
      'eidesstattliche erklärung', 'declaration', 'statutory declaration',
    ]
    
    const filteredOutline = outline.filter((item: any) => {
      const title = (item.title || '').toLowerCase().trim()
      return !forbiddenTitles.some(forbidden => title.includes(forbidden))
    })

    // Validate and normalize structure
    const validatedOutline = filteredOutline.map((item: any, index: number) => {
      const chapterNumber = item.number || String(index + 1)
      const sections = Array.isArray(item.sections) ? item.sections.map((section: any, secIndex: number) => {
        const sectionNumber = section.number || `${chapterNumber}.${secIndex + 1}`
        const subsections = Array.isArray(section.subsections) ? section.subsections.map((subsection: any, subIndex: number) => ({
          number: subsection.number || `${sectionNumber}.${subIndex + 1}`,
          title: subsection.title || 'Unbenannter Unterabschnitt',
        })) : []
        
        return {
          number: sectionNumber,
          title: section.title || 'Unbenannter Abschnitt',
          subsections,
        }
      }) : []
      
      return {
        number: chapterNumber,
        title: item.title || item.chapter || 'Unbenanntes Kapitel',
        sections,
      }
    })

    return NextResponse.json({ outline: validatedOutline })
  } catch (error) {
    console.error('Error parsing outline:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

