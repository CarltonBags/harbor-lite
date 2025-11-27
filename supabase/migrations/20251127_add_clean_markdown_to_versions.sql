-- Add clean_markdown_content column to thesis_versions table
-- This ensures version history also tracks the clean Markdown

ALTER TABLE thesis_versions
ADD COLUMN IF NOT EXISTS clean_markdown_content TEXT;

-- Add comment to explain the column
COMMENT ON COLUMN thesis_versions.clean_markdown_content IS 'Clean Markdown version of this thesis version for exports';
