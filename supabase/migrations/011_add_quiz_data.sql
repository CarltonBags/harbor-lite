-- Add quiz_data column to theses table
ALTER TABLE theses
ADD COLUMN IF NOT EXISTS quiz_data JSONB;

COMMENT ON COLUMN theses.quiz_data IS 'Generated quiz questions and answers for the thesis';
