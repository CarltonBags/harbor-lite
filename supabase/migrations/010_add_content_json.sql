-- Add content_json column to theses table for structured storage
ALTER TABLE theses 
ADD COLUMN IF NOT EXISTS content_json JSONB;

COMMENT ON COLUMN theses.content_json IS 'Structured JSON representation of the thesis content (chapters, sections, text)';
