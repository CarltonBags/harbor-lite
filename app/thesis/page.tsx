'use client'

import { useState, useEffect } from 'react'
import { Plus, FileText, Calendar, ArrowRight, Loader2, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createSupabaseClient } from '@/lib/supabase/client'
import { getUserTheses, deleteThesis } from '@/lib/supabase/theses'
import type { Thesis } from '@/lib/supabase/types'
import type { User as SupabaseUser } from '@supabase/supabase-js'

export default function MyThesesPage() {
  const router = useRouter()
  const [user, setUser] = useState<SupabaseUser | null>(null)
  const [theses, setTheses] = useState<Thesis[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createSupabaseClient()
    
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        loadTheses(session.user.id)
      } else {
        setLoading(false)
      }
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        loadTheses(session.user.id)
      } else {
        setTheses([])
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const loadTheses = async (userId: string) => {
    try {
      setLoading(true)
      const userTheses = await getUserTheses(userId)
      setTheses(userTheses)
    } catch (error) {
      console.error('Error loading theses:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (thesisId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Möchtest Du diese Thesis wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.')) {
      return
    }

    try {
      setDeletingId(thesisId)
      await deleteThesis(thesisId)
      setTheses(theses.filter(t => t.id !== thesisId))
    } catch (error) {
      console.error('Error deleting thesis:', error)
      alert('Fehler beim Löschen. Bitte versuche es erneut.')
    } finally {
      setDeletingId(null)
    }
  }

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      draft: 'Entwurf',
      generating: 'Wird generiert',
      completed: 'Abgeschlossen',
      archived: 'Archiviert',
    }
    return labels[status] || status
  }

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      draft: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
      generating: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
      completed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
      archived: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
    }
    return colors[status] || colors.draft
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('de-DE', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
              Bitte melde Dich an
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              Du musst angemeldet sein, um Deine Projekte zu sehen.
            </p>
            <Link
              href="/"
              className="inline-block px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg font-semibold hover:from-purple-700 hover:to-blue-700 transition-all"
            >
              Zur Startseite
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
              Meine Projekte
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Verwalte Deine Thesis-Projekte und setze Deine Arbeit fort
            </p>
          </div>
          <Link
            href="/thesis/new"
            className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg font-semibold hover:from-purple-700 hover:to-blue-700 transition-all shadow-lg hover:shadow-xl"
          >
            <Plus className="w-5 h-5" />
            Neues Projekt
          </Link>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-purple-600 dark:text-purple-400" />
            <span className="ml-3 text-gray-600 dark:text-gray-400">
              Lade Projekte...
            </span>
          </div>
        ) : theses.length === 0 ? (
          <div className="text-center py-12 bg-gray-50 dark:bg-gray-800 rounded-xl">
            <FileText className="w-16 h-16 text-gray-400 dark:text-gray-600 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Noch keine Projekte
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              Erstelle Dein erstes Thesis-Projekt, um zu beginnen.
            </p>
            <Link
              href="/thesis/new"
              className="inline-block px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg font-semibold hover:from-purple-700 hover:to-blue-700 transition-all"
            >
              Neues Projekt erstellen
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {theses.map((thesis) => (
              <div
                key={thesis.id}
                onClick={() => router.push(`/thesis/new?id=${thesis.id}`)}
                className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-6 hover:shadow-xl transition-all cursor-pointer group"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2 line-clamp-2">
                      {thesis.topic || 'Unbenanntes Projekt'}
                    </h3>
                    <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(thesis.status)}`}>
                      {getStatusLabel(thesis.status)}
                    </span>
                  </div>
                  <button
                    onClick={(e) => handleDelete(thesis.id, e)}
                    disabled={deletingId === thesis.id}
                    className="p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                    title="Projekt löschen"
                  >
                    {deletingId === thesis.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                </div>

                <div className="space-y-2 mb-4">
                  <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                    <FileText className="w-4 h-4 mr-2" />
                    <span className="capitalize">{thesis.thesis_type}</span>
                  </div>
                  <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                    <span>{thesis.field}</span>
                  </div>
                  <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                    <Calendar className="w-4 h-4 mr-2" />
                    <span>{formatDate(thesis.updated_at)}</span>
                  </div>
                </div>

                <div className="flex items-center text-purple-600 dark:text-purple-400 font-medium group-hover:gap-2 transition-all">
                  <span>Weiterarbeiten</span>
                  <ArrowRight className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

