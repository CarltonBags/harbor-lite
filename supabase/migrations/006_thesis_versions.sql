-- Thesis versions table for version control
CREATE TABLE IF NOT EXISTS public.thesis_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  thesis_id UUID NOT NULL REFERENCES public.theses(id) ON DELETE CASCADE,
  
  -- Version information
  version_number INTEGER NOT NULL,
  latex_content TEXT NOT NULL,
  
  -- Change information
  change_description TEXT, -- Optional description of what changed
  changed_by_user_id UUID REFERENCES public.user_profiles(id),
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  
  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,
  
  -- Ensure unique version numbers per thesis
  CONSTRAINT unique_thesis_version UNIQUE (thesis_id, version_number)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_thesis_versions_thesis_id ON public.thesis_versions(thesis_id);
CREATE INDEX IF NOT EXISTS idx_thesis_versions_version_number ON public.thesis_versions(thesis_id, version_number DESC);

-- Enable Row Level Security
ALTER TABLE public.thesis_versions ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view versions of their own theses
CREATE POLICY "Users can view own thesis versions"
  ON public.thesis_versions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.theses
      WHERE theses.id = thesis_versions.thesis_id
      AND theses.user_id = auth.uid()
    )
  );

-- Policy: Users can insert versions for their own theses
CREATE POLICY "Users can insert own thesis versions"
  ON public.thesis_versions
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.theses
      WHERE theses.id = thesis_versions.thesis_id
      AND theses.user_id = auth.uid()
    )
  );

-- Add comment
COMMENT ON TABLE public.thesis_versions IS 'Version history for thesis content, allowing rollback to previous versions';

