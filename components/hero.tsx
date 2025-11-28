'use client'

import { useState, useEffect } from 'react'
import { ArrowRight, ChevronDown } from 'lucide-react'

const thesisTypes = ['Hausarbeit', 'Bachelorarbeit', 'Masterarbeit']

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
      className="pt-16 md:pt-40 lg:pt-48 pb-16 md:pb-40 lg:pb-56 px-4 sm:px-6 lg:px-8 bg-white bg-cover bg-no-repeat relative min-h-[70vh] md:min-h-screen flex flex-col justify-center bg-center"
      style={{
        backgroundImage: "url('/assets/deskheader.png')",
      }}
    >
      <div className="max-w-6xl mx-auto relative z-10">
        <div className="text-center">
          {/* Main Hook - Elegant and Stylish */}
          {/* Main Content Container with Blur */}
          <div className="w-full min-h-[300px] md:min-w-[600px] flex flex-col justify-center backdrop-blur-[3px] bg-white/10 rounded-2xl md:rounded-3xl p-4 md:p-12 shadow-sm border border-white/10 max-w-4xl mx-auto">
            {/* Main Hook - Elegant and Stylish */}
            <h1 className="text-3xl md:text-5xl lg:text-6xl font-bold mb-4 md:mb-10 leading-tight">
              <span className="text-gray-900 block mb-1 md:mb-3 font-normal">
                Vom Thema zur
              </span>
              <span className="font-mono text-yellow-600 inline-block min-w-[300px] md:min-w-[450px] min-h-[1.2em] mb-1 md:mb-3 font-semibold tracking-tight">
                {displayText}
                <span className="inline-block w-0.5 h-[0.9em] bg-yellow-600 ml-1.5 animate-pulse align-middle" />
              </span>
              <span className="text-gray-900 block font-normal">
                in Minuten
              </span>
            </h1>

            {/* CTA - Subtle scroll-down link */}
            <div className="mb-0 md:mb-10">
              <button
                onClick={() => {
                  const servicesSection = document.querySelector('#services') || document.querySelector('main > *:nth-child(2)');
                  servicesSection?.scrollIntoView({ behavior: 'smooth' });
                }}
                className="group inline-flex flex-col items-center text-base md:text-xl text-gray-800 transition-colors font-medium"
              >
                <div className="flex flex-col items-center gap-2">
                  <span className="font-semibold bg-white border-2 border-black text-black hover:bg-sky-300/20 px-4 py-2 rounded-full w-56 md:w-64">Los geht's!</span>
                  <p className="flex flex-row items-center gap-2">
                    <span className="text-xs rounded-full px-2 py-1 bg-sky-300/20 border-black">100% legal</span>
                    <span className="text-xs rounded-full px-2 py-1 bg-sky-300/20 border-black">kein Abo</span>
                    <span className="text-xs rounded-full px-2 py-1 bg-sky-300/20 border-black">AI-powered</span>
                  </p>
                </div>
              </button>
            </div>

            {/* Clarifier - Subtle and Professional 
            <p className="text-lg md:text-xl lg:text-2xl text-gray-700 font-light leading-relaxed max-w-2xl mx-auto">
              Vom Thema zum Entwurf in{' '}
              <span className="text-yellow-600 font-medium">Minuten</span> statt{' '}
              <span className="text-gray-500 line-through">Wochen</span>
            </p>*/}
          </div>
        </div>
      </div>
    </section>
  )
}
