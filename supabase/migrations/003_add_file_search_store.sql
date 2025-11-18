-- Add file_search_store_id to theses table
ALTER TABLE public.theses
ADD COLUMN IF NOT EXISTS file_search_store_id TEXT;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_theses_file_search_store ON public.theses(file_search_store_id);

-- Add comment
COMMENT ON COLUMN public.theses.file_search_store_id IS 'Google File Search Store ID associated with this thesis for RAG';

