'use client'

import { useState, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2, CheckCircle2, AlertCircle, Mail } from 'lucide-react'
import Link from 'next/link'

export default function GeneratePage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const thesisId = searchParams.get('id')
  
  const [status, setStatus] = useState<'generating' | 'completed' | 'error' | 'loading'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [polling, setPolling] = useState(true)

  useEffect(() => {
    if (!thesisId) {
      setStatus('error')
      setError('Thesis ID nicht gefunden')
      return
    }

    // Poll for status updates
    const pollStatus = async () => {
      try {
        const response = await fetch(`/api/thesis-status?id=${thesisId}`)
        
        if (!response.ok) {
          if (response.status === 404) {
            setStatus('error')
            setError('Thesis nicht gefunden')
            setPolling(false)
            return
          }
          // Don't stop polling on transient errors
          return
        }

        const data = await response.json()
        
        if (data.status === 'completed') {
          setStatus('completed')
          setPolling(false)
          // Redirect to preview after a short delay
          setTimeout(() => {
            router.push(`/thesis/preview?id=${thesisId}`)
          }, 2000)
        } else if (data.status === 'generating') {
          setStatus('generating')
        } else if (data.status === 'draft') {
          // If status is still draft after a while, might be an error
          // But don't set error immediately - generation might just be starting
          setStatus('generating')
        }
      } catch (err) {
        console.error('Error polling status:', err)
        // Don't stop polling on transient errors
      }
    }

    // Poll immediately
    pollStatus()

    // Then poll every 5 seconds
    const interval = setInterval(pollStatus, 5000)

    // Stop polling after 30 minutes (generation should be done by then)
    const timeout = setTimeout(() => {
      setPolling(false)
      clearInterval(interval)
      if (status === 'generating') {
        setError('Generierung dauert länger als erwartet. Bitte überprüfen Sie später den Status.')
      }
    }, 30 * 60 * 1000)

    return () => {
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [thesisId, router, status])

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-purple-600 dark:text-purple-400" />
            <span className="ml-3 text-gray-600 dark:text-gray-400">
              Lade Status...
            </span>
          </div>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <AlertCircle className="w-6 h-6 text-red-600 dark:text-red-400" />
              <h1 className="text-2xl font-bold text-red-900 dark:text-red-100">
                Fehler
              </h1>
            </div>
            <p className="text-red-800 dark:text-red-200 mb-4">
              {error || 'Ein Fehler ist aufgetreten'}
            </p>
            <Link
              href="/thesis"
              className="inline-block px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
            >
              Zurück zu Meine Theses
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (status === 'completed') {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-8 text-center">
            <CheckCircle2 className="w-16 h-16 text-green-600 dark:text-green-400 mx-auto mb-4" />
            <h1 className="text-3xl font-bold text-green-900 dark:text-green-100 mb-2">
              Thesis erfolgreich generiert!
            </h1>
            <p className="text-green-800 dark:text-green-200 mb-6">
              Ihre Thesis ist fertig. Sie werden zur Vorschau weitergeleitet...
            </p>
            <div className="flex items-center justify-center gap-2 text-sm text-green-700 dark:text-green-300">
              <Mail className="w-4 h-4" />
              <span>Sie erhalten eine E-Mail-Benachrichtigung</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // status === 'generating'
  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center">
          <Loader2 className="w-16 h-16 animate-spin text-purple-600 dark:text-purple-400 mx-auto mb-6" />
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">
            Generierung läuft
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-400 mb-8">
            Ihre Thesis wird im Hintergrund generiert. Dies kann einige Minuten dauern.
          </p>
          
          <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg p-6 mb-6">
            <div className="flex items-center justify-center gap-2 text-purple-700 dark:text-purple-300 mb-2">
              <Mail className="w-5 h-5" />
              <span className="font-semibold">E-Mail-Benachrichtigung</span>
            </div>
            <p className="text-sm text-purple-600 dark:text-purple-400">
              Sie erhalten eine E-Mail, sobald Ihre Thesis fertig ist. Diese Seite aktualisiert sich automatisch.
            </p>
          </div>

          <div className="space-y-2 text-sm text-gray-500 dark:text-gray-400">
            <p>Sie können diese Seite schließen und später zurückkehren.</p>
            <p>Die Generierung läuft im Hintergrund weiter.</p>
          </div>

          <div className="mt-8">
            <Link
              href="/thesis"
              className="inline-block px-6 py-3 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              Zurück zu Meine Theses
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
