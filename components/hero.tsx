'use client'

import { useState, useEffect } from 'react'
import { ArrowRight, ChevronDown } from 'lucide-react'

const thesisTypes = ['Hausarbeit', 'Bachelorarbeit', 'Masterarbeit', 'Dissertation']

export function Hero() {
  const [currentTypeIndex, setCurrentTypeIndex] = useState(0)
  const [displayText, setDisplayText] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    const currentType = thesisTypes[currentTypeIndex]
    const targetText = currentType

    if (!isDeleting && displayText === targetText) {
      // Wait before starting to delete
      const timeout = setTimeout(() => {
        setIsDeleting(true)
      }, 2000)
      return () => clearTimeout(timeout)
    }

    if (isDeleting && displayText === '') {
      // Move to next type
      setIsDeleting(false)
      setCurrentTypeIndex((prev) => (prev + 1) % thesisTypes.length)
      return
    }

    const timeout = setTimeout(() => {
      if (isDeleting) {
        setDisplayText((prev) => prev.slice(0, -1))
      } else {
        setDisplayText((prev) => targetText.slice(0, prev.length + 1))
      }
    }, isDeleting ? 50 : 100)

    return () => clearTimeout(timeout)
  }, [displayText, isDeleting, currentTypeIndex])

  return (
    <section
      className="pt-40 md:pt-48 pb-48 md:pb-56 px-4 sm:px-6 lg:px-8 bg-white dark:bg-gray-900 bg-no-repeat relative min-h-screen flex flex-col justify-center"
      style={{
        backgroundImage: "url('/assets/deskheader.svg')",
        backgroundPosition: 'center center',
        backgroundSize: '100% auto'
      }}
    >
      <div className="max-w-5xl mx-auto relative z-10">
        <div className="text-center">
          {/* Main Hook - Elegant and Stylish */}
          {/* Main Content Container with Blur */}
          <div className="inline-block backdrop-blur-[3px] bg-white/10 dark:bg-black/10 rounded-3xl p-8 md:p-12 shadow-sm border border-white/10 max-w-4xl mx-auto">
            {/* Main Hook - Elegant and Stylish */}
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-8 md:mb-10 leading-tight">
              <span className="text-gray-900 dark:text-gray-100 block mb-2 md:mb-3 font-normal">
                Immer noch nicht mit deiner
              </span>
              <span className="font-mono text-yellow-600 dark:text-yellow-500 inline-block min-h-[1.2em] mb-2 md:mb-3 font-semibold tracking-tight">
                {displayText}
                <span className="inline-block w-0.5 h-[0.9em] bg-yellow-600 dark:bg-yellow-500 ml-1.5 animate-pulse align-middle" />
              </span>
              <span className="text-gray-900 dark:text-gray-100 block font-normal">
                angefangen?
              </span>
            </h1>

            {/* CTA - Subtle scroll-down link */}
            <div className="mb-8 md:mb-10">
              <button
                onClick={() => {
                  const servicesSection = document.querySelector('#services') || document.querySelector('main > *:nth-child(2)');
                  servicesSection?.scrollIntoView({ behavior: 'smooth' });
                }}
                className="group inline-flex flex-col items-center text-lg md:text-xl text-gray-800 dark:text-gray-200 hover:text-yellow-600 dark:hover:text-yellow-500 transition-colors font-medium"
              >
                <span>Dann lass uns loslegen</span>
                <ChevronDown className="mt-2 w-6 h-6 group-hover:translate-y-1 transition-transform" />
              </button>
            </div>

            {/* Clarifier - Subtle and Professional */}
            <p className="text-lg md:text-xl lg:text-2xl text-gray-700 dark:text-gray-300 font-light leading-relaxed max-w-2xl mx-auto">
              Vom Thema zum Entwurf in{' '}
              <span className="text-yellow-600 dark:text-yellow-500 font-medium">Minuten</span> statt{' '}
              <span className="text-gray-500 dark:text-gray-400 line-through">Wochen</span>
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
