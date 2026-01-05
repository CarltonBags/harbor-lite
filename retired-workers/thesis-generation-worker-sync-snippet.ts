/**
 * Specialized repair function to sync the Introduction's "Structure" section 
 * with the actual generated chapters.
 */
async function syncStructureInIntroduction(
    introContent: string,
    actualStructure: string,
    isGerman: boolean
): Promise<string> {
    const prompt = isGerman
        ? `Du bist ein strenger akademischer Lektor.
    
    DEINE AUFGABE:
    In diesem Einleitungskapitel gibt es einen Abschnitt "Aufbau der Arbeit" (oder "Gang der Untersuchung").
    Dieser Abschnitt beschreibt oft eine Gliederung, die NICHT MEHR stimmt.
    
    HIER IST DIE TATSÄCHLICHE GLIEDERUNG DER FERTIGEN ARBEIT:
    ${actualStructure}
    
    ANWEISUNG:
    1. Suche den Abschnitt, der den Aufbau beschreibt.
    2. SCHREIBE IHN KOMPLETT UM, sodass er EXAKT die oben genannte Gliederung beschreibt.
    3. Nenne die Kapitelnummern und Titel korrekt (z.B. "In Kapitel 2 beschäftigt sich die Arbeit mit...").
    4. Ändere NICHTS anderes am Text! Nur diesen einen Abschnitt.
    
    KAPITEL TEXT:
    ${introContent}
    
    GIB DAS KOMPLETTE KAPITEL ZURÜCK (mit dem korrigierten Abschnitt).`

        : `You are a strict academic editor.
    
    YOUR TASK:
    In this Introduction chapter, there is a section describing the "Structure of the Thesis".
    This section often describes an outline that is OUTDATED.
    
    HERE IS THE ACTUAL STRUCTURE OF THE FINISHED THESIS:
    ${actualStructure}
    
    INSTRUCTION:
    1. Find the section describing the structure.
    2. REWRITE IT COMPLETELY to match the list above EXACTLY.
    3. Mention chapter numbers and titles correctly (e.g. "Chapter 2 deals with...").
    4. Do NOT change anything else! Only this section.
    
    CHAPTER TEXT:
    ${introContent}
    
    OUTPUT THE FULL CHAPTER (with the corrected section).`

    try {
        const response = await retryApiCall(() => ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: prompt,
            config: { maxOutputTokens: 8000, temperature: 0.1 },
        }), 'Sync Structure')
        return response.text ? response.text.trim() : introContent
    } catch (error) {
        console.warn('[StructureSync] Failed to sync:', error)
        return introContent
    }
}
