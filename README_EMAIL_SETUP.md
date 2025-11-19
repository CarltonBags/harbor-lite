# Email Notification Setup

## Why External Email Service?

**Supabase does NOT have built-in email sending capabilities** for custom transactional emails like thesis completion notifications. 

Supabase Auth can send authentication emails (password reset, email verification), but for custom business logic emails, you need an external email service.

## Options

### Option 1: Resend (Recommended - Easiest)
- **Free tier**: 3,000 emails/month
- **Setup**: 
  1. Sign up at https://resend.com
  2. Get your API key
  3. Set `RESEND_API_KEY` in Supabase Edge Function secrets
  4. Update the "from" email in `supabase/functions/send-thesis-completion-email/index.ts` to your verified domain

### Option 2: SendGrid
- **Free tier**: 100 emails/day
- Similar setup to Resend

### Option 3: AWS SES
- **Free tier**: 62,000 emails/month (if on EC2)
- More complex setup, but very cost-effective at scale

### Option 4: Mailgun
- **Free tier**: 5,000 emails/month for first 3 months
- Good for development

### Option 5: Simple SMTP (Not Recommended)
- You could use a simple SMTP server, but it's less reliable and harder to debug

## Setup Instructions (Using Resend)

1. **Sign up for Resend**: https://resend.com/signup

2. **Get API Key**: 
   - Go to API Keys section
   - Create a new API key
   - Copy the key

3. **Set Edge Function Secret**:

   **Option A: Using Supabase CLI** (if you have CLI installed):
   ```bash
   supabase secrets set RESEND_API_KEY=your_api_key_here
   supabase secrets set NEXT_PUBLIC_APP_URL=https://your-app-domain.com
   ```

   **Option B: Using Supabase Dashboard**:
   1. Go to your Supabase project: https://supabase.com/dashboard
   2. Navigate to **Project Settings** → **Edge Functions**
   3. Scroll to **Secrets** section
   4. Click **Add Secret**
   5. Name: `RESEND_API_KEY`, Value: `re_your_key_here`
   6. Click **Save**
   7. Repeat for `NEXT_PUBLIC_APP_URL` with your app URL

5. **Update Email "From" Address**:
   - Edit `supabase/functions/send-thesis-completion-email/index.ts`
   - Change `'StudyFucker <noreply@yourdomain.com>'` to your verified domain
   - You need to verify your domain in Resend first

6. **Deploy Edge Function**:
   ```bash
   supabase functions deploy send-thesis-completion-email
   ```

7. **Test**: Complete a thesis and check if email is sent

## Alternative: Skip Email (For Development)

If you don't want to set up email right now, you can:

1. **Comment out the email trigger** in the database:
   ```sql
   -- Temporarily disable trigger
   ALTER TABLE public.theses DISABLE TRIGGER thesis_completion_email_trigger;
   ```

2. **Or modify the trigger** to only log instead of sending:
   - The trigger will still log to Supabase logs
   - Users can check their thesis list for completed theses

3. **Users can still access completed theses** via the preview page at `/thesis/preview?id=<thesisId>`

## Cost Considerations

- **Resend**: Free for 3,000 emails/month, then $20/month for 50,000
- **SendGrid**: Free for 100/day, then $19.95/month for 50,000
- **AWS SES**: $0.10 per 1,000 emails (very cheap at scale)

For a thesis generation app, Resend's free tier should be sufficient for initial testing and small-scale usage.

