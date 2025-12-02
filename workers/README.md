# Thesis Generation Worker

This worker handles the complete thesis generation pipeline:

1. **Research Pipeline**
   - Generate search queries (German + English)
   - Query OpenAlex API
   - Query Semantic Scholar API
   - Deduplicate and prioritize sources with PDF URLs
   - Rank sources by relevance using Gemini
   - Download PDFs and upload to Google FileSearchStore

2. **Content Generation**
   - Generate thesis content using Gemini Pro with FileSearchStore RAG
   - Per-chapter generation for better quality control
   - Automatic content extension if below target word count

3. **Post-Processing**
   - ZeroGPT AI detection check
   - Humanization loop until 70%+ human score
   - Footnote extraction for German citation style

## Environment Variables

Required:
- `GEMINI_KEY` - Google Gemini API key
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `THESIS_WORKER_API_KEY` - API key for worker authentication

Optional:
- `OPENALEX_EMAIL` - Email for OpenAlex API (higher rate limits)
- `RAPIDAPI_KEY` - RapidAPI key for ZeroGPT
- `OPENAI_API_KEY` - OpenAI API key for embeddings

## Deployment

### Render (Recommended)

1. Create a new Web Service on Render
2. Connect your GitHub repository
3. Set the root directory to `/workers`
4. Set environment variables
5. Deploy

### Local Development

```bash
cd workers
npm install
npm run dev
```

## API Endpoints

- `POST /jobs/thesis-generation` - Start thesis generation
- `GET /health` - Health check
- `GET /status/:thesisId` - Get thesis generation status

## Architecture

The worker is a standalone Express.js application that:
- Receives thesis generation requests via HTTP
- Uses Google Gemini with FileSearchStore for RAG-based generation
- Updates thesis status in Supabase
- Sends completion emails via database triggers
