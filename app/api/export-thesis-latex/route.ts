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

    let content = thesis.latex_content || ''
    if (!content) {
      return NextResponse.json(
        { error: 'Thesis content is empty' },
        { status: 400 }
      )
    }

    // Ensure content is properly decoded as UTF-8 string
    // Handle potential encoding issues
    if (typeof content !== 'string') {
      // If content is a Buffer or other type, decode it
      try {
        if (Buffer.isBuffer(content)) {
          content = content.toString('utf-8')
        } else {
          content = String(content)
        }
      } catch (e) {
        console.error('Error decoding content:', e)
        content = String(content)
      }
    }

    // Normalize Unicode to ensure proper character encoding
    try {
      content = content.normalize('NFC')
    } catch (e) {
      // If normalization fails, continue with original
      console.warn('Unicode normalization failed, using original content')
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

% TOC depth: show all levels (section=1, subsection=2, subsubsection=3, paragraph=4)
\\setcounter{tocdepth}{4}

% TOC indentation for subchapters
\\usepackage{tocloft}
\\cftsetindents{section}{0em}{2.5em}
\\cftsetindents{subsection}{2.5em}{3.5em}
\\cftsetindents{subsubsection}{6em}{4.5em}
\\cftsetindents{paragraph}{9.5em}{5.5em}

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
        // Sanitize non-Latin characters
        let sanitized = sanitizeForLaTeX(cleaned)
        // Escape special characters that aren't part of LaTeX commands
        // Use negative lookbehind to avoid double-escaping
        sanitized = sanitized
          .replace(/(?<!\\)&/g, '\\&')
          .replace(/(?<!\\)%/g, '\\%')
          .replace(/(?<!\\)#/g, '\\#')
          .replace(/(?<!\\)_/g, '\\_')
        latex += sanitized + '\n\n\\vspace{0.5em}\n\n'
      }
    }
  } else if (thesis.uploaded_sources && thesis.uploaded_sources.length > 0) {
    // Generate bibliography from uploaded_sources
    console.log('[ExportLaTeX] Generating bibliography from uploaded_sources...')
    latex += `\\setlength{\\parskip}{1em}\n\n`

    // Sort sources alphabetically by first author's last name
    const sortedSources = [...thesis.uploaded_sources].sort((a: any, b: any) => {
      const authorA = getFirstAuthorLastName(a)
      const authorB = getFirstAuthorLastName(b)
      return authorA.localeCompare(authorB, 'de')
    })

    for (const source of sortedSources) {
      const entry = formatBibliographyEntryLaTeX(source, citationStyle)
      latex += entry + '\n\n\\vspace{0.5em}\n\n'
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
  // FIRST: Normalize all Unicode to NFC form
  // This converts decomposed characters (a + combining diaeresis) to composed form (ä)
  // Without this, decomposed umlauts won't match our placeholder patterns
  try {
    content = content.normalize('NFC')
  } catch (e) {
    // If normalization fails, continue with original
  }

  // ALSO: Explicitly handle decomposed umlauts that NFC might have missed
  content = content.replace(/a\u0308/g, 'ä')
  content = content.replace(/o\u0308/g, 'ö')
  content = content.replace(/u\u0308/g, 'ü')
  content = content.replace(/A\u0308/g, 'Ä')
  content = content.replace(/O\u0308/g, 'Ö')
  content = content.replace(/U\u0308/g, 'Ü')

  // CRITICAL: Protect all German umlauts with placeholders BEFORE any other processing
  // This prevents normalizeText and other functions from corrupting them
  const umlautMap: [string, string][] = [
    ['ä', '___UMLAUT_A_LOWER___'],
    ['ö', '___UMLAUT_O_LOWER___'],
    ['ü', '___UMLAUT_U_LOWER___'],
    ['Ä', '___UMLAUT_A_UPPER___'],
    ['Ö', '___UMLAUT_O_UPPER___'],
    ['Ü', '___UMLAUT_U_UPPER___'],
    ['ß', '___UMLAUT_SS___'],
  ]

  // Protect umlauts
  for (const [umlaut, placeholder] of umlautMap) {
    content = content.split(umlaut).join(placeholder)
  }

  // Normalize content first to fix encoding issues
  content = normalizeText(content)

  // PRE-PROCESSING: Split inline headings onto their own lines
  // This fixes cases like "...text.## 2 Chapter" where headings are concatenated
  // The regex looks for ## preceded by non-whitespace and adds a newline before it
  content = content.replace(/([^\n])(#{1,6}\s+\d)/g, '$1\n\n$2')

  // Restore umlauts from placeholders
  for (const [umlaut, placeholder] of umlautMap) {
    content = content.split(placeholder).join(umlaut)
  }

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

      const headingText = headingMatch[2].trim()

      // Skip empty headings
      if (!headingText) {
        continue
      }

      // Skip TOC heading (already generated from outline)
      if (headingText.match(/^(Inhaltsverzeichnis|Table of Contents)$/i)) {
        continue
      }

      // IMPORTANT: Determine level from NUMBERING (dots) not hash count
      // This ensures "# 4.1 Title" is still treated as subsection (one dot = level 1)
      const numberMatch = headingText.match(/^(\d+(?:\.\d+)*\.?)\s+/)
      let effectiveLevel = 0 // 0=section, 1=subsection, 2=subsubsection

      if (numberMatch) {
        const number = numberMatch[1].replace(/\.$/, '') // Remove trailing dot
        const dotCount = (number.match(/\./g) || []).length
        effectiveLevel = dotCount // 0 dots = section, 1 dot = subsection, 2 dots = subsubsection
      } else {
        // No numbering, fall back to hash count
        effectiveLevel = headingMatch[1].length - 1
      }

      // Map effective level to LaTeX commands
      if (effectiveLevel === 0) {
        // Main chapter - add page break
        latex += '\\newpage\n'
        latex += `\\section*{${escapeLaTeX(headingText)}}\n`
        latex += `\\addcontentsline{toc}{section}{${escapeLaTeX(headingText)}}\n\n`
      } else if (effectiveLevel === 1) {
        // Subsection (e.g., 1.1, 4.1)
        latex += `\\subsection*{${escapeLaTeX(headingText)}}\n`
        latex += `\\addcontentsline{toc}{subsection}{${escapeLaTeX(headingText)}}\n\n`
      } else if (effectiveLevel === 2) {
        // Subsubsection (e.g., 1.1.1, 3.1.2)
        latex += `\\subsubsection*{${escapeLaTeX(headingText)}}\n`
        latex += `\\addcontentsline{toc}{subsubsection}{${escapeLaTeX(headingText)}}\n\n`
      } else if (effectiveLevel === 3) {
        // Paragraph (e.g., 1.1.1.1, 4.3.2.1)
        latex += `\\paragraph{${escapeLaTeX(headingText)}}\n`
        latex += `\\addcontentsline{toc}{paragraph}{${escapeLaTeX(headingText)}}\n\n`
      } else {
        // Deeper levels (1.1.1.1) - use paragraph style
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

    // Handle lines that look like chapter headings but aren't markdown headings
    // This MUST be done before list detection to prevent chapters like "1. Einleitung" from becoming list items

    // We need to handle three cases:
    // 1. "**1. Title**" (Bold Number & Title)
    // 2. "1. **Title**" (Number, Bold Title) - Common in lists too!
    // 3. "1. Title" (Plain)

    let headingMatchData = null

    // Clean bold markers for detection
    const cleanLine = trimmedLine.replace(/^\*\*/, '').replace(/\*\*$/, '').trim()

    // Case 1: "**1. Title** Text"
    const matchBoldFull = trimmedLine.match(/^\*\*(\d+(?:\.\d+)*\.?)\s+([^*]+)\*\*\s*(.*)$/)
    if (matchBoldFull) {
      headingMatchData = { number: matchBoldFull[1], title: matchBoldFull[2], rest: matchBoldFull[3] }
    }
    // Case 2: "1. **Title** Text"
    else {
      const matchBoldTitle = trimmedLine.match(/^(\d+(?:\.\d+)*\.?)\s+\*\*([^*]+)\*\*\s*(.*)$/)
      if (matchBoldTitle) {
        headingMatchData = { number: matchBoldTitle[1], title: matchBoldTitle[2], rest: matchBoldTitle[3] }
      }
      // Case 3: "1. Title" (Plain)
      else {
        const matchPlain = trimmedLine.match(/^(\d+(?:\.\d+)*\.?)\s+(.+)$/)
        if (matchPlain) {
          headingMatchData = { number: matchPlain[1], title: matchPlain[2], rest: '' }
          // For plain matches, we assume 'rest' is empty (whole line is title) unless we want to split by length?
          // But plain text splitting is dangerous. We'll rely on length check later.
        }
      }
    }

    if (headingMatchData && !headingMatch) {
      const { number, title, rest } = headingMatchData

      // Determine level
      const normalizedNumber = number.replace(/\.$/, '')
      const level = (normalizedNumber.match(/\./g) || []).length

      // HEURISTIC: When to treat as Heading vs List Item?
      // 1. If 'rest' is empty (no following text) -> Always Heading (e.g. "1. Einleitung")
      // 2. If 'rest' exists (run-in text):
      //    - Level 0 ("1.") -> Treat as List Item (e.g. "1. **Weak Form**...") to avoid polluting TOC
      //    - Level 1+ ("1.1") -> Treat as Heading (e.g. "1.1 **Problem**...") to ensure subheadings are formatted

      const isRunIn = rest.length > 0
      const isHeading = !isRunIn || (isRunIn && level > 0)

      // Additional safety: Plain matches must be short to be headings
      const isPlain = !trimmedLine.includes('**')
      if (isPlain && title.length > 100) {
        // Too long for a heading, treat as text
        // Fall through to list detection
      } else if (isHeading && !inList) {
        // It's a heading!

        // Close any open lists first
        if (inList) {
          latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
          inList = false
          listIsOrdered = false
        }

        const headingText = `${number} ${title}`

        if (level === 0) {
          latex += '\\newpage\n'
          latex += `\\section*{${escapeLaTeX(headingText)}}\n`
          latex += `\\addcontentsline{toc}{section}{${escapeLaTeX(headingText)}}\n\n`
        } else if (level === 1) {
          latex += `\\subsection*{${escapeLaTeX(headingText)}}\n`
          latex += `\\addcontentsline{toc}{subsection}{${escapeLaTeX(headingText)}}\n\n`
        } else {
          latex += `\\subsubsection*{${escapeLaTeX(headingText)}}\n`
          latex += `\\addcontentsline{toc}{subsubsection}{${escapeLaTeX(headingText)}}\n\n`
        }

        // If there was run-in text, add it as a paragraph
        if (rest) {
          // Process the rest of the line (quotes, footnotes, etc.)
          let processedRest = rest
          processedRest = processedRest.replace(/`([^`]+)`/g, '\\texttt{$1}')
          processedRest = convertQuotesToLaTeX(processedRest)
          processedRest = processFootnotesInText(processedRest, citationStyle, footnotes)
          latex += processedRest + '\n\n'
        }
        continue
      }
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
      // 1. Inline code
      let processedItem = itemText.replace(/`([^`]+)`/g, '\\texttt{$1}')
      // 2. Quotes
      processedItem = convertQuotesToLaTeX(processedItem)
      // 3. Footnotes
      const processedText = processFootnotesInText(processedItem, citationStyle, footnotes)
      latex += `\\item ${processedText}\n`
      continue
    } else if (inList && trimmedLine.length > 0 && (line.startsWith(' ') || line.startsWith('\t'))) {
      // Continuation of list item
      // 1. Inline code
      let processedLine = trimmedLine.replace(/`([^`]+)`/g, '\\texttt{$1}')
      // 2. Quotes
      processedLine = convertQuotesToLaTeX(processedLine)
      // 3. Footnotes
      const processedText = processFootnotesInText(processedLine, citationStyle, footnotes)
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

    // 1. Handle inline code FIRST (before quote conversion adds backticks)
    // `code` -> \texttt{code}
    let processedLine = line.replace(/`([^`]+)`/g, '\\texttt{$1}')

    // 2. Convert quotes
    processedLine = convertQuotesToLaTeX(processedLine)

    // 3. Process footnotes and other formatting
    const processedText = processFootnotesInText(processedLine, citationStyle, footnotes)
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

        console.log('[LaTeX Export] Processing footnote:', cleanText.substring(0, 100))

        // CRITICAL: Remove placeholder text like "\ETC." FIRST before any other processing
        // This prevents incomplete LaTeX commands from causing runaway arguments
        // Handle all possible forms of ETC placeholder - be VERY aggressive
        cleanText = cleanText.replace(/\\ETC\./gi, '')  // \ETC.
        cleanText = cleanText.replace(/\bETC\./gi, '')   // ETC.
        cleanText = cleanText.replace(/\.\.\./g, '')     // ...
        cleanText = cleanText.replace(/…/g, '')          // Unicode ellipsis
        cleanText = cleanText.replace(/\betc\./gi, '')   // etc.

        // Also remove any text that looks like a truncation marker
        cleanText = cleanText.replace(/\s*\\?ETC\.?\s*$/gi, '')
        cleanText = cleanText.replace(/\s*etc\.?\s*$/gi, '')

        // Fix spaces in LaTeX commands GLOBALLY (not just at start)
        // This handles cases like: \textit {text} anywhere in the string
        cleanText = cleanText.replace(/\\(textbf|textit|texttt|underline|textsubscript|textsuperscript|emph|em|textsc|textsl|textmd|textup|textnormal|textrm|textsf|textbackslash)\s+\{/g, '\\$1{')

        // AGGRESSIVE FIX: Close ALL unclosed LaTeX commands
        // Count opening braces in LaTeX commands and ensure they're all closed
        const latexCmdRegex = /\\(textbf|textit|texttt|underline|textsubscript|textsuperscript|emph|em|textsc|textsl|textmd|textup|textnormal|textrm|textsf)\{/g
        let match
        let unclosedCommands = 0
        let tempText = cleanText

        while ((match = latexCmdRegex.exec(tempText)) !== null) {
          const cmdStart = match.index
          const cmdName = match[1]
          let braceDepth = 1
          let i = cmdStart + match[0].length

          while (i < tempText.length && braceDepth > 0) {
            if (tempText[i] === '\\' && i + 1 < tempText.length) {
              i += 2 // Skip escaped character
              continue
            }
            if (tempText[i] === '{') braceDepth++
            else if (tempText[i] === '}') braceDepth--
            i++
          }

          if (braceDepth > 0) {
            unclosedCommands += braceDepth
          }
        }

        // Add closing braces for any unclosed commands
        if (unclosedCommands > 0) {
          console.log(`[LaTeX Export] Found ${unclosedCommands} unclosed LaTeX commands, adding closing braces`)
          cleanText = cleanText + '}'.repeat(unclosedCommands)
        }

        console.log('[LaTeX Export] After cleaning:', cleanText.substring(0, 100))



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
                  // Extract what we have so far and add closing brace
                  const partialContent = cleanText.substring(argStart).trim()
                  const cmdName = cmdNameMatch[0]
                  const fullCmd = `\\${cmdName}{${partialContent}}`
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
          console.log(`[LaTeX Export] Added ${openBraces - closeBraces} closing braces to balance`)
        }

        console.log('[LaTeX Export] Final footnote text:', escapedText.substring(0, 150))

        // FINAL SAFETY CHECK: Ensure the footnote doesn't have obvious syntax errors
        // Count all braces (not just in LaTeX commands)
        const totalOpen = (escapedText.match(/\{/g) || []).length
        const totalClose = (escapedText.match(/\}/g) || []).length

        if (totalOpen > totalClose) {
          console.log(`[LaTeX Export] WARNING: Unbalanced braces detected (${totalOpen} open, ${totalClose} close), adding ${totalOpen - totalClose} closing braces`)
          escapedText = escapedText + '}'.repeat(totalOpen - totalClose)
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

  // Inline code handling moved to convertMarkdownToLaTeX to avoid conflicts with LaTeX quotes

  // Links: [text](url) -> \href{url}{text}
  processed = processed.replace(/\[(.+?)\]\((.+?)\)/g, '\\href{$2}{$1}')

  // Protect LaTeX commands from being escaped
  // Use a placeholder format that won't be escaped (no underscores, use a unique pattern)
  const latexCommandPlaceholders: string[] = []
  let commandIndex = 0

  // Protect LaTeX commands (e.g., \textbf{...}, \textit{...}, \texttt{...}, \href{...}{...}, \footnote{...})
  // Match commands with one or two arguments
  // Use a placeholder that won't conflict with LaTeX escaping (no underscores)
  // Protect LaTeX commands but ESCAPE their content first
  // This ensures that \textit{A & B} becomes \textit{A \& B}
  processed = processed.replace(/\\(textbf|textit|texttt|underline|textsubscript|textsuperscript|footnote)\{([^}]*)\}/g, (match, cmd, content) => {
    // Escape the content (special chars like &, %, #)
    // We use a simplified escape that doesn't escape \ (to avoid breaking things if there are somehow nested commands)
    // But since this regex is non-recursive ([^}]*), there shouldn't be nested commands anyway
    const escapedContent = content
      .replace(/&/g, '\\&')
      .replace(/%/g, '\\%')
      .replace(/#/g, '\\#')
      .replace(/_/g, '\\_')

    const newMatch = `\\${cmd}{${escapedContent}}`

    const placeholder = `LATEXCMDPROTECT${commandIndex}LATEXCMDPROTECT`
    latexCommandPlaceholders[commandIndex] = newMatch
    commandIndex++
    return placeholder
  })

  // Protect \href{url}{text} (two arguments)
  // Protect \href{url}{text} (two arguments)
  processed = processed.replace(/\\href\{([^}]*)\}\{([^}]*)\}/g, (match, url, text) => {
    // Escape the text part (special chars like &, %, #)
    const escapedText = text
      .replace(/&/g, '\\&')
      .replace(/%/g, '\\%')
      .replace(/#/g, '\\#')
      .replace(/_/g, '\\_')

    const newMatch = `\\href{${url}}{${escapedText}}`

    const placeholder = `LATEXCMDPROTECT${commandIndex}LATEXCMDPROTECT`
    latexCommandPlaceholders[commandIndex] = newMatch
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

/**
 * Convert straight quotes to LaTeX quote syntax
 * Opening: `` (two backticks)
 * Closing: '' (two single quotes)
 */
function convertQuotesToLaTeX(text: string): string {
  if (!text) return ''

  // Replace pairs of straight quotes with LaTeX quotes
  // Pattern: "word" → ``word''
  // We need to distinguish opening from closing quotes

  let result = text
  let inQuote = false
  let output = ''

  for (let i = 0; i < result.length; i++) {
    const char = result[i]
    const prevChar = i > 0 ? result[i - 1] : ''
    const nextChar = i < result.length - 1 ? result[i + 1] : ''

    if (char === '"') {
      // Determine if this is an opening or closing quote
      // Opening quote: after space, start of string, or opening bracket
      // Closing quote: before space, punctuation, or end of string
      const isOpening = !inQuote || /[\s\(\[]/.test(prevChar) || i === 0

      if (isOpening) {
        output += '``'
        inQuote = true
      } else {
        output += "''"
        inQuote = false
      }
    } else {
      output += char
    }
  }

  return output
}

// Normalize text to fix common encoding issues
function normalizeText(text: string): string {
  if (!text) return ''

  let normalized = text

  // Fix "SZ" that should be a space in compound words
  // Pattern: lowercase letter + SZ + capital letter (e.g., "posthumaneSZivilisation" -> "posthumane Zivilisation")
  normalized = normalized.replace(/([a-zäöü])SZ([A-ZÄÖÜ])/g, '$1 Z$2')

  // Fix incorrect umlauts in English words
  // NOTE: We use (^|\\s) and (\\s|$) instead of \\b because JavaScript's \\b 
  // treats non-ASCII characters like ä as word boundaries, which causes
  // "Sphäre" to incorrectly match "Äre" and become "SphAre"
  normalized = normalized.replace(/(^|\s)Äre(\s|$)/gi, '$1Are$2')
  normalized = normalized.replace(/(^|\s)Änd(\s|$)/gi, '$1And$2')
  normalized = normalized.replace(/(^|\s)Äny(\s|$)/gi, '$1Any$2')
  normalized = normalized.replace(/(^|\s)Äll(\s|$)/gi, '$1All$2')
  normalized = normalized.replace(/(^|\s)Äre\s+You(\s|$)/gi, '$1Are You$2')

  // Fix standalone "Ä" at start of English words (followed by lowercase letters)
  // Only if it's clearly an English word pattern
  // Use (^|\s) instead of \b to avoid Unicode word boundary issues
  normalized = normalized.replace(/(^|\s)Ä([a-z]{2,})(\s|$)/g, (match, pre, rest, post) => {
    // Common English word patterns that start with "A"
    const englishPatterns = ['re', 'nd', 'ny', 'll', 'nd', 're', 'ct', 'ble', 'bout', 'fter', 'gain', 'lso', 'mong', 'nother', 'lready', 'lways', 'lthough', 'mong', 'nswer', 'ppear', 'pply', 'pproach', 'rrange', 'rticle', 'spect', 'ssume', 'ttach', 'ttack', 'ttempt', 'ttend', 'ttitude', 'ttract', 'udience', 'uthor', 'vailable', 'verage', 'void', 'ward', 'ware', 'wake', 'ward', 'way']
    if (englishPatterns.some(pattern => rest.toLowerCase().startsWith(pattern))) {
      return pre + 'A' + rest + post
    }
    return match
  })

  // Fix "Ö" that should be "O" in English contexts
  // Use (^|\s) instead of \b to avoid Unicode word boundary issues
  normalized = normalized.replace(/(^|\s)Ö([a-z]{2,})(\s|$)/g, (match, pre, rest, post) => {
    const englishPatterns = ['nly', 'nce', 'pen', 'ver', 'ther', 'rder', 'ffer', 'ffice', 'ften', 'ther', 'wner', 'bject', 'bserve', 'btain', 'bvious', 'ccur', 'cean', 'ctober', 'ffice', 'fficer', 'ften', 'nion', 'nly', 'pen', 'peration', 'pinion', 'pportunity', 'pposite', 'ption', 'rder', 'rganization', 'riginal', 'ther', 'utcome', 'utside', 'ver', 'wner']
    if (englishPatterns.some(pattern => rest.toLowerCase().startsWith(pattern))) {
      return pre + 'O' + rest + post
    }
    return match
  })

  // Fix "Ü" that should be "U" in English contexts
  // Use (^|\s) instead of \b to avoid Unicode word boundary issues
  normalized = normalized.replace(/(^|\s)Ü([a-z]{2,})(\s|$)/g, (match, pre, rest, post) => {
    const englishPatterns = ['nder', 'nion', 'nique', 'nit', 'nited', 'niversity', 'nless', 'ntil', 'pdate', 'pon', 'pper', 'rban', 'rge', 'rgent', 'sually', 'tilize']
    if (englishPatterns.some(pattern => rest.toLowerCase().startsWith(pattern))) {
      return pre + 'U' + rest + post
    }
    return match
  })

  return normalized
}

// Escape LaTeX for text (but preserve $ for math mode - math is handled separately)
function escapeLaTeXForText(text: string): string {
  if (!text) return ''

  // Ensure proper UTF-8 encoding - convert to string and normalize
  let textStr = String(text)

  // Normalize Unicode characters (NFC normalization)
  try {
    textStr = textStr.normalize('NFC')
  } catch (e) {
    // If normalization fails, continue with original string
  }

  // First, normalize the string to fix encoding issues
  let normalized = normalizeText(textStr)
    .replace(/^\uFEFF/, '') // Remove BOM
    .replace(/\u0000/g, '') // Remove null bytes
    .replace(/[\uFFFE\uFFFF]/g, '') // Remove invalid UTF-16 characters

  // Escape LaTeX special characters
  // Note: $ is NOT escaped here because math expressions are handled separately
  // IMPORTANT: Do NOT escape German umlauts (ä, ö, ü, Ä, Ö, Ü, ß) - they are valid UTF-8 and will be handled by inputenc
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
    // Only remove actual control characters, NOT extended ASCII or Unicode characters
    // Remove: NULL, control chars 1-31, DEL (127), but preserve extended ASCII and Unicode
    .replace(/[\u0000-\u001F\u007F]/g, '')
    // Remove invalid surrogate pairs and other invalid Unicode
    .replace(/[\uD800-\uDFFF]/g, '')
}

/**
 * Remove all non-Latin characters except German umlauts and basic punctuation
 * Keeps only: A-Z, a-z, 0-9, äöüßÄÖÜ, and basic punctuation
 */
function sanitizeForLaTeX(text: string): string {
  if (!text) return ''

  // IMPORTANT: Normalize Unicode to NFC first!
  // This converts decomposed characters (a + combining diaeresis) to composed form (ä)
  // Without this, the regex below may fail to recognize umlauts properly
  try {
    text = text.normalize('NFC')
  } catch (e) {
    // If normalization fails, continue with original
  }

  // MANUAL FIX: Handle decomposed umlauts that NFC might have missed
  // Replace base letter + combining diaeresis (U+0308) with composed form
  text = text.replace(/a\u0308/g, 'ä')
  text = text.replace(/o\u0308/g, 'ö')
  text = text.replace(/u\u0308/g, 'ü')
  text = text.replace(/A\u0308/g, 'Ä')
  text = text.replace(/O\u0308/g, 'Ö')
  text = text.replace(/U\u0308/g, 'Ü')

  // Also handle other extended Latin characters that look like umlauts
  // Latin Extended-A: ă (U+0103) -> a, etc. - but we want to keep actual umlauts
  // Latin Extended-B variants
  text = text.replace(/ǟ/g, 'ä')  // a with diaeresis and macron
  text = text.replace(/ǻ/g, 'ä')  // a with ring and acute

  // Define allowed characters:
  // - Latin alphabet: A-Z, a-z
  // - Numbers: 0-9
  // - German special characters: ä, ö, ü, ß, Ä, Ö, Ü
  // - Basic punctuation: . , ; : ! ? - ( ) [ ] " ' / 
  // - Spaces and newlines

  // First, explicitly preserve German umlauts by replacing them with placeholders
  const umlauts: [string, string][] = [
    ['ä', '__UMLAUT_A_LOWER__'],
    ['ö', '__UMLAUT_O_LOWER__'],
    ['ü', '__UMLAUT_U_LOWER__'],
    ['Ä', '__UMLAUT_A_UPPER__'],
    ['Ö', '__UMLAUT_O_UPPER__'],
    ['Ü', '__UMLAUT_U_UPPER__'],
    ['ß', '__UMLAUT_SS__'],
  ]

  for (const [umlaut, placeholder] of umlauts) {
    text = text.split(umlaut).join(placeholder)
  }

  // Now sanitize - remove non-Latin characters
  text = text.replace(/[^\x20-\x7E\xC0-\xFF\n\r\t_]/g, (match) => {
    // Check if it's a placeholder (starts with __)
    if (match.startsWith('_')) {
      return match
    }

    const code = match.charCodeAt(0)

    // Allow German umlauts and common Western European characters
    const allowedRanges = [
      [0xC0, 0xFF], // Latin-1 Supplement (includes äöüÄÖÜß and French/Spanish chars)
    ]

    for (const [start, end] of allowedRanges) {
      if (code >= start && code <= end) {
        return match
      }
    }

    // Remove everything else (Cyrillic, Greek, CJK, Arabic, etc.)
    return ''
  })

  // Restore German umlauts from placeholders
  for (const [umlaut, placeholder] of umlauts) {
    text = text.split(placeholder).join(umlaut)
  }

  return text
}

function escapeLaTeX(text: string): string {
  if (!text) return ''

  // First, sanitize non-Latin characters
  text = sanitizeForLaTeX(text)

  // Ensure proper UTF-8 encoding - convert to string and normalize
  let textStr = String(text)

  // Normalize Unicode characters (NFC normalization)
  try {
    textStr = textStr.normalize('NFC')
  } catch (e) {
    // If normalization fails, continue with original string
  }

  // First, normalize the string to fix encoding issues and remove BOM
  let normalized = normalizeText(textStr)
    .replace(/^\uFEFF/, '') // Remove UTF-8 BOM if present
    .replace(/\u0000/g, '') // Remove null bytes
    .replace(/[\uFFFE\uFFFF]/g, '') // Remove invalid UTF-16 characters

  // Then escape LaTeX special characters in the correct order
  // IMPORTANT: Do NOT escape German umlauts (ä, ö, ü, Ä, Ö, Ü, ß) - they are valid UTF-8
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
    // Only remove actual control characters, NOT extended ASCII or Unicode characters
    // Remove: NULL, control chars 1-31, DEL (127), but preserve extended ASCII and Unicode
    .replace(/[\u0000-\u001F\u007F]/g, '')
    // Remove invalid surrogate pairs and other invalid Unicode
    .replace(/[\uD800-\uDFFF]/g, '')
}

// Helper function to get first author's last name for sorting
function getFirstAuthorLastName(source: any): string {
  const authors = source.metadata?.authors || source.authors || []
  if (Array.isArray(authors) && authors.length > 0) {
    const firstAuthor = String(authors[0])
    // Extract last name (before comma or first word)
    return firstAuthor.split(/[,]/)[0].trim().toLowerCase()
  }
  if (typeof authors === 'string') {
    return authors.split(/[,]/)[0].trim().toLowerCase()
  }
  return 'zzz' // Unknown authors go to end
}

// Format a bibliography entry for LaTeX
function formatBibliographyEntryLaTeX(source: any, citationStyle: string): string {
  const title = escapeLaTeX(source.title || source.metadata?.title || 'Ohne Titel')
  const authors = formatAuthorsLaTeX(source.metadata?.authors || source.authors || [])
  const year = source.metadata?.year || source.year || 'o.J.'
  const journal = source.metadata?.venue || source.journal || ''
  const doi = source.doi || ''
  const pages = source.metadata?.pages || ''

  switch (citationStyle) {
    case 'deutsche-zitierweise':
      // German style: Author(s): Title. In: Journal (Year), S. Pages.
      let deEntry = `${authors}: ${title}.`
      if (journal) deEntry += ` In: \\textit{${escapeLaTeX(journal)}}`
      deEntry += ` (${year})`
      if (pages) deEntry += `, S. ${escapeLaTeX(pages)}`
      deEntry += '.'
      if (doi) deEntry += ` DOI: ${escapeLaTeX(doi)}`
      return deEntry

    case 'harvard':
      // Harvard: Author(s) (Year) Title. Journal, pages.
      let harvardEntry = `${authors} (${year}) ${title}.`
      if (journal) harvardEntry += ` \\textit{${escapeLaTeX(journal)}}`
      if (pages) harvardEntry += `, ${escapeLaTeX(pages)}`
      harvardEntry += '.'
      if (doi) harvardEntry += ` DOI: ${escapeLaTeX(doi)}`
      return harvardEntry

    case 'mla':
      // MLA: Author(s). "Title." Journal, Year, pages.
      let mlaEntry = `${authors}. ''${title}.''`
      if (journal) mlaEntry += ` \\textit{${escapeLaTeX(journal)}},`
      mlaEntry += ` ${year}`
      if (pages) mlaEntry += `, ${escapeLaTeX(pages)}`
      mlaEntry += '.'
      if (doi) mlaEntry += ` DOI: ${escapeLaTeX(doi)}`
      return mlaEntry

    case 'apa':
    default:
      // APA: Author(s) (Year). Title. Journal, pages. DOI
      let apaEntry = `${authors} (${year}). ${title}.`
      if (journal) apaEntry += ` \\textit{${escapeLaTeX(journal)}}`
      if (pages) apaEntry += `, ${escapeLaTeX(pages)}`
      apaEntry += '.'
      if (doi) apaEntry += ` https://doi.org/${escapeLaTeX(doi)}`
      return apaEntry
  }
}

// Format authors for LaTeX bibliography
function formatAuthorsLaTeX(authors: any): string {
  if (!authors) return 'Unbekannt'

  if (typeof authors === 'string') {
    return escapeLaTeX(authors)
  }

  if (Array.isArray(authors)) {
    if (authors.length === 0) return 'Unbekannt'
    if (authors.length === 1) return escapeLaTeX(String(authors[0]))
    if (authors.length === 2) return `${escapeLaTeX(String(authors[0]))} \\& ${escapeLaTeX(String(authors[1]))}`
    // 3+ authors: First author et al.
    return `${escapeLaTeX(String(authors[0]))} et al.`
  }

  return 'Unbekannt'
}
