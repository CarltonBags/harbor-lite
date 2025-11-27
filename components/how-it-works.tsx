'use client'

import { FileText, Upload, Sparkles, Wand2, Eye, Download, CheckCircle } from 'lucide-react'

const steps = [
  {
    number: '01',
    title: 'Thema & Forschungsfrage',
    description: 'Starte mit Deinem Thema. Gib Deine Forschungsfrage, Methodik und grobe Gliederung ein. Je genauer Deine Eingaben, desto präziser das Ergebnis.',
    icon: FileText,
    color: 'from-blue-500 to-blue-600',
    iconBg: 'bg-blue-100 dark:bg-blue-900',
  },
  {
    number: '02',
    title: 'Literatur & Quellen',
    description: 'Lade Deine PDF-Quellen, Notizen und Datensätze hoch. Unsere KI analysiert Deine Literatur und extrahiert automatisch die relevantesten Zitate und Fakten.',
    icon: Upload,
    color: 'from-purple-500 to-purple-600',
    iconBg: 'bg-purple-100 dark:bg-purple-900',
  },
  {
    number: '03',
    title: 'Struktur-Generierung',
    description: 'Basierend auf Deinen Vorgaben erstellt die KI eine detaillierte Gliederung. Du kannst Kapitel verschieben, umbenennen oder neue hinzufügen, bis die Struktur perfekt sitzt.',
    icon: Sparkles,
    color: 'from-pink-500 to-pink-600',
    iconBg: 'bg-pink-100 dark:bg-pink-900',
  },
  {
    number: '04',
    title: 'KI-Schreibprozess',
    description: 'Die KI schreibt Deine Thesis Kapitel für Kapitel. Sie integriert Deine Quellen, erstellt korrekte Zitate und achtet auf einen akademischen Schreibstil.',
    icon: Wand2,
    color: 'from-orange-500 to-orange-600',
    iconBg: 'bg-orange-100 dark:bg-orange-900',
  },
  {
    number: '05',
    title: 'Review & Feinschliff',
    description: 'Behalte die volle Kontrolle. Überprüfe den generierten Text, ergänze eigene Gedanken und verfeinere Argumentationen direkt im Editor.',
    icon: Eye,
    color: 'from-green-500 to-green-600',
    iconBg: 'bg-green-100 dark:bg-green-900',
  },
  {
    number: '06',
    title: 'Formatierung & Export',
    description: 'Wähle Dein gewünschtes Format. Exportiere die fertige Arbeit als perfekt formatiertes PDF, Word-Dokument (DOCX) oder LaTeX-Datei.',
    icon: Download,
    color: 'from-teal-500 to-teal-600',
    iconBg: 'bg-teal-100 dark:bg-teal-900',
  },
  {
    number: '07',
    title: 'Abgabefertig!',
    description: 'Deine Thesis ist bereit. Mit korrektem Inhaltsverzeichnis, Literaturverzeichnis und Fußnoten – fertig zur Einreichung an Deiner Hochschule.',
    icon: CheckCircle,
    color: 'from-yellow-500 to-yellow-600',
    iconBg: 'bg-yellow-100 dark:bg-yellow-900',
  },
]

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 px-4 sm:px-6 lg:px-8 bg-gradient-to-b from-white to-gray-50 dark:from-gray-900 dark:to-gray-800">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-20">
          <h2 className="text-4xl md:text-5xl font-bold mb-6 text-gray-900 dark:text-white tracking-tight">
            Dein Weg zur perfekten Thesis
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            Unser KI-gestützter Workflow begleitet Dich von der ersten Idee bis zur fertigen Abgabe.
          </p>
        </div>

        {/* Desktop Layout: Snake Pattern with Connecting Lines */}
        <div className="hidden lg:block relative">
          {/* Row 1: Steps 1-3 (Left to Right) */}
          <div className="grid grid-cols-3 gap-8 mb-12 relative">
            {steps.slice(0, 3).map((step, index) => {
              const Icon = step.icon
              return (
                <div key={index} className="relative">
                  <div className="h-full bg-white dark:bg-gray-800 rounded-2xl shadow-lg hover:shadow-xl transition-all duration-300 border border-gray-100 dark:border-gray-700 overflow-hidden">
                    <div className={`h-1.5 bg-gradient-to-r ${step.color}`} />
                    <div className="p-8">
                      <div className="flex justify-between items-start mb-6">
                        <div className={`p-3 rounded-xl ${step.iconBg}`}>
                          <Icon className="w-8 h-8 text-gray-700 dark:text-gray-300" />
                        </div>
                        <span className="text-4xl font-bold text-gray-100 dark:text-gray-800 select-none">
                          {step.number}
                        </span>
                      </div>
                      <h3 className="text-xl font-bold mb-3 text-gray-900 dark:text-white">
                        {step.title}
                      </h3>
                      <p className="text-gray-600 dark:text-gray-400 leading-relaxed text-sm">
                        {step.description}
                      </p>
                    </div>
                  </div>

                  {/* Horizontal connecting line to next step */}
                  {index < 2 && (
                    <div className="absolute top-1/2 -right-4 w-8 h-0.5 bg-gradient-to-r from-gray-300 to-gray-400 dark:from-gray-600 dark:to-gray-500 transform -translate-y-1/2">
                      <div className="absolute right-0 top-1/2 transform -translate-y-1/2">
                        <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full"></div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {/* Vertical line down from step 3 */}
            <div className="absolute right-[16.66%] top-full w-0.5 h-12 bg-gradient-to-b from-gray-300 to-gray-400 dark:from-gray-600 dark:to-gray-500 transform -translate-x-1/2">
              <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2">
                <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full"></div>
              </div>
            </div>
          </div>

          {/* Row 2: Steps 4-6 (Right to Left) */}
          <div className="grid grid-cols-3 gap-8 mb-12 relative">
            {steps.slice(3, 6).reverse().map((step, index) => {
              const Icon = step.icon
              const originalIndex = 5 - index
              return (
                <div key={originalIndex} className="relative">
                  <div className="h-full bg-white dark:bg-gray-800 rounded-2xl shadow-lg hover:shadow-xl transition-all duration-300 border border-gray-100 dark:border-gray-700 overflow-hidden">
                    <div className={`h-1.5 bg-gradient-to-r ${step.color}`} />
                    <div className="p-8">
                      <div className="flex justify-between items-start mb-6">
                        <div className={`p-3 rounded-xl ${step.iconBg}`}>
                          <Icon className="w-8 h-8 text-gray-700 dark:text-gray-300" />
                        </div>
                        <span className="text-4xl font-bold text-gray-100 dark:text-gray-800 select-none">
                          {step.number}
                        </span>
                      </div>
                      <h3 className="text-xl font-bold mb-3 text-gray-900 dark:text-white">
                        {step.title}
                      </h3>
                      <p className="text-gray-600 dark:text-gray-400 leading-relaxed text-sm">
                        {step.description}
                      </p>
                    </div>
                  </div>

                  {/* Horizontal connecting line to next step (going left) */}
                  {index < 2 && (
                    <div className="absolute top-1/2 -left-4 w-8 h-0.5 bg-gradient-to-l from-gray-300 to-gray-400 dark:from-gray-600 dark:to-gray-500 transform -translate-y-1/2">
                      <div className="absolute left-0 top-1/2 transform -translate-y-1/2">
                        <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full"></div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {/* Vertical line down from step 6 (leftmost in this row) */}
            <div className="absolute left-[16.66%] top-full w-0.5 h-12 bg-gradient-to-b from-gray-300 to-gray-400 dark:from-gray-600 dark:to-gray-500 transform -translate-x-1/2">
              <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2">
                <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full"></div>
              </div>
            </div>
          </div>

          {/* Row 3: Step 7 (Centered) */}
          <div className="flex justify-center">
            <div className="w-full max-w-sm">
              {(() => {
                const step = steps[6]
                const Icon = step.icon
                return (
                  <div className="h-full bg-white dark:bg-gray-800 rounded-2xl shadow-lg hover:shadow-xl transition-all duration-300 border-2 border-yellow-400 dark:border-yellow-600 overflow-hidden">
                    <div className={`h-1.5 bg-gradient-to-r ${step.color}`} />
                    <div className="p-8">
                      <div className="flex justify-between items-start mb-6">
                        <div className={`p-3 rounded-xl ${step.iconBg}`}>
                          <Icon className="w-8 h-8 text-gray-700 dark:text-gray-300" />
                        </div>
                        <span className="text-4xl font-bold text-gray-100 dark:text-gray-800 select-none">
                          {step.number}
                        </span>
                      </div>
                      <h3 className="text-xl font-bold mb-3 text-gray-900 dark:text-white">
                        {step.title}
                      </h3>
                      <p className="text-gray-600 dark:text-gray-400 leading-relaxed text-sm">
                        {step.description}
                      </p>
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
        </div>

        {/* Mobile Layout: Simple Top to Bottom without Lines */}
        <div className="lg:hidden space-y-6">
          {steps.map((step, index) => {
            const Icon = step.icon
            return (
              <div key={index}>
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-md border border-gray-100 dark:border-gray-700 overflow-hidden">
                  <div className={`h-1.5 bg-gradient-to-r ${step.color}`} />
                  <div className="p-6 flex gap-6">
                    <div className="flex-shrink-0">
                      <div className={`p-3 rounded-xl ${step.iconBg}`}>
                        <Icon className="w-6 h-6 text-gray-700 dark:text-gray-300" />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                          {step.title}
                        </h3>
                        <span className="text-2xl font-bold text-gray-100 dark:text-gray-800">
                          {step.number}
                        </span>
                      </div>
                      <p className="text-gray-600 dark:text-gray-400 text-sm leading-relaxed">
                        {step.description}
                      </p>
                    </div>
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
