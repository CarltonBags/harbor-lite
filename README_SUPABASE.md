# Supabase Setup Guide

## Database Schema

The database schema is defined in migration files:

### Migration 001: Initial Schema (`001_initial_schema.sql`)
1. **user_profiles** - Extends Supabase auth.users with usage tracking
2. **theses** - Stores thesis projects metadata
3. **usage_logs** - Tracks all usage events
4. **subscriptions** - Manages user subscriptions and purchases

### Migration 002: Thesis Paragraphs (`002_thesis_paragraphs.sql`)
5. **thesis_paragraphs** - Stores individual paragraphs with embeddings for semantic search
   - Each paragraph has: id, thesis_id, chapter_number, section_number, paragraph_number, text, embedding, version
   - Supports version control (auto-increments on text changes)
   - Includes vector embeddings for semantic search (requires pgvector extension)
   - Indexed for efficient querying and similarity search

## Environment Variables

Add these to your `.env.local` file:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
NEXT_PUBLIC_SUPABASE_PROJECT_ID=your-project-id
```

## Running Migrations

1. Install Supabase CLI: `npm install -g supabase`
2. Link your project: `supabase link --project-ref your-project-ref`
3. Run migrations: `supabase db push`

Or manually run the SQL files in order:
1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_thesis_paragraphs.sql`

**Important**: The `002_thesis_paragraphs.sql` migration requires the `pgvector` extension. Make sure it's enabled in your Supabase project:
- Go to Database > Extensions in Supabase dashboard
- Enable the `vector` extension
- Or run: `CREATE EXTENSION IF NOT EXISTS vector;` in the SQL editor

## Authentication

The app supports:
- Email/Password authentication
- Google OAuth

Make sure to enable Google OAuth in your Supabase dashboard:
1. Go to Authentication > Providers
2. Enable Google provider
3. Add your OAuth credentials

## Pricing Tiers

The system tracks usage but does not enforce limits (testing mode):

- **V1 Starter Draft** ($79): 10 AI rewrite prompts, 1 PDF upload
- **Top-Up Pack** ($15): 5 additional AI rewrite prompts
- **Pro Thesis Package** ($149): 20 AI rewrite prompts, 5 PDF uploads
- **Premium / Academic** ($249): Unlimited everything

Usage is tracked in the `user_profiles` table but not enforced.

