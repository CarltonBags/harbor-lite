'use client'

import { FileText, Sparkles, Download, CheckCircle } from 'lucide-react'

const steps = [
  {
    number: '01',
    title: 'Beschreibe Deine Forschung',
    description: 'Erzähle uns von Deinem Thesis-Thema, Deiner Forschungsfrage und Methodik. Unsere KI versteht akademische Anforderungen.',
    icon: FileText,
  },
  {
    number: '02',
    title: 'KI generiert Struktur',
    description: 'Unsere moderne KI erstellt eine umfassende Thesis-Struktur mit passenden Abschnitten, Zitaten und Formatierung.',
    icon: Sparkles,
  },
  {
    number: '03',
    title: 'Verfeinern & Anpassen',
    description: 'Überprüfe und verfeinere den generierten Inhalt. Nimm Änderungen vor, füge Deine Forschungsergebnisse hinzu und passe nach Bedarf an.',
    icon: CheckCircle,
  },
  {
    number: '04',
    title: 'Exportieren & Einreichen',
    description: 'Exportiere Deine Thesis als professionell formatiertes PDF oder LaTeX-Dokument, bereit zur Einreichung.',
    icon: Download,
  },
]

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-20 px-4 sm:px-6 lg:px-8 bg-white dark:bg-gray-900">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-gray-900 dark:text-white">
            So funktioniert's
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-400">
            Von der Idee zur Einreichung in vier einfachen Schritten
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {steps.map((step, index) => {
            const Icon = step.icon
            return (
              <div key={index} className="relative">
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl p-8 h-full shadow-lg">
                  <div className="flex items-center justify-between mb-6">
                    <div className="w-16 h-16 rounded-full bg-black dark:bg-white flex items-center justify-center">
                      <Icon className="w-8 h-8 text-white dark:text-black" />
                    </div>
                    <span className="text-6xl font-bold text-gray-200 dark:text-gray-700">
                      {step.number}
                    </span>
                  </div>
                  
                  <h3 className="text-xl font-bold mb-3 text-black dark:text-white">
                    {step.title}
                  </h3>
                  <p className="text-gray-600 dark:text-gray-400">
                    {step.description}
                  </p>
                </div>
                
                {index < steps.length - 1 && (
                  <div className="hidden lg:block absolute top-1/2 -right-4 transform -translate-y-1/2">
                    <div className="w-8 h-0.5 bg-yellow-600 dark:bg-yellow-500" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

