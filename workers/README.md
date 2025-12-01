# Thesis Generation Worker

A BullMQ-based background worker for thesis generation, deployed on Render.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Thesis Worker (Node.js)                   │
├─────────────────────────────────────────────────────────────┤
│  BullMQ Consumer ──► Research Pipeline ──► Python Bridge    │
│                            │                    │           │
│                            ▼                    ▼           │
│                      FileSearchStore      DSPy Pipelines    │
│                      (Google GenAI)       (Generation +     │
│                                           Humanization)     │
└─────────────────────────────────────────────────────────────┘
```

## Pipeline Phases

1. **Research Pipeline** (TypeScript)
   - Generate search queries per chapter
   - Query OpenAlex + Semantic Scholar
   - Deduplicate and enrich with Unpaywall
   - Rank sources by relevance
   - Download PDFs and upload to FileSearchStore

2. **Generation Pipeline** (Python/DSPy)
   - Generate thesis text using FileSearchStore RAG
   - Extract citation metadata
   - Validate word count and mandatory sources

3. **Humanization Pipeline** (Python/DSPy)
   - Rewrite text to sound more human
   - ZeroGPT loop until 70% human score

4. **Assembly** (TypeScript)
   - Build bibliography from citation metadata
   - Assemble final document with TOC

## Deployment on Render

### Using Docker (Recommended)

1. Create a new **Background Worker** on Render
2. Connect your GitHub repository
3. Set the root directory to `workers`
4. Render will auto-detect the Dockerfile

### Environment Variables

Set these in the Render dashboard:

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | ✅ | Redis connection URL (use `rediss://` for TLS) |
| `GEMINI_KEY` | ✅ | Google Gemini API key |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key |
| `OPENALEX_EMAIL` | ⚡ | Email for OpenAlex polite pool |
| `SEMANTIC_SCHOLAR_API_KEY` | ⚡ | Semantic Scholar API key |
| `ZEROGPT_API_KEY` | ⚡ | ZeroGPT API key |
| `OPENAI_API_KEY` | ⚡ | OpenAI API key (for embeddings) |

⚡ = Optional but recommended

## Local Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

## Project Structure

```
workers/
├── thesis-worker.ts       # Main BullMQ worker
├── lib/
│   ├── research-pipeline.ts   # Academic research functions
│   ├── python-bridge.ts       # Node.js ↔ Python bridge
│   ├── citation-builder.ts    # Bibliography formatting
│   └── thesis-assembler.ts    # Final document assembly
├── python/
│   ├── main.py               # Python entry point
│   ├── config.py             # Configuration
│   ├── modules/
│   │   ├── generator.py      # DSPy thesis generator
│   │   ├── humanizer.py      # DSPy humanizer
│   │   ├── citation_extractor.py
│   │   └── quality_checker.py
│   ├── pipelines/
│   │   ├── generation_pipeline.py
│   │   └── humanization_pipeline.py
│   ├── utils/
│   │   ├── gemini_client.py
│   │   └── zerogpt.py
│   └── requirements.txt
├── Dockerfile
├── package.json
├── tsconfig.json
└── render.yaml
```

## Monitoring

The worker logs progress to stdout. On Render, you can view logs in the dashboard.

Progress stages:
- `research` - Academic database search and PDF upload
- `generation` - AI thesis generation
- `humanization` - AI detection evasion
- `citations` - Bibliography formatting
- `assembly` - Final document assembly
- `saving` - Database update

