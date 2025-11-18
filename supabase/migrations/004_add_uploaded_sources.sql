-- Add uploaded_sources JSONB field to theses table to track uploaded files
ALTER TABLE public.theses
ADD COLUMN IF NOT EXISTS uploaded_sources JSONB DEFAULT '[]'::jsonb;

-- Add index for faster DOI lookups
CREATE INDEX IF NOT EXISTS idx_theses_uploaded_sources_doi ON public.theses USING GIN ((uploaded_sources -> 'doi'));

-- Add comment
COMMENT ON COLUMN public.theses.uploaded_sources IS 'Array of uploaded source documents with metadata including DOI, file name, upload date, etc.';

