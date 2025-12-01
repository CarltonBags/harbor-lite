'use client'

import { Shield, Lock, CheckCircle, FileCheck } from 'lucide-react'

const badges = [
  {
    icon: Shield,
    title: 'DSGVO-konform',
    description: 'Deine Daten sind sicher und geschützt',
  },
  {
    icon: Lock,
    title: 'Verschlüsselt',
    description: 'Ende-zu-Ende Verschlüsselung',
  },
  {
    icon: CheckCircle,
    title: '100% Legal',
    description: 'Nur Entwürfe, die du weiterbearbeitest',
  },
  {
    icon: FileCheck,
    title: 'KI-Detection geschützt',
    description: 'Automatische Humanisierung',
  },
]

export function TrustBadges() {
  return (
    <section className="py-16 px-4 sm:px-6 lg:px-8 bg-gray-50 dark:bg-gray-800">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {badges.map((badge, index) => {
            const Icon = badge.icon
            return (
              <div
                key={index}
                className="bg-white dark:bg-gray-900 rounded-lg p-6 border border-gray-200 dark:border-gray-700 text-center"
              >
                <div className="w-12 h-12 rounded-full bg-black dark:bg-white flex items-center justify-center mx-auto mb-4">
                  <Icon className="w-6 h-6 text-white dark:text-black" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                  {badge.title}
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {badge.description}
                </p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}



