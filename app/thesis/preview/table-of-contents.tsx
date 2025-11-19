'use client'

import React from 'react'
import type { OutlineChapter } from '@/lib/supabase/types'

interface TableOfContentsProps {
  outline: OutlineChapter[]
  language?: 'german' | 'english'
}

export function TableOfContents({ outline, language = 'german' }: TableOfContentsProps) {
  if (!outline || outline.length === 0) {
    return null
  }

  const tocTitle = language === 'german' ? 'Inhaltsverzeichnis' : 'Table of Contents'

  // Calculate page numbers for each chapter (simplified - in real implementation, 
  // we'd need to track actual page positions)
  // For now, we'll just show the structure without page numbers
  // Page numbers can be added later based on actual content positions

  return (
    <div className="toc-section" style={{ marginBottom: '12mm' }}>
      <h2
        className="toc-heading"
        style={{
          fontSize: '16pt',
          fontWeight: 'bold',
          marginBottom: '8mm',
          marginTop: '0',
          textAlign: 'left',
          pageBreakAfter: 'auto',
        }}
      >
        {tocTitle}
      </h2>
      <ul
        className="toc-list"
        style={{
          marginBottom: '6mm',
          marginLeft: '0',
          paddingLeft: '0',
          fontSize: '12pt',
          listStyle: 'none',
          display: 'block',
        }}
      >
        {outline.map((chapter) => {
          // Main chapter (level 0)
          const chapterIndent = 0
          const chapterEntry = (
            <li
              key={`chapter-${chapter.number}`}
              className="toc-entry toc-entry-level-0"
              style={{
                marginBottom: '4mm',
                lineHeight: '1.6',
                listStyle: 'none',
                paddingLeft: '0',
                marginLeft: `${chapterIndent}mm`,
                fontSize: '12pt',
                display: 'block',
                breakInside: 'avoid',
                pageBreakInside: 'avoid',
              }}
            >
              <span style={{ fontWeight: 'bold' }}>
                {chapter.number} {chapter.title}
              </span>
            </li>
          )

          // Sections (level 1)
          const sectionEntries = chapter.sections.map((section) => {
            const sectionIndent = 8 // 8mm for level 1
            return (
              <li
                key={`section-${section.number}`}
                className="toc-entry toc-entry-level-1"
                style={{
                  marginBottom: '4mm',
                  lineHeight: '1.6',
                  listStyle: 'none',
                  paddingLeft: '0',
                  marginLeft: `${sectionIndent}mm`,
                  fontSize: '12pt',
                  display: 'block',
                  breakInside: 'avoid',
                  pageBreakInside: 'avoid',
                }}
              >
                <span style={{ fontWeight: 'normal' }}>
                  {section.number} {section.title}
                </span>
              </li>
            )
          })

          // Subsections (level 2)
          const subsectionEntries = chapter.sections.flatMap((section) =>
            section.subsections.map((subsection) => {
              const subsectionIndent = 16 // 16mm for level 2
              return (
                <li
                  key={`subsection-${subsection.number}`}
                  className="toc-entry toc-entry-level-2"
                  style={{
                    marginBottom: '4mm',
                    lineHeight: '1.6',
                    listStyle: 'none',
                    paddingLeft: '0',
                    marginLeft: `${subsectionIndent}mm`,
                    fontSize: '12pt',
                    display: 'block',
                    breakInside: 'avoid',
                    pageBreakInside: 'avoid',
                  }}
                >
                  <span style={{ fontWeight: 'normal' }}>
                    {subsection.number} {subsection.title}
                  </span>
                </li>
              )
            })
          )

          return (
            <React.Fragment key={chapter.number}>
              {chapterEntry}
              {sectionEntries}
              {subsectionEntries}
            </React.Fragment>
          )
        })}
      </ul>
    </div>
  )
}

