'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { Moon, Sun, Menu, X, FileText, User, LogOut, Settings, ChevronDown } from 'lucide-react'
import { useTheme } from '@/lib/theme-provider'
import { createSupabaseClient } from '@/lib/supabase/client'
import { AuthDialog } from '@/components/auth/auth-dialog'
import type { User as SupabaseUser } from '@supabase/supabase-js'

export function Navbar() {
  const { theme, toggleTheme } = useTheme()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [authDialogOpen, setAuthDialogOpen] = useState(false)
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin')
  const [user, setUser] = useState<SupabaseUser | null>(null)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const supabase = createSupabaseClient()

      // Get initial session
      supabase.auth.getSession().then(({ data: { session } }) => {
        setUser(session?.user ?? null)
      }).catch((error) => {
        console.warn('Failed to get session:', error)
      })

      // Listen for auth changes
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        setUser(session?.user ?? null)
      })

      return () => subscription.unsubscribe()
    } catch (error) {
      console.warn('Supabase client initialization failed:', error)
    }
  }, [])

  const handleSignOut = async () => {
    try {
      const supabase = createSupabaseClient()
      await supabase.auth.signOut()
      setUser(null)
      setUserMenuOpen(false)
    } catch (error) {
      console.warn('Failed to sign out:', error)
      setUser(null) // Still clear user state even if sign out fails
      setUserMenuOpen(false)
    }
  }

  // Close user menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false)
      }
    }

    if (userMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [userMenuOpen])

  const navItems = [
    { name: 'Funktionen', href: '#features' },
    { name: 'So funktioniert\'s', href: '#how-it-works' },
    { name: 'Preise', href: '#pricing' },
    { name: 'Testimonials', href: '#testimonials' },
  ]

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-white/40 backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center space-x-3 hover:opacity-80 transition-opacity">
            <img src="/assets/darklogo.png" alt="ThesisMeister Logo" className="w-10 h-10" />

          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center space-x-8">
            <Link
              href="/"
              className="text-gray-700 dark:text-gray-700 hover:text-red-600 dark:hover:text-red-400 transition-colors font-medium"
            >
              Startseite
            </Link>
            {navItems.map((item) => (
              <a
                key={item.name}
                href={item.href}
                className="text-gray-700 dark:text-gray-700 hover:text-yellow-600 dark:hover:text-yellow-500 transition-colors font-medium"
              >
                {item.name}
              </a>
            ))}
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? (
                <Sun className="w-5 h-5 text-yellow-500" />
              ) : (
                <Moon className="w-5 h-5 text-gray-700" />
              )}
            </button>
            {user ? (
              <div className="relative" ref={userMenuRef}>
                <button
                  onClick={() => setUserMenuOpen(!userMenuOpen)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                  aria-label="Benutzermenü"
                >
                  <User className="w-5 h-5 text-gray-700 dark:text-gray-300" />
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-700 hidden sm:block">
                    {user.email?.split('@')[0] || 'Benutzer'}
                  </span>
                  <ChevronDown className={`w-4 h-4 text-gray-700 dark:text-gray-300 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} />
                </button>

                {userMenuOpen && (
                  <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-2 z-50">
                    <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        Angemeldet als
                      </p>
                      <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
                        {user.email}
                      </p>
                    </div>
                    <div className="py-1">
                      <Link
                        href="/thesis"
                        onClick={() => setUserMenuOpen(false)}
                        className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                      >
                        <FileText className="w-4 h-4" />
                        Meine Projekte
                      </Link>
                      <button
                        onClick={() => {
                          setUserMenuOpen(false)
                          // TODO: Navigate to account settings
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                      >
                        <Settings className="w-4 h-4" />
                        Konto
                      </button>
                      <button
                        onClick={handleSignOut}
                        className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                      >
                        <LogOut className="w-4 h-4" />
                        Abmelden
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => {
                  setAuthMode('signin')
                  setAuthDialogOpen(true)
                }}
                className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                aria-label="Anmelden"
              >
                <User className="w-5 h-5 text-gray-700 dark:text-gray-300" />
              </button>
            )}
          </div>

          {/* Mobile menu button */}
          <div className="md:hidden flex items-center space-x-2">
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? (
                <Sun className="w-5 h-5 text-yellow-500" />
              ) : (
                <Moon className="w-5 h-5 text-gray-700" />
              )}
            </button>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800"
              aria-label="Toggle menu"
            >
              {mobileMenuOpen ? (
                <X className="w-6 h-6" />
              ) : (
                <Menu className="w-6 h-6" />
              )}
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <div className="md:hidden py-4 border-t border-gray-200 dark:border-gray-800 max-h-[calc(100vh-4rem)] overflow-y-auto bg-white dark:bg-gray-900 shadow-lg">
            <Link
              href="/"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2 text-gray-700 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            >
              Startseite
            </Link>
            {navItems.map((item) => (
              <a
                key={item.name}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className="block py-2 text-gray-700 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 transition-colors"
              >
                {item.name}
              </a>
            ))}
            {user ? (
              <>
                <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 mt-4">
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Angemeldet als
                  </p>
                  <p className="text-sm text-gray-700 dark:text-gray-300 truncate">
                    {user.email}
                  </p>
                </div>
                <Link
                  href="/thesis"
                  onClick={() => {
                    setUserMenuOpen(false)
                    setMobileMenuOpen(false)
                  }}
                  className="block mt-2 px-6 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-center w-full flex items-center justify-center gap-2"
                >
                  <FileText className="w-4 h-4" />
                  Meine Projekte
                </Link>
                <button
                  onClick={() => {
                    setUserMenuOpen(false)
                    setMobileMenuOpen(false)
                    // TODO: Navigate to account settings
                  }}
                  className="block mt-2 px-6 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-center w-full flex items-center justify-center gap-2"
                >
                  <Settings className="w-4 h-4" />
                  Konto
                </button>
                <button
                  onClick={() => {
                    handleSignOut()
                    setMobileMenuOpen(false)
                  }}
                  className="block mt-2 px-6 py-2 text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-center w-full flex items-center justify-center gap-2"
                >
                  <LogOut className="w-4 h-4" />
                  Abmelden
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  setAuthMode('signin')
                  setAuthDialogOpen(true)
                  setMobileMenuOpen(false)
                }}
                className="block mt-4 px-6 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-center w-full flex items-center justify-center gap-2"
              >
                <User className="w-4 h-4" />
                Anmelden
              </button>
            )}
          </div>
        )}
      </div>

      <AuthDialog
        isOpen={authDialogOpen}
        onClose={() => setAuthDialogOpen(false)}
        mode={authMode}
      />
    </nav>
  )
}

