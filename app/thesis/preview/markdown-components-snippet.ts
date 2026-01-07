
// Memoize markdown components to avoid re-rendering and losing text selection
const markdownComponents = React.useMemo(() => ({
    // Text component - footnotes are handled at paragraph level to avoid double processing
    text: ({ node, children, ...props }: any) => {
        return <>{ children } </>
    },
    h1: ({ node, children, ...props }: any) => {
        return (
            <h1 style= {{
            fontSize: '16pt',
                fontWeight: 'bold',
                    textAlign: 'left',
                        marginTop: '12mm',
                            marginBottom: '8mm',
                                pageBreakBefore: 'always',
                                    breakBefore: 'page',
        }
    } { ...props } > { children } </h1>
)
    },
h2: ({ node, children, ...props }: any) => {
    const text = String(children || '')
    const isTOCHeading = text.includes('Inhaltsverzeichnis') || text.includes('Table of Contents')

    if (isTOCHeading && thesis?.outline) {
        return null
    }

    return (
        <h2 style= {{
        fontSize: '14pt',
            fontWeight: 'bold',
                marginTop: '8mm',
                    marginBottom: '4mm',
                        textAlign: 'left',
        }
} {...props }> { children } </h2>
      )
    },
h3: ({ node, ...props }: any) => (
    <h3 style= {{
    fontSize: '12pt',
        fontWeight: 'bold',
            marginTop: '8mm',
                marginBottom: '4mm',
                    textAlign: 'left',
      }} {...props } />
    ),
h4: ({ node, ...props }: any) => (
    <h4 style= {{
    fontSize: '11pt',
        fontWeight: 'bold',
            marginTop: '6mm',
                marginBottom: '3mm',
                    textAlign: 'left',
      }} {...props } />
    ),
p: ({ node, children, ...props }: any) => {
    // Extract footnotes from content
    const extractFootnotesFromContent = (text: string): Record<number, string> => {
        const footnotes: Record<number, string> = {}
        const footnoteRegex = /\[\^(\d+)\]:\s*(.+?)(?=\n\[\^|\n\n|$)/gs
        let match
        while ((match = footnoteRegex.exec(text)) !== null) {
            footnotes[parseInt(match[1], 10)] = match[2].trim()
        }
        return footnotes
    }

    let footnotes: Record<number, string> = thesis?.metadata?.footnotes || {}
    if (Object.keys(footnotes).length === 0 && content) {
        footnotes = extractFootnotesFromContent(content)
    }

    // If still no footnotes and we have citations, create footnotes from them
    if (Object.keys(footnotes).length === 0 && thesis?.metadata?.citations) {
        const citations = thesis.metadata.citations as any[]
        citations.forEach((citation, idx) => {
            const authors = Array.isArray(citation.authors)
                ? citation.authors.join(', ')
                : citation.authors || 'Unbekannt'
            const year = citation.year || ''
            const title = citation.title || ''
            const pages = citation.pages || ''
            footnotes[idx + 1] = `${authors} (${year}): ${title}${pages ? `, S. ${pages}` : ''}`
        })
    }

    // Build footnote PDF URLs
    const footnotePdfUrls: Record<number, string | null> = {}
    if (bibliographySources && bibliographySources.length > 0) {
        Object.entries(footnotes).forEach(([numStr, citationText]) => {
            const num = parseInt(numStr, 10)
            const citation = citationText as string
            const yearMatch = citation.match(/[\(\s,](\d{4})[\)\s,:]/)
            const citationYear = yearMatch ? yearMatch[1] : null
            const authorMatch = citation.match(/^([A-ZÄÖÜa-zäöüß][a-zäöüß]+)(?:\s|,|\/|\(|\:)/)
            const citationAuthorLastName = authorMatch ? authorMatch[1].toLowerCase() : null

            if (!citationYear && !citationAuthorLastName) return

            const matchingSource = bibliographySources.find((source: any) => {
                const meta = source.metadata || source
                const sourceYear = String(meta.year || source.year || '')
                const authors = meta.authors || []
                const firstAuthor = authors[0] || ''
                const sourceAuthorLastName = firstAuthor.split(' ').pop()?.toLowerCase() || ''

                if (citationYear && citationAuthorLastName) {
                    return sourceYear === citationYear && sourceAuthorLastName === citationAuthorLastName
                }
                if (citationYear) return sourceYear === citationYear
                if (citationAuthorLastName) return sourceAuthorLastName === citationAuthorLastName
                return false
            })

            if (matchingSource) {
                footnotePdfUrls[num] = matchingSource.sourceUrl || matchingSource.metadata?.sourceUrl || matchingSource.pdfUrl || null
            }
        })
    }

    // Check for highlight
    const getTextContent = (n: any): string => {
        if (typeof n === 'string') return n
        if (Array.isArray(n)) return n.map(getTextContent).join('')
        if (n?.props?.children) return getTextContent(n.props.children)
        return ''
    }
    const paragraphText = getTextContent(children)

    const isHighlighted = highlightedPassages.some(passage =>
        paragraphText.includes(passage.text.substring(0, 50)) ||
        passage.text.includes(paragraphText.substring(0, 50))
    )

    const hasPendingEdit = pendingEdit && paragraphText.includes(pendingEdit.oldText)

    return (
        <p style= {{
        marginBottom: '0',
            textAlign: 'justify',
                backgroundColor: hasPendingEdit ? '#fee2e2' : isHighlighted ? '#fef3c7' : 'transparent',
                    padding: (hasPendingEdit || isHighlighted) ? '2px 4px' : '0',
                        borderRadius: (hasPendingEdit || isHighlighted) ? '2px' : '0',
        }
} {...props }>
{
    React.Children.map(children, (child) => {
        if (typeof child === 'string') {
            const parts = child.split(/(\[\^\d+\])/g)
            return parts.map((part, index) => {
                const match = part.match(/\[\^(\d+)\]/)
                if (match) {
                    const num = parseInt(match[1], 10)
                    const pdfUrl = footnotePdfUrls[num]
                    const hasPdf = !!pdfUrl

                    return (
                        <span key= { index } className = "group relative inline-block" >
                            <sup style={
                                {
                                    fontSize: '0.7em',
                                        verticalAlign: 'super',
                                            marginRight: '1px',
                                                cursor: hasPdf ? 'pointer' : 'default',
                                                    color: hasPdf ? '#2563eb' : 'inherit',
                                                        fontWeight: hasPdf ? 'bold' : 'normal',
                      }
                    }
                    onClick = {(e) => {
                        if (hasPdf && pdfUrl) {
                            e.stopPropagation()
                            window.open(pdfUrl, '_blank')
                        }
                    }
                }
                      >
                    { num }
                    </sup>
                    </span>
                  )
        }
        return part
    })
}
return child
          })}
</p>
      )
    },
li: ({ node, ...props }: any) => (
    <li style= {{ marginBottom: '4mm' }} {...props } />
    ),
blockquote: ({ node, ...props }: any) => (
    <blockquote style= {{
    borderLeft: '4px solid #e0e0e0',
        paddingLeft: '5mm',
            marginLeft: '0',
                marginRight: '0',
                    fontStyle: 'italic',
                        color: '#555',
      }} {...props } />
    )
  }), [thesis, content, bibliographySources, highlightedPassages, pendingEdit])
