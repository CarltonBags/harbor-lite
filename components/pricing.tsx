'use client'

import { Check, Sparkles } from 'lucide-react'

const plans = [
  {
    name: 'V1 Starter Draft',
    price: '$79',
    period: '',
    description: 'Ideal "one-time thesis package"',
    planType: 'starter' as const,
    features: [
      'Vollständiger Thesis-Entwurf',
      '10 KI-Umschreib-Prompts',
      'Unbegrenzte manuelle Bearbeitungen',
      '1 PDF-Upload',
      'Basis Exa-Recherche',
      'PDF-Export',
    ],
    popular: false,
  },
  {
    name: 'Top-Up Pack',
    price: '$15',
    period: '/ 5 Prompts',
    description: 'Zusätzliche KI-Umschreib-Prompts',
    planType: 'topup' as const,
    features: [
      '5 zusätzliche KI-Umschreib-Prompts',
      'Kann mehrfach gekauft werden',
      'Keine Ablaufzeit',
    ],
    popular: false,
  },
  {
    name: 'Pro Thesis Package',
    price: '$149',
    period: '',
    description: 'Für erweiterte Recherche + Grafiken',
    planType: 'pro' as const,
    features: [
      'Vollständiger Thesis-Entwurf',
      '20 KI-Umschreib-Prompts',
      '5 PDF-Uploads',
      'Erweiterte Exa-Recherche',
      'KI-Figuren-Generierung',
      'PDF & Word Export',
    ],
    popular: true,
  },
  {
    name: 'Premium / Academic',
    price: '$249',
    period: '',
    description: 'Für Universitäten, Betreuer, fortgeschrittene Nutzer',
    planType: 'premium' as const,
    features: [
      'Unbegrenzte Entwürfe',
      'Unbegrenzte KI-Umschreib-Prompts',
      'Unbegrenzte PDF-Uploads',
      'Prioritäts Exa-Recherche + LLM',
      'Multi-Thesis Support',
      'Export zu Word/PDF/LaTeX',
      'Prioritäts-Support',
    ],
    popular: false,
  },
]

export function Pricing() {
  return (
    <section id="pricing" className="py-20 px-4 sm:px-6 lg:px-8 bg-white dark:bg-gray-900">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-gray-900 dark:text-white">
            Einfache, transparente Preise
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-400">
            Wähle den Plan, der zu Deinem akademischen Weg passt
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`relative rounded-2xl p-8 ${
                plan.popular
                  ? 'bg-gradient-to-br from-purple-600 to-blue-600 text-white shadow-2xl scale-105'
                  : 'bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white shadow-lg'
              }`}
            >
              {plan.popular && (
                <div className="absolute -top-4 left-1/2 transform -translate-x-1/2">
                  <span className="bg-yellow-400 text-gray-900 px-4 py-1 rounded-full text-sm font-semibold flex items-center">
                    <Sparkles className="w-4 h-4 mr-1" />
                    Beliebtester
                  </span>
                </div>
              )}
              
              <div className="mb-6">
                <h3 className="text-2xl font-bold mb-2">{plan.name}</h3>
                <p className={`text-sm mb-4 ${plan.popular ? 'text-purple-100' : 'text-gray-600 dark:text-gray-400'}`}>
                  {plan.description}
                </p>
                <div className="flex items-baseline">
                  <span className="text-5xl font-bold">{plan.price}</span>
                  {plan.period && (
                    <span className={`ml-2 text-lg ${plan.popular ? 'text-purple-100' : 'text-gray-600 dark:text-gray-400'}`}>
                      {plan.period}
                    </span>
                  )}
                </div>
              </div>
              
              <ul className="space-y-4 mb-8">
                {plan.features.map((feature, index) => (
                  <li key={index} className="flex items-start">
                    <Check className={`w-5 h-5 mr-3 flex-shrink-0 ${plan.popular ? 'text-white' : 'text-purple-600 dark:text-purple-400'}`} />
                    <span className={plan.popular ? 'text-purple-50' : 'text-gray-700 dark:text-gray-300'}>
                      {feature}
                    </span>
                  </li>
                ))}
              </ul>
              
              <button
                className={`w-full py-3 rounded-lg font-semibold transition-all ${
                  plan.popular
                    ? 'bg-white text-purple-600 hover:bg-purple-50'
                    : 'bg-purple-600 text-white hover:bg-purple-700'
                }`}
              >
                Loslegen
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

