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
\\usepackage[ngerman,english]{babel}
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

  // Table of Contents - generate manually from outline
  if (outline && Array.isArray(outline) && outline.length > 0) {
    const tocTitle = isGerman ? 'Inhaltsverzeichnis' : 'Table of Contents'
    latex += `\\section*{${tocTitle}}
\\addcontentsline{toc}{section}{${tocTitle}}

`
    outline.forEach((chapter) => {
      // Main chapter entry
      latex += `\\noindent\\textbf{${chapter.number} ${escapeLaTeX(chapter.title)}}\\\\[0.5em]
`
      // Sections
      chapter.sections?.forEach((section) => {
        latex += `\\hspace{8mm}${section.number} ${escapeLaTeX(section.title)}\\\\[0.3em]
`
        // Subsections
        section.subsections?.forEach((subsection) => {
          latex += `\\hspace{16mm}${subsection.number} ${escapeLaTeX(subsection.title)}\\\\[0.2em]
`
        })
      })
    })
    latex += `\\newpage

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
    // Process bibliography entries
    const bibLines = bibliographyContent.split('\n')
    for (const line of bibLines) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.match(/^#+\s*(Literaturverzeichnis|Bibliography)/i)) {
        // Convert bibliography entries to LaTeX
        const processed = processFootnotesInText(trimmed, citationStyle, footnotes)
        // Format as bibliography entry (remove list markers if present)
        const cleaned = processed.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '')
        latex += cleaned + '\n\n'
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
  const lines = content.split('\n')
  let latex = ''
  let inCodeBlock = false
  let inList = false
  let listLevel = 0
  let listIsOrdered = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmedLine = line.trim()

    // Skip TOC if present (we generate it from outline)
    if (trimmedLine.match(/^#+\s*(Inhaltsverzeichnis|Table of Contents)/i)) {
      while (i < lines.length - 1 && !lines[i + 1].match(/^##?\s+/)) {
        i++
      }
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

    // Handle headings - remove numbers since LaTeX auto-numbers
    if (trimmedLine.startsWith('# ')) {
      if (inList) {
        latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
        inList = false
        listIsOrdered = false
      }
      // Keep the full heading text with number (e.g., "1. Einleitung") - use section* to avoid LaTeX auto-numbering
      const headingText = trimmedLine.substring(2).trim()
      // Add page break before new chapter (H1)
      latex += '\\newpage\n'
      latex += `\\section*{${escapeLaTeX(headingText)}}\n`
      latex += `\\addcontentsline{toc}{section}{${escapeLaTeX(headingText)}}\n\n`
      continue
    } else if (trimmedLine.startsWith('## ')) {
      if (inList) {
        latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
        inList = false
        listIsOrdered = false
      }
      // Keep the full heading text with number (e.g., "1.1 Problemstellung")
      const headingText = trimmedLine.substring(3).trim()
      latex += `\\subsection*{${escapeLaTeX(headingText)}}\n`
      latex += `\\addcontentsline{toc}{subsection}{${escapeLaTeX(headingText)}}\n\n`
      continue
    } else if (trimmedLine.startsWith('### ')) {
      if (inList) {
        latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
        inList = false
        listIsOrdered = false
      }
      // Keep the full heading text with number (e.g., "1.1.1 Untertitel")
      const headingText = trimmedLine.substring(4).trim()
      latex += `\\subsubsection*{${escapeLaTeX(headingText)}}\n`
      latex += `\\addcontentsline{toc}{subsubsection}{${escapeLaTeX(headingText)}}\n\n`
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

    // Handle empty lines
    if (trimmedLine.length === 0) {
      if (inList) {
        latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
        inList = false
        listLevel = 0
        listIsOrdered = false
      }
      latex += '\n'
      continue
    }

    // Regular text - process footnotes and formatting
    const processedText = processFootnotesInText(line, citationStyle, footnotes)
    latex += processedText + '\n\n'
  }

  // Close any open lists
  if (inList) {
    latex += (listIsOrdered ? '\\end{enumerate}\n' : '\\end{itemize}\n')
  }

  return latex
}

function processFootnotesInText(
  text: string,
  citationStyle: string,
  footnotes: Record<number, string>
): string {
  let processed = text

  // Handle German citation style footnotes (^1, ^2, etc.)
  if (citationStyle === 'deutsche-zitierweise' && Object.keys(footnotes).length > 0) {
    // Replace ^N with \footnote{...}
    processed = processed.replace(/\^(\d+)/g, (match, num) => {
      const footnoteNum = parseInt(num, 10)
      const footnoteText = footnotes[footnoteNum]
      if (footnoteText) {
        return `\\footnote{${escapeLaTeX(footnoteText)}}`
      }
      return match
    })
  }

  // Handle markdown formatting
  // Bold: **text** -> \textbf{text}
  processed = processed.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}')
  
  // Italic: *text* -> \textit{text} (but not if it's part of **)
  processed = processed.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '\\textit{$1}')
  
  // Inline code: `code` -> \texttt{code}
  processed = processed.replace(/`(.+?)`/g, '\\texttt{$1}')
  
  // Links: [text](url) -> \href{url}{text}
  processed = processed.replace(/\[(.+?)\]\((.+?)\)/g, '\\href{$2}{$1}')

  return processed
}

function escapeLaTeX(text: string): string {
  if (!text) return ''
  
  // First, normalize the string to remove any BOM or encoding issues
  let normalized = text
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

