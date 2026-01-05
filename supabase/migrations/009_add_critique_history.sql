-- Add critique_history column to theses table
ALTER TABLE theses ADD COLUMN IF NOT EXISTS critique_history JSONB DEFAULT '[]'::jsonb;

-- Update the comments/description
COMMENT ON COLUMN theses.critique_history IS 'Stores the history of all critique reports generated during the iterative repair process.';
