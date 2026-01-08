import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/client'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { promisify } from 'util'
import { Document, Packer, Paragraph, HeadingLevel, AlignmentType } from 'docx'

const writeFile = promisify(fs.writeFile)
const readFile = promisify(fs.readFile)
const unlink = promisify(fs.unlink)

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { thesisId } = body

    if (!thesisId) {
      return NextResponse.json({ error: 'Missing thesisId' }, { status: 400 })
    }

    const supabase = createSupabaseServerClient()
    const { data: thesis, error: thesisError } = await supabase
      .from('theses')
      .select('*')
      .eq('id', thesisId)
      .single()

    if (thesisError || !thesis) {
      return NextResponse.json({ error: 'Thesis not found' }, { status: 404 })
    }

    // 1. Regenerate Clean Markdown
    // We use the updated logic in markdown-utils.ts which now:
    // - Removes the title from body
    // - Uses correct levels (# 1. Einleitung)
    // - Handles fake headings
    let content = ''
    if (thesis.latex_content) {
      console.log('[ExportDOCX] Regenerating clean markdown...')
      const { convertToCleanMarkdown } = await import('@/lib/markdown-utils')
      content = convertToCleanMarkdown(thesis.latex_content)
    } else {
      content = thesis.clean_markdown_content || ''
    }

    if (!content) {
      return NextResponse.json({ error: 'Thesis content is empty' }, { status: 400 })
    }

    // 2. Generate Bibliography from uploaded_sources if not already present
    const hasExistingBibliography = /^#{1,2}\s*(Literaturverzeichnis|Bibliography|References)/mi.test(content)

    if (!hasExistingBibliography && thesis.uploaded_sources && thesis.uploaded_sources.length > 0) {
      console.log('[ExportDOCX] Generating bibliography from uploaded_sources...')
      const bibliography = generateBibliography(thesis.uploaded_sources, thesis.citation_style || 'apa')
      content = content + '\n\n' + bibliography
      console.log(`[ExportDOCX] Added bibliography with ${thesis.uploaded_sources.length} sources`)
    }

    // 3. Prepare Pandoc Input
    // Add YAML frontmatter
    const title = thesis.title || thesis.topic || 'Thesis'
    const date = new Date().toLocaleDateString('de-DE')

    const yamlHeader = `---
title: "${title.replace(/"/g, '\\"')}"
date: "${date}"
lang: de-DE
toc-title: "Inhaltsverzeichnis"
---

`
    // Add page break after TOC
    const pandocContent = yamlHeader + '\\newpage\n\n' + content

    // 3. Create Reference Document for Styles
    const tmpDir = os.tmpdir()
    const timestamp = Date.now()
    const inputPath = path.join(tmpDir, `thesis-${thesisId}-${timestamp}.md`)
    const outputPath = path.join(tmpDir, `thesis-${thesisId}-${timestamp}.docx`)

    // Check for custom reference.docx in project root
    const customReferencePath = path.join(process.cwd(), 'reference.docx')
    const hasCustomReference = fs.existsSync(customReferencePath)

    const referenceDocPath = hasCustomReference
      ? customReferencePath
      : path.join(tmpDir, `reference-${timestamp}.docx`)

    try {
      // Only create default reference doc if we don't have a custom one
      if (!hasCustomReference) {
        console.log('[ExportDOCX] Generating default reference document...')
        await createReferenceDocument(referenceDocPath)
      } else {
        console.log('[ExportDOCX] Using custom reference.docx from project root')
      }

      await writeFile(inputPath, pandocContent, 'utf8')

      // 4. Run Pandoc (Markdown -> DOCX)
      let pandocPath = 'pandoc'
      const localPandocPath = path.join(process.cwd(), 'node_modules', 'pandoc-binary', '2.14.0.2', 'darwin', 'pandoc')
      if (fs.existsSync(localPandocPath)) {
        pandocPath = localPandocPath
      }

      console.log(`[ExportDOCX] Converting Markdown to DOCX using ${pandocPath}`)

      await new Promise<void>((resolve, reject) => {
        const pandoc = spawn(pandocPath, [
          inputPath,
          '-o', outputPath,
          '--from', 'markdown+footnotes', // Enable footnotes extension
          '--to', 'docx',
          '--toc',
          '--toc-depth=3',
          `--reference-doc=${referenceDocPath}`
        ])

        let stderr = ''
        pandoc.stderr.on('data', d => stderr += d.toString())

        pandoc.on('close', code => {
          if (code === 0) resolve()
          else reject(new Error(`Pandoc failed: ${stderr}`))
        })
      })

      const buffer = await readFile(outputPath)

      return new NextResponse(buffer, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename="${(thesis.title || 'thesis').replace(/[^a-z0-9]/gi, '_')}.docx"`,
        },
      })

    } finally {
      try {
        if (fs.existsSync(inputPath)) await unlink(inputPath)
        if (fs.existsSync(outputPath)) await unlink(outputPath)
        // Only delete reference doc if it's the temp one
        if (!hasCustomReference && fs.existsSync(referenceDocPath)) await unlink(referenceDocPath)
      } catch (e) {
        console.error('Cleanup error:', e)
      }
    }

  } catch (error) {
    console.error('[ExportDOCX] Error:', error)
    return NextResponse.json({ error: 'Failed to export' }, { status: 500 })
  }
}

// Strict Reference Document Generation
async function createReferenceDocument(path: string) {
  const doc = new Document({
    styles: {
      paragraphStyles: [
        {
          id: 'Normal',
          name: 'Normal',
          run: {
            font: 'Times New Roman',
            size: 24, // 12pt
            color: '000000',
            bold: false,
          },
          paragraph: {
            spacing: { line: 360 }, // 1.5 spacing
            alignment: AlignmentType.JUSTIFIED,
            outlineLevel: undefined, // CRITICAL: No TOC entry for body text
          },
        },
        {
          id: 'BodyText',
          name: 'Body Text',
          basedOn: 'Normal',
          next: 'Normal',
          run: {
            font: 'Times New Roman',
            size: 24, // 12pt
            color: '000000',
            bold: false,
          },
          paragraph: {
            spacing: { line: 360 },
            alignment: AlignmentType.JUSTIFIED,
            outlineLevel: undefined,
          },
        },
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          run: {
            font: 'Times New Roman',
            size: 32, // 16pt
            bold: true,
            color: '000000',
          },
          paragraph: {
            spacing: { before: 480, after: 240 },
            outlineLevel: 0,
          },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          run: {
            font: 'Times New Roman',
            size: 28, // 14pt
            bold: true,
            color: '000000',
          },
          paragraph: {
            spacing: { before: 360, after: 180 },
            outlineLevel: 1,
          },
        },
        {
          id: 'Heading3',
          name: 'Heading 3',
          basedOn: 'Normal',
          next: 'Normal',
          run: {
            font: 'Times New Roman',
            size: 24, // 12pt
            bold: true,
            color: '000000',
          },
          paragraph: {
            spacing: { before: 240, after: 120 },
            outlineLevel: 2,
          },
        },
        {
          id: 'FootnoteText',
          name: 'Footnote Text',
          basedOn: 'Normal',
          run: {
            font: 'Times New Roman',
            size: 20, // 10pt
          },
          paragraph: {
            spacing: { line: 240 }, // Single spacing
          },
        },
        // TOC Styles - prevent weird formatting in table of contents
        {
          id: 'TOC1',
          name: 'toc 1',
          basedOn: 'Normal',
          run: {
            font: 'Times New Roman',
            size: 24, // 12pt
            bold: true,
          },
          paragraph: {
            spacing: { before: 120, after: 60 },
          },
        },
        {
          id: 'TOC2',
          name: 'toc 2',
          basedOn: 'Normal',
          run: {
            font: 'Times New Roman',
            size: 24, // 12pt
            bold: false,
          },
          paragraph: {
            spacing: { before: 60, after: 30 },
            indent: { left: 240 }, // Indent sub-entries
          },
        },
        {
          id: 'TOC3',
          name: 'toc 3',
          basedOn: 'Normal',
          run: {
            font: 'Times New Roman',
            size: 24, // 12pt
            bold: false,
          },
          paragraph: {
            spacing: { before: 30, after: 30 },
            indent: { left: 480 }, // More indent for sub-sub
          },
        },
        // First Paragraph style - no extra spacing after heading
        {
          id: 'FirstParagraph',
          name: 'First Paragraph',
          basedOn: 'Normal',
          run: {
            font: 'Times New Roman',
            size: 24,
            bold: false,
          },
          paragraph: {
            spacing: { line: 360 },
            alignment: AlignmentType.JUSTIFIED,
          },
        },
      ],
    },
    sections: [{ children: [new Paragraph("Reference")] }],
  })

  const buffer = await Packer.toBuffer(doc)
  await writeFile(path, buffer)
}

// Generate bibliography markdown from uploaded sources
function generateBibliography(sources: any[], citationStyle: string): string {
  if (!sources || sources.length === 0) return ''

  // Sort sources alphabetically by first author's last name
  const sortedSources = [...sources].sort((a, b) => {
    const authorA = getFirstAuthorLastName(a)
    const authorB = getFirstAuthorLastName(b)
    return authorA.localeCompare(authorB, 'de')
  })

  const entries = sortedSources.map(source => formatBibliographyEntry(source, citationStyle))

  // Choose heading based on language (default German)
  const heading = '# Literaturverzeichnis\n\n'

  // Join with blank line between each source for visual separation
  return heading + entries.join('\n\n\n')
}

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

function formatBibliographyEntry(source: any, citationStyle: string): string {
  const title = source.title || source.metadata?.title || 'Ohne Titel'
  const authors = formatAuthors(source.metadata?.authors || source.authors || [])
  const year = source.metadata?.year || source.year || 'o.J.'
  const journal = source.metadata?.venue || source.journal || ''
  const doi = source.doi || ''
  const pages = source.metadata?.pages || ''

  switch (citationStyle) {
    case 'deutsche-zitierweise':
      // German style: Author(s): Title. In: Journal (Year), S. Pages.
      let deEntry = `${authors}: ${title}.`
      if (journal) deEntry += ` In: *${journal}*`
      deEntry += ` (${year})`
      if (pages) deEntry += `, S. ${pages}`
      deEntry += '.'
      if (doi) deEntry += ` DOI: ${doi}`
      return deEntry

    case 'harvard':
      // Harvard: Author(s) (Year) Title. Journal, pages.
      let harvardEntry = `${authors} (${year}) ${title}.`
      if (journal) harvardEntry += ` *${journal}*`
      if (pages) harvardEntry += `, ${pages}`
      harvardEntry += '.'
      if (doi) harvardEntry += ` DOI: ${doi}`
      return harvardEntry

    case 'mla':
      // MLA: Author(s). "Title." Journal, Year, pages.
      let mlaEntry = `${authors}. "${title}."`
      if (journal) mlaEntry += ` *${journal}*,`
      mlaEntry += ` ${year}`
      if (pages) mlaEntry += `, ${pages}`
      mlaEntry += '.'
      if (doi) mlaEntry += ` DOI: ${doi}`
      return mlaEntry

    case 'apa':
    default:
      // APA: Author(s) (Year). Title. Journal, pages. DOI
      let apaEntry = `${authors} (${year}). ${title}.`
      if (journal) apaEntry += ` *${journal}*`
      if (pages) apaEntry += `, ${pages}`
      apaEntry += '.'
      if (doi) apaEntry += ` https://doi.org/${doi}`
      return apaEntry
  }
}

function formatAuthors(authors: any): string {
  if (!authors) return 'Unbekannt'

  if (typeof authors === 'string') {
    return authors
  }

  if (Array.isArray(authors)) {
    if (authors.length === 0) return 'Unbekannt'
    if (authors.length === 1) return String(authors[0])
    if (authors.length === 2) return `${authors[0]} & ${authors[1]}`
    // 3+ authors: First author et al.
    return `${authors[0]} et al.`
  }

  return 'Unbekannt'
}
