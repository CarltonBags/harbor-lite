'use client'

import { Sparkles, Zap, Shield, CheckCircle, GitBranch } from 'lucide-react'

const uniqueFeatures = [
  {
    icon: Sparkles,
    title: 'KI-gestützte Bearbeitung',
    description: 'Nach dem ersten Entwurf kannst du manuell oder KI-assistiert editieren. Sechs inklusive KI-Umschreib-Prompts für präzise Anpassungen.',
  },
  {
    icon: Zap,
    title: 'Interaktiver Editor',
    description: 'Bearbeite deine Thesis direkt im Editor. Nutze KI-Prompts für gezielte Verbesserungen einzelner Abschnitte oder Kapitel.',
  },
  {
    icon: GitBranch,
    title: 'Versionskontrolle',
    description: 'Alle Änderungen werden automatisch gespeichert. Kehre zu früheren Versionen zurück, vergleiche Änderungen und verwalte deine Thesis-Versionen sicher.',
  },
  {
    icon: CheckCircle,
    title: 'Vollständige Kontrolle',
    description: 'Du bestimmst, was geändert wird. Manuelle Bearbeitung, KI-Assistenz oder beides – du hast die volle Kontrolle über deinen Text.',
  },
]

export function UniqueProcess() {
  return (
    <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-yellow-50 to-yellow-100 dark:from-gray-800 dark:to-gray-900">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <div className="inline-block mb-4">
            <span className="px-4 py-2 bg-yellow-600 dark:bg-yellow-500 text-black dark:text-white rounded-full text-sm font-semibold">
              Einzigartig
            </span>
          </div>
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-gray-900 dark:text-white">
            Der erste Thesis-Generator mit integrierter Bearbeitung
          </h2>
          <p className="text-xl text-gray-700 dark:text-gray-300 max-w-3xl mx-auto">
            Während andere Tools nur generieren, bietet ThesisMeister als erstes Tool manuelle und KI-assistierte Bearbeitung direkt im Editor.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 max-w-7xl mx-auto">
          {uniqueFeatures.map((feature, index) => {
            const Icon = feature.icon
            return (
              <div
                key={index}
                className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-lg border-2 border-yellow-200 dark:border-yellow-800 hover:shadow-xl transition-all"
              >
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-lg bg-yellow-600 dark:bg-yellow-500 flex items-center justify-center flex-shrink-0">
                    <Icon className="w-6 h-6 text-white dark:text-black" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold mb-2 text-gray-900 dark:text-white">
                      {feature.title}
                    </h3>
                    <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        
      </div>
    </section>
  )
}

