import { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://unilord.com'

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/thesis/preview', '/thesis/generate', '/thesis/new', '/auth/'],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  }
}

