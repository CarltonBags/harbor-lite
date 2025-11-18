'use client'

import { Navbar } from '@/components/navbar'
import { Hero } from '@/components/hero'
import { Features } from '@/components/features'
import { HowItWorks } from '@/components/how-it-works'
import { Pricing } from '@/components/pricing'
import { Testimonials } from '@/components/testimonials'
import { Footer } from '@/components/footer'

export default function Home() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-900">
      <Navbar />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Pricing />
        <Testimonials />
      </main>
      <Footer />
    </div>
  )
}
