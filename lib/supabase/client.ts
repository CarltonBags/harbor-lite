import { createBrowserClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

// Client-side Supabase client
export function createSupabaseClient() {
  const supabaseUrl = env.SUPABASE_STORAGE_ENDPOINT || (env.SUPABASE_PROJECT_ID ? `https://${env.SUPABASE_PROJECT_ID}.supabase.co` : '')
  const supabaseAnonKey = env.SUPABASE_ANON_KEY

  // Return a mock client if environment variables are not set (for development/testing)
  if (!supabaseUrl || !supabaseAnonKey) {
    if (typeof window !== 'undefined') {
      console.warn('Supabase environment variables are not set. Using mock client.')
    }
    // Return a mock client that won't crash but won't work either
    return createBrowserClient(
      'https://placeholder.supabase.co',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsYWNlaG9sZGVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE2NDUxOTIwMDAsImV4cCI6MTk2MDc2ODAwMH0.placeholder'
    )
  }

  return createBrowserClient(supabaseUrl, supabaseAnonKey)
}

// Server-side Supabase client
export function createSupabaseServerClient() {
  const supabaseUrl = env.SUPABASE_STORAGE_ENDPOINT || (env.SUPABASE_PROJECT_ID ? `https://${env.SUPABASE_PROJECT_ID}.supabase.co` : '')
  const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE

  // Return a mock client if environment variables are not set (for development/testing)
  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn('Supabase environment variables are not set. Using mock server client.')
    return createClient(
      'https://placeholder.supabase.co',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsYWNlaG9sZGVyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTY0NTE5MjAwMCwiZXhwIjoxOTYwNzY4MDAwfQ.placeholder',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    )
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

