'use client'

import { FileText, GraduationCap, Award, BookOpen } from 'lucide-react'

const examples = [
  {
    type: 'Hausarbeit',
    icon: BookOpen,
    title: 'Beispiel Hausarbeit',
    subject: 'Soziologie',
    pages: '12 Seiten',
    description: 'Eine vollständige Hausarbeit über moderne Gesellschaftsstrukturen mit korrekter Zitierung und Formatierung.',
    image: '/examples/hausarbeit-placeholder.png',
    color: 'from-blue-500 to-blue-600',
  },
  {
    type: 'Bachelorarbeit',
    icon: GraduationCap,
    title: 'Beispiel Bachelorarbeit',
    subject: 'Wirtschaftswissenschaften',
    pages: '45 Seiten',
    description: 'Eine umfassende Bachelorarbeit mit Literaturrecherche, empirischer Analyse und professioneller Formatierung.',
    image: '/examples/bachelorarbeit-placeholder.png',
    color: 'from-purple-500 to-purple-600',
  },
  {
    type: 'Masterarbeit',
    icon: Award,
    title: 'Beispiel Masterarbeit',
    subject: 'Informatik',
    pages: '80 Seiten',
    description: 'Eine detaillierte Masterarbeit mit komplexer Methodik, umfangreicher Literaturanalyse und wissenschaftlicher Tiefe.',
    image: '/examples/masterarbeit-placeholder.png',
    color: 'from-yellow-500 to-yellow-600',
  },
]

export function ThesisExamples() {
  return (
    <section id="examples" className="py-20 px-4 sm:px-6 lg:px-8 bg-white dark:bg-gray-900">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-gray-900 dark:text-white">
            Beispiele unserer Arbeit
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-400">
            Sieh dir echte Beispiele generierter Theses an
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {examples.map((example, index) => {
            const Icon = example.icon
            return (
              <div
                key={index}
                className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden hover:shadow-xl transition-all duration-300 group"
              >
                {/* Image placeholder */}
                <div className="relative h-64 bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-700 dark:to-gray-800 overflow-hidden">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center p-8">
                      <Icon className="w-16 h-16 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
                      <p className="text-sm text-gray-500 dark:text-gray-400 font-medium">
                        {example.type}
                      </p>
                      <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                        Platzhalter - Bild wird später hochgeladen
                      </p>
                    </div>
                  </div>
                  {/* Badge */}
                  <div className={`absolute top-4 right-4 px-3 py-1 rounded-full bg-gradient-to-r ${example.color} text-white text-xs font-semibold shadow-lg`}>
                    {example.type}
                  </div>
                </div>

                {/* Content */}
                <div className="p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <Icon className={`w-5 h-5 bg-gradient-to-r ${example.color} bg-clip-text text-transparent`} />
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                      {example.title}
                    </h3>
                  </div>
                  
                  <div className="flex items-center gap-4 mb-4 text-sm text-gray-600 dark:text-gray-400">
                    <span className="flex items-center gap-1">
                      <FileText className="w-4 h-4" />
                      {example.subject}
                    </span>
                    <span>•</span>
                    <span>{example.pages}</span>
                  </div>

                  <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                    {example.description}
                  </p>

                  <button className="w-full py-2 px-4 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors group-hover:shadow-md">
                    Beispiel ansehen
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="text-center mt-12">
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            Alle Beispiele wurden mit ThesisMeister generiert
          </p>
          <a
            href="/thesis/new"
            className="inline-flex items-center px-6 py-3 bg-yellow-600 dark:bg-yellow-500 text-black dark:text-white rounded-lg font-semibold hover:bg-yellow-700 dark:hover:bg-yellow-400 transition-colors no-underline"
          >
            Jetzt deine eigene Thesis erstellen
          </a>
        </div>
      </div>
    </section>
  )
}

