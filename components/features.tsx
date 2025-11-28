'use client'

import { FileText, Zap, Shield, Users, Globe, BarChart } from 'lucide-react'

const features = [
  {
    icon: FileText,
    title: 'LaTeX & DOCX',
    description: 'Professionelle akademische Formatierung mit LaTeX und DOCX.',
  },
  {
    icon: Zap,
    title: 'KI-Content-Generierung',
    description: 'Moderne KI hilft Dir, Deine Forschung zu strukturieren, Inhalte zu generieren und Dein Schreiben zu verfeinern.',
  },
  {
    icon: Shield,
    title: 'Zitationsverwaltung',
    description: 'Automatische Zitationsformatierung für alle wichtigen akademischen Stile (APA, MLA, Chicago, etc.).',
  },
 
  
]

export function Features() {
  return (
    <section id="features" className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50 dark:bg-gray-800">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-gray-900 dark:text-white">
            Alles was Du brauchst
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-400">
            Leistungsstarke Funktionen für müheloses Thesis-Schreiben
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => {
            const Icon = feature.icon
            return (
              <div
                key={index}
                className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-lg hover:shadow-xl transition-shadow"
              >
                <div className="w-12 h-12 rounded-lg bg-black dark:bg-white flex items-center justify-center mb-4">
                  <Icon className="w-6 h-6 text-white dark:text-black" />
                </div>
                <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">
                  {feature.title}
                </h3>
                <p className="text-gray-600 dark:text-gray-400">
                  {feature.description}
                </p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

