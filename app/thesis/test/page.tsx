'use client'

import { useState, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2, Download, ExternalLink, ChevronDown, ChevronUp, ArrowLeft } from 'lucide-react'
import { createSupabaseClient } from '@/lib/supabase/client'
import { getThesisById } from '@/lib/supabase/theses'
import Link from 'next/link'

interface TestSource {
  title: string
  authors: string[]
  year?: number
  doi?: string
  url?: string
  pdfUrl?: string
  abstract?: string
  journal?: string
  publisher?: string
  citationCount?: number
  relevanceScore?: number
  source: 'openalex' | 'semantic_scholar'
}

interface TestStatistics {
  totalSourcesFound: number
  sourcesAfterDeduplication: number
  sourcesAfterRanking: number
  sourcesWithPDFs: number
  selectedSourcesCount: number
  selectedSourcesWithPDFs: number
}

export default function TestResultsPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const thesisId = searchParams.get('id')
  
  const [loading, setLoading] = useState(true)
  const [sources, setSources] = useState<TestSource[]>([])
  const [statistics, setStatistics] = useState<TestStatistics | null>(null)
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const [thesisTitle, setThesisTitle] = useState<string>('')

  useEffect(() => {
    if (!thesisId) {
      setLoading(false)
      return
    }

    loadTestResults()
  }, [thesisId])

  const loadTestResults = async (retryCount = 0) => {
    if (!thesisId) return

    try {
      setLoading(true)
      const thesis = await getThesisById(thesisId)
      
      if (!thesis) {
        console.error('Thesis not found')
        setLoading(false)
        return
      }

      setThesisTitle(thesis.topic || 'Unbekanntes Thema')

      // Extract test mode data from metadata
      const metadata = thesis.metadata as any
      if (metadata?.testMode && metadata?.selectedSources) {
        setSources(metadata.selectedSources || [])
        setStatistics(metadata.statistics || null)
        setLoading(false)
      } else {
        // If data not found and we haven't retried too many times, retry after a delay
        if (retryCount < 5) {
          console.log(`Test mode data not found, retrying in 1 second... (attempt ${retryCount + 1}/5)`)
          setTimeout(() => loadTestResults(retryCount + 1), 1000)
        } else {
          console.error('No test mode data found in thesis metadata after retries')
          setLoading(false)
        }
      }
    } catch (error) {
      console.error('Error loading test results:', error)
      setLoading(false)
    }
  }

  const downloadJSON = () => {
    const data = {
      sources,
      statistics,
      exportedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `test-sources-${thesisId}-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const toggleExpand = (index: number) => {
    setExpandedIndex(expandedIndex === index ? null : index)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-purple-600 dark:text-purple-400" />
            <span className="ml-3 text-gray-600 dark:text-gray-400">
              Lade Testergebnisse...
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/thesis"
            className="inline-flex items-center text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-4"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Zurück zu Meine Theses
          </Link>
          
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            Test-Modus Ergebnisse
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-400">
            {thesisTitle}
          </p>
        </div>

        {/* Statistics */}
        {statistics && (
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-6 mb-8">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
              Statistiken
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <div className="text-sm text-gray-600 dark:text-gray-400">Gefundene Quellen</div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">
                  {statistics.totalSourcesFound}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600 dark:text-gray-400">Nach Deduplizierung</div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">
                  {statistics.sourcesAfterDeduplication}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600 dark:text-gray-400">Nach Ranking</div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">
                  {statistics.sourcesAfterRanking}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600 dark:text-gray-400">Mit PDF verfügbar</div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">
                  {statistics.sourcesWithPDFs}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600 dark:text-gray-400">Ausgewählte Quellen</div>
                <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                  {statistics.selectedSourcesCount}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600 dark:text-gray-400">Ausgewählt mit PDF</div>
                <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                  {statistics.selectedSourcesWithPDFs}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end mb-6">
          <button
            onClick={downloadJSON}
            className="inline-flex items-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
          >
            <Download className="w-4 h-4 mr-2" />
            JSON herunterladen
          </button>
        </div>

        {/* Sources List */}
        <div className="space-y-4">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
            Ausgewählte Quellen ({sources.length})
          </h2>

          {sources.length === 0 ? (
            <div className="text-center py-12 text-gray-600 dark:text-gray-400">
              Keine Quellen gefunden
            </div>
          ) : (
            sources.map((source, index) => (
              <div
                key={index}
                className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                      {source.title}
                    </h3>
                    
                    <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600 dark:text-gray-400 mb-3">
                      {source.authors && source.authors.length > 0 && (
                        <span>
                          {source.authors.slice(0, 3).join(', ')}
                          {source.authors.length > 3 && ` et al.`}
                        </span>
                      )}
                      {source.year && <span>{source.year}</span>}
                      {source.journal && <span>{source.journal}</span>}
                      {source.relevanceScore !== undefined && (
                        <span className="px-2 py-1 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded">
                          Relevanz: {source.relevanceScore}
                        </span>
                      )}
                      <span className="px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-xs">
                        {source.source === 'openalex' ? 'OpenAlex' : 'Semantic Scholar'}
                      </span>
                    </div>

                    {expandedIndex === index && (
                      <div className="mt-4 space-y-3 text-sm">
                        {source.doi && (
                          <div>
                            <span className="font-medium text-gray-700 dark:text-gray-300">DOI:</span>{' '}
                            <a
                              href={`https://doi.org/${source.doi}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-purple-600 dark:text-purple-400 hover:underline"
                            >
                              {source.doi}
                            </a>
                          </div>
                        )}
                        {source.abstract && (
                          <div>
                            <span className="font-medium text-gray-700 dark:text-gray-300">Abstract:</span>
                            <p className="mt-1 text-gray-600 dark:text-gray-400">{source.abstract}</p>
                          </div>
                        )}
                        {source.publisher && (
                          <div>
                            <span className="font-medium text-gray-700 dark:text-gray-300">Verlag:</span>{' '}
                            <span className="text-gray-600 dark:text-gray-400">{source.publisher}</span>
                          </div>
                        )}
                        {source.citationCount !== undefined && (
                          <div>
                            <span className="font-medium text-gray-700 dark:text-gray-300">Zitationen:</span>{' '}
                            <span className="text-gray-600 dark:text-gray-400">{source.citationCount}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 ml-4">
                    {source.pdfUrl && (
                      <a
                        href={source.pdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-colors"
                        title="PDF öffnen"
                      >
                        <ExternalLink className="w-5 h-5" />
                      </a>
                    )}
                    {source.url && (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                        title="Quelle öffnen"
                      >
                        <ExternalLink className="w-5 h-5" />
                      </a>
                    )}
                    <button
                      onClick={() => toggleExpand(index)}
                      className="p-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                      title={expandedIndex === index ? 'Weniger anzeigen' : 'Mehr anzeigen'}
                    >
                      {expandedIndex === index ? (
                        <ChevronUp className="w-5 h-5" />
                      ) : (
                        <ChevronDown className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

