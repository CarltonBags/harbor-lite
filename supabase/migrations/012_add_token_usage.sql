-- Add token usage tracking columns to theses table
-- These track the total input/output tokens used during thesis generation

ALTER TABLE theses ADD COLUMN IF NOT EXISTS input_tokens BIGINT DEFAULT 0;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS output_tokens BIGINT DEFAULT 0;

-- Add index for querying by token usage (useful for cost analysis)
CREATE INDEX IF NOT EXISTS idx_theses_token_usage ON theses (input_tokens, output_tokens);

COMMENT ON COLUMN theses.input_tokens IS 'Total input tokens used during thesis generation (Gemini API)';
COMMENT ON COLUMN theses.output_tokens IS 'Total output tokens used during thesis generation (Gemini API)';
