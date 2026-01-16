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
      seminararbeit: 'Seminararbeit',
      bachelor: 'Bachelorarbeit',
    }

    // ALL theses are literature-based - no own research/methodology allowed
    // We do NOT conduct studies, surveys, interviews, or experiments
    const isSourceBasedThesis = true // Always true - all theses are literature-based

    const citationStyleLabels: Record<string, string> = {
      apa: 'APA',
      mla: 'MLA',
      harvard: 'Harvard',
      'deutsche-zitierweise': 'Deutsche Zitierweise',
    }

    const avgPages = Math.round((lengthMin + lengthMax) / 2 / 250)
    const lengthText = language === 'german'
      ? `${lengthMin}-${lengthMax} Wörter (ca. ${Math.round(lengthMin / 250)}-${Math.round(lengthMax / 250)} Seiten)`
      : `${lengthMin}-${lengthMax} words (approx. ${Math.round(lengthMin / 250)}-${Math.round(lengthMax / 250)} pages)`
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

    // ALL theses are literature-based - stronger instruction
    const thesisTypeSpecificInstruction = language === 'german'
      ? `🚫 ABSOLUT KRITISCH für ${thesisTypeLabels[thesisType] || 'Bachelorarbeit'}:

Diese Arbeit ist eine REINE LITERATURARBEIT. Es wird KEINE eigene Forschung durchgeführt!

**STRENG VERBOTENE KAPITEL-TYPEN:**
- ✗ "Methodik" / "Methodisches Vorgehen" / "Forschungsmethodik"
- ✗ "Forschungsdesign" / "Untersuchungsdesign"
- ✗ "Datenerhebung" / "Datensammlung" / "Stichprobe"
- ✗ "Empirische Untersuchung" / "Empirische Analyse"
- ✗ "Ergebnisse" (im Sinne eigener Forschung)
- ✗ "Auswertung" (im Sinne eigener Datenauswertung)
- ✗ "Befragung" / "Interview" / "Umfrage"
- ✗ "Fallstudie" (im Sinne eigener Forschung)
- ✗ "Experiment" / "Experimentelles Design"

**ERLAUBTE STRUKTUR:**
- ✓ Einleitung (Problemstellung, Zielsetzung, Aufbau der Arbeit)
- ✓ Theoretischer Hintergrund / Begriffsklärung / Grundlagen
- ✓ Thematisch gegliederte Hauptkapitel (verschiedene Aspekte des Themas)
- ✓ Diskussion / Kritische Würdigung / Vergleich verschiedener Positionen
- ✓ Fazit / Schlussbetrachtung

Die Arbeit analysiert und vergleicht BESTEHENDE Literatur - sie führt KEINE eigene empirische Forschung durch!`
      : `🚫 ABSOLUTELY CRITICAL for ${thesisTypeLabels[thesisType] || 'Bachelor thesis'}:

This work is a PURE LITERATURE REVIEW. NO own research is conducted!

**STRICTLY FORBIDDEN CHAPTER TYPES:**
- ✗ "Methodology" / "Research Methods" / "Methodological Approach"
- ✗ "Research Design" / "Study Design"
- ✗ "Data Collection" / "Sampling" / "Sample"
- ✗ "Empirical Investigation" / "Empirical Analysis"
- ✗ "Results" (in terms of own research)
- ✗ "Analysis" (in terms of own data analysis)
- ✗ "Survey" / "Interview" / "Questionnaire"
- ✗ "Case Study" (in terms of own research)
- ✗ "Experiment" / "Experimental Design"

**ALLOWED STRUCTURE:**
- ✓ Introduction (Problem Statement, Objectives, Structure)
- ✓ Theoretical Background / Definitions / Fundamentals
- ✓ Thematically structured main chapters (different aspects of the topic)
- ✓ Discussion / Critical Analysis / Comparison of different positions
- ✓ Conclusion / Final Remarks

The work analyzes and compares EXISTING literature - it does NOT conduct own empirical research!`

    // Build prompt in the selected language
    const prompt = language === 'german'
      ? `Du bist ein akademischer Berater. Erstelle eine detaillierte, nummerierte Gliederung für eine ${thesisTypeLabels[thesisType] || 'Bachelorarbeit'} im Fachbereich ${field} zum Thema "${topic}".

Forschungsfrage: "${researchQuestion}"
Umfang: ${lengthText} (Durchschnitt: ca. ${avgPages} Seiten)
Zitationsstil: ${citationStyleLabels[citationStyle] || 'APA'}
Sprache: ${langText}

${langInstruction}

${detailLevelInstruction}

${thesisTypeSpecificInstruction}

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
- Die Gliederung sollte typische Kapitel für eine LITERATURARBEIT enthalten (z.B. Einleitung, Theoretischer Hintergrund, thematisch gegliederter Hauptteil, Diskussion, Fazit - KEINE Methodik, KEINE eigene Forschung!)
- Passe die Gliederung an das spezifische Thema und den Fachbereich an
- Die Anzahl der Kapitel und die Detailtiefe sollten dem Umfang von ${lengthText} (ca. ${avgPages} Seiten) angemessen sein

**ABSOLUT VERBOTEN in der Gliederung (werden automatisch hinzugefügt):**
- KEIN "Literaturverzeichnis", "Quellenverzeichnis", "Bibliography" oder "References"
- KEIN "Inhaltsverzeichnis" oder "Table of Contents"
- KEIN "Abbildungsverzeichnis", "Tabellenverzeichnis" oder "Abkürzungsverzeichnis"
- KEIN "Anhang", "Appendix" oder "Anlagen"
- KEIN "Deckblatt", "Titelseite" oder "Title Page"
- KEIN "Eidesstattliche Erklärung" oder "Declaration"
Diese Elemente werden AUTOMATISCH vom System hinzugefügt und dürfen NICHT in der Gliederung erscheinen!`
      : `You are an academic advisor. Create a detailed, numbered outline for a ${thesisTypeLabels[thesisType] || 'Bachelor thesis'} in the field of ${field} on the topic "${topic}".

Research Question: "${researchQuestion}"
Length: ${lengthText} (Average: approx. ${avgPages} pages)
Citation Style: ${citationStyleLabels[citationStyle] || 'APA'}
Language: ${langText}

${langInstruction}

${detailLevelInstruction}

${thesisTypeSpecificInstruction}

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
- The outline should contain typical chapters for a LITERATURE REVIEW (e.g., Introduction, Theoretical Background, thematically structured main body, Discussion, Conclusion - NO Methodology, NO own research!)
- Adapt the outline to the specific topic and field
- The number of chapters and level of detail should be appropriate for the length of ${lengthText} (approx. ${avgPages} pages)

**ABSOLUTELY FORBIDDEN in the outline (added automatically by system):**
- NO "Bibliography", "References", "Works Cited", or "Literaturverzeichnis"
- NO "Table of Contents" or "Inhaltsverzeichnis"
- NO "List of Figures", "List of Tables", or "List of Abbreviations"
- NO "Appendix", "Appendices", or "Anhang"
- NO "Title Page", "Cover Page", or "Deckblatt"
- NO "Declaration", "Statutory Declaration", or "Eidesstattliche Erklärung"
These elements are AUTOMATICALLY added by the system and must NOT appear in the outline!`

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

    // Filter out forbidden chapters (Verzeichnisse, Anhang, and methodology/research chapters)
    const forbiddenTitles = [
      // Verzeichnisse
      'literaturverzeichnis', 'quellenverzeichnis', 'bibliography', 'references', 'works cited',
      'inhaltsverzeichnis', 'table of contents',
      'abbildungsverzeichnis', 'tabellenverzeichnis', 'abkürzungsverzeichnis',
      'list of figures', 'list of tables', 'list of abbreviations',
      'anhang', 'appendix', 'appendices', 'anlagen',
      'deckblatt', 'titelseite', 'title page', 'cover page',
      'eidesstattliche erklärung', 'declaration', 'statutory declaration',
      // Methodology/Research chapters - FORBIDDEN for literature-based theses
      'methodik', 'methodisches vorgehen', 'forschungsmethodik', 'methodology', 'research methods',
      'forschungsdesign', 'untersuchungsdesign', 'research design', 'study design',
      'datenerhebung', 'datensammlung', 'data collection', 'sampling',
      'empirische untersuchung', 'empirische analyse', 'empirical investigation', 'empirical analysis',
      'stichprobe', 'sample', 'befragung', 'interview', 'umfrage', 'survey', 'questionnaire',
      'experiment', 'experimentelles design', 'experimental design',
    ]

    const filteredOutline = outline.filter((item: any) => {
      const title = (item.title || '').toLowerCase().trim()
      return !forbiddenTitles.some(forbidden => title.includes(forbidden))
    })

    // Validate and normalize structure
    const isGerman = !language || language === 'german' || language === 'de'

    const defaultChapterTitle = isGerman ? 'Unbenanntes Kapitel' : 'Untitled Chapter'
    const defaultSectionTitle = isGerman ? 'Unbenannter Abschnitt' : 'Untitled Section'
    const defaultSubsectionTitle = isGerman ? 'Unbenannter Unterabschnitt' : 'Untitled Subsection'

    const validatedOutline = filteredOutline.map((item: any, index: number) => {
      const chapterNumber = item.number || String(index + 1)
      const sections = Array.isArray(item.sections) ? item.sections.map((section: any, secIndex: number) => {
        const sectionNumber = section.number || `${chapterNumber}.${secIndex + 1}`
        const subsections = Array.isArray(section.subsections) ? section.subsections.map((subsection: any, subIndex: number) => ({
          number: subsection.number || `${sectionNumber}.${subIndex + 1}`,
          title: subsection.title || defaultSubsectionTitle,
        })) : []

        return {
          number: sectionNumber,
          title: section.title || defaultSectionTitle,
          subsections,
        }
      }) : []

      return {
        number: chapterNumber,
        title: item.title || item.chapter || defaultChapterTitle,
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

