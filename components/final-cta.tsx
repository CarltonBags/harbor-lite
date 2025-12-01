'use client'

import { ArrowRight, Sparkles } from 'lucide-react'

export function FinalCTA() {
  return (
    <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-yellow-600 to-yellow-500 dark:from-yellow-700 dark:to-yellow-600">
      <div className="max-w-4xl mx-auto text-center">
        <div className="mb-8">
          <Sparkles className="w-16 h-16 text-white mx-auto mb-4" />
          <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">
            Bereit, deine Thesis zu starten?
          </h2>
          <p className="text-xl text-yellow-50 mb-8 max-w-2xl mx-auto">
            Vom Thema zum fertigen Entwurf in Minuten. Keine Abos, keine versteckten Kosten – einfach loslegen.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <a
            href="/thesis/new"
            className="group inline-flex items-center px-8 py-4 bg-black text-white rounded-xl font-semibold text-lg hover:bg-gray-800 transition-all shadow-lg no-underline"
          >
            Jetzt starten
            <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </a>
          <a
            href="#pricing"
            className="inline-flex items-center px-8 py-4 bg-white text-black rounded-xl font-semibold text-lg hover:bg-gray-100 transition-all shadow-lg no-underline"
          >
            Preise ansehen
          </a>
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-4 text-yellow-50 text-sm">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 bg-white rounded-full"></span>
            Keine Kreditkarte erforderlich
          </span>
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 bg-white rounded-full"></span>
            Sofort loslegen
          </span>
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 bg-white rounded-full"></span>
            100% sicher
          </span>
        </div>
      </div>
    </section>
  )
}



