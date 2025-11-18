'use client'

import { useState, useEffect, FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { X, Mail, Lock, Loader2 } from 'lucide-react'
import { createSupabaseClient } from '@/lib/supabase/client'

interface AuthDialogProps {
  isOpen: boolean
  onClose: () => void
  mode: 'signin' | 'signup'
}

export function AuthDialog({ isOpen, onClose, mode: initialMode }: AuthDialogProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [mounted, setMounted] = useState(false)

  // Update mode when prop changes
  useEffect(() => {
    setMode(initialMode)
    setError(null)
    setMessage(null)
    setPassword('')
    setConfirmPassword('')
  }, [initialMode, isOpen])

  useEffect(() => {
    setMounted(true)
    return () => setMounted(false)
  }, [])

  if (!isOpen || !mounted) return null

  const handleEmailAuth = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setMessage(null)

    // Validate password confirmation for signup
    if (mode === 'signup') {
      if (password !== confirmPassword) {
        setError('Die Passwörter stimmen nicht überein.')
        setLoading(false)
        return
      }
      if (password.length < 6) {
        setError('Das Passwort muss mindestens 6 Zeichen lang sein.')
        setLoading(false)
        return
      }
    }

    try {
      const supabase = createSupabaseClient()

      if (mode === 'signup') {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        })

        if (signUpError) throw signUpError

        setMessage('Bitte überprüfe Deine E-Mail, um Dein Konto zu bestätigen.')
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })

        if (signInError) throw signInError

        // Show success modal for 2 seconds, then close and reload
        setMessage('Erfolgreich angemeldet!')
        setTimeout(() => {
          onClose()
          window.location.reload()
        }, 2000)
      }
    } catch (err: any) {
      const errorMessage = err.message || 'Ein Fehler ist aufgetreten'
      // Check if it's a Supabase connection error
      if (errorMessage.includes('fetch') || errorMessage.includes('network')) {
        setError('Supabase ist nicht konfiguriert. Bitte setze die Umgebungsvariablen.')
      } else {
        setError(errorMessage)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleAuth = async () => {
    setLoading(true)
    setError(null)

    try {
      const supabase = createSupabaseClient()
      const { error: googleError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      })

      if (googleError) throw googleError
    } catch (err: any) {
      const errorMessage = err.message || 'Ein Fehler ist aufgetreten'
      // Check if it's a Supabase connection error
      if (errorMessage.includes('fetch') || errorMessage.includes('network')) {
        setError('Supabase ist nicht konfiguriert. Bitte setze die Umgebungsvariablen.')
      } else {
        setError(errorMessage)
      }
      setLoading(false)
    }
  }

  const dialogContent = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md p-6 relative my-auto max-h-[90vh] overflow-y-auto">
        {!(message && mode === 'signin' && message.includes('Erfolgreich')) && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors z-10"
          >
            <X className="w-5 h-5" />
          </button>
        )}

        {!(message && mode === 'signin' && message.includes('Erfolgreich')) && (
          <h2 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">
            {mode === 'signin' ? 'Anmelden' : 'Registrieren'}
          </h2>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        {message && mode === 'signin' && message.includes('Erfolgreich') ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Erfolgreich angemeldet!
            </h3>
            <p className="text-gray-600 dark:text-gray-400">
              Du wirst weitergeleitet...
            </p>
          </div>
        ) : message ? (
          <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-green-700 dark:text-green-400 text-sm">
            {message}
          </div>
        ) : (
          <form onSubmit={handleEmailAuth} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              E-Mail
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full pl-10 pr-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                placeholder="deine@email.de"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Passwort
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                className="w-full pl-10 pr-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                placeholder="••••••••"
              />
            </div>
          </div>

          {mode === 'signup' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Passwort bestätigen
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="••••••••"
                />
              </div>
              {password && confirmPassword && password !== confirmPassword && (
                <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                  Die Passwörter stimmen nicht überein.
                </p>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg font-semibold hover:from-purple-700 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                {mode === 'signin' ? 'Anmelden...' : 'Registrieren...'}
              </>
            ) : (
              mode === 'signin' ? 'Anmelden' : 'Registrieren'
            )}
          </button>
        </form>
        )}

        {!(message && mode === 'signin' && message.includes('Erfolgreich')) && (
          <>
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-300 dark:border-gray-600"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white dark:bg-gray-800 text-gray-500">oder</span>
              </div>
            </div>

            <button
              onClick={handleGoogleAuth}
              disabled={loading}
              className="w-full py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
            >
              <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Mit Google {mode === 'signin' ? 'anmelden' : 'registrieren'}
            </button>

            <div className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
              {mode === 'signin' ? (
                <>
                  Noch kein Konto?{' '}
                  <button
                    onClick={() => setMode('signup')}
                    className="text-purple-600 dark:text-purple-400 hover:underline"
                  >
                    Registrieren
                  </button>
                </>
              ) : (
                <>
                  Bereits ein Konto?{' '}
                  <button
                    onClick={() => setMode('signin')}
                    className="text-purple-600 dark:text-purple-400 hover:underline"
                  >
                    Anmelden
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )

  return createPortal(dialogContent, document.body)
}

