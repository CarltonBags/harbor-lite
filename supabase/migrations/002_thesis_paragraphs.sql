-- Enable vector extension for embeddings (pgvector)
-- Note: This requires pgvector extension to be installed in Supabase
-- Run this in Supabase SQL editor if extension is not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Thesis paragraphs table for storing individual paragraphs with embeddings
CREATE TABLE IF NOT EXISTS public.thesis_paragraphs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  thesis_id UUID NOT NULL REFERENCES public.theses(id) ON DELETE CASCADE,
  
  -- Structure and ordering
  chapter_number INTEGER NOT NULL,
  section_number INTEGER,
  paragraph_number INTEGER NOT NULL,
  
  -- Content
  text TEXT NOT NULL,
  embedding vector(1536), -- OpenAI ada-002 embedding dimension (adjust if using different model)
  
  -- Version control
  version INTEGER DEFAULT 1 NOT NULL,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  
  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,
  
  -- Ensure unique ordering within a thesis
  CONSTRAINT unique_paragraph_order UNIQUE (thesis_id, chapter_number, section_number, paragraph_number)
);

-- Enable Row Level Security
ALTER TABLE public.thesis_paragraphs ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view paragraphs of their own theses
CREATE POLICY "Users can view own thesis paragraphs"
  ON public.thesis_paragraphs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.theses
      WHERE theses.id = thesis_paragraphs.thesis_id
      AND theses.user_id = auth.uid()
    )
  );

-- Policy: Users can insert paragraphs into their own theses
CREATE POLICY "Users can insert own thesis paragraphs"
  ON public.thesis_paragraphs
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.theses
      WHERE theses.id = thesis_paragraphs.thesis_id
      AND theses.user_id = auth.uid()
    )
  );

-- Policy: Users can update paragraphs in their own theses
CREATE POLICY "Users can update own thesis paragraphs"
  ON public.thesis_paragraphs
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.theses
      WHERE theses.id = thesis_paragraphs.thesis_id
      AND theses.user_id = auth.uid()
    )
  );

-- Policy: Users can delete paragraphs from their own theses
CREATE POLICY "Users can delete own thesis paragraphs"
  ON public.thesis_paragraphs
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.theses
      WHERE theses.id = thesis_paragraphs.thesis_id
      AND theses.user_id = auth.uid()
    )
  );

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_thesis_paragraphs_thesis_id ON public.thesis_paragraphs(thesis_id);
CREATE INDEX IF NOT EXISTS idx_thesis_paragraphs_chapter ON public.thesis_paragraphs(thesis_id, chapter_number);
CREATE INDEX IF NOT EXISTS idx_thesis_paragraphs_ordering ON public.thesis_paragraphs(thesis_id, chapter_number, section_number, paragraph_number);
CREATE INDEX IF NOT EXISTS idx_thesis_paragraphs_version ON public.thesis_paragraphs(thesis_id, version);

-- Index for vector similarity search (using HNSW for better performance)
-- Note: Adjust m and ef_construction based on your needs
CREATE INDEX IF NOT EXISTS idx_thesis_paragraphs_embedding ON public.thesis_paragraphs
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64)
WHERE embedding IS NOT NULL;

-- Function to automatically increment version on update
CREATE OR REPLACE FUNCTION public.increment_paragraph_version()
RETURNS TRIGGER AS $$
BEGIN
  -- Only increment version if text actually changed
  IF OLD.text IS DISTINCT FROM NEW.text THEN
    NEW.version = OLD.version + 1;
  END IF;
  NEW.updated_at = TIMEZONE('utc'::text, NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update version and updated_at
CREATE TRIGGER update_thesis_paragraphs_version
  BEFORE UPDATE ON public.thesis_paragraphs
  FOR EACH ROW
  EXECUTE FUNCTION public.increment_paragraph_version();

-- Trigger to update updated_at on insert
CREATE TRIGGER update_thesis_paragraphs_updated_at
  BEFORE UPDATE ON public.thesis_paragraphs
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- Function to get paragraphs ordered by structure
CREATE OR REPLACE FUNCTION public.get_thesis_paragraphs(p_thesis_id UUID)
RETURNS TABLE (
  id UUID,
  thesis_id UUID,
  chapter_number INTEGER,
  section_number INTEGER,
  paragraph_number INTEGER,
  text TEXT,
  version INTEGER,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    tp.id,
    tp.thesis_id,
    tp.chapter_number,
    tp.section_number,
    tp.paragraph_number,
    tp.text,
    tp.version,
    tp.created_at,
    tp.updated_at
  FROM public.thesis_paragraphs tp
  WHERE tp.thesis_id = p_thesis_id
  ORDER BY 
    tp.chapter_number ASC NULLS LAST,
    tp.section_number ASC NULLS LAST,
    tp.paragraph_number ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function for semantic search using embeddings
CREATE OR REPLACE FUNCTION public.search_thesis_paragraphs(
  p_thesis_id UUID,
  p_query_embedding vector(1536),
  p_limit INTEGER DEFAULT 10,
  p_similarity_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  thesis_id UUID,
  chapter_number INTEGER,
  section_number INTEGER,
  paragraph_number INTEGER,
  text TEXT,
  version INTEGER,
  similarity FLOAT,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    tp.id,
    tp.thesis_id,
    tp.chapter_number,
    tp.section_number,
    tp.paragraph_number,
    tp.text,
    tp.version,
    1 - (tp.embedding <=> p_query_embedding) AS similarity,
    tp.created_at,
    tp.updated_at
  FROM public.thesis_paragraphs tp
  WHERE 
    tp.thesis_id = p_thesis_id
    AND tp.embedding IS NOT NULL
    AND (1 - (tp.embedding <=> p_query_embedding)) >= p_similarity_threshold
  ORDER BY tp.embedding <=> p_query_embedding
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

