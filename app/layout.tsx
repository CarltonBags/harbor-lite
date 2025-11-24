import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '@/lib/theme-provider'

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://unilord.com'
const siteName = 'UniLord'
const defaultTitle = 'UniLord - KI-gestützter Wissenschaftlicher Thesis-Schreiber'
const defaultDescription = 'Vom Thema zum Entwurf in Minuten statt Wochen. KI-gestützter Assistent zum Schreiben wissenschaftlicher Arbeiten für Studenten und Forscher. Hausarbeit, Bachelorarbeit, Masterarbeit oder Dissertation - wir helfen dir dabei.'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: defaultTitle,
    template: `%s | ${siteName}`,
  },
  description: defaultDescription,
  keywords: [
    'Thesis schreiben',
    'Hausarbeit',
    'Bachelorarbeit',
    'Masterarbeit',
    'Dissertation',
    'KI Thesis',
    'KI-gestützt',
    'LaTeX',
    'wissenschaftliches Schreiben',
    'akademisches Schreiben',
    'Thesis Generator',
    'AI Thesis',
    'automatische Thesis',
    'Thesis Hilfe',
    'wissenschaftliche Arbeit',
  ],
  authors: [{ name: 'UniLord' }],
  creator: 'UniLord',
  publisher: 'UniLord',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  openGraph: {
    type: 'website',
    locale: 'de_DE',
    url: siteUrl,
    siteName: siteName,
    title: defaultTitle,
    description: defaultDescription,
    images: [
      {
        url: `${siteUrl}/og-image.jpg`,
        width: 1200,
        height: 630,
        alt: 'UniLord - KI-gestützter Thesis-Schreiber',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: defaultTitle,
    description: defaultDescription,
    images: [`${siteUrl}/og-image.jpg`],
    creator: '@unilord',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  verification: {
    // Add your verification codes here when available
    // google: 'your-google-verification-code',
    // yandex: 'your-yandex-verification-code',
    // bing: 'your-bing-verification-code',
  },
  alternates: {
    canonical: siteUrl,
  },
  category: 'education',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="de" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'SoftwareApplication',
              name: 'UniLord',
              applicationCategory: 'EducationalApplication',
              operatingSystem: 'Web',
              offers: {
                '@type': 'Offer',
                price: '0',
                priceCurrency: 'EUR',
              },
              description: defaultDescription,
              url: siteUrl,
              aggregateRating: {
                '@type': 'AggregateRating',
                ratingValue: '4.8',
                ratingCount: '127',
              },
            }),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'Organization',
              name: 'UniLord',
              url: siteUrl,
              logo: `${siteUrl}/logo.png`,
              description: defaultDescription,
              sameAs: [
                // Add your social media links here
                // 'https://twitter.com/unilord',
                // 'https://linkedin.com/company/unilord',
              ],
            }),
          }}
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}

