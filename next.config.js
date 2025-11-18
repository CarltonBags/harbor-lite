/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Headers required for WebContainer (SharedArrayBuffer support)
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp',
          },
        ],
      },
    ]
  },
  // Turbopack configuration
  experimental: {
    turbo: {
      // Turbopack will handle client-side only modules automatically
      // Dynamic imports and 'use client' directives are sufficient
    },
  },
  // Webpack config - needed for production builds
  // Warning in dev with Turbopack is harmless - Turbopack ignores this config
  webpack: (config, { isServer }) => {
    // Exclude @webcontainer/api from server-side bundle only
    // On client-side, it should be bundled normally
    if (isServer) {
      config.externals = config.externals || []
      if (Array.isArray(config.externals)) {
        config.externals.push('@webcontainer/api')
      } else {
        config.externals = [config.externals, '@webcontainer/api']
      }
      
      // Ignore @webcontainer/api during server-side module resolution
      config.resolve.fallback = {
        ...config.resolve.fallback,
        '@webcontainer/api': false,
      }
    }
    // Client-side: allow normal bundling of @webcontainer/api
    
    return config
  },
}

module.exports = nextConfig

