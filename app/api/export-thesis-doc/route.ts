import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'
import { 
  Document, 
  Packer, 
  Paragraph, 
  TextRun, 
  HeadingLevel, 
  AlignmentType,
  PageBreak,
  PageOrientation,
} from 'docx'
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

    // Parse Markdown content and convert to DOCX
    const paragraphs: Paragraph[] = []
    const footnoteMap = new Map<number, string>() // Store footnote text for later
    
    // Add cover page title (centered, large, prominent)
    if (thesis.title || thesis.topic) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: thesis.title || thesis.topic,
              size: 48, // 24pt - more pronounced
              font: 'Times New Roman',
              bold: true,
              color: '000000', // Black, not blue
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { after: 0, before: 0 },
        })
      )
      // Add vertical spacing to center on page
      for (let i = 0; i < 15; i++) {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: ' ', size: 24, font: 'Times New Roman', color: '000000' })],
            spacing: { after: 0, before: 0 },
          })
        )
      }
    }

    // Add page break after cover
    paragraphs.push(new Paragraph({ children: [new PageBreak()] }))

    // Generate Table of Contents from outline
    if (outline && Array.isArray(outline) && outline.length > 0) {
      const tocTitle = language === 'german' ? 'Inhaltsverzeichnis' : 'Table of Contents'
      
      // TOC Heading
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: tocTitle,
              size: 32, // 16pt
              font: 'Times New Roman',
              bold: true,
              color: '000000', // Black, not blue
            }),
          ],
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.LEFT,
          spacing: { before: 0, after: 240 }, // Reduced spacing
        })
      )

      // Generate TOC entries from outline
      outline.forEach((chapter) => {
        // Main chapter (level 0) - bold, no indent
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${chapter.number} ${chapter.title}`,
                size: 24, // 12pt
                font: 'Times New Roman',
                bold: true,
                color: '000000', // Black, not blue
              }),
            ],
            spacing: { before: 0, after: 120 }, // Reduced spacing
            indent: { left: 0 },
          })
        )

        // Sections (level 1) - normal, 8mm indent
        chapter.sections?.forEach((section) => {
          paragraphs.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `${section.number} ${section.title}`,
                  size: 24, // 12pt
                  font: 'Times New Roman',
                  bold: false,
                  color: '000000', // Black, not blue
                }),
              ],
              spacing: { before: 0, after: 120 }, // Reduced spacing
              indent: { left: 227 }, // 8mm = ~227 twips (1mm = 28.35 twips)
            })
          )

          // Subsections (level 2) - normal, 16mm indent
          section.subsections?.forEach((subsection) => {
            paragraphs.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: `${subsection.number} ${subsection.title}`,
                    size: 24, // 12pt
                    font: 'Times New Roman',
                    bold: false,
                    color: '000000', // Black, not blue
                  }),
                ],
                spacing: { before: 0, after: 120 }, // Reduced spacing
                indent: { left: 454 }, // 16mm = ~454 twips
              })
            )
          })
        })
      })

      // Page break after TOC
      paragraphs.push(new Paragraph({ children: [new PageBreak()] }))
    }

    // Split content by lines and process
    const lines = content.split('\n')
    let currentParagraph: string[] = []
    let inCodeBlock = false
    let inList = false
    let listItems: string[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmedLine = line.trim()

      // Skip TOC if present (will be generated separately)
      if (trimmedLine.match(/^#+\s*(Inhaltsverzeichnis|Table of Contents)/i)) {
        // Skip until next heading
        while (i < lines.length - 1 && !lines[i + 1].match(/^##?\s+/)) {
          i++
        }
        continue
      }

      // Handle code blocks
      if (trimmedLine.startsWith('```')) {
        inCodeBlock = !inCodeBlock
        continue
      }
      if (inCodeBlock) {
        currentParagraph.push(line)
        continue
      }

      // Skip TOC heading if present (we generate it from outline)
      if (trimmedLine.match(/^#+\s*(Inhaltsverzeichnis|Table of Contents)/i)) {
        // Skip until next heading
        while (i < lines.length - 1 && !lines[i + 1].match(/^##?\s+/)) {
          i++
        }
        continue
      }

      // Handle headings
      if (trimmedLine.startsWith('# ')) {
        if (currentParagraph.length > 0) {
          paragraphs.push(createParagraphFromText(
            currentParagraph.join('\n'),
            citationStyle === 'deutsche-zitierweise' ? footnotes : undefined,
            citationStyle === 'deutsche-zitierweise' ? footnoteMap : undefined
          ))
          currentParagraph = []
        }
        // Add line break before new chapter (H1)
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: ' ', size: 24, font: 'Times New Roman', color: '000000' })],
            spacing: { after: 0, before: 0 },
          })
        )
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmedLine.substring(2),
                size: 32, // 16pt
                font: 'Times New Roman',
                bold: true,
                color: '000000', // Black, not blue
              }),
            ],
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 240, after: 120, line: 360, lineRule: 'auto' }, // Line height 1.5
            alignment: AlignmentType.LEFT,
          })
        )
        continue
      } else if (trimmedLine.startsWith('## ')) {
        if (currentParagraph.length > 0) {
          paragraphs.push(createParagraphFromText(
            currentParagraph.join('\n'),
            citationStyle === 'deutsche-zitierweise' ? footnotes : undefined,
            citationStyle === 'deutsche-zitierweise' ? footnoteMap : undefined
          ))
          currentParagraph = []
        }
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmedLine.substring(3),
                size: 28, // 14pt
                font: 'Times New Roman',
                bold: true,
                color: '000000', // Black, not blue
              }),
            ],
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 180, after: 120, line: 360, lineRule: 'auto' }, // Line height 1.5
            alignment: AlignmentType.LEFT,
          })
        )
        continue
      } else if (trimmedLine.startsWith('### ')) {
        if (currentParagraph.length > 0) {
          paragraphs.push(createParagraphFromText(
            currentParagraph.join('\n'),
            citationStyle === 'deutsche-zitierweise' ? footnotes : undefined,
            citationStyle === 'deutsche-zitierweise' ? footnoteMap : undefined
          ))
          currentParagraph = []
        }
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: trimmedLine.substring(4),
                size: 24, // 12pt
                font: 'Times New Roman',
                bold: true,
                color: '000000', // Black, not blue
              }),
            ],
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 120, after: 80, line: 360, lineRule: 'auto' }, // Line height 1.5
            alignment: AlignmentType.LEFT,
          })
        )
        continue
      }

      // Handle lists
      if (trimmedLine.match(/^[-*+]\s+/) || trimmedLine.match(/^\d+\.\s+/)) {
        if (currentParagraph.length > 0) {
          paragraphs.push(createParagraphFromText(
            currentParagraph.join('\n'),
            citationStyle === 'deutsche-zitierweise' ? footnotes : undefined,
            citationStyle === 'deutsche-zitierweise' ? footnoteMap : undefined
          ))
          currentParagraph = []
        }
        const listText = trimmedLine.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '')
        listItems.push(listText)
        inList = true
        continue
      } else if (inList && trimmedLine.length > 0 && !trimmedLine.match(/^#+\s+/)) {
        // Continue list item (but not if it's a heading)
        listItems[listItems.length - 1] += ' ' + trimmedLine
        continue
      } else if (inList && trimmedLine.length === 0) {
        // End of list
        listItems.forEach(item => {
          paragraphs.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: item,
                  size: 24, // 12pt
                  font: 'Times New Roman',
                }),
              ],
              bullet: { level: 0 },
              spacing: { after: 200 },
              indent: { left: 454 }, // 16mm indent for lists
            })
          )
        })
        listItems = []
        inList = false
        continue
      }

      // Handle empty lines - reduce excessive spacing
      if (trimmedLine.length === 0) {
        if (currentParagraph.length > 0) {
          paragraphs.push(createParagraphFromText(
            currentParagraph.join('\n'),
            citationStyle === 'deutsche-zitierweise' ? footnotes : undefined,
            citationStyle === 'deutsche-zitierweise' ? footnoteMap : undefined
          ))
          currentParagraph = []
        }
        // Only add minimal spacing, not full paragraph
        // Skip multiple consecutive empty lines
        if (i < lines.length - 1 && lines[i + 1].trim().length === 0) {
          continue // Skip consecutive empty lines
        }
        continue // Don't add empty paragraph
      }

      // Regular text
      currentParagraph.push(line)
    }

    // Add remaining paragraph
    if (currentParagraph.length > 0) {
      paragraphs.push(createParagraphFromText(
        currentParagraph.join('\n'),
        citationStyle === 'deutsche-zitierweise' ? footnotes : undefined,
        citationStyle === 'deutsche-zitierweise' ? footnoteMap : undefined
      ))
    }

    // Add remaining list items
    if (listItems.length > 0) {
      listItems.forEach(item => {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: item,
                size: 24, // 12pt
                font: 'Times New Roman',
                color: '000000', // Black, not blue
              }),
            ],
            bullet: { level: 0 },
            spacing: { after: 120, before: 0, line: 360, lineRule: 'auto' }, // Line height 1.5
            indent: { left: 454 }, // 16mm indent for lists
          })
        )
      })
    }

    // Create document with proper styling
    console.log('[ExportDOC] Creating document structure...')
    console.log('[ExportDOC] Footnotes found:', Object.keys(footnotes).length)
    
    // Add footnotes as a section at the end if German citation style
    if (citationStyle === 'deutsche-zitierweise' && footnoteMap.size > 0) {
      // Add page break before footnotes
      paragraphs.push(new Paragraph({ children: [new PageBreak()] }))
      
      // Add footnotes heading
      const footnotesTitle = language === 'german' ? 'Fußnoten' : 'Footnotes'
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: footnotesTitle,
              size: 32, // 16pt
              font: 'Times New Roman',
              bold: true,
              color: '000000',
            }),
          ],
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
          alignment: AlignmentType.LEFT,
        })
      )
      
      // Add footnotes in order
      const sortedNumbers = Array.from(footnoteMap.keys()).sort((a, b) => a - b)
      sortedNumbers.forEach(num => {
        const footnoteText = footnoteMap.get(num)
        if (footnoteText) {
          paragraphs.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `${num}. ${footnoteText}`,
                  size: 20, // 10pt for footnotes
                  font: 'Times New Roman',
                  color: '000000',
                }),
              ],
              spacing: { after: 100, before: 0 },
              indent: { left: 454 }, // Indent footnotes
            })
          )
        }
      })
    }
    
    const doc = new Document({
      sections: [{
        properties: {
          page: {
            size: {
              orientation: PageOrientation.PORTRAIT,
              width: 11906, // A4 width in twips (210mm)
              height: 16838, // A4 height in twips (297mm)
            },
            margin: {
              top: 1440, // 25mm top margin
              right: 1134, // 20mm right margin
              bottom: 1440, // 25mm bottom margin
              left: 1134, // 20mm left margin
            },
          },
        },
        children: paragraphs,
      }],
      // TODO: Add footnotes support - the docx library may need a different API
      // footnotes: documentFootnotes.length > 0 ? documentFootnotes : undefined,
    })

    // Generate DOCX buffer
    console.log('[ExportDOC] Creating document with', paragraphs.length, 'paragraphs')
    const buffer = await Packer.toBuffer(doc)
    console.log('[ExportDOC] Document created successfully, size:', buffer.length, 'bytes')

    // Return as blob
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${(thesis.title || thesis.topic || 'thesis').replace(/[^a-z0-9]/gi, '_')}.docx"`,
      },
    })
  } catch (error) {
    console.error('[ExportDOC] Error exporting thesis to DOC:', error)
    console.error('[ExportDOC] Error stack:', error instanceof Error ? error.stack : 'No stack trace')
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

// Helper function to create paragraph from text with basic formatting and footnotes
function createParagraphFromText(
  text: string, 
  footnotes?: Record<number, string>, 
  footnoteMap?: Map<number, Footnote>
): Paragraph {
  // Clean up markdown syntax first (but preserve footnote markers)
  let cleanText = text
    .replace(/\*\*(.+?)\*\*/g, '$1') // Bold
    .replace(/\*(.+?)\*/g, '$1') // Italic (but not if it's part of **)
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // Links
    .replace(/`(.+?)`/g, '$1') // Code
    // Keep footnote markers for processing
  
  // Create text runs with proper formatting and footnotes
  const textRuns: TextRun[] = []
  
  // First, split by footnote markers if footnotes are available
  if (footnotes && Object.keys(footnotes).length > 0 && footnoteMap) {
    // Split text by footnote markers (^1, ^2, etc.)
    const parts = cleanText.split(/(\^\d+)/g)
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      
      // Check if this is a footnote marker
      const footnoteMatch = part.match(/\^(\d+)/)
      if (footnoteMatch) {
        const footnoteNum = parseInt(footnoteMatch[1], 10)
        const footnoteText = footnotes[footnoteNum]
        
        if (footnoteText && footnoteMap) {
          // Store footnote text for later (we'll add footnotes as regular text at the end for now)
          // TODO: Implement proper footnote support when docx library API is confirmed
          if (!footnoteMap.has(footnoteNum)) {
            footnoteMap.set(footnoteNum, footnoteText as any) // Store text instead of Footnote object
          }
          
          // Add footnote reference as superscript text
          textRuns.push(new TextRun({
            text: String(footnoteNum),
            size: 18, // Smaller for superscript
            font: 'Times New Roman',
            color: '000000',
            superScript: true,
          }))
        } else {
          // If footnote not found, just add the number as superscript text
          textRuns.push(new TextRun({
            text: String(footnoteNum),
            size: 18, // Smaller for superscript
            font: 'Times New Roman',
            color: '000000',
            superScript: true,
          }))
        }
      } else if (part.length > 0) {
        // Regular text - parse for bold/italic
        let remainingText = part
        let currentIndex = 0
        
        while (currentIndex < remainingText.length) {
          // Check for bold **text** (after cleaning, this should be rare, but handle it)
          const boldMatch = remainingText.substring(currentIndex).match(/\*\*(.+?)\*\*/)
          // Check for italic *text* (single asterisk, not double)
          const italicMatch = remainingText.substring(currentIndex).match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/)
          
          let match: RegExpMatchArray | null = null
          let isBold = false
          
          if (boldMatch && (!italicMatch || boldMatch.index! < italicMatch.index!)) {
            match = boldMatch
            isBold = true
          } else if (italicMatch) {
            match = italicMatch
          }
          
          if (match) {
            // Add text before match
            if (match.index! > 0) {
              const beforeText = remainingText.substring(currentIndex, currentIndex + match.index!)
              if (beforeText) {
                textRuns.push(new TextRun({
                  text: beforeText,
                  size: 24, // 12pt
                  font: 'Times New Roman',
                  color: '000000', // Black, not blue
                }))
              }
            }
            
            // Add formatted text
            textRuns.push(new TextRun({
              text: match[1],
              size: 24, // 12pt
              font: 'Times New Roman',
              bold: isBold,
              italics: !isBold,
              color: '000000', // Black, not blue
            }))
            
            currentIndex += match.index! + match[0].length
          } else {
            // Add remaining text
            const remaining = remainingText.substring(currentIndex)
            if (remaining) {
              textRuns.push(new TextRun({
                text: remaining,
                size: 24, // 12pt
                font: 'Times New Roman',
                color: '000000', // Black, not blue
              }))
            }
            break
          }
        }
      }
    }
  } else {
    // No footnotes - parse normally for bold/italic
    let remainingText = cleanText
    let currentIndex = 0
    
    while (currentIndex < remainingText.length) {
      // Check for bold **text** (after cleaning, this should be rare, but handle it)
      const boldMatch = remainingText.substring(currentIndex).match(/\*\*(.+?)\*\*/)
      // Check for italic *text* (single asterisk, not double)
      const italicMatch = remainingText.substring(currentIndex).match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/)
      
      let match: RegExpMatchArray | null = null
      let isBold = false
      
      if (boldMatch && (!italicMatch || boldMatch.index! < italicMatch.index!)) {
        match = boldMatch
        isBold = true
      } else if (italicMatch) {
        match = italicMatch
      }
      
      if (match) {
        // Add text before match
        if (match.index! > 0) {
          const beforeText = remainingText.substring(currentIndex, currentIndex + match.index!)
          if (beforeText) {
            textRuns.push(new TextRun({
              text: beforeText,
              size: 24, // 12pt
              font: 'Times New Roman',
              color: '000000', // Black, not blue
            }))
          }
        }
        
        // Add formatted text
        textRuns.push(new TextRun({
          text: match[1],
          size: 24, // 12pt
          font: 'Times New Roman',
          bold: isBold,
          italics: !isBold,
          color: '000000', // Black, not blue
        }))
        
        currentIndex += match.index! + match[0].length
      } else {
        // Add remaining text
        const remaining = remainingText.substring(currentIndex)
        if (remaining) {
          textRuns.push(new TextRun({
            text: remaining,
            size: 24, // 12pt
            font: 'Times New Roman',
            color: '000000', // Black, not blue
          }))
        }
        break
      }
    }
  }
  
  // If no formatting found, just use plain text
  if (textRuns.length === 0) {
    return new Paragraph({
      children: [
        new TextRun({
          text: cleanText,
          size: 24, // 12pt
          font: 'Times New Roman',
          color: '000000', // Black, not blue
        }),
      ],
      spacing: { after: 120, before: 0, line: 360, lineRule: 'auto' }, // Line height 1.5
      alignment: AlignmentType.JUSTIFIED, // Justified text like in preview
    })
  }
  
  return new Paragraph({
    children: textRuns,
    spacing: { after: 120, before: 0, line: 360, lineRule: 'auto' }, // Line height 1.5 (360 twips = 1.5 * 240)
    alignment: AlignmentType.JUSTIFIED, // Justified text like in preview
  })
}

