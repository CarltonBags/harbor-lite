-- Query to check if thesis paragraphs and embeddings are stored
-- Run this in Supabase SQL Editor to verify

-- 1. Check if thesis_paragraphs table exists and has data
SELECT 
  COUNT(*) as total_paragraphs,
  COUNT(embedding) as paragraphs_with_embeddings,
  COUNT(*) - COUNT(embedding) as paragraphs_without_embeddings
FROM public.thesis_paragraphs;

-- 2. Check paragraphs for a specific thesis (replace with your thesis ID)
-- SELECT 
--   id,
--   thesis_id,
--   chapter_number,
--   paragraph_number,
--   LEFT(text, 100) as text_preview,
--   CASE 
--     WHEN embedding IS NOT NULL THEN 'Has embedding (' || array_length(embedding::text::int[], 1) || ' dims)'
--     ELSE 'No embedding'
--   END as embedding_status,
--   created_at
-- FROM public.thesis_paragraphs
-- WHERE thesis_id = 'YOUR_THESIS_ID_HERE'
-- ORDER BY chapter_number, paragraph_number
-- LIMIT 20;

-- 3. Check all theses that have paragraphs stored
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

-- 4. Check if pgvector extension is enabled
SELECT * FROM pg_extension WHERE extname = 'vector';

-- 5. Check table structure
SELECT 
  column_name,
  data_type,
  character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'thesis_paragraphs'
ORDER BY ordinal_position;

