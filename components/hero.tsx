'use client'

import { ArrowRight, Sparkles, FileText, Zap } from 'lucide-react'

export function Hero() {
  return (
    <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-b from-white to-gray-50 dark:from-gray-900 dark:to-gray-800">
      <div className="max-w-7xl mx-auto">
        <div className="text-center">
          <div className="inline-flex items-center px-4 py-2 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 mb-8">
            <Sparkles className="w-4 h-4 mr-2" />
            <span className="text-sm font-medium">KI-gestütztes Thesis-Schreiben</span>
          </div>
          
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold mb-6">
            <span className="bg-gradient-to-r from-purple-600 via-pink-600 to-blue-600 dark:from-purple-400 dark:via-pink-400 dark:to-blue-400 bg-clip-text text-transparent">
              Schreibe Deine Thesis
            </span>
            <br />
            <span className="text-gray-900 dark:text-white">Mit KI-Präzision</span>
          </h1>
          
          <p className="text-xl md:text-2xl text-gray-600 dark:text-gray-300 mb-12 max-w-3xl mx-auto">
            Verwandele Deine Forschung in eine polierte, publikationsreife Thesis. 
            Angetrieben von moderner KI, LaTeX-Formatierung und akademischer Exzellenz.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-16">
            <a
              href="/thesis/new"
              className="group px-8 py-4 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-xl font-semibold text-lg hover:from-purple-700 hover:to-blue-700 transition-all shadow-lg hover:shadow-2xl flex items-center"
            >
              Kostenlos starten
              <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </a>
            <a
              href="#how-it-works"
              className="px-8 py-4 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-xl font-semibold text-lg border-2 border-gray-200 dark:border-gray-700 hover:border-purple-300 dark:hover:border-purple-600 transition-all"
            >
              So funktioniert's
            </a>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            <div className="p-6 bg-white dark:bg-gray-800 rounded-xl shadow-lg">
              <FileText className="w-10 h-10 text-purple-600 dark:text-purple-400 mb-4 mx-auto" />
              <h3 className="font-semibold text-lg mb-2">LaTeX-Ready</h3>
              <p className="text-gray-600 dark:text-gray-400 text-sm">
                Professionell formatierte Dokumente, bereit zur Einreichung
              </p>
            </div>
            <div className="p-6 bg-white dark:bg-gray-800 rounded-xl shadow-lg">
              <Zap className="w-10 h-10 text-purple-600 dark:text-purple-400 mb-4 mx-auto" />
              <h3 className="font-semibold text-lg mb-2">KI-gestützt</h3>
              <p className="text-gray-600 dark:text-gray-400 text-sm">
                Moderne KI hilft bei Strukturierung und Verfeinerung Deiner Forschung
              </p>
            </div>
            <div className="p-6 bg-white dark:bg-gray-800 rounded-xl shadow-lg">
              <Sparkles className="w-10 h-10 text-purple-600 dark:text-purple-400 mb-4 mx-auto" />
              <h3 className="font-semibold text-lg mb-2">Zeitsparend</h3>
              <p className="text-gray-600 dark:text-gray-400 text-sm">
                Konzentriere Dich auf die Forschung, während die KI Formatierung und Struktur übernimmt
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

