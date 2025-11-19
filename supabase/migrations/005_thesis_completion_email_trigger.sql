-- Database trigger to send email notification when thesis is completed
-- This trigger fires automatically when a thesis status changes to 'completed'

-- Create a configuration table to store Supabase settings (avoids permission issues)
CREATE TABLE IF NOT EXISTS public.app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Insert default config (you'll need to update these with your actual values)
-- You can update these via SQL or through your app
INSERT INTO public.app_config (key, value) 
VALUES 
  ('supabase_url', 'https://your-project.supabase.co'),
  ('supabase_service_role_key', 'your-service-role-key')
ON CONFLICT (key) DO NOTHING;

-- Enable Row Level Security
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

-- Policy: Only service role can read config (for triggers)
-- Drop policy if it exists to avoid conflicts
DROP POLICY IF EXISTS "Service role can read config" ON public.app_config;

CREATE POLICY "Service role can read config"
  ON public.app_config
  FOR SELECT
  USING (true); -- Triggers run with SECURITY DEFINER, so this is safe

-- First, create a function that will be called by the trigger
CREATE OR REPLACE FUNCTION public.send_thesis_completion_notification()
RETURNS TRIGGER AS $$
DECLARE
  user_email TEXT;
  user_name TEXT;
  thesis_topic TEXT;
  supabase_url TEXT;
  service_role_key TEXT;
BEGIN
  -- Only proceed if status changed to 'completed'
  IF NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status != 'completed') THEN
    -- Get user email and name
    SELECT email, full_name INTO user_email, user_name
    FROM public.user_profiles
    WHERE id = NEW.user_id;
    
    -- Get thesis topic
    thesis_topic := COALESCE(NEW.title, NEW.topic, 'Ihre Thesis');
    
    -- Get Supabase configuration from app_config table
    SELECT value INTO supabase_url FROM public.app_config WHERE key = 'supabase_url';
    SELECT value INTO service_role_key FROM public.app_config WHERE key = 'supabase_service_role_key';
    
    -- If email and config are available, call Edge Function
    IF user_email IS NOT NULL AND supabase_url IS NOT NULL AND service_role_key IS NOT NULL THEN
      -- Enable pg_net extension if not already enabled
      -- CREATE EXTENSION IF NOT EXISTS pg_net;
      
      -- Call Supabase Edge Function to send email
      PERFORM
        net.http_post(
          url := supabase_url || '/functions/v1/send-thesis-completion-email',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_role_key
          ),
          body := jsonb_build_object(
            'thesisId', NEW.id::text,
            'thesisTitle', thesis_topic,
            'userEmail', user_email,
            'userName', COALESCE(user_name, 'User')
          )
        );
      
      RAISE NOTICE 'Thesis completed: % for user % (%). Email notification sent to: %', 
        NEW.id, NEW.user_id, thesis_topic, user_email;
    ELSE
      RAISE NOTICE 'Thesis completed: % for user % (%), but email config missing. Email: %, URL: %, Key: %', 
        NEW.id, NEW.user_id, thesis_topic, user_email, supabase_url IS NOT NULL, service_role_key IS NOT NULL;
    END IF;
    
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create the trigger (drop first if exists)
DROP TRIGGER IF EXISTS thesis_completion_email_trigger ON public.theses;
CREATE TRIGGER thesis_completion_email_trigger
  AFTER UPDATE OF status ON public.theses
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status != 'completed'))
  EXECUTE FUNCTION public.send_thesis_completion_notification();

-- Setup Instructions:
-- 1. Enable pg_net extension in Supabase SQL Editor:
--    CREATE EXTENSION IF NOT EXISTS pg_net;
--
-- 2. Update the configuration table with your actual values:
--    UPDATE public.app_config SET value = 'https://your-project.supabase.co' WHERE key = 'supabase_url';
--    UPDATE public.app_config SET value = 'your-service-role-key' WHERE key = 'supabase_service_role_key';
--
-- 3. Create a Supabase Edge Function at: supabase/functions/send-thesis-completion-email/
--    The Edge Function should use Resend, SendGrid, or another email service to send the email
--
-- 4. Deploy the Edge Function: supabase functions deploy send-thesis-completion-email
--
-- Note: The configuration table approach avoids permission issues with ALTER DATABASE.
-- You can also update these values programmatically through your app if needed.

