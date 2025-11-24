'use client'

import { useState, useEffect } from 'react'
import { ArrowRight } from 'lucide-react'

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
    <section className="pt-24 md:pt-32 pb-20 md:pb-28 px-4 sm:px-6 lg:px-8 bg-white dark:bg-gray-900">
      <div className="max-w-5xl mx-auto">
        <div className="text-center">
          {/* Main Hook - Elegant and Stylish */}
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-8 md:mb-12 leading-tight">
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

          {/* CTA - Refined and Professional */}
          <div className="mb-10 md:mb-12">
            <a
              href="/thesis/new"
              className="group inline-flex items-center px-8 py-3.5 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium text-base md:text-lg hover:bg-blue-600 dark:hover:bg-blue-500 transition-all shadow-md hover:shadow-lg"
            >
              Dann lass uns loslegen
              <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </a>
          </div>

          {/* Clarifier - Subtle and Professional */}
          <p className="text-lg md:text-xl lg:text-2xl text-gray-600 dark:text-gray-400 font-light leading-relaxed max-w-2xl mx-auto">
            Vom Thema zum Entwurf in{' '}
            <span className="text-yellow-600 dark:text-yellow-500 font-medium">Minuten</span> statt{' '}
            <span className="text-gray-400 dark:text-gray-500 line-through">Wochen</span>
          </p>
        </div>
      </div>
    </section>
  )
}

