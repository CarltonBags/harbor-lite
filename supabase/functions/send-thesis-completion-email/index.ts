// Supabase Edge Function to send email notification when thesis is completed
// This function is called by the database trigger (005_thesis_completion_email_trigger.sql)
// 
// Setup:
// 1. Install dependencies: npm install resend (or your preferred email service)
// 2. Set RESEND_API_KEY in Supabase Edge Function secrets
// 3. Deploy: supabase functions deploy send-thesis-completion-email

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { Resend } from 'https://esm.sh/resend@2.0.0'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
// For localhost development, you can use http://localhost:3000
// For production, set this to your actual domain (e.g., https://your-app.vercel.app)
const APP_URL = Deno.env.get('NEXT_PUBLIC_APP_URL') || Deno.env.get('APP_URL') || 'http://localhost:3000'

serve(async (req) => {
  try {
    // Parse request body
    const { thesisId, thesisTitle, userEmail, userName } = await req.json()

    if (!thesisId || !userEmail) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    if (!RESEND_API_KEY) {
      console.error('RESEND_API_KEY not configured')
      return new Response(
        JSON.stringify({ error: 'Email service not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const resend = new Resend(RESEND_API_KEY)

    // Build preview URL
    const previewUrl = `${APP_URL}/thesis/preview?id=${thesisId}`

    // Email content
    const emailSubject = `Ihre Thesis "${thesisTitle}" ist fertig!`
    const emailHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 24px;">🎉 Ihre Thesis ist fertig!</h1>
          </div>
          
          <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #e5e7eb;">
            <p style="font-size: 16px; margin-bottom: 20px;">
              Hallo ${userName || 'liebe/r Nutzer/in'},
            </p>
            
            <p style="font-size: 16px; margin-bottom: 20px;">
              Wir freuen uns, Ihnen mitteilen zu können, dass Ihre Thesis <strong>"${thesisTitle}"</strong> erfolgreich generiert wurde!
            </p>
            
            <div style="background: white; padding: 20px; border-radius: 8px; border-left: 4px solid #667eea; margin: 20px 0;">
              <p style="margin: 0; font-size: 14px; color: #6b7280;">
                Sie können Ihre Thesis jetzt in der Vorschau ansehen, bearbeiten und mit unserem AI-Assistenten weiter optimieren.
              </p>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${previewUrl}" 
                 style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                Thesis öffnen →
              </a>
            </div>
            
            <p style="font-size: 14px; color: #6b7280; margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
              <strong>Was Sie jetzt tun können:</strong>
            </p>
            <ul style="font-size: 14px; color: #6b7280; padding-left: 20px;">
              <li>Ihre Thesis in der Vorschau ansehen</li>
              <li>Text manuell bearbeiten</li>
              <li>Mit dem AI-Assistenten Änderungen vornehmen</li>
              <li>Die Thesis als PDF oder Word exportieren</li>
            </ul>
            
            <p style="font-size: 12px; color: #9ca3af; margin-top: 30px; text-align: center;">
              Falls Sie Fragen haben, zögern Sie nicht, uns zu kontaktieren.
            </p>
          </div>
        </body>
      </html>
    `

    const emailText = `
Hallo ${userName || 'liebe/r Nutzer/in'},

Wir freuen uns, Ihnen mitteilen zu können, dass Ihre Thesis "${thesisTitle}" erfolgreich generiert wurde!

Sie können Ihre Thesis jetzt in der Vorschau ansehen, bearbeiten und mit unserem AI-Assistenten weiter optimieren.

Thesis öffnen: ${previewUrl}

Was Sie jetzt tun können:
- Ihre Thesis in der Vorschau ansehen
- Text manuell bearbeiten
- Mit dem AI-Assistenten Änderungen vornehmen
- Die Thesis als PDF oder Word exportieren

Falls Sie Fragen haben, zögern Sie nicht, uns zu kontaktieren.
    `.trim()

    // Send email
    const { data, error } = await resend.emails.send({
      from: 'StudyFucker <noreply@yourdomain.com>', // Update with your verified domain
      to: userEmail,
      subject: emailSubject,
      html: emailHtml,
      text: emailText,
    })

    if (error) {
      console.error('Error sending email:', error)
      return new Response(
        JSON.stringify({ error: 'Failed to send email', details: error }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }

    console.log('Email sent successfully:', data)

    return new Response(
      JSON.stringify({ success: true, messageId: data?.id }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})

