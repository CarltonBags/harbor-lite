# Vector Database Storage Guide

## Where Vectors Are Stored

The thesis content is stored in the **`thesis_paragraphs`** table in Supabase, NOT in Google FileSearchStore.

- **Table**: `public.thesis_paragraphs`
- **Embedding Column**: `embedding` (vector(1536))
- **Content Column**: `text` (TEXT)

## How to Check if Vectors Are Stored

### 1. Run this SQL query in Supabase SQL Editor:

```sql
-- Check if any paragraphs exist
SELECT 
  COUNT(*) as total_paragraphs,
  COUNT(embedding) as paragraphs_with_embeddings,
  COUNT(*) - COUNT(embedding) as paragraphs_without_embeddings
FROM public.thesis_paragraphs;
```

### 2. Check paragraphs for a specific thesis:

```sql
-- Replace 'YOUR_THESIS_ID' with your actual thesis ID
SELECT 
  id,
  thesis_id,
  chapter_number,
  paragraph_number,
  LEFT(text, 100) as text_preview,
  CASE 
    WHEN embedding IS NOT NULL THEN 'Has embedding'
    ELSE 'No embedding (NULL)'
  END as embedding_status,
  created_at
FROM public.thesis_paragraphs
WHERE thesis_id = 'YOUR_THESIS_ID'
ORDER BY chapter_number, paragraph_number
LIMIT 20;
```

### 3. List all theses with stored paragraphs:

```sql
SELECT 
  t.id as thesis_id,
  t.topic,
  t.status,
  COUNT(tp.id) as paragraph_count,
  COUNT(tp.embedding) as paragraphs_with_embeddings
FROM public.theses t
LEFT JOIN public.thesis_paragraphs tp ON tp.thesis_id = t.id
GROUP BY t.id, t.topic, t.status
HAVING COUNT(tp.id) > 0
ORDER BY t.created_at DESC;
```

## Why You Might Not See Vectors

### 1. **Test Mode**
If you're running in test mode, the chunking step is **skipped**. Test mode only stores selected sources in metadata, not the thesis content.

**Solution**: Run in production mode (set `testMode: false` in the frontend).

### 2. **Thesis Generation Not Completed**
The chunking only happens after thesis generation completes (Step 8). If generation failed or is still running, no paragraphs will be stored.

**Check**: Look at the thesis `status` field - it should be `'completed'` for chunking to have run.

### 3. **Missing OpenAI API Key**
If `OPENAI_API_KEY` is not set, paragraphs are stored **without embeddings** (embedding column will be NULL). The text is still stored, but semantic search won't work.

**Solution**: Set `OPENAI_API_KEY` environment variable in your worker.

### 4. **Chunking Step Failed**
Check the worker logs for errors in Step 8. The chunking step has error handling that logs but doesn't fail the whole process.

**Check logs for**: `[Chunking]` messages

### 5. **Row Level Security (RLS)**
If you're querying from the Supabase dashboard, RLS policies might prevent you from seeing the data. The worker uses the service role key, so it can insert, but you might not be able to read it from the dashboard if RLS is blocking.

**Solution**: Query using the service role key, or check RLS policies.

## How to Verify Chunking Worked

1. **Check worker logs** for:
   - `[Chunking] Starting thesis chunking and embedding for Supabase vector DB...`
   - `[Chunking] Successfully stored X paragraphs in Supabase vector DB`

2. **Check thesis status**:
   ```sql
   SELECT id, topic, status, completed_at 
   FROM public.theses 
   WHERE status = 'completed'
   ORDER BY completed_at DESC;
   ```

3. **Check paragraph count**:
   ```sql
   SELECT thesis_id, COUNT(*) as paragraph_count
   FROM public.thesis_paragraphs
   GROUP BY thesis_id;
   ```

## Troubleshooting

If you still don't see vectors:

1. **Enable pgvector extension** (if not already enabled):
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

2. **Check if table exists**:
   ```sql
   SELECT EXISTS (
     SELECT FROM information_schema.tables 
     WHERE table_schema = 'public' 
     AND table_name = 'thesis_paragraphs'
   );
   ```

3. **Check RLS policies** - Make sure you can read the data:
   ```sql
   SELECT * FROM pg_policies 
   WHERE tablename = 'thesis_paragraphs';
   ```

4. **Check worker environment variables**:
   - `OPENAI_API_KEY` - Required for embeddings (optional for text storage)
   - `SUPABASE_URL` - Required
   - `SUPABASE_SERVICE_ROLE_KEY` - Required

