# Thesis Generation Protocol - Technical Documentation

## Overview

This document describes the complete protocol and workflow for the automated thesis generation system. The system uses AI-powered research, source discovery, content generation, and document management to create academic theses from user-provided topics and outlines.

## System Architecture

### Components

1. **Frontend (Next.js)**
   - User interface for thesis creation and management
   - Preview and editing interface with chat-based modifications
   - Export functionality (DOCX, LaTeX)
   - Real-time status polling

2. **Backend API (Next.js API Routes)**
   - Thesis CRUD operations
   - Job triggering and status checking
   - FileSearchStore creation
   - Thesis editing and versioning
   - Export generation

3. **Background Worker (Node.js/Express on Render)**
   - Long-running thesis generation tasks
   - Literature research and source discovery
   - PDF processing and upload
   - AI-powered content generation
   - Humanization and quality checks

4. **External Services**
   - **Supabase**: Database (PostgreSQL with pgvector for embeddings)
   - **Google Gemini API**: AI content generation (2.5 Pro, 2.5 Flash)
   - **Google FileSearchStore**: RAG (Retrieval-Augmented Generation) for source documents
   - **OpenAlex API**: Scholarly works database
   - **Semantic Scholar API**: Academic paper search
   - **Unpaywall API**: Open-access PDF discovery
   - **OpenAI API**: Text embeddings (optional, configurable)

## Complete Workflow

### Phase 1: Thesis Initialization

#### Step 1.1: User Input Collection
- User provides:
  - **Topic**: Main subject of the thesis
  - **Field**: Academic discipline (e.g., Informatik, BWL)
  - **Thesis Type**: Hausarbeit, Bachelorarbeit, Masterarbeit, Dissertation
  - **Research Question**: Optional, can be generated or provided
  - **Citation Style**: APA, Harvard, Deutsche Zitierweise, MLA
  - **Length**: Pages (min-max) or Words (minimum with 5% tolerance)
  - **Language**: German or English

#### Step 1.2: Outline Generation
- If user doesn't upload an outline:
  - AI (Gemini 2.5 Pro) generates outline based on:
    - Topic and research question
    - Thesis type and length
    - Language
    - Detail level appropriate for length (prevents over-detailed outlines for short theses)
- Outline structure: Hierarchical JSON with chapters, sections, subsections
- Outline stored in `theses.outline` (JSONB column)

#### Step 1.3: Source Upload (Optional)
- User can upload their own PDF sources
- Sources are:
  - Uploaded to Google FileSearchStore
  - Metadata extracted and stored in `theses.uploaded_sources`
  - Used in generation if sufficient count

#### Step 1.4: Thesis Record Creation
- Thesis record created in Supabase `theses` table with status `'draft'`
- FileSearchStore created if not exists (one per thesis)
- FileSearchStore ID stored in `theses.file_search_store_id`

### Phase 2: Thesis Generation Trigger

#### Step 2.1: API Call to Start Generation
- Frontend calls `/api/start-thesis-generation` with `thesisId`
- API:
  - Validates thesis exists and has outline
  - Creates FileSearchStore if missing
  - Updates thesis status to `'generating'`
  - Sends job request to background worker

#### Step 2.2: Worker Job Creation
- Worker receives POST to `/jobs/thesis-generation`
- Validates Bearer token (`THESIS_WORKER_API_KEY`)
- Creates job record (in-memory or database)
- Returns `jobId` to frontend
- Starts async `processThesisGeneration()` function

### Phase 3: Literature Research (Conditional)

#### Pre-Check: Existing Sources
- Worker checks:
  - FileSearchStore document count
  - Database `uploaded_sources` count
  - Required source count (calculated: `min(50, max(10, ceil(pages * 1.25)))`)
- **If sufficient sources exist**: Skip Steps 1-6, proceed to Step 7
- **If insufficient**: Load existing sources, calculate additional needed, proceed with research

#### Step 3.1: Search Query Generation
- For each chapter in outline:
  - Generate 2 search queries in thesis language (German/English)
  - Generate 2 search queries in English (for international sources)
  - Total: 4 queries per chapter
- Uses Gemini 2.5 Flash for efficiency
- Queries optimized for:
  - OpenAlex API format
  - Semantic Scholar API format
  - Academic relevance

#### Step 3.2: OpenAlex Query
- For each query:
  - Query OpenAlex API with:
    - Email: `moontoolsinc@proton.me` (for polite pool)
    - Sample size: 20 results per query
    - Prioritize sources with DOI
  - Extract metadata:
    - Title, authors, year, journal, publisher
    - DOI, abstract
    - PDF URL (if available)
    - OpenAlex ID
  - Rate limiting: 200ms delay between queries
  - Retry: 3 attempts with exponential backoff

#### Step 3.3: Semantic Scholar Query
- For each query:
  - Query Semantic Scholar API
    - Limit to open-access PDFs if possible
    - Top 10 results per query
    - Require DOI
  - Extract similar metadata
  - Rate limiting: 200ms delay
  - Retry: 3 attempts

#### Step 3.4: Source Deduplication
- Combine all sources from both APIs
- Deduplicate by:
  - DOI (primary)
  - Title similarity
  - Author + year matching
- Prioritize sources with:
  1. Direct PDF URL
  2. DOI (for Unpaywall lookup)
  3. Complete metadata

#### Step 3.5: Unpaywall Enrichment
- For sources with DOI but no PDF:
  - Query Unpaywall API with email parameter
  - Retrieve open-access PDF URL if available
  - Update source metadata

#### Step 3.6: Relevance Ranking
- Batch process sources (50 at a time, max 350 total)
- For each batch:
  - Send to Gemini 2.5 Flash with:
    - Thesis context (topic, research question, outline)
    - Source metadata
    - Request relevance score (0-100)
  - Filter: Remove sources with score < 40
- Sort by relevance score (descending)

#### Step 3.7: Source Selection
- Select top N sources (scaled by thesis length, max 50)
- Algorithm ensures:
  - At least 2 sources per chapter-based query
  - Chapter relevance tracked in metadata
  - Prioritize sources with PDF URLs

### Phase 4: PDF Processing and Upload

#### Step 4.1: PDF Download
- For each selected source:
  - Download PDF from URL
  - Validate PDF format
  - Check file size (reasonable limits)
  - Retry: 3 attempts with exponential backoff

#### Step 4.2: Page Number Extraction
- Use Gemini 2.5 Flash to extract:
  - Total page count
  - Page ranges for citations
- Fallback: Estimate from PDF file size if extraction fails

#### Step 4.3: Metadata Extraction
- Extract citation metadata from PDF:
  - Title, authors, year
  - Journal, publisher
  - DOI, abstract
  - Page numbers (start, end, total)
- Use Gemini 2.5 Flash for extraction

#### Step 4.4: FileSearchStore Upload
- Upload PDF to Google FileSearchStore
- Store metadata in `theses.uploaded_sources`:
  ```json
  {
    "title": "...",
    "authors": [...],
    "year": 2021,
    "journal": "...",
    "publisher": "...",
    "doi": "...",
    "abstract": "...",
    "pageStart": 1,
    "pageEnd": 25,
    "pages": 25,
    "pdf_url": "...",
    "chapterTitle": "...",
    "chapterNumber": "..."
  }
  ```

#### Step 4.5: Paywall Handling
- If PDF is paywalled or inaccessible:
  - Remove from list
  - Replace with next best source from ranked list
  - Prioritize:
    1. Sources from same chapter
    2. Higher relevance score
  - Retry until sufficient sources uploaded

#### Step 4.6: Upload Completion
- Track successfully uploaded sources
- Stop when target count reached (existing + new)
- Log statistics: uploaded count, failed count, replaced count

### Phase 5: Content Generation

#### Step 5.1: RAG Context Preparation
- Query FileSearchStore with:
  - Thesis topic and research question
  - Chapter-specific queries
  - Relevant source metadata
- Retrieve relevant document chunks for context

#### Step 5.2: Thesis Generation Prompt
- Comprehensive system prompt includes:
  - **Research Context**: AI is the researcher, sources are self-selected
  - **Forbidden Elements**: No tables, images, AI limitation mentions
  - **Citation Requirements**: All citations must include page numbers
  - **Completeness**: Must complete all chapters, reach target length
  - **Bibliography**: Only cited sources, must exist and not be empty
  - **Language**: Strict adherence to selected language
  - **Citation Style**: Detailed formatting rules per style
  - **Human-like Writing**: Instructions to avoid AI detection patterns

#### Step 5.3: Gemini 2.5 Pro Generation
- Model: `gemini-2.5-pro`
- Token limit: 1,000,000 tokens (with 50% buffer)
- Temperature: 0.7 (balanced creativity/consistency)
- Output: Complete thesis in Markdown format
- Structure:
  - All chapters from outline
  - Introduction, main content, conclusion
  - Bibliography (only cited sources)
  - Footnotes (for German citation style)

#### Step 5.4: Generation Validation
- Check:
  - Word count >= 95% of target (lenient)
  - All chapters present (or 50% if word count met)
  - Bibliography exists and not empty
  - Footnotes present (if German citation style)
- If incomplete: Retry with enhanced prompt (2 retries, same config)
- **No fallback to inferior models** - strict requirement

#### Step 5.5: Humanization
- Pass generated content through Gemini 2.5 Flash
- Humanization prompt includes:
  - Sentence burstiness and perplexity
  - Syntax variation
  - Natural academic hedging
  - Avoiding AI discourse markers
  - Preserving all facts, citations, structure
- Verification: Check citations preserved after humanization
- If citations lost: Return original content

#### Step 5.6: Footnote Processing (German Citation Style)
- Extract footnotes from markdown format: `[^N]: citation`
- Process sequential numbering:
  - Each citation occurrence gets next sequential number (1, 2, 3...)
  - Same source cited multiple times = multiple footnotes
  - Replace `[^N]` with `^N` in text
- Store footnotes in `thesis.metadata.footnotes`:
  ```json
  {
    "1": "Author, A. (2021). Title. Journal, S. 14.",
    "2": "..."
  }
  ```

### Phase 6: Storage and Indexing

#### Step 6.1: Database Update
- Update `theses` table:
  - `latex_content`: Generated Markdown content
  - `status`: `'completed'`
  - `completed_at`: Timestamp
  - `metadata.footnotes`: Footnote data (if German citation)
  - `metadata.zerogpt`: ZeroGPT result (if checked)

#### Step 6.2: Vector Database Chunking
- Split thesis content into paragraphs
- Generate embeddings (OpenAI `text-embedding-ada-002` or configurable)
- Store in `thesis_paragraphs` table:
  - `thesis_id`: Foreign key
  - `content`: Paragraph text
  - `embedding`: Vector embedding (pgvector)
  - `paragraph_index`: Order in document
  - `chapter_title`: Chapter context

#### Step 6.3: Email Notification
- Database trigger fires on status change to `'completed'`
- Supabase Edge Function sends email via Resend API
- Email includes:
  - Thesis title
  - Completion notification
  - Link to preview page

### Phase 7: User Interaction

#### Step 7.1: Preview Interface
- Split-view layout:
  - Left: Chat interface for modifications
  - Right: Formatted thesis preview (LaTeX-style)
- Features:
  - Scrollable content (fixed sidebar)
  - Word counter
  - Text selection with "Add to Chat" button
  - Source list (bibliography sources only)
  - Version history

#### Step 7.2: Text Selection and Editing
- User selects text in preview
- "Add to Chat" button appears
- Selected text added to chat context (purple box)
- User provides modification request
- AI (Gemini 2.5 Pro) edits:
  - Only selected text + 500 chars context
  - Returns edited segment only
  - Follows citation style strictly

#### Step 7.3: Diff Preview
- Old text: Red background, strikethrough
- New text: Green background
- Inline approve/reject buttons
- Related passages highlighted (yellow) via semantic search

#### Step 7.4: Versioning
- On "Save" (`/api/save-thesis`):
  - Create new version in `thesis_versions` table
  - Store: `content`, `version_number`, `created_at`
  - Update `theses.latex_content`
  - Update vector DB chunks for modified paragraphs
- Version rollback:
  - `/api/rollback-thesis` restores previous version
  - Updates content and embeddings

#### Step 7.5: Semantic Search for Related Passages
- When AI edit is proposed:
  - Generate embedding for edited text
  - Query `thesis_paragraphs` for similar embeddings
  - Highlight related passages in yellow
  - Helps user identify affected content

### Phase 8: Export

#### Step 8.1: DOCX Export
- API: `/api/export-thesis-doc`
- Uses `docx` library
- Features:
  - Table of Contents (from outline JSON)
  - Hierarchical heading styles
  - Footnotes section (German citation style)
  - Bibliography
  - 1.5 line spacing
  - Page breaks between chapters
  - Page numbering

#### Step 8.2: LaTeX Export
- API: `/api/export-thesis-latex`
- Converts Markdown to LaTeX
- Features:
  - Document class: `article`
  - Packages: `inputenc`, `fontenc`, `babel`, `geometry`, `setspace`, `fancyhdr`, `titlesec`, `hyperref`, `footmisc`
  - Cover page with title
  - Table of Contents (from outline JSON)
  - Proper LaTeX command escaping
  - Math block handling (`$$...$$`, `$...$`)
  - HTML tag conversion (`<sub>`, `<sup>`, etc.)
  - Footnote processing (German citation style)
  - Bibliography extraction
  - Balanced brace validation

## Data Flow

### Request Flow
```
User Input → Frontend → Next.js API → Background Worker → External APIs
                                                          ↓
User Preview ← Frontend ← Next.js API ← Background Worker ← Database
```

### Source Research Flow
```
Outline → Query Generation → OpenAlex/Semantic Scholar → Deduplication
                                                              ↓
PDF Upload ← FileSearchStore ← PDF Download ← Ranking ← Unpaywall
```

### Content Generation Flow
```
FileSearchStore (RAG) → Gemini 2.5 Pro → Humanization → Validation
                                                              ↓
Database ← Vector DB ← Chunking ← Footnotes ← Content
```

## API Endpoints

### Frontend API Routes

- `POST /api/start-thesis-generation`: Trigger thesis generation
- `GET /api/thesis-status`: Check generation status
- `POST /api/edit-thesis`: AI-powered text editing
- `POST /api/save-thesis`: Save thesis version
- `POST /api/rollback-thesis`: Restore previous version
- `POST /api/update-thesis-embeddings`: Update vector DB chunks
- `POST /api/find-related-passages`: Semantic search for related text
- `POST /api/export-thesis-doc`: Export to DOCX
- `POST /api/export-thesis-latex`: Export to LaTeX
- `POST /api/check-zerogpt`: Check AI detection score

### Worker API Routes

- `POST /jobs/thesis-generation`: Start generation job
- `GET /jobs/:thesisId`: Get job status
- Authentication: Bearer token (`THESIS_WORKER_API_KEY`)

## Error Handling and Retries

### Retry Strategy
- **Generic API Calls**: 3 retries with exponential backoff (2s, 4s, 8s)
- **Critical Steps**: 2 retries with same configuration (no fallback)
- **Rate Limiting**: 200ms delay between API calls

### Error Recovery
- **PDF Download Failure**: Replace with next best source
- **Generation Incomplete**: Retry with enhanced prompt (2x)
- **Citation Loss in Humanization**: Return original content
- **Worker Failure**: Status reverted to `'draft'`, user notified

## Database Schema

### `theses` Table
- `id`: UUID (primary key)
- `user_id`: UUID (foreign key to users)
- `title`: Text
- `topic`: Text
- `field`: Text
- `thesis_type`: Enum (hausarbeit, bachelorarbeit, masterarbeit, dissertation)
- `research_question`: Text
- `citation_style`: Enum (apa, harvard, deutsche-zitierweise, mla)
- `target_length`: Integer
- `length_unit`: Enum (pages, words)
- `outline`: JSONB (hierarchical structure)
- `latex_content`: Text (Markdown)
- `status`: Enum (draft, generating, completed)
- `file_search_store_id`: Text
- `uploaded_sources`: JSONB (array of source metadata)
- `metadata`: JSONB (footnotes, zerogpt, etc.)
- `created_at`, `updated_at`, `completed_at`: Timestamps

### `thesis_paragraphs` Table
- `id`: UUID (primary key)
- `thesis_id`: UUID (foreign key)
- `content`: Text
- `embedding`: Vector (pgvector)
- `paragraph_index`: Integer
- `chapter_title`: Text

### `thesis_versions` Table
- `id`: UUID (primary key)
- `thesis_id`: UUID (foreign key)
- `version_number`: Integer
- `content`: Text
- `created_at`: Timestamp

## Configuration and Environment Variables

### Frontend/API
- `GEMINI_KEY`: Google Gemini API key
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `THESIS_WORKER_URL`: Background worker URL
- `THESIS_WORKER_API_KEY`: Worker authentication key
- `OPENAI_API_KEY`: OpenAI API key (for embeddings, optional)
- `RAPIDAPI_KEY`: RapidAPI key (for ZeroGPT)

### Worker
- `PORT`: Server port (default: 3001, Render uses 10000)
- `GEMINI_KEY`: Google Gemini API key
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `OPENALEX_EMAIL`: Email for OpenAlex polite pool
- `UNPAYWALL_EMAIL`: Email for Unpaywall API
- `SEMANTIC_SCHOLAR_API_KEY`: Optional, for higher rate limits

## Security Considerations

1. **Authentication**: Bearer token for worker API
2. **RLS (Row Level Security)**: Supabase RLS policies for user data isolation
3. **API Key Management**: Environment variables, never in code
4. **Input Validation**: All user inputs validated before processing
5. **Rate Limiting**: Built-in delays to respect API limits

## Performance Optimizations

1. **Batch Processing**: Sources ranked in batches of 50
2. **Concurrent Processing**: Multiple theses can be processed (with limits)
3. **Caching**: FileSearchStore documents reused across generations
4. **Efficient Embeddings**: Chunked storage for semantic search
5. **Selective Updates**: Only modified paragraphs re-embedded

## Future Enhancements

1. **Concurrent Job Processing**: Queue system for multiple theses
2. **Advanced RAG**: Multi-query retrieval, reranking
3. **Citation Verification**: Automatic DOI validation
4. **Plagiarism Detection**: Integration with detection services
5. **Multi-language Support**: Extended language options
6. **Collaborative Editing**: Multiple users editing same thesis

## Troubleshooting

### Common Issues

1. **"Thesis not found"**: Ensure thesis is saved before starting generation
2. **"Failed to create FileSearchStore"**: Check GEMINI_KEY configuration
3. **"Invalid API key"**: Verify THESIS_WORKER_API_KEY matches worker config
4. **Generation stuck**: Check worker logs, may be rate-limited
5. **Incomplete generation**: Check token limits, may need to reduce length
6. **Missing footnotes**: Verify German citation style selected
7. **LaTeX compilation errors**: Check footnote formatting, brace balancing

### Debugging

- Worker logs: Detailed logging at each step
- Frontend console: API errors and status updates
- Supabase logs: Database queries and triggers
- FileSearchStore: Document count and status

---

**Last Updated**: 2025-01-XX
**Version**: 1.0
**Maintainer**: Development Team

