import { Metadata } from 'next'
import { HomePageClient } from './home-client'

export const metadata: Metadata = {
  title: 'UniLord - KI-gestützter Wissenschaftlicher Thesis-Schreiber',
  description: 'Vom Thema zum Entwurf in Minuten statt Wochen. KI-gestützter Assistent zum Schreiben wissenschaftlicher Arbeiten für Studenten und Forscher. Hausarbeit, Bachelorarbeit, Masterarbeit oder Dissertation - wir helfen dir dabei.',
  keywords: [
    'Thesis schreiben',
    'Hausarbeit',
    'Bachelorarbeit',
    'Masterarbeit',
    'Dissertation',
    'KI Thesis',
    'KI-gestützt',
    'LaTeX',
    'wissenschaftliches Schreiben',
    'akademisches Schreiben',
    'Thesis Generator',
    'AI Thesis',
  ],
  openGraph: {
    title: 'UniLord - KI-gestützter Wissenschaftlicher Thesis-Schreiber',
    description: 'Vom Thema zum Entwurf in Minuten statt Wochen. KI-gestützter Assistent zum Schreiben wissenschaftlicher Arbeiten.',
    type: 'website',
    locale: 'de_DE',
  },
}

export default function Home() {
  return <HomePageClient />
}
