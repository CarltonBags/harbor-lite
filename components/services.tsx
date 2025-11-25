'use client'

import { Clock, Brain, CheckCircle } from 'lucide-react'

const valueProps = [
  {
    icon: Clock,
    title: 'Spare Wochen der Arbeit',
    description: 'Von der Recherche bis zum fertigen Entwurf in Minuten statt Wochen. Unsere KI übernimmt die zeitaufwendige Arbeit.',
  },
  {
    icon: Brain,
    title: 'Argumentiere mit KI-Präzision',
    description: 'Folge dem Roten Faden zur beantwortung deiner Forschungsfrage mit kohärenter Gedankenführung durch fortschrittliche KI.',
  },
  {
    icon: CheckCircle,
    title: 'Vermeide strukturelle Fehler',
    description: 'Automatische Gliederung, die zu deiner Forschungsfrage passt und professionelle Formatierung – keine strukturellen Schwächen mehr.',
  },
]

export function Services() {
  return (
    <section id="services" className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50 dark:bg-gray-800">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-black dark:text-white">
            Warum ThesisMeister?
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-400">
            Deine Vorteile auf einen Blick
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {valueProps.map((prop, index) => {
            const Icon = prop.icon
            return (
              <div key={index} className="bg-white dark:bg-gray-900 rounded-xl p-8 shadow-lg border border-gray-200 dark:border-gray-700 hover:shadow-xl transition-shadow">
                <div className="w-16 h-16 rounded-full bg-yellow-600 dark:bg-yellow-500 flex items-center justify-center mb-6">
                  <Icon className="w-8 h-8 text-white dark:text-black" />
                </div>
                <h3 className="text-xl font-bold mb-3 text-black dark:text-white">
                  {prop.title}
                </h3>
                <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                  {prop.description}
                </p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
