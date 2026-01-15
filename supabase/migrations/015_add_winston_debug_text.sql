-- Add column to store the last text sent to Winston AI for checking (debugging purposes)
ALTER TABLE theses
ADD COLUMN IF NOT EXISTS last_winston_input_text TEXT;
