import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'
import { createSupabaseServerClient } from '@/lib/supabase/client'
import { getThesisParagraphs } from '@/lib/supabase/thesis-paragraphs'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { thesisId, userMessage, selectedText, currentContent, thesisContext } = body

    if (!thesisId || !userMessage || !currentContent) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    if (!env.GEMINI_KEY) {
      return NextResponse.json(
        { error: 'Gemini API key not configured' },
        { status: 500 }
      )
    }

    // Get thesis paragraphs for context (semantic search)
    let relevantContext = ''
    try {
      const paragraphs = await getThesisParagraphs(thesisId)
      // Use first few paragraphs as context
      relevantContext = paragraphs.slice(0, 5).map(p => p.text).join('\n\n')
    } catch (error) {
      console.warn('Could not load thesis paragraphs for context:', error)
    }

    // Initialize Gemini
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_KEY })

    // Build prompt for editing
    const language = thesisContext?.language || 'german'
    const citationStyle = thesisContext?.citation_style || 'apa'
    
    const prompt = language === 'german'
      ? `Du bist ein akademischer Schreibassistent. Ein Benutzer möchte einen Teil seiner Thesis bearbeiten.

**Thesis-Kontext:**
- Thema: ${thesisContext?.topic || 'Nicht angegeben'}
- Fachbereich: ${thesisContext?.field || 'Nicht angegeben'}
- Zitationsstil: ${citationStyle}
- Sprache: ${language}

**Aktueller Thesis-Inhalt (Markdown-Format):**
${currentContent.substring(0, 10000)}${currentContent.length > 10000 ? '\n\n[... Inhalt gekürzt ...]' : ''}

${selectedText ? `**Vom Benutzer ausgewählter Text, der bearbeitet werden soll:**
"${selectedText}"

**Benutzeranfrage:**
${userMessage}

**Aufgabe:**
1. Verstehe die Anfrage des Benutzers genau
2. Bearbeite den ausgewählten Text (oder den relevanten Teil des Inhalts) entsprechend der Anfrage
3. Stelle sicher, dass der bearbeitete Text:
   - Akademisch und professionell formuliert ist
   - Im gleichen Stil wie der Rest der Thesis geschrieben ist
   - Die gleiche Sprache (${language}) verwendet
   - Den Zitationsstil ${citationStyle} beibehält
   - Nahtlos in den Kontext passt
4. Gib den VOLLSTÄNDIGEN bearbeiteten Thesis-Inhalt zurück (nicht nur den geänderten Teil)

**Wichtig:**
- Antworte NUR mit dem vollständigen bearbeiteten Markdown-Inhalt
- Keine Erklärungen, keine Kommentare, nur der Inhalt
- Behalte die Markdown-Formatierung bei
- Stelle sicher, dass der gesamte Inhalt konsistent ist` 
      : `You are an academic writing assistant. A user wants to edit part of their thesis.

**Thesis Context:**
- Topic: ${thesisContext?.topic || 'Not specified'}
- Field: ${thesisContext?.field || 'Not specified'}
- Citation Style: ${citationStyle}
- Language: ${language}

**Current Thesis Content (Markdown format):**
${currentContent.substring(0, 10000)}${currentContent.length > 10000 ? '\n\n[... Content truncated ...]' : ''}

${selectedText ? `**Text selected by user to be edited:**
"${selectedText}"

**User Request:**
${userMessage}

**Task:**
1. Understand the user's request precisely
2. Edit the selected text (or relevant part of the content) according to the request
3. Ensure the edited text:
   - Is academically and professionally written
   - Matches the style of the rest of the thesis
   - Uses the same language (${language})
   - Maintains the ${citationStyle} citation style
   - Fits seamlessly into the context
4. Return the COMPLETE edited thesis content (not just the changed part)

**Important:**
- Respond ONLY with the complete edited Markdown content
- No explanations, no comments, just the content
- Maintain Markdown formatting
- Ensure the entire content is consistent`

    // Call Gemini API
    console.log('[EditThesis] Calling Gemini API for thesis editing...')
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
    })

    const editedContent = response.text

    if (!editedContent) {
      throw new Error('No content from Gemini API')
    }

    // Extract explanation if present (sometimes Gemini adds explanations)
    // Try to find if there's a clear separation between explanation and content
    let finalContent = editedContent.trim()
    let explanation = 'Text wurde erfolgreich bearbeitet.'

    // Check if response starts with markdown headers or content (likely the thesis)
    // vs starting with explanatory text
    if (editedContent.includes('```') || editedContent.includes('# ')) {
      // Likely contains code blocks or markdown - extract the content
      const codeBlockMatch = editedContent.match(/```(?:markdown|md)?\n([\s\S]*?)\n```/)
      if (codeBlockMatch) {
        finalContent = codeBlockMatch[1]
      } else {
        // Try to find where actual content starts (after explanation)
        const contentStart = editedContent.search(/(?:^|\n)(?:# |\*\*|\[)/)
        if (contentStart > 100) {
          // There's likely an explanation before the content
          explanation = editedContent.substring(0, contentStart).trim()
          finalContent = editedContent.substring(contentStart).trim()
        }
      }
    }

    // If the content seems too short or doesn't match expected format, use original
    if (finalContent.length < currentContent.length * 0.5) {
      console.warn('[EditThesis] Edited content seems too short, may have extraction issue')
      // Try to use the full response as content
      finalContent = editedContent
    }

    console.log(`[EditThesis] Successfully edited thesis (${finalContent.length} characters)`)

    return NextResponse.json({
      editedContent: finalContent,
      explanation,
    })
  } catch (error) {
    console.error('[EditThesis] Error editing thesis:', error)
    return NextResponse.json(
      { 
        error: 'Failed to edit thesis',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

