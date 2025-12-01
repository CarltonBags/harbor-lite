-- Add mandatory_sources column to theses table
-- This column stores an array of source identifiers (titles or DOIs) that the user 
-- has marked as mandatory to cite in the generated thesis

ALTER TABLE public.theses
ADD COLUMN IF NOT EXISTS mandatory_sources TEXT[] DEFAULT '{}';

-- Add index for faster lookups when checking if a specific source is mandatory
CREATE INDEX IF NOT EXISTS idx_theses_mandatory_sources ON public.theses USING GIN (mandatory_sources);

-- Add comment explaining the column
COMMENT ON COLUMN public.theses.mandatory_sources IS 'Array of source titles/DOIs that must be cited in the thesis. Populated from uploaded_sources where mandatory=true.';

