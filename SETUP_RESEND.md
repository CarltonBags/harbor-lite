# Setting Up Resend API Key for Email Notifications

## Step 1: Get Your Resend API Key

1. Sign up at https://resend.com/signup (or log in)
2. Go to **API Keys** in the dashboard
3. Click **Create API Key**
4. Give it a name (e.g., "Thesis Completion Emails")
5. Copy the API key (you'll only see it once!)

## Step 2: Set the Secret in Supabase

### Option A: Using Supabase CLI (Recommended)

If you have the Supabase CLI installed and linked to your project:

```bash
# Set the Resend API key
supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxxx

# Set your app URL (for email links)
supabase secrets set NEXT_PUBLIC_APP_URL=https://your-app-domain.com
```

**Note:** Make sure you're in your project directory and have the Supabase CLI linked to your project.

### Option B: Using Supabase Dashboard

1. Go to your Supabase project dashboard: https://supabase.com/dashboard
2. Navigate to **Project Settings** → **Edge Functions**
3. Scroll down to **Secrets**
4. Click **Add Secret**
5. Enter:
   - **Name**: `RESEND_API_KEY`
   - **Value**: Your Resend API key (starts with `re_`)
6. Click **Save**
7. Repeat for `NEXT_PUBLIC_APP_URL`:
   - **Name**: `NEXT_PUBLIC_APP_URL`
   - **Value**: Your app URL (e.g., `https://your-app.vercel.app` or `http://localhost:3000` for local dev)

## Step 3: Verify the Secret is Set

You can verify the secret is set by:

```bash
# List all secrets (values are hidden for security)
supabase secrets list
```

Or check in the Supabase dashboard under **Project Settings** → **Edge Functions** → **Secrets**.

## Step 4: Update Email "From" Address

Edit `supabase/functions/send-thesis-completion-email/index.ts` and change:

```typescript
from: 'StudyFucker <noreply@yourdomain.com>',
```

To your verified domain in Resend. For testing, you can use Resend's test domain:

```typescript
from: 'onboarding@resend.dev',  // For testing only
```

**Important:** For production, you need to:
1. Verify your domain in Resend
2. Use an email from that verified domain

## Step 5: Deploy the Edge Function

```bash
supabase functions deploy send-thesis-completion-email
```

## Step 6: Test

1. Complete a thesis generation
2. Check if the email is sent
3. Check Supabase Edge Function logs if there are issues:
   - Go to **Edge Functions** → **send-thesis-completion-email** → **Logs**

## Troubleshooting

### Secret Not Found Error

If you get an error that the secret is not found:
- Make sure you set it in the correct Supabase project
- Redeploy the Edge Function after setting the secret
- Check the secret name is exactly `RESEND_API_KEY` (case-sensitive)

### Email Not Sending

1. Check Edge Function logs in Supabase dashboard
2. Verify the API key is correct
3. Make sure your "from" email is verified in Resend
4. Check Resend dashboard for delivery status

### Local Development

For local development, you can also set secrets in a `.env.local` file, but Edge Functions run on Supabase's servers, so you need to set them as Supabase secrets.

## Quick Reference

```bash
# Set secrets
supabase secrets set RESEND_API_KEY=re_your_key_here
supabase secrets set NEXT_PUBLIC_APP_URL=https://your-app.com

# Deploy function
supabase functions deploy send-thesis-completion-email

# View logs
supabase functions logs send-thesis-completion-email
```

