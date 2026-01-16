import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'

export async function POST(request: Request) {
  try {
    const { topic, field, thesisType, language } = await request.json()

    if (!topic || !field) {
      return NextResponse.json(
        { error: 'Topic and field are required' },
        { status: 400 }
      )
    }

    if (!env.GEMINI_KEY) {
      return NextResponse.json(
        { error: 'GEMINI_KEY is not configured' },
        { status: 500 }
      )
    }

    const isGerman = !language || language === 'german' || language === 'de'

    const thesisTypeLabels: Record<string, string> = {
      hausarbeit: isGerman ? 'Hausarbeit' : 'Term Paper',
      seminararbeit: isGerman ? 'Seminararbeit' : 'Seminar Paper',
      bachelor: isGerman ? 'Bachelorarbeit' : 'Bachelor Thesis',
      master: isGerman ? 'Masterarbeit' : 'Master Thesis',
    }

    const typeLabel = thesisTypeLabels[thesisType] || (isGerman ? 'Bachelorarbeit' : 'Bachelor Thesis')

    // Determine if this is a source-based thesis (no own research/methodology)
    const isSourceBasedThesis = thesisType === 'hausarbeit' || thesisType === 'seminararbeit'

    let sourceBasedInstruction = ''
    if (isGerman) {
      sourceBasedInstruction = isSourceBasedThesis
        ? `WICHTIG: Diese ${typeLabel} basiert NUR auf Literaturrecherche und Quellenanalyse.
  - Die Forschungsfragen sollten KEINE eigene empirische Forschung erfordern
  - Geeignet sind Fragen wie: "Wie wird X in der Literatur definiert?", "Welche Ansätze gibt es zu Y?", "Wie hat sich Z entwickelt?"
  - NICHT geeignet sind Fragen wie: "Welche Auswirkungen hat X?" (wenn eigene Datenerhebung nötig wäre)`
        : `Diese ${typeLabel} kann eigene Forschung/Methodik enthalten.
  - Die Forschungsfragen können empirische Untersuchungen erfordern`
    } else {
      sourceBasedInstruction = isSourceBasedThesis
        ? `IMPORTANT: This ${typeLabel} is based ONLY on literature review and source analysis.
  - Research questions should NOT require empirical research.
  - Suitable: "How is X defined in literature?", "What approaches exist for Y?", "How has Z developed?"
  - NOT suitable: "What is the impact of X?" (if it requires data collection)`
        : `This ${typeLabel} may include original research/methodology.
  - Research questions typically require empirical investigation.`
    }

    const prompt = isGerman
      ? `Du bist ein akademischer Berater. Generiere 5 präzise, gut formulierte Forschungsfragen für eine ${typeLabel} im Fachbereich ${field} zum Thema "${topic}".

${sourceBasedInstruction}

Die Forschungsfragen sollten:
- Wissenschaftlich präzise und klar formuliert sein
- Zum Thema und Fachbereich passen
- Für eine ${typeLabel} angemessen sein
- Verschiedene Aspekte des Themas abdecken
- **Allgemein genug sein, um durch Standardliteratur beantwortbar zu sein**
- **Fokussiere auf Konzepte und Zusammenhänge**

Antworte NUR mit einer JSON-Liste von genau 5 Forschungsfragen auf DEUTSCH, ohne zusätzlichen Text. Format:
["Frage 1", "Frage 2", "Frage 3", "Frage 4", "Frage 5"]`
      : `You are an academic advisor. Generate 5 precise, well-formulated research questions for a ${typeLabel} in the field of ${field} on the topic "${topic}".

${sourceBasedInstruction}

The research questions should:
- Be scientifically precise and clearly formulated
- Fit the topic and field
- Be appropriate for a ${typeLabel}
- Cover different aspects of the topic
- **Be general enough to be answerable by standard literature**
- **Focus on concepts and relationships**

Reply ONLY with a JSON list of exactly 5 research questions in ENGLISH, without extra text. Format:
["Question 1", "Question 2", "Question 3", "Question 4", "Question 5"]`

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

    const suggestions = JSON.parse(jsonMatch[0])

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      throw new Error('Invalid suggestions format')
    }

    // Ensure we have exactly 5 suggestions
    const finalSuggestions = suggestions.slice(0, 5)

    return NextResponse.json({ suggestions: finalSuggestions })
  } catch (error) {
    console.error('Error generating research questions:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

