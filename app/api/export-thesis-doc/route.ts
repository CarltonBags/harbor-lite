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

    // 2. Prepare Pandoc Input
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
    const referenceDocPath = path.join(tmpDir, `reference-${timestamp}.docx`)

    try {
      await createReferenceDocument(referenceDocPath)
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
        if (fs.existsSync(referenceDocPath)) await unlink(referenceDocPath)
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
      ],
    },
    sections: [{ children: [new Paragraph("Reference")] }],
  })

  const buffer = await Packer.toBuffer(doc)
  await writeFile(path, buffer)
}
