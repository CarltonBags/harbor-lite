-- Add language column to theses table
ALTER TABLE theses
ADD COLUMN language TEXT NOT NULL DEFAULT 'german';

-- Optional: Add a check constraint to ensure only valid languages are stored
-- ALTER TABLE theses ADD CONSTRAINT valid_language CHECK (language IN ('german', 'english'));
