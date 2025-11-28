'use client'

import { Users, FileText, Clock, CheckCircle } from 'lucide-react'

const stats = [
  {
    icon: FileText,
    value: '100+',
    label: 'Theses generiert',
    description: 'In Tests und Produktion',
  },
  {
    icon: Clock,
    value: 'Wochen',
    label: 'Zeitersparnis',
    description: 'Von der Recherche bis zum Entwurf',
  },
  {
    icon: CheckCircle,
    value: '100%',
    label: 'KI-Detection geschützt',
    description: 'Automatische Humanisierung',
  },
  {
    icon: Users,
    value: 'Neu',
    label: 'Jetzt verfügbar',
    description: 'Starte deine Thesis heute',
  },
]

export function Stats() {
  return (
    <section className="py-20 px-4 sm:px-6 lg:px-8 bg-white dark:bg-gray-900">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-gray-900 dark:text-white">
            Was wir erreicht haben
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-400">
            Erste Erfolge und kontinuierliche Verbesserung
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {stats.map((stat, index) => {
            const Icon = stat.icon
            return (
              <div
                key={index}
                className="bg-gray-50 dark:bg-gray-800 rounded-xl p-8 text-center border border-gray-200 dark:border-gray-700 hover:shadow-lg transition-shadow"
              >
                <div className="w-16 h-16 rounded-full bg-yellow-600 dark:bg-yellow-500 flex items-center justify-center mx-auto mb-4">
                  <Icon className="w-8 h-8 text-white dark:text-black" />
                </div>
                <div className="text-4xl md:text-5xl font-bold text-gray-900 dark:text-white mb-2">
                  {stat.value}
                </div>
                <div className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-1">
                  {stat.label}
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  {stat.description}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

