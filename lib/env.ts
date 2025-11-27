/**
 * Environment variable utilities
 * Validates and provides typed access to environment variables
 */

export const env = {
  // OpenAI
  OPENAI_KEY: process.env.OPENAI_KEY || '',

  // Gemini
  GEMINI_KEY: process.env.GEMINI_KEY || '',

  // Supabase
  SUPABASE_PROJECT_ID: process.env.NEXT_PUBLIC_SUPABASE_PROJECT_ID || '',
  SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  SUPABASE_SERVICE_ROLE: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_STORAGE_ENDPOINT: process.env.NEXT_PUBLIC_SUPABASE_URL || '',

  // Thesis Worker
  THESIS_WORKER_URL: process.env.THESIS_WORKER_URL || '',
  THESIS_WORKER_API_KEY: process.env.THESIS_WORKER_API_KEY || '',

  // Redis
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
} as const;

/**
 * Validate that required environment variables are set
 */
export function validateEnv(): { valid: boolean; missing: string[] } {
  const required = [
    'OPENAI_KEY',
    'GEMINI_KEY',
    'NEXT_PUBLIC_SUPABASE_PROJECT_ID',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_SUPABASE_URL',
  ] as const;

  const missing: string[] = [];

  for (const key of required) {
    const envKey = key as keyof typeof env;
    if (!env[envKey]) {
      missing.push(key);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

