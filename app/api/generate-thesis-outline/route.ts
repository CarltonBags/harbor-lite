import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'

export async function POST(request: Request) {
  try {
    const { topic, field, thesisType, researchQuestion, lengthMin, lengthMax, citationStyle, language } = await request.json()

    if (!topic || !field || !researchQuestion) {
      return NextResponse.json(
        { error: 'Topic, field, and research question are required' },
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
      bachelor: 'Bachelorarbeit',
      master: 'Masterarbeit',
      dissertation: 'Dissertation',
    }

    const citationStyleLabels: Record<string, string> = {
      apa: 'APA',
      mla: 'MLA',
      harvard: 'Harvard',
      'deutsche-zitierweise': 'Deutsche Zitierweise',
    }

    const avgPages = Math.round((lengthMin + lengthMax) / 2 / 320)
    const lengthText = language === 'german'
      ? `${lengthMin}-${lengthMax} Wörter (ca. ${Math.round(lengthMin/320)}-${Math.round(lengthMax/320)} Seiten)`
      : `${lengthMin}-${lengthMax} words (approx. ${Math.round(lengthMin/320)}-${Math.round(lengthMax/320)} pages)`
    const langText = language === 'german' ? 'Deutsch' : 'English'
    const langInstruction = language === 'german' 
      ? 'KRITISCH WICHTIG: Die gesamte Gliederung MUSS ausschließlich auf Deutsch sein. Alle Kapitel-Titel, Abschnitts-Titel und Unterabschnitts-Titel müssen auf Deutsch verfasst werden. KEINE englischen Begriffe verwenden, es sei denn, es handelt sich um Fachbegriffe, die üblicherweise auf Englisch verwendet werden. Die gesamte Kommunikation und alle Titel müssen auf Deutsch sein.'
      : 'CRITICALLY IMPORTANT: The entire outline MUST be exclusively in English. All chapter titles, section titles, and subsection titles must be written in English. DO NOT use German terms unless they are technical terms commonly used in German. All communication and all titles must be in English.'

    // Determine detail level based on thesis length
    let detailLevelInstruction = ''
    if (avgPages < 20) {
      // Very short thesis: Only chapters and sections, NO subsections
      detailLevelInstruction = language === 'german'
        ? 'WICHTIG: Diese Thesis ist sehr kurz (unter 20 Seiten). Erstelle eine einfache Gliederung mit NUR Kapiteln (1, 2, 3...) und Abschnitten (1.1, 1.2...). KEINE Unterabschnitte (1.1.1, etc.). Die Gliederung muss dem geringen Umfang angemessen sein.'
        : 'IMPORTANT: This thesis is very short (under 20 pages). Create a simple outline with ONLY chapters (1, 2, 3...) and sections (1.1, 1.2...). NO subsections (1.1.1, etc.). The outline must be appropriate for the limited length.'
    } else if (avgPages < 40) {
      // Short thesis: Chapters, sections, minimal subsections
      detailLevelInstruction = language === 'german'
        ? 'WICHTIG: Diese Thesis ist relativ kurz (20-40 Seiten). Erstelle eine angemessene Gliederung mit Kapiteln, Abschnitten und nur wenigen, wichtigen Unterabschnitten. Vermeide zu tiefe Verschachtelung (keine 1.1.1.1 oder tiefer).'
        : 'IMPORTANT: This thesis is relatively short (20-40 pages). Create an appropriate outline with chapters, sections, and only a few important subsections. Avoid deep nesting (no 1.1.1.1 or deeper).'
    } else if (avgPages < 80) {
      // Medium thesis: Standard structure with subsections
      detailLevelInstruction = language === 'german'
        ? 'WICHTIG: Diese Thesis hat einen mittleren Umfang (40-80 Seiten). Erstelle eine strukturierte Gliederung mit Kapiteln, Abschnitten und Unterabschnitten. Vermeide jedoch zu tiefe Verschachtelung (keine 1.1.1.1 oder tiefer).'
        : 'IMPORTANT: This thesis has a medium length (40-80 pages). Create a structured outline with chapters, sections, and subsections. However, avoid deep nesting (no 1.1.1.1 or deeper).'
    } else {
      // Long thesis: Can have more detail
      detailLevelInstruction = language === 'german'
        ? 'WICHTIG: Diese Thesis ist lang (über 80 Seiten). Erstelle eine detaillierte Gliederung mit Kapiteln, Abschnitten und Unterabschnitten. Tiefere Verschachtelung ist erlaubt, sollte aber sparsam verwendet werden.'
        : 'IMPORTANT: This thesis is long (over 80 pages). Create a detailed outline with chapters, sections, and subsections. Deeper nesting is allowed but should be used sparingly.'
    }

    // Build prompt in the selected language
    const prompt = language === 'german'
      ? `Du bist ein akademischer Berater. Erstelle eine detaillierte, nummerierte Gliederung für eine ${thesisTypeLabels[thesisType] || 'Masterarbeit'} im Fachbereich ${field} zum Thema "${topic}".

Forschungsfrage: "${researchQuestion}"
Umfang: ${lengthText} (Durchschnitt: ca. ${avgPages} Seiten)
Zitationsstil: ${citationStyleLabels[citationStyle] || 'APA'}
Sprache: ${langText}

${langInstruction}

${detailLevelInstruction}

Erstelle eine umfassende, hierarchische Gliederung mit nummerierten Kapiteln, Abschnitten und Unterabschnitten. Die Struktur muss dem Umfang angemessen sein und wissenschaftlichen Standards entsprechen.

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
          },
          {
            "number": "1.1.2",
            "title": "Identifizierte Forschungslücke"
          }
        ]
      },
      {
        "number": "1.2",
        "title": "Zielsetzung und Forschungsfrage",
        "subsections": []
      }
    ]
  },
  {
    "number": "2",
    "title": "Theoretischer Hintergrund",
    "sections": [
      {
        "number": "2.1",
        "title": "Grundlegende Konzepte",
        "subsections": []
      }
    ]
  }
]

WICHTIG:
- SPRACHE: Alle Titel MÜSSEN auf Deutsch sein. Keine Ausnahmen.
- Verwende immer korrekte Nummerierung (1, 2, 3 für Kapitel; 1.1, 1.2 für Abschnitte; 1.1.1, 1.1.2 für Unterabschnitte)
- Die Detailtiefe MUSS dem Umfang entsprechen: Bei kurzen Thesen (unter 20 Seiten) KEINE Unterabschnitte, bei mittleren Thesen (20-40 Seiten) nur wenige wichtige Unterabschnitte
- Jedes Kapitel sollte mindestens 2-3 Abschnitte haben (bei sehr kurzen Thesen können es auch weniger sein)
- Abschnitte können Unterabschnitte haben, ABER NUR wenn der Umfang dies rechtfertigt
- KEINE Verschachtelung tiefer als 3 Ebenen (Kapitel > Abschnitt > Unterabschnitt) - niemals 1.1.1.1 oder tiefer
- Die Gliederung sollte typische Kapitel für eine ${thesisTypeLabels[thesisType] || 'Masterarbeit'} enthalten (z.B. Einleitung, Theoretischer Hintergrund, Methodik, Ergebnisse, Diskussion, Fazit)
- Passe die Gliederung an das spezifische Thema und den Fachbereich an
- Die Anzahl der Kapitel und die Detailtiefe sollten dem Umfang von ${lengthText} (ca. ${avgPages} Seiten) angemessen sein`
      : `You are an academic advisor. Create a detailed, numbered outline for a ${thesisTypeLabels[thesisType] || 'Masterarbeit'} in the field of ${field} on the topic "${topic}".

Research Question: "${researchQuestion}"
Length: ${lengthText} (Average: approx. ${avgPages} pages)
Citation Style: ${citationStyleLabels[citationStyle] || 'APA'}
Language: ${langText}

${langInstruction}

${detailLevelInstruction}

Create a comprehensive, hierarchical outline with numbered chapters, sections, and subsections. The structure must be appropriate for the length and meet academic standards.

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
          },
          {
            "number": "1.1.2",
            "title": "Identified Research Gap"
          }
        ]
      },
      {
        "number": "1.2",
        "title": "Objectives and Research Question",
        "subsections": []
      }
    ]
  },
  {
    "number": "2",
    "title": "Theoretical Background",
    "sections": [
      {
        "number": "2.1",
        "title": "Fundamental Concepts",
        "subsections": []
      }
    ]
  }
]

IMPORTANT:
- LANGUAGE: All titles MUST be in English. No exceptions.
- Always use correct numbering (1, 2, 3 for chapters; 1.1, 1.2 for sections; 1.1.1, 1.1.2 for subsections)
- The level of detail MUST match the length: For short theses (under 20 pages) NO subsections, for medium theses (20-40 pages) only a few important subsections
- Each chapter should have at least 2-3 sections (for very short theses it can be fewer)
- Sections can have subsections, BUT ONLY if the length justifies it
- NO nesting deeper than 3 levels (Chapter > Section > Subsection) - never 1.1.1.1 or deeper
- The outline should contain typical chapters for a ${thesisTypeLabels[thesisType] || 'Masterarbeit'} (e.g., Introduction, Theoretical Background, Methodology, Results, Discussion, Conclusion)
- Adapt the outline to the specific topic and field
- The number of chapters and level of detail should be appropriate for the length of ${lengthText} (approx. ${avgPages} pages)`

    // Initialize Google Gen AI SDK
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_KEY })

    // Call Gemini API using the SDK
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
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

    // Validate and normalize structure
    const validatedOutline = outline.map((item: any, index: number) => {
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
    console.error('Error generating thesis outline:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

