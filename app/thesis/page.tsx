import { Metadata } from 'next'
import { MyThesesPageClient } from './my-theses-client'

export const metadata: Metadata = {
  title: 'Meine Projekte',
  description: 'Verwalte deine Thesis-Projekte und setze deine Arbeit fort',
  robots: {
    index: false,
    follow: false,
  },
}

export default function MyThesesPage() {
  return <MyThesesPageClient />
}
