'use client'

import { Star, Quote } from 'lucide-react'

const testimonials = [
  {
    name: 'Sarah Chen',
    role: 'Doktorandin, Informatik',
    university: 'TU München',
    content: 'ThesisMeister hat meinen Thesis-Schreibprozess transformiert. Die KI half mir, meine Forschung zu strukturieren und die LaTeX-Formatierung sparte mir unzählige Stunden. Sehr empfehlenswert!',
    rating: 5,
    avatar: 'SC',
  },
  {
    name: 'Marcus Rodriguez',
    role: 'Masterstudent, Biologie',
    university: 'LMU München',
    content: 'Als jemand, der mit akademischem Schreiben kämpfte, war ThesisMeister ein Game-Changer. Die KI-Vorschläge waren punktgenau und halfen mir, meine Forschung klar zu artikulieren.',
    rating: 5,
    avatar: 'MR',
  },
  {
    name: 'Emily Johnson',
    role: 'Forschungsstipendiatin, Physik',
    university: 'HU Berlin',
    content: 'Die Zitationsverwaltung und Formatierungsfunktionen sind außergewöhnlich. Meine Thesis sah vom ersten Tag an professionell aus. Jeden Cent wert!',
    rating: 5,
    avatar: 'EJ',
  },
  {
    name: 'David Kim',
    role: 'Doktorand, Wirtschaftswissenschaften',
    university: 'Uni Heidelberg',
    content: 'ThesisMeister half mir, meine Thesis 3 Monate früher fertigzustellen. Die Kollaborations-Tools machten die Arbeit mit meinem Betreuer nahtlos.',
    rating: 5,
    avatar: 'DK',
  },
  {
    name: 'Lisa Wang',
    role: 'Masterstudentin, Ingenieurwesen',
    university: 'RWTH Aachen',
    content: 'Die Vorlagen und KI-Anleitung waren perfekt für meine erste Thesis. Ich fühlte mich während des gesamten Prozesses sicher.',
    rating: 5,
    avatar: 'LW',
  },
  {
    name: 'James Thompson',
    role: 'Postdoc, Chemie',
    university: 'Uni Freiburg',
    content: 'Professionelle Formatierung und exzellenter Support. ThesisMeister machte die mühsamen Teile des Thesis-Schreibens tatsächlich angenehm.',
    rating: 5,
    avatar: 'JT',
  },
]

export function Testimonials() {
  return (
    <section id="testimonials" className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50 dark:bg-gray-800">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-gray-900 dark:text-white">
            Vertraut von Forschern weltweit
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-400">
            Sieh, was Studenten und Forscher über ThesisMeister sagen
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {testimonials.map((testimonial, index) => (
            <div
              key={index}
              className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-lg hover:shadow-xl transition-shadow"
            >
              <div className="flex items-center mb-4">
                <div className="w-12 h-12 rounded-full bg-black dark:bg-white flex items-center justify-center text-white dark:text-black font-semibold mr-4">
                  {testimonial.avatar}
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900 dark:text-white">
                    {testimonial.name}
                  </h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {testimonial.role}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-500">
                    {testimonial.university}
                  </p>
                </div>
              </div>

              <div className="flex mb-3">
                {[...Array(testimonial.rating)].map((_, i) => (
                  <Star
                    key={i}
                    className="w-4 h-4 fill-yellow-400 text-yellow-400"
                  />
                ))}
              </div>

              <Quote className="w-6 h-6 text-yellow-600 dark:text-yellow-500 mb-2 opacity-50" />
              <p className="text-gray-700 dark:text-gray-300 italic">
                {testimonial.content}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

