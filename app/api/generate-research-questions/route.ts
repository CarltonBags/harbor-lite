import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'

export async function POST(request: Request) {
  try {
    const { topic, field, thesisType } = await request.json()

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

    const thesisTypeLabels: Record<string, string> = {
      hausarbeit: 'Hausarbeit',
      bachelor: 'Bachelorarbeit',
      master: 'Masterarbeit',
      dissertation: 'Dissertation',
    }

    const prompt = `Du bist ein akademischer Berater. Generiere 5 präzise, gut formulierte Forschungsfragen für eine ${thesisTypeLabels[thesisType] || 'Masterarbeit'} im Fachbereich ${field} zum Thema "${topic}".

Die Forschungsfragen sollten:
- Wissenschaftlich präzise und klar formuliert sein
- Zum Thema und Fachbereich passen
- Für eine ${thesisTypeLabels[thesisType] || 'Masterarbeit'} angemessen sein
- Verschiedene Aspekte des Themas abdecken

Antworte NUR mit einer JSON-Liste von genau 5 Forschungsfragen, ohne zusätzlichen Text. Format:
["Frage 1", "Frage 2", "Frage 3", "Frage 4", "Frage 5"]`

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

