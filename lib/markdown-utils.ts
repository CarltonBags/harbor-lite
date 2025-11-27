/**
 * Utility to convert thesis content to clean Markdown format
 * This ensures proper heading structure and formatting for Pandoc exports
 */

export function convertToCleanMarkdown(content: string): string {
    const lines = content.split('\n')
    const processedLines: string[] = []

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmedLine = line.trim()

        if (!trimmedLine) {
            processedLines.push('')
            continue
        }

        // SAFETY: Strip bold from long paragraphs (>150 chars)
        // AI sometimes bolds entire paragraphs. We want to undo this.
        // Check if it starts and ends with **
        if (trimmedLine.length > 150 && trimmedLine.startsWith('**') && trimmedLine.endsWith('**')) {
            // Remove the first 2 and last 2 chars
            const stripped = trimmedLine.slice(2, -2)
            processedLines.push(stripped)
            continue
        }

        // CHECK EXISTING HEADINGS
        // If the AI generated "## 1. Einleitung", we want to enforce Level 1 based on the number "1."
        const existingHeadingMatch = trimmedLine.match(/^(#{1,6})\s+(.*)$/)
        if (existingHeadingMatch) {
            const currentHashes = existingHeadingMatch[1]
            const text = existingHeadingMatch[2]

            // Check if it has numbering like "1. Title" or "1.1 Title"
            const numberMatch = text.match(/^(\d+(?:\.\d+)*\.?)\s+(.+)$/)

            if (numberMatch) {
                const number = numberMatch[1]
                const title = numberMatch[2]

                // SKIP if this looks like the main thesis title (Level 1/2, no number or very short)
                // Actually, if it HAS a number, it's likely a chapter. 
                // But if it's just "# Title", we might want to skip.

                // Determine correct level based on number dots
                const normalizedNumber = number.replace(/\.$/, '')
                const level = (normalizedNumber.match(/\./g) || []).length

                let newHashes = '#'
                if (level === 0) newHashes = '#'      // 1. -> #
                else if (level === 1) newHashes = '##' // 1.1 -> ##
                else if (level === 2) newHashes = '###' // 1.1.1 -> ###
                else newHashes = '####'

                processedLines.push(`${newHashes} ${number} ${title}`)
            } else {
                // No number (e.g. "## Introduction" or "# Thesis Title")
                // If it looks like the main title (Level 1 and short), skip it
                // But "Introduction" (Abstract, etc) should be kept.
                // We'll map Abstract/Introduction to Level 1 if they are top level
                if (currentHashes.length === 1 && text.length < 100) {
                    // Likely the document title, skip it as we add it via metadata
                    continue;
                }

                // Otherwise keep as is, but maybe ensure it's at least Level 1?
                // If AI output "## Abstract", we probably want "# Abstract"
                if (text.match(/^(Abstract|Kurzfassung|Introduction|Einleitung|Fazit|Conclusion|Literaturverzeichnis|Bibliography|References)/i)) {
                    processedLines.push(`# ${text}`)
                } else {
                    processedLines.push(line)
                }
            }
            continue
        }

        // HEADING DETECTION LOGIC
        let headingMatchData = null

        // Case 1: "**1. Title** Text"
        const matchBoldFull = trimmedLine.match(/^\*\*(\d+(?:\.\d+)*\.?)\s+([^*]+)\*\*\s*(.*)$/)
        if (matchBoldFull) {
            headingMatchData = {
                number: matchBoldFull[1],
                title: matchBoldFull[2],
                rest: matchBoldFull[3],
                isBold: true
            }
        }
        // Case 2: "1. **Title** Text"
        else {
            const matchBoldTitle = trimmedLine.match(/^(\d+(?:\.\d+)*\.?)\s+\*\*([^*]+)\*\*\s*(.*)$/)
            if (matchBoldTitle) {
                headingMatchData = {
                    number: matchBoldTitle[1],
                    title: matchBoldTitle[2],
                    rest: matchBoldTitle[3],
                    isBold: true
                }
            }
            // Case 3: "1. Title" (Plain)
            else {
                const matchPlain = trimmedLine.match(/^(\d+(?:\.\d+)*\.?)\s+(.+)$/)
                if (matchPlain) {
                    headingMatchData = {
                        number: matchPlain[1],
                        title: matchPlain[2],
                        rest: '',
                        isBold: false
                    }
                }
            }
        }

        if (headingMatchData) {
            const { number, title, rest, isBold } = headingMatchData

            // Determine level
            const normalizedNumber = number.replace(/\.$/, '')
            const level = (normalizedNumber.match(/\./g) || []).length

            // HEURISTICS: When to treat as Heading vs List Item
            let isHeading = false
            const hasColon = /:$/.test(title)

            // RULE 1: If it ends in a colon, it is NEVER a heading (it's likely a list intro)
            if (hasColon) {
                isHeading = false
            }
            // RULE 2: Multi-level (1.1, 1.1.1) is usually a heading
            else if (level > 0) {
                isHeading = true
            }
            // RULE 3: Bold Level 0 (**1. Title**) is a heading unless it has a colon
            else if (isBold) {
                isHeading = true
            }
            // RULE 4: Plain Level 0 (1. Title) - strict checks
            else {
                // Only treat as heading if short and no ending punctuation
                const isShort = title.length < 100
                const hasPunctuation = /[.,;]$/.test(title) // Colon handled above

                if (isShort && !hasPunctuation) {
                    isHeading = true
                }
            }

            if (isHeading) {
                // Convert to proper Markdown heading
                // Standard Pandoc mapping:
                // 1. Title -> # 1. Title (Level 1)
                // 1.1 Title -> ## 1.1 Title (Level 2)

                // SKIP if this looks like the main thesis title (heuristic)
                // If it's Level 0 (no numbers) and very short, it might be the title.
                // But usually the title doesn't have a number.
                // If the user entered "My Thesis" as the first line, we want to skip it 
                // because Pandoc adds the title from metadata.
                if (level === 0 && !number && i === 0) {
                    continue;
                }

                const headingText = `${number} ${title}`

                if (level === 0) {
                    // Level 0 (e.g. "Einleitung" without number, or "1. Einleitung")
                    // We treat top-level numbered items as H1
                    processedLines.push(`# ${headingText}`)
                } else if (level === 1) {
                    // 1.1 -> H2
                    processedLines.push(`## ${headingText}`)
                } else if (level === 2) {
                    // 1.1.1 -> H3
                    processedLines.push(`### ${headingText}`)
                } else {
                    // 1.1.1.1 -> H4
                    processedLines.push(`#### ${headingText}`)
                }

                // Add blank line after heading
                processedLines.push('')

                // If there's run-in text, add it as a new paragraph
                if (rest) {
                    processedLines.push(rest)
                }
                continue
            } else {
                // Not a heading, but starts with numbering.
                // Format as bold list item if it was bold or looks like a title
                if (isBold || (title.length < 100 && !rest)) {
                    processedLines.push(`**${number} ${title}** ${rest}`)
                } else {
                    // Just regular text
                    processedLines.push(line)
                }
                continue
            }
        }

        // Fix lists - ensure space after marker
        if (trimmedLine.match(/^([*+-])(?!\s)/)) {
            processedLines.push(trimmedLine.replace(/^([*+-])/, '$1 '))
            continue
        }
        if (trimmedLine.match(/^(\d+\.)(?!\s)/) && !headingMatchData) {
            processedLines.push(trimmedLine.replace(/^(\d+\.)/, '$1 '))
            continue
        }

        // Regular text - keep as-is
        processedLines.push(line)
    }

    return processedLines.join('\n')
}
