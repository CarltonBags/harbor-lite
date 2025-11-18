-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- User profiles table (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  
  -- Subscription/Plan information
  current_plan TEXT DEFAULT 'free', -- 'free', 'starter', 'pro', 'premium'
  plan_started_at TIMESTAMP WITH TIME ZONE,
  plan_expires_at TIMESTAMP WITH TIME ZONE,
  
  -- Usage tracking (not enforced, just tracked)
  total_thesis_drafts INTEGER DEFAULT 0,
  total_ai_rewrite_prompts_used INTEGER DEFAULT 0,
  total_ai_rewrite_prompts_available INTEGER DEFAULT 0,
  total_pdf_uploads INTEGER DEFAULT 0,
  total_pdf_uploads_available INTEGER DEFAULT 0,
  total_exa_research_queries INTEGER DEFAULT 0,
  total_ai_figures_generated INTEGER DEFAULT 0,
  
  -- Top-up packs tracking
  top_up_packs_purchased INTEGER DEFAULT 0,
  top_up_prompts_available INTEGER DEFAULT 0,
  
  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Enable Row Level Security
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own profile
CREATE POLICY "Users can view own profile"
  ON public.user_profiles
  FOR SELECT
  USING (auth.uid() = id);

-- Policy: Users can update their own profile
CREATE POLICY "Users can update own profile"
  ON public.user_profiles
  FOR UPDATE
  USING (auth.uid() = id);

-- Policy: Users can insert their own profile
CREATE POLICY "Users can insert own profile"
  ON public.user_profiles
  FOR INSERT
  WITH CHECK (auth.uid() = id);

-- Theses table
CREATE TABLE IF NOT EXISTS public.theses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  
  -- Thesis information
  title TEXT,
  topic TEXT NOT NULL,
  field TEXT NOT NULL,
  thesis_type TEXT NOT NULL, -- 'bachelor', 'master', 'phd', 'dissertation'
  research_question TEXT NOT NULL,
  citation_style TEXT NOT NULL,
  target_length INTEGER NOT NULL,
  length_unit TEXT NOT NULL, -- 'pages' or 'words'
  
  -- Outline
  outline JSONB, -- Array of {chapter: string, points: string[]}
  
  -- Content
  latex_content TEXT,
  pdf_url TEXT,
  word_url TEXT,
  
  -- Status
  status TEXT DEFAULT 'draft', -- 'draft', 'generating', 'completed', 'archived'
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  
  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Enable Row Level Security
ALTER TABLE public.theses ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own theses
CREATE POLICY "Users can view own theses"
  ON public.theses
  FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Users can insert their own theses
CREATE POLICY "Users can insert own theses"
  ON public.theses
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Policy: Users can update their own theses
CREATE POLICY "Users can update own theses"
  ON public.theses
  FOR UPDATE
  USING (auth.uid() = user_id);

-- Policy: Users can delete their own theses
CREATE POLICY "Users can delete own theses"
  ON public.theses
  FOR DELETE
  USING (auth.uid() = user_id);

-- Usage logs table (for tracking all usage events)
CREATE TABLE IF NOT EXISTS public.usage_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  
  -- Event information
  event_type TEXT NOT NULL, -- 'thesis_created', 'ai_rewrite', 'pdf_upload', 'exa_research', 'ai_figure'
  thesis_id UUID REFERENCES public.theses(id) ON DELETE SET NULL,
  
  -- Event data
  event_data JSONB DEFAULT '{}'::jsonb,
  
  -- Timestamp
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Enable Row Level Security
ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own usage logs
CREATE POLICY "Users can view own usage logs"
  ON public.usage_logs
  FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: System can insert usage logs (via service role)
CREATE POLICY "Service role can insert usage logs"
  ON public.usage_logs
  FOR INSERT
  WITH CHECK (true);

-- Subscriptions/Purchases table
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  
  -- Subscription details
  plan_type TEXT NOT NULL, -- 'starter', 'topup', 'pro', 'premium'
  amount_paid DECIMAL(10, 2) NOT NULL,
  currency TEXT DEFAULT 'USD',
  
  -- Features included
  ai_rewrite_prompts INTEGER DEFAULT 0,
  pdf_uploads INTEGER DEFAULT 0,
  exa_research_queries INTEGER DEFAULT 0,
  ai_figures INTEGER DEFAULT 0,
  unlimited_drafts BOOLEAN DEFAULT false,
  unlimited_rewrites BOOLEAN DEFAULT false,
  unlimited_pdfs BOOLEAN DEFAULT false,
  priority_support BOOLEAN DEFAULT false,
  multi_thesis BOOLEAN DEFAULT false,
  export_formats TEXT[], -- ['pdf', 'word', 'latex']
  
  -- Status
  status TEXT DEFAULT 'active', -- 'active', 'expired', 'cancelled'
  
  -- Timestamps
  purchased_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE,
  
  -- Payment information
  payment_provider TEXT, -- 'stripe', 'paypal', etc.
  payment_id TEXT,
  
  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Enable Row Level Security
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own subscriptions
CREATE POLICY "Users can view own subscriptions"
  ON public.subscriptions
  FOR SELECT
  USING (auth.uid() = user_id);

-- Function to automatically create user profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create profile on user signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = TIMEZONE('utc'::text, NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER update_theses_updated_at
  BEFORE UPDATE ON public.theses
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

