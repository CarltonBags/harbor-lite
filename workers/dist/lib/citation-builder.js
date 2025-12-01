"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CitationBuilder = void 0;
class CitationBuilder {
    buildBibliography(citations, style) {
        // Deduplicate citations based on ID or Title
        const uniqueCitations = this.deduplicateCitations(citations);
        // Sort alphabetically by first author
        uniqueCitations.sort((a, b) => {
            const authorA = (a.authors[0] || '').toLowerCase();
            const authorB = (b.authors[0] || '').toLowerCase();
            return authorA.localeCompare(authorB);
        });
        switch (style) {
            case 'apa':
                return this.buildAPA(uniqueCitations);
            case 'harvard':
                return this.buildHarvard(uniqueCitations);
            case 'mla':
                return this.buildMLA(uniqueCitations);
            case 'deutsche-zitierweise':
                return this.buildDeutsche(uniqueCitations);
            default:
                // Default to APA if unknown
                return this.buildAPA(uniqueCitations);
        }
    }
    deduplicateCitations(citations) {
        const seen = new Set();
        const unique = [];
        for (const cit of citations) {
            // Create a unique key
            const key = `${cit.title?.toLowerCase()}-${cit.year}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(cit);
            }
        }
        return unique;
    }
    formatAuthors(authors, style) {
        if (!authors || authors.length === 0)
            return 'Unknown Author';
        if (style === 'apa') {
            // Smith, J. D., & Doe, J.
            return authors.join(', ');
        }
        else if (style === 'mla') {
            if (authors.length > 2)
                return `${authors[0]}, et al.`;
            return authors.join(' and ');
        }
        else {
            return authors.join(', ');
        }
    }
    buildAPA(citations) {
        return citations.map(c => {
            const authors = this.formatAuthors(c.authors, 'apa');
            const year = c.year ? `(${c.year})` : '(n.d.)';
            const title = c.title ? `*${c.title}*` : '';
            const source = c.journal || c.publisher || '';
            const doi = c.doi ? ` https://doi.org/${c.doi}` : '';
            return `${authors} ${year}. ${title}. ${source}.${doi}`;
        }).join('\n\n');
    }
    buildHarvard(citations) {
        return citations.map(c => {
            const authors = this.formatAuthors(c.authors, 'harvard');
            const year = c.year ? `${c.year}` : 'n.d.';
            const title = c.title ? `'${c.title}'` : '';
            const source = c.journal ? `*${c.journal}*` : c.publisher || '';
            return `${authors} (${year}) ${title}, ${source}.`;
        }).join('\n\n');
    }
    buildMLA(citations) {
        return citations.map(c => {
            const authors = this.formatAuthors(c.authors, 'mla');
            const title = c.title ? `"${c.title}."` : '';
            const container = c.journal ? `*${c.journal}*` : c.publisher || '';
            const year = c.year ? `${c.year}` : 'n.d.';
            return `${authors} ${title} ${container}, ${year}.`;
        }).join('\n\n');
    }
    buildDeutsche(citations) {
        return citations.map(c => {
            const authors = this.formatAuthors(c.authors, 'deutsche');
            const title = c.title ? `${c.title}` : '';
            const source = c.journal || c.publisher || '';
            const year = c.year ? `${c.year}` : 'o.J.';
            return `${authors}: ${title}, ${source} ${year}.`;
        }).join('\n\n');
    }
}
exports.CitationBuilder = CitationBuilder;
