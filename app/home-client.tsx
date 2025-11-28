'use client'

import { Navbar } from '@/components/navbar'
import { Hero } from '@/components/hero'
import { Services } from '@/components/services'
import { Stats } from '@/components/stats'
import { Features } from '@/components/features'
import { UniqueProcess } from '@/components/unique-process'
import { HowItWorks } from '@/components/how-it-works'
import { ThesisExamples } from '@/components/thesis-examples'
import { Pricing } from '@/components/pricing'
import { TrustBadges } from '@/components/trust-badges'
import { Testimonials } from '@/components/testimonials'
import { FinalCTA } from '@/components/final-cta'
import { Footer } from '@/components/footer'

export function HomePageClient() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-900">
      <Navbar />
      <main>
        <Hero />
        <Services />
        <Stats />
        <UniqueProcess />
        <HowItWorks />
        <ThesisExamples />
        <Pricing />
        <TrustBadges />
        <Testimonials />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  )
}

