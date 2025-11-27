-- Add clean_markdown_content column to theses table
-- This stores a properly formatted Markdown version for exports (DOCX, etc.)

ALTER TABLE theses
ADD COLUMN IF NOT EXISTS clean_markdown_content TEXT;

-- Add comment to explain the column
COMMENT ON COLUMN theses.clean_markdown_content IS 'Clean Markdown version of thesis content with explicit headings and proper formatting for Pandoc exports';
