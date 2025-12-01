interface OutlineSection {
    number: string
    title: string
    subsections?: OutlineSection[]
}

interface OutlineChapter {
    number: string
    title: string
    sections: OutlineSection[]
}

export class ThesisAssembler {
    assemble(components: {
        outline: OutlineChapter[]
        mainText: string
        bibliography: string
        metadata: {
            title: string
            author?: string
            date?: string
        }
    }): string {
        // 1. Build Inhaltsverzeichnis
        const toc = this.buildTableOfContents(components.outline)

        // 2. Combine components
        // Add title page or header if needed, but usually just the content
        // Markdown format

        const thesis = `
# ${components.metadata.title}

## Inhaltsverzeichnis

${toc}

<div style="page-break-after: always;"></div>

${components.mainText}

<div style="page-break-after: always;"></div>

## Literaturverzeichnis

${components.bibliography}
`
        return thesis
    }

    private buildTableOfContents(outline: OutlineChapter[]): string {
        let toc = ''

        for (const chapter of outline) {
            toc += `- **${chapter.number} ${chapter.title}**\n`

            if (chapter.sections) {
                for (const section of chapter.sections) {
                    toc += `  - ${section.number} ${section.title}\n`

                    if (section.subsections) {
                        for (const sub of section.subsections) {
                            toc += `    - ${sub.number} ${sub.title}\n`
                        }
                    }
                }
            }
        }

        return toc
    }
}
