'use client'

import { FileText, Search, List, Upload, Rocket, ArrowRight } from 'lucide-react'

const services = [
  {
    step: 1,
    icon: FileText,
    title: 'Thema eingeben',
    description: 'Einfach dein Thema eingeben',
  },
  {
    step: 2,
    icon: Search,
    title: 'Forschungsfrage',
    description: 'Selbst angeben oder Auswahl generieren lassen',
  },
  {
    step: 3,
    icon: List,
    title: 'Gliederung',
    description: 'Hochladen oder automatisch erstellen lassen',
  },
  {
    step: 4,
    icon: Upload,
    title: 'Eigene Quellen',
    description: 'Falls du eigene Quellen hast, hochladen',
  },
  {
    step: 5,
    icon: Rocket,
    title: 'Los!',
    description: 'KI generiert deine Thesis',
  },
]

export function Services() {
  return (
    <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50 dark:bg-gray-800">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-black dark:text-white">
            So einfach geht's
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-400">
            In 5 einfachen Schritten zu deiner fertigen Thesis
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 md:gap-2 max-w-6xl mx-auto relative">
          {services.map((service, index) => {
            const Icon = service.icon
            return (
              <div key={service.step} className="relative">
                <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-lg border border-gray-200 dark:border-gray-700 h-full flex flex-col items-center text-center relative z-10">
                  <div className="w-16 h-16 rounded-full bg-black dark:bg-white flex items-center justify-center mb-4">
                    <Icon className="w-8 h-8 text-white dark:text-black" />
                  </div>
                  <div className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-yellow-600 dark:bg-yellow-500 flex items-center justify-center text-black font-bold text-sm z-20">
                    {service.step}
                  </div>
                  <h3 className="text-lg font-semibold mb-2 text-black dark:text-white">
                    {service.title}
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {service.description}
                  </p>
                </div>
                
                {index < services.length - 1 && (
                  <div className="hidden md:block absolute top-1/2 right-0 transform -translate-y-1/2 translate-x-1/2 z-0">
                    <ArrowRight className="w-5 h-5 text-yellow-600 dark:text-yellow-500" />
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

