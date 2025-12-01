import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '@/lib/theme-provider'

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://thesismeister.com'
const siteName = 'ThesisMeister'
const defaultTitle = 'ThesisMeister - KI-gestützter Wissenschaftlicher Thesis-Schreiber'
const defaultDescription = 'Vom Thema zum Entwurf in Minuten statt Wochen. KI-gestützter Assistent zum Schreiben wissenschaftlicher Arbeiten für Studenten und Forscher. Hausarbeit, Seminararbeit oder Bachelorarbeit - wir helfen dir dabei.'

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
    'Seminararbeit',
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
  authors: [{ name: 'ThesisMeister' }],
  creator: 'ThesisMeister',
  publisher: 'ThesisMeister',
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
        alt: 'ThesisMeister - KI-gestützter Thesis-Schreiber',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: defaultTitle,
    description: defaultDescription,
    images: [`${siteUrl}/og-image.jpg`],
    creator: '@thesismeister',
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'SoftwareApplication',
              name: 'ThesisMeister',
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
              name: 'ThesisMeister',
              url: siteUrl,
              logo: `${siteUrl}/logo.png`,
              description: defaultDescription,
              sameAs: [
                // Add your social media links here
                // 'https://twitter.com/thesismeister',
                // 'https://linkedin.com/company/thesismeister',
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

