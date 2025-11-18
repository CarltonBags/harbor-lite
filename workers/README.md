# Thesis Generation Worker

Background worker for processing thesis generation jobs. This worker handles:
1. Generating search queries (2 per chapter, German + English)
2. Querying OpenAlex API (with polite pool via email)
3. Querying Semantic Scholar API
4. Enriching sources with Unpaywall API to find PDF URLs (with email)
5. Deduplicating and prioritizing sources with PDF URLs
6. Ranking sources by relevance using Gemini
7. Downloading PDFs and uploading to Google FileSearchStore
8. Generating thesis content using Gemini Pro

## Deployment on Render

### Prerequisites
- Node.js 18+ environment
- Environment variables configured (see below)

### Environment Variables

Set these in your Render service:

```bash
# Required
GEMINI_KEY=your_gemini_api_key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
THESIS_WORKER_API_KEY=your_secure_api_key_for_authentication

# Optional
PORT=3001
OPENALEX_EMAIL=moontools@proton.me  # For polite pool (10x faster, 10 req/sec instead of 1)
SEMANTIC_SCHOLAR_API_KEY=your_semantic_scholar_key  # Optional but recommended
```

### Deploy Steps

1. **Create a new Web Service on Render**
   - Connect your repository
   - Root Directory: `workers`
   - Build Command: `npm install`
   - Start Command: `npm start`

2. **Set Environment Variables**
   - Add all required environment variables in Render dashboard

3. **Update Main App**
   - Set `THESIS_WORKER_URL` in your main app's environment variables
   - Set `THESIS_WORKER_API_KEY` to match the worker's API key

### Local Development

```bash
cd workers
npm install
npm run dev
```

The worker will start on `http://localhost:3001`

### API Endpoints

#### POST `/jobs/thesis-generation`
Triggers a thesis generation job.

**Headers:**
```
Authorization: Bearer <THESIS_WORKER_API_KEY>
Content-Type: application/json
```

**Body:**
```json
{
  "thesisId": "uuid",
  "thesisData": {
    "title": "Thesis Title",
    "topic": "Topic",
    "field": "Field",
    "thesisType": "master",
    "researchQuestion": "Research question",
    "citationStyle": "apa",
    "targetLength": 50,
    "lengthUnit": "pages",
    "outline": [...],
    "fileSearchStoreId": "fileSearchStores/...",
    "language": "german"
  }
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "job-uuid-timestamp",
  "message": "Thesis generation job started"
}
```

#### GET `/health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

## Rate Limiting

- **OpenAlex**: 10 requests/second with email (polite pool), 1 req/sec without
- **Semantic Scholar**: Check their documentation for current limits
- **Gemini**: Check Google's rate limits

The worker includes built-in rate limiting delays between API calls.

## Error Handling

- If a job fails, the thesis status is set back to `draft`
- Errors are logged to console
- The worker continues processing other jobs even if one fails

## Monitoring

Monitor the worker logs in Render dashboard to track:
- Job progress
- API call success/failure
- PDF download/upload status
- Thesis generation completion

