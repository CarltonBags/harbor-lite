-- Add granular token tracking and cost columns to theses table

-- Gemini 2.5 Pro tokens
ALTER TABLE theses ADD COLUMN IF NOT EXISTS tokens_gemini_2_5_pro_input BIGINT DEFAULT 0;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS tokens_gemini_2_5_pro_output BIGINT DEFAULT 0;

-- Gemini 3.0 Pro Preview tokens
ALTER TABLE theses ADD COLUMN IF NOT EXISTS tokens_gemini_3_pro_preview_input BIGINT DEFAULT 0;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS tokens_gemini_3_pro_preview_output BIGINT DEFAULT 0;

-- Winston AI Tracking (input only, measured in words/tokens)
ALTER TABLE theses ADD COLUMN IF NOT EXISTS tokens_winston_input BIGINT DEFAULT 0;

-- Total Cost Calculation (USD)
ALTER TABLE theses ADD COLUMN IF NOT EXISTS total_cost NUMERIC(10, 4) DEFAULT 0;

-- Add comments for clarity
COMMENT ON COLUMN theses.tokens_gemini_2_5_pro_input IS 'Input tokens for Gemini 2.5 Pro';
COMMENT ON COLUMN theses.tokens_gemini_2_5_pro_output IS 'Output tokens for Gemini 2.5 Pro';
COMMENT ON COLUMN theses.tokens_gemini_3_pro_preview_input IS 'Input tokens for Gemini 3 Pro Preview';
COMMENT ON COLUMN theses.tokens_gemini_3_pro_preview_output IS 'Output tokens for Gemini 3 Pro Preview';
COMMENT ON COLUMN theses.tokens_winston_input IS 'Total words processed by Winston AI';
COMMENT ON COLUMN theses.total_cost IS 'Total estimated cost in USD based on token usage';
