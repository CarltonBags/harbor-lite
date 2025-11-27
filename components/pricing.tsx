'use client'

import { Check, Sparkles, ChevronDown } from 'lucide-react'
import { useState } from 'react'

const plans = [
  {
    name: 'Draft Package',
    price: '59€',
    period: '',
    description: 'Alles was du brauchst',
    planType: 'starter' as const,
    features: [
      'Vollständiger Thesis-Entwurf',
      'Sechs KI-Umschreib-Prompts',
      'KI-Literaturrecherche',
      'Plagiatsprüfung',
      'Humanisierter Text gegen KI-Detection',
      'Unbegrenzte manuelle Bearbeitungen',
      'Export als .docx oder LaTeX-file',
    ],
    popular: false,
  },
  {
    name: 'Booster Pack',
    price: '10€',
    period: '/ 20 Prompts',
    description: 'Zusätzliche KI-Umschreib-Prompts',
    planType: 'topup' as const,
    features: [
      '5 zusätzliche KI-Umschreib-Prompts',
      'Kann mehrfach gekauft werden',
      'Keine Ablaufzeit',
    ],
    popular: false,
  },

]

const faqs = [
  {
    question: 'Muss ich selbst eine Gliederung oder eine Forschungsfrage hochladen?',
    answer: 'Nein! Bring mit, was du hast, den Rest übernehmen wir.',
  },
  {
    question: 'Ist das nicht illegal?',
    answer: 'Nein! Bedenke, du erwirbst hier nur einen Entwurf deiner Arbeit. Bearbeite diesen weiter und mache die Thesis zu deiner.',
  },
  {
    question: 'Was passiert mit meinen Daten?',
    answer: 'Deine Daten sind sicher. Weder verkaufen wir deine Daten, noch werden sie irgendwo publiziert.',
  },
  {
    question: 'Kann meine Arbeit von KI-Detektoren erkannt werden?',
    answer: 'Während der Generierung deiner Thesis wird diese durch KI-Detektoren geprüft und automatisch angepasst, bis ein Human-Score von mindestens 70% erreicht ist.',
  },
  {
    question: 'Ist das ein Abo?',
    answer: 'Nein, wir verkaufen keinerlei Abos! Alle Pakete sind Einzelprodukte, die du nur ein mal bezahlst.',
  },
  {
    question: 'Wie lange bleibt meine Thesis gespeichert?',
    answer: 'Solange, wie du willst. Du kannst über einen unbegrenzten Zeitraum deine Thesis weiter bearbeiten. Wenn du bedenken haben solltest, kannst du deine Thesis löschen. Diese wird dann unwiederbringlich aus unserem System gelöscht.',
  },
]

export function Pricing() {
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null)

  const toggleFaq = (index: number) => {
    setOpenFaqIndex(openFaqIndex === index ? null : index)
  }

  return (
    <section id="pricing" className="py-20 px-4 sm:px-6 lg:px-8 bg-white dark:bg-gray-900">
      <div className="max-w-7xl mx-auto">
        {/* FAQ Section */}
        <div className="mb-20">
          <div className="text-center mb-12">
            <h2 className="text-4xl md:text-5xl font-bold mb-4 text-gray-900 dark:text-white">
              Häufig gestellte Fragen
            </h2>
            <p className="text-xl text-gray-600 dark:text-gray-400">
              Wir beantworten deine wichtigsten Fragen
            </p>
          </div>

          <div className="max-w-3xl mx-auto space-y-4">
            {faqs.map((faq, index) => (
              <div
                key={index}
                className="bg-white dark:bg-gray-800 rounded-xl border-2 border-gray-200 dark:border-gray-700 overflow-hidden transition-all"
              >
                <button
                  onClick={() => toggleFaq(index)}
                  className="w-full px-6 py-5 text-left flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <span className="text-lg font-semibold text-gray-900 dark:text-white pr-8">
                    {faq.question}
                  </span>
                  <ChevronDown
                    className={`w-6 h-6 text-yellow-600 dark:text-yellow-500 flex-shrink-0 transition-transform duration-200 ${openFaqIndex === index ? 'rotate-180' : ''
                      }`}
                  />
                </button>

                <div
                  className={`overflow-hidden transition-all duration-200 ${openFaqIndex === index ? 'max-h-96' : 'max-h-0'
                    }`}
                >
                  <div className="px-6 pb-5 pt-2">
                    <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                      {faq.answer}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Pricing Section */}
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-gray-900 dark:text-white">
            Einfache, transparente Preise
          </h2>
        </div>
        <div className="flex flex-col md:flex-row justify-center items-center md:items-stretch gap-6 max-w-7xl mx-auto">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`relative rounded-2xl p-8 border-2 w-full max-w-md flex flex-col ${plan.popular
                ? 'bg-yellow-600 dark:bg-yellow-700 text-black shadow-2xl scale-105 border-yellow-700 dark:border-yellow-800'
                : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-lg border-gray-200 dark:border-gray-700'
                }`}
            >
              <div className="mb-6">
                <h3 className="text-2xl font-bold mb-2">{plan.name}</h3>
                <p className={`text-sm mb-4 ${plan.popular ? 'text-yellow-100' : 'text-gray-600 dark:text-gray-400'}`}>
                  {plan.description}
                </p>
                <div className="flex items-baseline">
                  <span className="text-5xl font-bold">{plan.price}</span>
                  {plan.period && (
                    <span className={`ml-2 text-lg ${plan.popular ? 'text-yellow-100' : 'text-gray-600 dark:text-gray-400'}`}>
                      {plan.period}
                    </span>
                  )}
                </div>
              </div>

              <ul className="space-y-4 mb-8 flex-1">
                {plan.features.map((feature, index) => (
                  <li key={index} className="flex items-start">
                    <Check className={`w-5 h-5 mr-3 flex-shrink-0 ${plan.popular ? 'text-black' : 'text-yellow-600 dark:text-yellow-500'}`} />
                    <span className={plan.popular ? 'text-yellow-50' : 'text-gray-700 dark:text-gray-300'}>
                      {feature}
                    </span>
                  </li>
                ))}
              </ul>

              <button
                className={`w-full py-3 rounded-lg font-semibold transition-all mt-auto ${plan.popular
                  ? 'bg-black dark:bg-white text-white dark:text-black hover:bg-blue-600 dark:hover:bg-blue-500'
                  : 'bg-black dark:bg-white text-white dark:text-black hover:bg-blue-600 dark:hover:bg-blue-500'
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

