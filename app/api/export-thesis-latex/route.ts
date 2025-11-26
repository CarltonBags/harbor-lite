import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'
import type { OutlineChapter } from '@/lib/supabase/types'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { thesisId } = body

    if (!thesisId) {
      return NextResponse.json(
        { error: 'Missing thesisId' },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServerClient()

    // Get thesis data
    const { data: thesis, error: thesisError } = await supabase
      .from('theses')
      .select('*')
      .eq('id', thesisId)
      .single()

    if (thesisError || !thesis) {
      return NextResponse.json(
        { error: 'Thesis not found' },
        { status: 404 }
      )
    }

    const content = thesis.latex_content || ''
    if (!content) {
      return NextResponse.json(
        { error: 'Thesis content is empty' },
        { status: 400 }
      )
    }

    // Get language from metadata or default to german
    const language = (thesis.metadata as any)?.language || 'german'
    const outline = thesis.outline as OutlineChapter[] | null
    const citationStyle = thesis.citation_style || 'apa'
    const footnotes = (thesis.metadata as any)?.footnotes || {} as Record<number, string>

    // Generate LaTeX document
    let latexContent = generateLaTeXDocument(
      thesis,
      content,
      outline,
      language,
      citationStyle,
      footnotes
    )

    // Ensure UTF-8 encoding and remove any BOM
    const encoder = new TextEncoder()
    const utf8Bytes = encoder.encode(latexContent)
    const utf8String = new TextDecoder('utf-8', { ignoreBOM: true }).decode(utf8Bytes)

    // Return as .tex file with proper UTF-8 encoding
    return new NextResponse(utf8String, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${(thesis.title || thesis.topic || 'thesis').replace(/[^a-z0-9]/gi, '_')}.tex"`,
      },
    })
  } catch (error) {
    console.error('[ExportLaTeX] Error exporting thesis to LaTeX:', error)
    console.error('[ExportLaTeX] Error stack:', error instanceof Error ? error.stack : 'No stack trace')
    return NextResponse.json(
      {
        error: 'Failed to export thesis',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 }
    )
  }
}

function generateLaTeXDocument(
  thesis: any,
  content: string,
  outline: OutlineChapter[] | null,
  language: string,
  citationStyle: string,
  footnotes: Record<number, string>
): string {
  const isGerman = language === 'german'

  // Document class and packages
  let latex = `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[${isGerman ? 'english,ngerman' : 'ngerman,english'}]{babel}
\\usepackage{geometry}
\\geometry{a4paper, left=2cm, right=2cm, top=2.5cm, bottom=2.5cm}
\\usepackage{setspace}
\\onehalfspacing % Line spacing 1.5
\\usepackage{fancyhdr}
\\usepackage{titlesec}
\\usepackage{hyperref}
\\hypersetup{
    colorlinks=false,
    pdfborder={0 0 0},
    unicode=true,
    pdfencoding=auto
}

% Footnote formatting for German citation style
\\usepackage[bottom]{footmisc}
\\setlength{\\footnotesep}{0.5cm}

% Page numbering
\\pagestyle{plain}
\\pagenumbering{arabic}

% Title formatting - use manual numbering from content
\\titleformat{\\section}
  {\\normalfont\\fontsize{16}{19.2}\\bfseries}
  {}{0em}{}
\\titleformat{\\subsection}
  {\\normalfont\\fontsize{14}{16.8}\\bfseries}
  {}{0em}{}
\\titleformat{\\subsubsection}
  {\\normalfont\\fontsize{12}{14.4}\\bfseries}
  {}{0em}{}

\\begin{document}

`

  // Cover page
  if (thesis.title || thesis.topic) {
    latex += `\\begin{titlepage}
\\vspace*{0pt}
\\vfill
\\centering

{\\fontsize{32}{38.4}\\selectfont\\textbf{${escapeLaTeX(thesis.title || thesis.topic)}}}

\\vfill
\\vspace*{0pt}

\\end{titlepage}

\\newpage

`
  }

  // Table of Contents - use native LaTeX command
  if (outline && Array.isArray(outline) && outline.length > 0) {
    // Rename TOC if needed (babel handles this usually, but we can force it)
    if (isGerman) {
      latex += `\\renewcommand{\\contentsname}{Inhaltsverzeichnis}\n`
    } else {
      latex += `\\renewcommand{\\contentsname}{Table of Contents}\n`
    }

    latex += `\\tableofcontents
\\newpage

`
  }

  // Extract bibliography from content before processing
  let mainContent = content
  let bibliographyContent = ''
  const bibMatch = content.match(/^#+\s*(Literaturverzeichnis|Bibliography)\s*\n(.*?)(?=^#+\s+|$)/ims)

  if (bibMatch) {
    // Remove bibliography from main content
    mainContent = content.replace(bibMatch[0], '').trim()
    bibliographyContent = bibMatch[2] || ''
  }

  // Attempt to rescue orphaned references from the end of mainContent
  // This handles cases where the AI generates references before the actual bibliography header
  const lines = mainContent.split('\n')
  const orphanedRefs: string[] = []
  let lastIndexToRemove = -1

  // Regex for a citation line: Name, Initials. (Year) ...
  // More robust regex to catch academic citations with various author patterns:
  // - Single author: "Smith, J. (2020)."
  // - Multiple authors: "Smith, J. & Jones, K. (2020)."
  // - Complex names: "Castro Varela, M. (2020)."
  // - German "ohne Jahr": "Author (o.J.)."
  const citationRegex = /^[A-Za-zÄÖÜäöüß\u00C0-\u017F\-\s&.,]+\(\d{4}(?:\/\d{4})?\)|^[A-Za-zÄÖÜäöüß\u00C0-\u017F\-\s&.,]+\(o\.J\.\)/
  const pageNumRegex = /^\d+$/
  const emptyRegex = /^\s*$/

  // Scan from bottom up
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()

    if (citationRegex.test(line)) {
      orphanedRefs.unshift(line)
      lastIndexToRemove = i
    } else if (pageNumRegex.test(line) || emptyRegex.test(line)) {
      // Only include spacers/page numbers if we've already found a citation below
      if (orphanedRefs.length > 0) {
        orphanedRefs.unshift(line)
        lastIndexToRemove = i
      }
    } else {
      // Stop at first non-citation line
      break
    }
  }

  if (lastIndexToRemove !== -1) {
    // Remove orphaned refs from mainContent
    mainContent = lines.slice(0, lastIndexToRemove).join('\n').trim()

    // Add to bibliography (filtering out page numbers/empty lines)
    const cleanOrphaned = orphanedRefs.filter(l => !pageNumRegex.test(l.trim()) && !emptyRegex.test(l.trim()))
    bibliographyContent = cleanOrphaned.join('\n') + '\n' + bibliographyContent
  }

  // Main content (without bibliography)
  const processedContent = convertMarkdownToLaTeX(mainContent, citationStyle, footnotes, isGerman)
  latex += processedContent

  // Footnotes section (if German citation style and footnotes exist)
  if (citationStyle === 'deutsche-zitierweise' && Object.keys(footnotes).length > 0) {
    latex += `\\newpage
\\section*{${isGerman ? 'Fußnoten' : 'Footnotes'}}
\\addcontentsline{toc}{section}{${isGerman ? 'Fußnoten' : 'Footnotes'}}

`
    const sortedNumbers = Object.keys(footnotes)
      .map(n => parseInt(n, 10))
      .sort((a, b) => a - b)

    sortedNumbers.forEach(num => {
      const footnoteText = footnotes[num]
      if (footnoteText) {
        latex += `\\textbf{${num}.} ${escapeLaTeX(footnoteText)}\\\\
\\vspace{0.3cm}

`
      }
    })
  }

  // Bibliography section
  latex += `\\newpage
\\section*{${isGerman ? 'Literaturverzeichnis' : 'Bibliography'}}
\\addcontentsline{toc}{section}{${isGerman ? 'Literaturverzeichnis' : 'Bibliography'}}

`

  if (bibliographyContent.trim()) {
    // Add spacing between bibliography entries
    latex += `\\setlength{\\parskip}{1em}\n\n`

    // Process bibliography entries
    const bibLines = bibliographyContent.split('\n')
    for (const line of bibLines) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.match(/^#+\s*(Literaturverzeichnis|Bibliography|Inhalt)/i)) {
        // Convert bibliography entries to LaTeX
        const processed = processFootnotesInText(trimmed, citationStyle, footnotes)
        // Format as bibliography entry (remove list markers if present)
        const cleaned = processed.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '')
        latex += cleaned + '\n\n\\vspace{0.5em}\n\n'
      }
    }
  } else {
    latex += `% Bibliography entries will be added here
% You can use BibTeX or manually add entries

`
  }

  latex += `\\end{document}
`

  return latex
}

function convertMarkdownToLaTeX(
  content: string,
  citationStyle: string,
  footnotes: Record<number, string>,
  isGerman: boolean
): string {
  // Normalize content first to fix encoding issues
  content = normalizeText(content)
  const lines = content.split('\n')
  let latex = ''
  let inCodeBlock = false
  let inMathBlock = false
  let inList = false
  let listLevel = 0
  let listIsOrdered = false
  let inTable = false
  let tableRows: string[][] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmedLine = line.trim()

    // Skip TOC if present (we generate it from outline)
    // This removes the "Inhaltsverzeichnis" that might be in the database content
    if (trimmedLine.match(/^#+\s*(Inhaltsverzeichnis|Table of Contents|Inhalt)/i)) {
      while (i < lines.length - 1 && !lines[i + 1].match(/^#+\s+/)) {
        i++
      }
      continue
    }

    // Handle math blocks (display math: $$...$$ or \[...\])
    // Check for single-line math blocks first ($$...$$ on same line)
    if (trimmedLine.match(/^\$\$.+\$\$$/) || trimmedLine.match(/^\\\[.+\\\]$/)) {
      // Single-line display math
      const mathContent = trimmedLine.replace(/^\$\$|\$\$$|^\\\[|\\\]$/g, '').trim()
      latex += `\\[${mathContent}\\]\n\n`
      continue
    }

    // Check for opening math block
    if (trimmedLine.match(/^\$\$/) || trimmedLine.match(/^\\\[/)) {
      latex += '\\[\n'
      inMathBlock = true
      // Check if closing marker is on same line
      const mathContent = trimmedLine.replace(/^\$\$|^\\\[/, '').trim()
      if (mathContent.match(/\$\$$|\\\]$/)) {
        // Closing on same line
        const content = mathContent.replace(/\$\$$|\\\]$/, '').trim()
        if (content) {
          latex += content + '\n'
        }
        latex += '\\]\n'
        inMathBlock = false
      } else if (mathContent) {
        latex += mathContent + '\n'
      }
      continue
    }

    // Check for closing math block
    if (trimmedLine.match(/\$\$$/) || trimmedLine.match(/\\\]$/)) {
      if (inMathBlock) {
        const mathContent = trimmedLine.replace(/\$\$$|\\\]$/, '').trim()
        if (mathContent) {
          latex += mathContent + '\n'
        }
        latex += '\\]\n'
        inMathBlock = false
      }
      continue
    }

    if (inMathBlock) {
      // Inside math block - don't escape, just output
      latex += line + '\n'
      continue
    }

    // Handle code blocks
    if (trimmedLine.startsWith('```')) {
      if (inCodeBlock) {
        latex += '\\end{verbatim}\n'
        inCodeBlock = false
      } else {
        latex += '\\begin{verbatim}\n'
        inCodeBlock = true
      }
      continue
    }
    if (inCodeBlock) {
      latex += escapeLaTeX(line) + '\n'
      continue
    }

    // Handle headings - match any number of # followed by optional space and text
    // This handles both standard markdown (## Heading) and edge cases (##Heading)
    const headingMatch = trimmedLine.match(/^(#{1,6})\s*(.+)$/)
    if (headingMatch) {
      if (inList) {
        latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
        inList = false
        listIsOrdered = false
      }

      const hashCount = headingMatch[1].length
      const headingText = headingMatch[2].trim()

      // Skip empty headings
      if (!headingText) {
        continue
      }

      // Skip TOC heading (already generated from outline)
      if (headingText.match(/^(Inhaltsverzeichnis|Table of Contents)$/i)) {
        continue
      }

      // Map heading levels to LaTeX commands
      if (hashCount === 1) {
        // H1: Main chapter - add page break
        latex += '\\newpage\n'
        latex += `\\section{${escapeLaTeX(headingText)}}\n\n`
      } else if (hashCount === 2) {
        // H2: Section
        latex += `\\subsection{${escapeLaTeX(headingText)}}\n\n`
      } else if (hashCount === 3) {
        // H3: Subsection
        latex += `\\subsubsection{${escapeLaTeX(headingText)}}\n\n`
      } else {
        // H4-H6: Use paragraph style (smaller)
        latex += `\\paragraph{${escapeLaTeX(headingText)}}\n\n`
      }
      continue
    }

    // Also handle lines that start with # but might be malformed
    // This catches cases like "##" on its own, or "##Heading" without space
    if (trimmedLine.match(/^#{1,6}$/) || (trimmedLine.match(/^#{2,}/) && !trimmedLine.match(/^#{1,6}\s+/))) {
      // This looks like a malformed heading or just hashes
      // If it's just hashes with no text, skip it
      if (trimmedLine.match(/^#{1,6}$/)) {
        // Just hashes, no text - skip this line
        continue
      }
      // Try to extract text after hashes
      const textAfterHashes = trimmedLine.replace(/^#+\s*/, '').trim()
      if (textAfterHashes) {
        // Treat as H2 (most common case for malformed headings)
        if (inList) {
          latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
          inList = false
          listIsOrdered = false
        }
        latex += `\\subsection*{${escapeLaTeX(textAfterHashes)}}\n\n`
      } else {
        // No text after hashes - skip this line to avoid LaTeX errors
        continue
      }
      continue
    }

    // Handle lists
    const listMatch = trimmedLine.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/)
    if (listMatch) {
      const indent = listMatch[1].length / 2
      const marker = listMatch[2]
      const itemText = listMatch[3]
      const isOrdered = marker.match(/^\d+\./) !== null

      if (!inList || indent !== listLevel || isOrdered !== listIsOrdered) {
        if (inList) {
          latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
        }
        if (isOrdered) {
          latex += '\\begin{enumerate}\n'
        } else {
          latex += '\\begin{itemize}\n'
        }
        inList = true
        listLevel = indent
        listIsOrdered = isOrdered
      }

      // Process footnotes in list items
      const processedText = processFootnotesInText(itemText, citationStyle, footnotes)
      latex += `\\item ${processedText}\n`
      continue
    } else if (inList && trimmedLine.length > 0 && (line.startsWith(' ') || line.startsWith('\t'))) {
      // Continuation of list item
      const processedText = processFootnotesInText(trimmedLine, citationStyle, footnotes)
      latex += processedText + '\n'
      continue
    } else if (inList && trimmedLine.length === 0) {
      // End of list
      latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
      inList = false
      listLevel = 0
      listIsOrdered = false
      latex += '\n'
      continue
    }

    // Handle tables (markdown format: | col1 | col2 |)
    if (trimmedLine.includes('|') && trimmedLine.match(/^\|.+\|$/)) {
      if (!inTable) {
        // Start of table
        inTable = true
        tableRows = []
      }
      // Skip separator row (|---|---|)
      if (trimmedLine.match(/^\|[\s\-:|]+\|$/)) {
        continue
      }
      // Parse table row
      const cells = trimmedLine.split('|').map(cell => cell.trim()).filter(cell => cell.length > 0)
      tableRows.push(cells)
      continue
    } else if (inTable) {
      // End of table - convert to LaTeX
      if (tableRows.length > 0) {
        latex += convertTableToLaTeX(tableRows, citationStyle, footnotes)
        tableRows = []
      }
      inTable = false
    }

    // Handle empty lines
    if (trimmedLine.length === 0) {
      if (inList) {
        latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
        inList = false
        listLevel = 0
        listIsOrdered = false
      }
      if (inTable && tableRows.length > 0) {
        // Empty line might be end of table
        latex += convertTableToLaTeX(tableRows, citationStyle, footnotes)
        tableRows = []
        inTable = false
      }
      latex += '\n'
      continue
    }

    // Regular text - process footnotes and formatting
    // Note: Any # characters in regular text will be escaped by processFootnotesInText -> escapeLaTeX
    const processedText = processFootnotesInText(line, citationStyle, footnotes)
    latex += processedText + '\n\n'
  }

  // Close any open lists
  if (inList) {
    latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
  }

  // Close any open table
  if (inTable && tableRows.length > 0) {
    latex += convertTableToLaTeX(tableRows, citationStyle, footnotes)
  }

  return latex
}

function convertTableToLaTeX(rows: string[][], citationStyle: string, footnotes: Record<number, string>): string {
  if (rows.length === 0) return ''

  const numCols = Math.max(...rows.map(row => row.length))
  if (numCols === 0) return ''

  let latex = '\n\\begin{table}[h]\n\\centering\n'
  latex += `\\begin{tabular}{|${'l|'.repeat(numCols)}}\n`
  latex += '\\hline\n'

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const cells: string[] = []

    for (let j = 0; j < numCols; j++) {
      const cell = row[j] || ''
      // Process cell content (HTML tags, footnotes, etc.)
      const processedCell = processFootnotesInText(cell, citationStyle, footnotes)
      cells.push(processedCell)
    }

    latex += cells.join(' & ') + ' \\\\\n'
    if (i === 0) {
      // Add horizontal line after header row
      latex += '\\hline\n'
    }
  }

  latex += '\\hline\n'
  latex += '\\end{tabular}\n'
  latex += '\\end{table}\n\n'

  return latex
}

function processFootnotesInText(
  text: string,
  citationStyle: string,
  footnotes: Record<number, string>
): string {
  // First, protect math expressions from being processed
  const mathPlaceholders: string[] = []
  let placeholderIndex = 0

  // Replace inline math ($...$) with placeholders
  let processed = text.replace(/(?<!\$)\$(?!\$)((?:(?!\$).)+?)\$(?!\$)/g, (match) => {
    const placeholder = `__MATH_PLACEHOLDER_${placeholderIndex}__`
    mathPlaceholders[placeholderIndex] = match // Store original math
    placeholderIndex++
    return placeholder
  })

  // Replace display math ($$...$$) with placeholders
  processed = processed.replace(/\$\$([^$]+)\$\$/g, (match) => {
    const placeholder = `__MATH_PLACEHOLDER_${placeholderIndex}__`
    mathPlaceholders[placeholderIndex] = match // Store original math
    placeholderIndex++
    return placeholder
  })

  // Handle German citation style footnotes (^1, ^2, etc.)
  // But not if they're inside math (which we've already protected)
  if (citationStyle === 'deutsche-zitierweise' && Object.keys(footnotes).length > 0) {
    processed = processed.replace(/\^(\d+)/g, (match, num) => {
      const footnoteNum = parseInt(num, 10)
      const footnoteText = footnotes[footnoteNum]
      if (footnoteText) {
        // Clean and prepare footnote text
        let cleanText = footnoteText.trim()

        // Normalize LaTeX commands: remove spaces between command and opening brace
        // e.g., \textit {text} -> \textit{text}
        cleanText = cleanText.replace(/\\(?:textbf|textit|texttt|underline|textsubscript|textsuperscript|emph|em|textsc|textsl|textmd|textup|textnormal|textrm|textsf|textbackslash)\s+\{/g, (match) => {
          return match.replace(/\s+\{/, '{')
        })

        // Remove placeholder text like "\ETC." that might indicate truncation
        cleanText = cleanText.replace(/\\ETC\./gi, '')

        // Protect LaTeX commands before escaping
        const latexCmdPlaceholders: string[] = []
        let cmdIndex = 0

        // Process text to find and protect LaTeX commands
        let protectedText = ''
        let i = 0
        while (i < cleanText.length) {
          // Check if we're at the start of a LaTeX command
          if (cleanText[i] === '\\' && i + 1 < cleanText.length) {
            const cmdStart = i
            i++ // Skip backslash

            // Match command name (with optional whitespace)
            const cmdNameMatch = cleanText.substring(i).match(/^(?:textbf|textit|texttt|underline|textsubscript|textsuperscript|emph|em|textsc|textsl|textmd|textup|textnormal|textrm|textsf|textbackslash)/)
            if (cmdNameMatch) {
              i += cmdNameMatch[0].length

              // Skip whitespace (normalized, but handle edge cases)
              while (i < cleanText.length && /\s/.test(cleanText[i])) i++

              // Find the opening brace
              if (i < cleanText.length && cleanText[i] === '{') {
                i++ // Skip opening brace

                // Find matching closing brace
                let depth = 1
                const argStart = i
                while (i < cleanText.length && depth > 0) {
                  if (cleanText[i] === '\\' && i + 1 < cleanText.length) {
                    // Skip escaped characters
                    i += 2
                    continue
                  }
                  if (cleanText[i] === '{') depth++
                  else if (cleanText[i] === '}') depth--
                  i++
                }

                if (depth === 0) {
                  // Complete command found
                  const fullCmd = cleanText.substring(cmdStart, i)
                  const placeholder = `FOOTNOTECMD${cmdIndex}FOOTNOTECMD`
                  latexCmdPlaceholders[cmdIndex] = fullCmd
                  protectedText += placeholder
                  cmdIndex++
                  continue
                } else {
                  // Incomplete command - close it properly
                  // Extract what we have so far
                  const partialContent = cleanText.substring(argStart)
                  // Remove any trailing incomplete commands or placeholders
                  const cleanedContent = partialContent.replace(/\\ETC\./gi, '').trim()
                  const fullCmd = cleanText.substring(cmdStart, argStart) + cleanedContent + '}'
                  const placeholder = `FOOTNOTECMD${cmdIndex}FOOTNOTECMD`
                  latexCmdPlaceholders[cmdIndex] = fullCmd
                  protectedText += placeholder
                  cmdIndex++
                  break // End of text
                }
              } else {
                // No opening brace found - might be incomplete, skip this command
                // Just add the backslash and continue
                protectedText += cleanText[cmdStart]
                i = cmdStart + 1
              }
            } else {
              // Not a recognized command, treat as regular text
              protectedText += cleanText[i]
              i++
            }
          } else {
            // Regular character
            protectedText += cleanText[i]
            i++
          }
        }

        // Escape the rest of the text (but not the protected commands)
        let escapedText = escapeLaTeXForText(protectedText)

        // Restore LaTeX commands (in reverse order to avoid conflicts)
        for (let i = latexCmdPlaceholders.length - 1; i >= 0; i--) {
          const placeholder = `FOOTNOTECMD${i}FOOTNOTECMD`
          const cmd = latexCmdPlaceholders[i]
          escapedText = escapedText.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), cmd)
        }

        // Final validation: ensure balanced braces in the footnote content
        // Count braces that are NOT part of LaTeX commands
        let openBraces = 0
        let closeBraces = 0
        i = 0
        while (i < escapedText.length) {
          if (escapedText[i] === '\\' && i + 1 < escapedText.length) {
            // Check if this is a LaTeX command
            const cmdMatch = escapedText.substring(i).match(/^\\(?:textbf|textit|texttt|underline|textsubscript|textsuperscript|emph|em|textsc|textsl|textmd|textup|textnormal|textrm|textsf|textbackslash)/)
            if (cmdMatch) {
              // Skip LaTeX command
              i += cmdMatch[0].length
              // Skip whitespace
              while (i < escapedText.length && /\s/.test(escapedText[i])) i++
              // Skip command argument (braces are part of the command)
              if (i < escapedText.length && escapedText[i] === '{') {
                i++
                let depth = 1
                while (i < escapedText.length && depth > 0) {
                  if (escapedText[i] === '\\' && i + 1 < escapedText.length) {
                    // Skip escaped characters
                    i += 2
                    continue
                  }
                  if (escapedText[i] === '{') depth++
                  else if (escapedText[i] === '}') depth--
                  i++
                }
                continue
              }
            } else {
              // Escaped character, skip it
              i += 2
              continue
            }
          } else {
            if (escapedText[i] === '{') openBraces++
            else if (escapedText[i] === '}') closeBraces++
            i++
          }
        }

        // Balance braces if needed
        if (openBraces > closeBraces) {
          escapedText = escapedText + '}'.repeat(openBraces - closeBraces)
        }

        return `\\footnote{${escapedText}}`
      }
      return match
    })
  }

  // Handle HTML tags (convert to LaTeX before markdown processing)
  // <sub>text</sub> -> \textsubscript{text}
  processed = processed.replace(/<sub>(.+?)<\/sub>/gi, '\\textsubscript{$1}')
  // <sup>text</sup> -> \textsuperscript{text}
  processed = processed.replace(/<sup>(.+?)<\/sup>/gi, '\\textsuperscript{$1}')
  // <b>text</b> or <strong>text</strong> -> \textbf{text}
  processed = processed.replace(/<(b|strong)>(.+?)<\/(b|strong)>/gi, '\\textbf{$2}')
  // <i>text</i> or <em>text</em> -> \textit{text}
  processed = processed.replace(/<(i|em)>(.+?)<\/(i|em)>/gi, '\\textit{$2}')
  // <u>text</u> -> \underline{text}
  processed = processed.replace(/<u>(.+?)<\/u>/gi, '\\underline{$1}')
  // <br> or <br/> -> line break
  processed = processed.replace(/<br\s*\/?>/gi, '\\\\\n')
  // Remove any remaining HTML tags (safety measure)
  processed = processed.replace(/<[^>]+>/g, '')

  // Handle markdown formatting (but not inside math)
  // Bold: **text** -> \textbf{text}
  processed = processed.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}')

  // Italic: *text* -> \textit{text} (but not if it's part of **)
  processed = processed.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '\\textit{$1}')

  // Inline code: `code` -> \texttt{code}
  processed = processed.replace(/`(.+?)`/g, '\\texttt{$1}')

  // Links: [text](url) -> \href{url}{text}
  processed = processed.replace(/\[(.+?)\]\((.+?)\)/g, '\\href{$2}{$1}')

  // Protect LaTeX commands from being escaped
  // Use a placeholder format that won't be escaped (no underscores, use a unique pattern)
  const latexCommandPlaceholders: string[] = []
  let commandIndex = 0

  // Protect LaTeX commands (e.g., \textbf{...}, \textit{...}, \texttt{...}, \href{...}{...}, \footnote{...})
  // Match commands with one or two arguments
  // Use a placeholder that won't conflict with LaTeX escaping (no underscores)
  processed = processed.replace(/\\(?:textbf|textit|texttt|underline|textsubscript|textsuperscript|footnote)\{([^}]*)\}/g, (match) => {
    const placeholder = `LATEXCMDPROTECT${commandIndex}LATEXCMDPROTECT`
    latexCommandPlaceholders[commandIndex] = match
    commandIndex++
    return placeholder
  })

  // Protect \href{url}{text} (two arguments)
  processed = processed.replace(/\\href\{([^}]*)\}\{([^}]*)\}/g, (match) => {
    const placeholder = `LATEXCMDPROTECT${commandIndex}LATEXCMDPROTECT`
    latexCommandPlaceholders[commandIndex] = match
    commandIndex++
    return placeholder
  })

  // Escape LaTeX special characters (but not the protected commands)
  processed = escapeLaTeXForText(processed)

  // Restore LaTeX commands
  for (let i = 0; i < latexCommandPlaceholders.length; i++) {
    const placeholder = `LATEXCMDPROTECT${i}LATEXCMDPROTECT`
    processed = processed.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), latexCommandPlaceholders[i])
  }

  // Restore math expressions (convert to LaTeX format)
  for (let i = 0; i < mathPlaceholders.length; i++) {
    const placeholder = `__MATH_PLACEHOLDER_${i}__`
    const mathExpr = mathPlaceholders[i]

    // Convert to LaTeX math format
    let latexMath = mathExpr
    if (mathExpr.startsWith('$$') && mathExpr.endsWith('$$')) {
      // Display math: $$...$$ -> \[...\]
      const content = mathExpr.slice(2, -2).trim()
      latexMath = `\\[${content}\\]`
    } else if (mathExpr.startsWith('$') && mathExpr.endsWith('$') && !mathExpr.startsWith('$$')) {
      // Inline math: $...$ -> $...$ (keep as-is)
      // Content is already correct
      latexMath = mathExpr
    }

    processed = processed.replace(placeholder, latexMath)
  }

  return processed
}

// Normalize text to fix common encoding issues
function normalizeText(text: string): string {
  if (!text) return ''

  let normalized = text

  // Fix "SZ" that should be a space in compound words
  // Pattern: lowercase letter + SZ + capital letter (e.g., "posthumaneSZivilisation" -> "posthumane Zivilisation")
  normalized = normalized.replace(/([a-zäöü])SZ([A-ZÄÖÜ])/g, '$1 Z$2')

  // Fix incorrect umlauts in English words
  // "Äre" -> "Are" (common English word pattern)
  normalized = normalized.replace(/\bÄre\b/gi, 'Are')
  normalized = normalized.replace(/\bÄnd\b/gi, 'And')
  normalized = normalized.replace(/\bÄny\b/gi, 'Any')
  normalized = normalized.replace(/\bÄll\b/gi, 'All')
  normalized = normalized.replace(/\bÄre\s+You\b/gi, 'Are You')
  
  // Fix standalone "Ä" at start of English words (followed by lowercase letters)
  // Only if it's clearly an English word pattern
  normalized = normalized.replace(/\bÄ([a-z]{2,})\b/g, (match, rest) => {
    // Common English word patterns that start with "A"
    const englishPatterns = ['re', 'nd', 'ny', 'll', 'nd', 're', 'ct', 'ble', 'bout', 'fter', 'gain', 'lso', 'mong', 'nother', 'lready', 'lways', 'lthough', 'mong', 'nswer', 'ppear', 'pply', 'pproach', 'rrange', 'rticle', 'spect', 'ssume', 'ttach', 'ttack', 'ttempt', 'ttend', 'ttitude', 'ttract', 'udience', 'uthor', 'vailable', 'verage', 'void', 'ward', 'ware', 'wake', 'ward', 'way']
    if (englishPatterns.some(pattern => rest.toLowerCase().startsWith(pattern))) {
      return 'A' + rest
    }
    return match
  })

  // Fix "Ö" that should be "O" in English contexts
  normalized = normalized.replace(/\bÖ([a-z]{2,})\b/g, (match, rest) => {
    const englishPatterns = ['nly', 'nce', 'pen', 'ver', 'ther', 'rder', 'ffer', 'ffice', 'ften', 'ther', 'wner', 'bject', 'bserve', 'btain', 'bvious', 'ccur', 'cean', 'ctober', 'ffice', 'fficer', 'ften', 'nion', 'nly', 'pen', 'peration', 'pinion', 'pportunity', 'pposite', 'ption', 'rder', 'rganization', 'riginal', 'ther', 'utcome', 'utside', 'ver', 'wner']
    if (englishPatterns.some(pattern => rest.toLowerCase().startsWith(pattern))) {
      return 'O' + rest
    }
    return match
  })

  // Fix "Ü" that should be "U" in English contexts
  normalized = normalized.replace(/\bÜ([a-z]{2,})\b/g, (match, rest) => {
    const englishPatterns = ['nder', 'nion', 'nique', 'nit', 'nited', 'niversity', 'nless', 'ntil', 'pdate', 'pon', 'pper', 'rban', 'rge', 'rgent', 'sually', 'tilize']
    if (englishPatterns.some(pattern => rest.toLowerCase().startsWith(pattern))) {
      return 'U' + rest
    }
    return match
  })

  return normalized
}

// Escape LaTeX for text (but preserve $ for math mode - math is handled separately)
function escapeLaTeXForText(text: string): string {
  if (!text) return ''

  // First, normalize the string to fix encoding issues
  let normalized = normalizeText(text)
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .replace(/[\uFFFE\uFFFF]/g, '')

  // Escape LaTeX special characters
  // Note: $ is NOT escaped here because math expressions are handled separately
  return normalized
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    // Don't escape $ - it's handled in processFootnotesInText for math
    .replace(/%/g, '\\%')
    .replace(/&/g, '\\&')
    .replace(/#/g, '\\#')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/</g, '\\textless{}')
    .replace(/>/g, '\\textgreater{}')
    .replace(/\|/g, '\\textbar{}')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
}

function escapeLaTeX(text: string): string {
  if (!text) return ''

  // First, normalize the string to fix encoding issues and remove BOM
  let normalized = normalizeText(text)
    .replace(/^\uFEFF/, '') // Remove UTF-8 BOM if present
    .replace(/\u0000/g, '') // Remove null bytes
    .replace(/[\uFFFE\uFFFF]/g, '') // Remove invalid UTF-16 characters

  // Then escape LaTeX special characters in the correct order
  return normalized
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\$/g, '\\$')
    .replace(/%/g, '\\%')
    .replace(/&/g, '\\&')
    .replace(/#/g, '\\#')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/</g, '\\textless{}')
    .replace(/>/g, '\\textgreater{}')
    .replace(/\|/g, '\\textbar{}')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove control characters
}

