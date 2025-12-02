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
        // Note: Inhaltsverzeichnis is NOT included here because:
        // 1. The preview page renders it from the outline JSON
        // 2. The LaTeX export generates it automatically
        // This prevents duplicate TOCs

        const thesis = `# ${components.metadata.title}

${components.mainText}

---

## Literaturverzeichnis

${components.bibliography}
`
        return thesis
    }
}
