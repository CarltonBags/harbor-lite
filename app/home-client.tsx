'use client'

import { Navbar } from '@/components/navbar'
import { Hero } from '@/components/hero'
import { Services } from '@/components/services'
import { Pricing } from '@/components/pricing'
import { Features } from '@/components/features'
import { HowItWorks } from '@/components/how-it-works'
import { Testimonials } from '@/components/testimonials'
import { Footer } from '@/components/footer'

export function HomePageClient() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-900">
      <Navbar />
      <main>
        <Hero />
        <Services />
        <Pricing />
        <Features />
        <HowItWorks />
        <Testimonials />
      </main>
      <Footer />
    </div>
  )
}

