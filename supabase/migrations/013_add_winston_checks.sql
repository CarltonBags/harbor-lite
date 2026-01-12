-- Add winston_checks column to theses table to store all Winston AI check iterations
-- This tracks the history of AI detection checks during the humanization process

ALTER TABLE theses ADD COLUMN IF NOT EXISTS winston_checks JSONB DEFAULT '[]'::jsonb;

-- Add a comment to document the expected structure
COMMENT ON COLUMN theses.winston_checks IS 'Array of Winston AI check results from each iteration. Structure: [{iteration: number, score: number, sentenceCount: number, flaggedCount: number, checkedAt: ISO timestamp}]';

-- Create index for efficient querying of thesis by final score
CREATE INDEX IF NOT EXISTS idx_theses_winston_final_score ON theses ((
  (winston_checks->-1->>'score')::int
)) WHERE winston_checks IS NOT NULL AND jsonb_array_length(winston_checks) > 0;
