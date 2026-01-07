import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'
import { createSupabaseServerClient } from '@/lib/supabase/client'

export const maxDuration = 60 // 1 minute max

export async function POST(request: Request) {
    try {
        const { thesisId } = await request.json()

        if (!thesisId) {
            return NextResponse.json({ error: 'Missing thesisId' }, { status: 400 })
        }

        const supabase = createSupabaseServerClient()

        // 1. Check if quiz already exists
        const { data: thesis, error: fetchError } = await supabase
            .from('theses')
            .select('quiz_data, content, content_json, title')
            .eq('id', thesisId)
            .single()

        if (fetchError || !thesis) {
            return NextResponse.json({ error: 'Thesis not found' }, { status: 404 })
        }

        // Return existing quiz if available
        if (thesis.quiz_data && Array.isArray(thesis.quiz_data) && thesis.quiz_data.length > 0) {
            console.log('[GenerateQuiz] Returning existing quiz data')
            return NextResponse.json({ questions: thesis.quiz_data })
        }

        // 2. Prepare content for generation
        console.log('[GenerateQuiz] Generating new quiz for thesis:', thesisId)

        let textContent = ''
        if (thesis.content) {
            textContent = thesis.content
        } else if (thesis.content_json) {
            // Fallback/Parsing if structured
            textContent = JSON.stringify(thesis.content_json)
        }

        // Truncate to avoid context limits (e.g. 50k chars is plenty for quiz)
        // Gemini 1.5 Flash has huge context, but keep it reasonable
        const truncatedContent = textContent.slice(0, 100000)

        if (!env.GEMINI_KEY) {
            return NextResponse.json({ error: 'Gemini API key missing' }, { status: 500 })
        }

        const ai = new GoogleGenAI({ apiKey: env.GEMINI_KEY })
        const model = ai.models.generateContent

        // 3. Generate Quiz
        const prompt = `
      You are an exam creator. Create a challenging multiple-choice quiz based strictly on the provided thesis text.
      
      Requirements:
      - Create exactly 25 multiple-choice questions.
      - Questions must be ONLY about the content of the thesis (arguments, findings, theories).
      - NO questions about formatting, structure, or bibliography.
      - Each question must have exactly 4 options.
      - There must be exactly one correct answer per question.
      - Output purely valid JSON.

      Thesis Title: "${thesis.title}"
      
      Thesis Content (Snippet):
      ${truncatedContent}

      Output JSON format:
      [
        {
          "question": "Question text...",
          "options": ["Option A", "Option B", "Option C", "Option D"],
          "correctAnswer": 0 // index of correct option (0-3)
        }
      ]
    `

        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json'
            }
        })

        const responseText = response.text()
        let quizData = []

        try {
            if (responseText) {
                quizData = JSON.parse(responseText)
            }
        } catch (e) {
            console.error('[GenerateQuiz] Failed to parse JSON:', e)
            return NextResponse.json({ error: 'Failed to generate valid quiz JSON' }, { status: 500 })
        }

        // 4. Save to Database
        if (quizData.length > 0) {
            const { error: updateError } = await supabase
                .from('theses')
                .update({ quiz_data: quizData })
                .eq('id', thesisId)

            if (updateError) {
                console.error('[GenerateQuiz] Failed to save quiz:', updateError)
                // We still return the quiz even if save failed
            }
        }

        return NextResponse.json({ questions: quizData })

    } catch (error) {
        console.error('[GenerateQuiz] Error:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
