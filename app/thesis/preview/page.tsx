'use client'

import React, { useState, useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2, Send, Edit2, Save, X, Copy, Check, MessageSquare, FileText, BookOpen, Download, Shield, Home, RefreshCw } from 'lucide-react'
import { createSupabaseClient } from '@/lib/supabase/client'
import { getThesisById } from '@/lib/supabase/theses'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import './thesis-document.css'
import { TableOfContents } from './table-of-contents'
import type { OutlineChapter } from '@/lib/supabase/types'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  selectedText?: string
  timestamp: Date
}

export default function ThesisPreviewPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const thesisId = searchParams.get('id')

  const [loading, setLoading] = useState(true)
  const [thesis, setThesis] = useState<any>(null)
  const [content, setContent] = useState<string>('')
  const [originalContent, setOriginalContent] = useState<string>('')
  const [isEditing, setIsEditing] = useState(false)
  const [selectedText, setSelectedText] = useState<string>('')
  const [textAddedToChat, setTextAddedToChat] = useState<boolean>(false) // Track if text was explicitly added via button
  const [selectionButtonPosition, setSelectionButtonPosition] = useState<{ top: number; left: number } | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [userProfile, setUserProfile] = useState<any>(null)
  const [showSourcesModal, setShowSourcesModal] = useState(false)
  const [pendingEdit, setPendingEdit] = useState<{ oldText: string; newText: string; oldContent: string; newContent: string } | null>(null)
  const [thesisVersions, setThesisVersions] = useState<any[]>([])
  const [showVersionsModal, setShowVersionsModal] = useState(false)
  const [showZeroGptModal, setShowZeroGptModal] = useState(false)
  const [isCheckingZeroGpt, setIsCheckingZeroGpt] = useState(false)
  const [showWinstonModal, setShowWinstonModal] = useState(false)

  const [isCheckingWinston, setIsCheckingWinston] = useState(false)

  // Unified AI Check State
  const [showAIModal, setShowAIModal] = useState(false)
  const [isCheckingAI, setIsCheckingAI] = useState(false)
  const [showPlagiarismModal, setShowPlagiarismModal] = useState(false)
  const [isCheckingPlagiarism, setIsCheckingPlagiarism] = useState(false)
  const [highlightedPassages, setHighlightedPassages] = useState<Array<{ text: string; paragraphId: string }>>([])
  const [selectionRange, setSelectionRange] = useState<Range | null>(null)
  const [bibliographySources, setBibliographySources] = useState<any[]>([])

  const chatEndRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Extract sources from bibliography section
  const extractBibliographySources = (content: string, uploadedSources: any[]): any[] => {
    if (!content || !uploadedSources || uploadedSources.length === 0) return []

    // Find bibliography section - look for "Literaturverzeichnis" or "Bibliography" heading
    const bibliographyMarkers = [
      /^##\s+Literaturverzeichnis\s*$/mi,
      /^##\s+Bibliography\s*$/mi,
      /^#\s+Literaturverzeichnis\s*$/mi,
      /^#\s+Bibliography\s*$/mi,
    ]

    let bibliographyStart = -1
    for (const marker of bibliographyMarkers) {
      const match = content.search(marker)
      if (match >= 0) {
        bibliographyStart = match
        break
      }
    }

    if (bibliographyStart < 0) {
      // If no explicit bibliography heading, look for common patterns at the end
      const endPatterns = [
        /Literaturverzeichnis/gi,
        /Bibliography/gi,
        /References/gi,
      ]
      for (const pattern of endPatterns) {
        const match = content.search(pattern)
        if (match >= 0 && match > content.length * 0.7) { // In last 30% of content
          bibliographyStart = match
          break
        }
      }
    }

    if (bibliographyStart < 0) return []

    // Extract bibliography text (from marker to end or next major heading)
    const bibliographyText = content.substring(bibliographyStart)
    const nextMajorHeading = bibliographyText.search(/^##?\s+/m)
    const bibliographyContent = nextMajorHeading > 0
      ? bibliographyText.substring(0, nextMajorHeading)
      : bibliographyText

    // Match sources from bibliography with uploaded sources
    const matchedSources: any[] = []

    for (const uploadedSource of uploadedSources) {
      // Try to find this source in the bibliography by matching key identifiers
      const sourceTitle = (uploadedSource.title || uploadedSource.metadata?.title || '').toLowerCase().trim()
      const sourceAuthors = uploadedSource.metadata?.authors || []
      const sourceDOI = uploadedSource.doi || ''
      const sourceYear = uploadedSource.metadata?.year || uploadedSource.year || ''

      // Create search patterns
      const searchPatterns: string[] = []

      // Add title (first 50 chars to avoid too long matches)
      if (sourceTitle) {
        const titleShort = sourceTitle.substring(0, 50)
        searchPatterns.push(titleShort)
      }

      // Add author names (first author)
      if (Array.isArray(sourceAuthors) && sourceAuthors.length > 0) {
        const firstAuthor = String(sourceAuthors[0]).toLowerCase().trim()
        if (firstAuthor) {
          // Extract last name (usually before comma or first word)
          const lastName = firstAuthor.split(/[,\s]/)[0]
          if (lastName && lastName.length > 2) {
            searchPatterns.push(lastName)
          }
        }
      } else if (typeof sourceAuthors === 'string') {
        const lastName = sourceAuthors.toLowerCase().split(/[,\s]/)[0]
        if (lastName && lastName.length > 2) {
          searchPatterns.push(lastName)
        }
      }

      // Add DOI
      if (sourceDOI) {
        searchPatterns.push(sourceDOI)
      }

      // Check if any pattern matches in bibliography
      const bibliographyLower = bibliographyContent.toLowerCase()
      const hasMatch = searchPatterns.some(pattern => {
        if (pattern.length < 3) return false
        return bibliographyLower.includes(pattern)
      })

      // Also check for year if we have author/title match
      if (hasMatch && sourceYear) {
        const yearMatch = bibliographyContent.includes(String(sourceYear))
        if (yearMatch) {
          matchedSources.push(uploadedSource)
        } else if (searchPatterns.length >= 2) {
          // If we have multiple identifiers matching, include even without year
          matchedSources.push(uploadedSource)
        }
      } else if (hasMatch && searchPatterns.length >= 2) {
        // If we have multiple identifiers matching, include even without year
        matchedSources.push(uploadedSource)
      }
    }

    return matchedSources
  }

  useEffect(() => {
    if (!thesisId) {
      setLoading(false)
      return
    }
    loadThesis()
  }, [thesisId])

  useEffect(() => {
    // Scroll chat to bottom when new messages arrive
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  // Calculate word count
  const wordCount = content ? content.split(/\s+/).filter(word => word.length > 0).length : 0

  const handleCheckZeroGpt = async () => {
    if (!thesisId) return

    try {
      setIsCheckingZeroGpt(true)
      const response = await fetch('/api/check-zerogpt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ thesisId }),
      })

      if (!response.ok) {
        const error = await response.json()
        const errorMessage = error.error || 'Failed to check ZeroGPT'
        const errorDetails = error.details ? `\n\nDetails: ${typeof error.details === 'string' ? error.details : JSON.stringify(error.details)}` : ''
        throw new Error(errorMessage + errorDetails)
      }

      const data = await response.json()
      console.log('ZeroGPT check completed:', data.result)

      // Update thesis state directly with new ZeroGPT result to immediately update modal
      if (data.result && thesis) {
        const updatedMetadata = {
          ...(thesis.metadata || {}),
          zeroGptResult: data.result,
        }
        setThesis({
          ...thesis,
          metadata: updatedMetadata,
        })
      } else {
        // Fallback: reload thesis if direct update didn't work
        await loadThesis()
      }

      // Ensure modal stays open to show updated results
      if (!showZeroGptModal) {
        setShowZeroGptModal(true)
      }

      // Do NOT show message in chat - results are displayed in the ZeroGPT modal
    } catch (error) {
      console.error('Error checking ZeroGPT:', error)
      const errorMessage = error instanceof Error ? error.message : 'Fehler beim ZeroGPT-Check'
      console.error('Full error:', error)

      // Do NOT show error in chat - errors can be shown in the modal or via console
      // The modal will remain open and show the previous result if available
    } finally {
      setIsCheckingZeroGpt(false)
    }
  }

  const handleCheckWinston = async () => {
    if (!thesisId) return

    try {
      setIsCheckingWinston(true)
      const response = await fetch('/api/check-winston', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ thesisId }),
      })

      if (!response.ok) {
        const error = await response.json()
        const errorMessage = error.error || 'Failed to check Winston AI'
        const errorDetails = error.details ? `\n\nDetails: ${typeof error.details === 'string' ? error.details : JSON.stringify(error.details)}` : ''
        throw new Error(errorMessage + errorDetails)
      }

      const data = await response.json()
      console.log('Winston check completed:', data.result)

      // Update thesis state directly
      if (data.result && thesis) {
        const updatedMetadata = {
          ...(thesis.metadata || {}),
          winstonResult: data.result,
        }
        setThesis({
          ...thesis,
          metadata: updatedMetadata,
        })
      } else {
        await loadThesis()
      }

      if (!showWinstonModal) {
        setShowWinstonModal(true)
      }

    } catch (error) {
      console.error('Error checking Winston:', error)
    } finally {
      setIsCheckingWinston(false)
    }
  }

  const handleAICheck = async () => {
    if (!thesisId) return

    setIsCheckingAI(true)
    try {
      // Run both checks in parallel
      const [winstonResult, zeroGptResult] = await Promise.allSettled([
        fetch('/api/check-winston', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thesisId }),
        }).then(res => res.ok ? res.json() : Promise.reject(res)),

        fetch('/api/check-zerogpt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thesisId }),
        }).then(res => res.ok ? res.json() : Promise.reject(res))
      ])

      // Prepare metadata update
      const newMetadata = { ...(thesis?.metadata || {}) }

      // Process Winston Result
      if (winstonResult.status === 'fulfilled' && winstonResult.value.result) {
        newMetadata.winstonResult = winstonResult.value.result
      } else if (winstonResult.status === 'rejected') {
        console.error('Winston Check Failed:', winstonResult.reason)
      }

      // Process ZeroGPT Result
      if (zeroGptResult.status === 'fulfilled' && zeroGptResult.value.result) {
        newMetadata.zeroGptResult = zeroGptResult.value.result
      } else if (zeroGptResult.status === 'rejected') {
        console.error('ZeroGPT Check Failed:', zeroGptResult.reason)
      }

      // Update state if we have new data
      if (thesis) {
        setThesis({
          ...thesis,
          metadata: newMetadata
        })
      } else {
        await loadThesis()
      }

      // Open the unified modal
      setShowAIModal(true)

    } catch (error) {
      console.error('Error during AI check:', error)
    } finally {
      setIsCheckingAI(false)
    }
  }

  const handleCheckPlagiarism = async () => {
    if (!thesisId) return

    try {
      setIsCheckingPlagiarism(true)
      const response = await fetch('/api/check-plagiarism', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ thesisId }),
      })

      if (!response.ok) {
        const error = await response.json()
        const errorMessage = error.error || 'Failed to check plagiarism'
        const errorDetails = error.details ? `\n\nDetails: ${typeof error.details === 'string' ? error.details : JSON.stringify(error.details)}` : ''
        throw new Error(errorMessage + errorDetails)
      }

      const data = await response.json()
      console.log('Plagiarism check completed:', data.result)

      // Update thesis state directly with new plagiarism result
      if (data.result && thesis) {
        const updatedMetadata = {
          ...(thesis.metadata || {}),
          plagiarismResult: data.result,
        }
        setThesis({
          ...thesis,
          metadata: updatedMetadata,
        })
      } else {
        // Fallback: reload thesis if direct update didn't work
        await loadThesis()
      }

      // Ensure modal stays open to show updated results
      if (!showPlagiarismModal) {
        setShowPlagiarismModal(true)
      }
    } catch (error) {
      console.error('Error checking plagiarism:', error)
      const errorMessage = error instanceof Error ? error.message : 'Fehler beim Plagiat-Check'
      console.error('Full error:', error)
    } finally {
      setIsCheckingPlagiarism(false)
    }
  }

  const loadThesis = async () => {
    if (!thesisId) return

    try {
      setLoading(true)
      const thesisData = await getThesisById(thesisId)

      if (!thesisData) {
        console.error('Thesis not found')
        return
      }

      setThesis(thesisData)
      const thesisContent = thesisData.latex_content || ''
      setContent(thesisContent)
      setOriginalContent(thesisContent)

      // Load sources - use uploaded_sources directly (from research pipeline)
      // or fall back to extracting from bibliography for older theses
      const uploadedSources = thesisData.uploaded_sources || []
      if (uploadedSources.length > 0) {
        // New format: sources are stored directly
        setBibliographySources(uploadedSources)
      } else {
        // Legacy: try to extract from bibliography text
        const bibliographySources = extractBibliographySources(thesisContent, uploadedSources)
        setBibliographySources(bibliographySources)
      }

      // Load user profile for cover page
      const supabase = createSupabaseClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('full_name, email')
          .eq('id', user.id)
          .single()
        setUserProfile(profile)
      }

      // Load versions on initial load
      if (thesisId) {
        const { data: versions } = await supabase
          .from('thesis_versions')
          .select('*')
          .eq('thesis_id', thesisId)
          .order('version_number', { ascending: false })
        setThesisVersions(versions || [])
      }
    } catch (error) {
      console.error('Error loading thesis:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleTextSelection = () => {
    // Small delay to ensure selection is complete
    setTimeout(() => {
      const selection = window.getSelection()
      if (selection && selection.toString().trim().length > 0) {
        const selectedText = selection.toString().trim()
        setSelectedText(selectedText)
        setTextAddedToChat(false) // Reset - text not yet added to chat

        // Store the range to keep selection visible
        const range = selection.getRangeAt(0)
        setSelectionRange(range.cloneRange())

        // Get selection position for button placement
        const rect = range.getBoundingClientRect()

        // Calculate position relative to viewport (fixed positioning)
        const buttonTop = rect.top + window.scrollY - 45 // Above selection
        const buttonLeft = rect.right + 10 // Right of selection

        setSelectionButtonPosition({
          top: buttonTop,
          left: buttonLeft,
        })

        console.log('[Selection] Text selected:', {
          selectedText: selectedText.substring(0, 50),
          buttonTop,
          buttonLeft,
          rectTop: rect.top,
          rectRight: rect.right,
          scrollY: window.scrollY,
          hasButton: true
        })
      } else {
        // Only clear if user explicitly deselects
        if (!selectedText) {
          setSelectionButtonPosition(null)
          setTextAddedToChat(false)
        }
      }
    }, 100) // Delay to ensure selection is stable
  }

  const handleAddToChat = () => {
    if (selectedText) {
      // Mark that text has been added to chat
      setTextAddedToChat(true)
      // Hide the button
      setSelectionButtonPosition(null)
      // Don't clear the selection - keep it visible (blue highlight stays)
    }
  }

  const handleCopySelection = () => {
    if (selectedText) {
      setChatInput(`Bitte ändere folgenden Text:\n\n"${selectedText}"\n\n`)
      // Don't clear selection - keep it visible
    }
  }

  const handleSendMessage = async () => {
    // Security check: Text MUST be selected
    if (!selectedText) {
      alert('Bitte markieren Sie zuerst die Textstelle, die Sie bearbeiten möchten.')
      return
    }

    if (!chatInput.trim() || isProcessing || !thesisId) return

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: chatInput,
      selectedText: selectedText || undefined,
      timestamp: new Date(),
    }

    setChatMessages(prev => [...prev, userMessage])
    setChatInput('')
    // Don't clear selectedText - keep it visible (blue highlight stays)
    setIsProcessing(true)

    try {
      // Call API to process the edit request
      const response = await fetch('/api/edit-thesis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          thesisId,
          userMessage: userMessage.content,
          selectedText: userMessage.selectedText,
          currentContent: content,
          thesisContext: {
            topic: thesis?.topic,
            field: thesis?.field,
            citationStyle: thesis?.citation_style,
            language: thesis?.metadata?.language || 'german',
          },
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || errorData.error || 'Failed to process edit request')
      }

      const data = await response.json()

      // Show diff preview instead of directly replacing
      if (data.oldText && data.newText) {
        setPendingEdit({
          oldText: data.oldText,
          newText: data.newText,
          oldContent: content,
          newContent: data.newContent,
        })

        // Find related passages using semantic search
        if (data.relatedPassages && Array.isArray(data.relatedPassages)) {
          setHighlightedPassages(data.relatedPassages)
        } else {
          // Fallback: search for related passages
          try {
            const searchResponse = await fetch('/api/find-related-passages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                thesisId,
                queryText: data.newText,
                excludeText: data.oldText,
              }),
            })

            if (searchResponse.ok) {
              const searchData = await searchResponse.json()
              setHighlightedPassages(searchData.passages || [])
            }
          } catch (error) {
            console.error('Error finding related passages:', error)
          }
        }
      } else {
        // Fallback: direct replacement if no diff provided
        setContent(data.editedContent || data.newContent)
        setHasUnsavedChanges(true)
      }

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.explanation || 'Text wurde erfolgreich bearbeitet. Bitte überprüfe die Änderungen unten.',
        timestamp: new Date(),
      }

      setChatMessages(prev => [...prev, assistantMessage])

      // Don't clear selection - keep it visible
    } catch (error) {
      console.error('Error processing edit:', error)
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: error instanceof Error ? error.message : 'Fehler beim Bearbeiten des Textes. Bitte versuche es erneut.',
        timestamp: new Date(),
      }
      setChatMessages(prev => [...prev, errorMessage])
    } finally {
      setIsProcessing(false)
    }
  }

  const handleApproveEdit = async () => {
    if (pendingEdit) {
      const oldContent = content
      const newContent = pendingEdit.newContent
      setContent(newContent)
      setHasUnsavedChanges(true)
      setPendingEdit(null)

      // Clear highlights after approval
      setHighlightedPassages([])

      // Clear selection after approval
      window.getSelection()?.removeAllRanges()
      setSelectedText('')
      setSelectionRange(null)

      // Update bibliography sources after content change
      if (thesis?.uploaded_sources) {
        const updatedSources = extractBibliographySources(newContent, thesis.uploaded_sources)
        setBibliographySources(updatedSources)
      }

      // Update vector store embeddings for changed paragraphs
      if (thesisId) {
        try {
          await fetch('/api/update-thesis-embeddings', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              thesisId,
              oldContent,
              newContent,
            }),
          })
        } catch (error) {
          console.error('Error updating embeddings:', error)
          // Don't block the user if embedding update fails
        }
      }
    }
  }

  const handleRejectEdit = () => {
    setPendingEdit(null)
    setHighlightedPassages([])
  }

  const handleExportDoc = async () => {
    if (!thesisId) return

    try {
      setIsProcessing(true)
      const response = await fetch('/api/export-thesis-doc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ thesisId }),
      })

      if (!response.ok) {
        throw new Error('Failed to export thesis')
      }

      // Get filename from Content-Disposition header or use default
      const contentDisposition = response.headers.get('Content-Disposition')
      const filename = contentDisposition
        ? contentDisposition.split('filename=')[1]?.replace(/"/g, '') || 'thesis.docx'
        : 'thesis.docx'

      // Create blob and download
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)

      // Show success message
      const successMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: '✓ Thesis wurde als Word-Dokument exportiert.',
        timestamp: new Date(),
      }
      setChatMessages(prev => [...prev, successMessage])
    } catch (error) {
      console.error('Error exporting thesis:', error)
      alert('Fehler beim Exportieren der Thesis')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleExportLaTeX = async () => {
    if (!thesisId) return

    try {
      setIsProcessing(true)
      const response = await fetch('/api/export-thesis-latex', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ thesisId }),
      })

      if (!response.ok) {
        throw new Error('Failed to export thesis')
      }

      // Get filename from Content-Disposition header or use default
      const contentDisposition = response.headers.get('Content-Disposition')
      const filename = contentDisposition
        ? contentDisposition.split('filename=')[1]?.replace(/"/g, '') || 'thesis.tex'
        : 'thesis.tex'

      // Create blob and download
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)

      // Show success message
      const successMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: '✓ Thesis wurde als LaTeX-Datei exportiert.',
        timestamp: new Date(),
      }
      setChatMessages(prev => [...prev, successMessage])
    } catch (error) {
      console.error('Error exporting thesis:', error)
      alert('Fehler beim Exportieren der Thesis')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleSave = async () => {
    if (!thesisId || !hasUnsavedChanges) return

    try {
      setIsProcessing(true)
      const oldContent = originalContent

      const response = await fetch('/api/save-thesis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          thesisId,
          content,
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to save thesis')
      }

      const data = await response.json()
      setOriginalContent(content)
      setHasUnsavedChanges(false)

      // Update bibliography sources after save
      if (thesis?.uploaded_sources) {
        const updatedSources = extractBibliographySources(content, thesis.uploaded_sources)
        setBibliographySources(updatedSources)
      }

      // Update vector store embeddings for changed paragraphs
      try {
        await fetch('/api/update-thesis-embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            thesisId,
            oldContent,
            newContent: content,
          }),
        })
      } catch (error) {
        console.error('Error updating embeddings:', error)
        // Don't block the user if embedding update fails
      }

      // Reload versions after save
      const supabase = createSupabaseClient()
      const { data: versions } = await supabase
        .from('thesis_versions')
        .select('*')
        .eq('thesis_id', thesisId)
        .order('version_number', { ascending: false })
      setThesisVersions(versions || [])

      // Show success message
      const successMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: `✓ Änderungen wurden gespeichert (Version ${data.versionNumber || 'N/A'}).`,
        timestamp: new Date(),
      }
      setChatMessages(prev => [...prev, successMessage])
    } catch (error) {
      console.error('Error saving thesis:', error)
      alert('Fehler beim Speichern der Änderungen')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleManualEdit = () => {
    setIsEditing(true)
    // Focus textarea after a brief delay to ensure it's rendered
    setTimeout(() => {
      textareaRef.current?.focus()
    }, 100)
  }

  const handleCancelEdit = () => {
    if (hasUnsavedChanges) {
      if (confirm('Ungespeicherte Änderungen verwerfen?')) {
        setContent(originalContent)
        setHasUnsavedChanges(false)
      } else {
        return
      }
    }
    setIsEditing(false)
  }

  const handleContentChange = (newContent: string) => {
    setContent(newContent)
    setHasUnsavedChanges(newContent !== originalContent)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-red-600 dark:text-red-500" />
          <span className="ml-3 text-gray-600 dark:text-gray-400">Lade Thesis...</span>
        </div>
      </div>
    )
  }

  if (!thesis) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">
            Thesis nicht gefunden
          </h1>
          <Link href="/thesis" className="text-red-600 dark:text-red-500 hover:underline">
            Zurück zu Meine Theses
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen bg-gray-50 dark:bg-gray-900 flex flex-col pt-16 overflow-hidden">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="inline-flex items-center text-sm text-gray-600 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            >
              <Home className="w-4 h-4 mr-1" />
              Startseite
            </Link>
            <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                {thesis.topic || 'Thesis Preview'}
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {thesis.field} • {thesis.thesis_type}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {hasUnsavedChanges && (
              <span className="text-sm text-amber-600 dark:text-amber-400">
                Ungespeicherte Änderungen
              </span>
            )}
            {!isEditing ? (
              <button
                onClick={handleManualEdit}
                className="inline-flex items-center px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                <Edit2 className="w-3 h-3 mr-1" />
                Bearbeiten
              </button>
            ) : (
              <button
                onClick={handleCancelEdit}
                className="inline-flex items-center px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                <X className="w-3 h-3 mr-1" />
                Abbrechen
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!hasUnsavedChanges || isProcessing}
              className="inline-flex items-center px-2 py-1 text-xs bg-black dark:bg-white text-white dark:text-black rounded hover:bg-blue-600 dark:hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isProcessing ? (
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              ) : (
                <Save className="w-3 h-3 mr-1" />
              )}
              Speichern
            </button>
            <button
              onClick={() => setShowSourcesModal(true)}
              className="inline-flex items-center px-2 py-1 text-xs bg-gray-600 text-white rounded hover:bg-gray-700 transition-colors"
            >
              <BookOpen className="w-3 h-3 mr-1" />
              Quellen
            </button>
            <button
              onClick={() => setShowVersionsModal(true)}
              className="inline-flex items-center px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              <FileText className="w-3 h-3 mr-1" />
              Versionen ({thesisVersions.length})
            </button>

            <button
              onClick={() => setShowAIModal(true)}
              className="inline-flex items-center px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors"
              title="KI-Inhaltsanalyse anzeigen"
            >
              <Shield className="w-3 h-3 mr-1" />
              GPT-Check
            </button>
            <button
              onClick={() => setShowPlagiarismModal(true)}
              className="inline-flex items-center px-2 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors"
              title="Plagiat-Erkennungsergebnis anzeigen"
            >
              <FileText className="w-3 h-3 mr-1" />
              Plagiat
            </button>
            <div className="flex gap-2">
              <button
                onClick={handleExportDoc}
                disabled={isProcessing}
                className="inline-flex items-center px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="Als Word-Dokument exportieren"
              >
                {isProcessing ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <Download className="w-3 h-3 mr-1" />
                )}
                DOC
              </button>
              <button
                onClick={handleExportLaTeX}
                disabled={isProcessing}
                className="inline-flex items-center px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="Als LaTeX-Datei exportieren"
              >
                {isProcessing ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <Download className="w-3 h-3 mr-1" />
                )}
                LaTeX
              </button>
            </div>
            <Link
              href="/thesis"
              className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
            >
              Zurück
            </Link>
          </div>
        </div>
      </div>

      {/* Split View: Chat (Left) + Preview (Right) */}
      <div className="flex-1 flex overflow-hidden h-full">
        {/* Chat Panel (Left) - Fixed */}
        <div className="w-96 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col h-full flex-shrink-0">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center">
              <MessageSquare className="w-5 h-5 mr-2" />
              AI-Assistent
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Markiere Text und bitte um Änderungen
            </p>
          </div>

          {/* Chat Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {chatMessages.length === 0 && (
              <div className="text-center text-gray-500 dark:text-gray-400 py-8">
                <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p className="text-sm">
                  Markiere Text im Preview und kopiere ihn hierher,<br />
                  oder stelle eine allgemeine Anfrage.
                </p>
              </div>
            )}
            {chatMessages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg p-3 ${message.role === 'user'
                    ? 'bg-black dark:bg-white text-white dark:text-black'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white'
                    }`}
                >
                  {message.selectedText && (
                    <div className="text-xs opacity-75 mb-2 italic border-b border-current pb-1">
                      Ausgewählter Text: "{message.selectedText.substring(0, 50)}..."
                    </div>
                  )}
                  <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                  <p className="text-xs opacity-75 mt-1">
                    {message.timestamp.toLocaleTimeString()}
                  </p>
                </div>
              </div>
            ))}
            {isProcessing && (
              <div className="flex justify-start">
                <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-3">
                  <Loader2 className="w-4 h-4 animate-spin text-red-600 dark:text-red-500" />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Chat Input */}
          <div className="p-4 border-t border-gray-200 dark:border-gray-700">
            {/* Selected Text Display - Only show when explicitly added via button */}
            {selectedText && textAddedToChat && (
              <div className="mb-2 p-2 bg-purple-50 dark:bg-purple-900/20 rounded text-sm text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium">Ausgewählter Text:</span>
                  <button
                    onClick={() => {
                      window.getSelection()?.removeAllRanges()
                      setSelectedText('')
                      setSelectionRange(null)
                      setTextAddedToChat(false)
                    }}
                    className="text-red-600 dark:text-red-500 hover:text-red-800 dark:hover:text-red-300"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-xs italic line-clamp-2">"{selectedText.substring(0, 150)}{selectedText.length > 150 ? '...' : ''}"</p>
              </div>
            )}

            <div className="flex gap-2">
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (!selectedText) {
                      alert('Bitte markieren Sie zuerst die Textstelle, die Sie bearbeiten möchten.')
                      return
                    }
                    if (chatInput.trim()) {
                      handleSendMessage()
                    }
                  }
                }}
                placeholder={selectedText ? "Änderungswünsche für den markierten Text..." : "Bitte zuerst Text markieren..."}
                className="flex-1 bg-transparent border-none focus:ring-0 resize-none max-h-32 text-sm"
                rows={1}
                disabled={isProcessing}
              />
              <button
                onClick={handleSendMessage}
                disabled={!chatInput.trim() || isProcessing || !selectedText}
                className="p-2 bg-black dark:bg-white text-white dark:text-black rounded-full hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
                title={!selectedText ? "Bitte markiere zuerst Text im Preview" : !textAddedToChat ? "Bitte klicke auf 'Zu Chat hinzufügen'" : ""}
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Preview Panel (Right) - Scrollable Container */}
        <div className="flex-1 flex flex-col overflow-hidden bg-gray-100 dark:bg-gray-800">
          {/* Scrollable Content Area */}
          <div className="flex-1 overflow-y-auto overflow-x-auto">
            {isEditing ? (
              <div className="p-8">
                <textarea
                  ref={textareaRef}
                  value={content}
                  onChange={(e) => handleContentChange(e.target.value)}
                  className="w-full h-full min-h-[calc(100vh-200px)] font-mono text-sm border-none outline-none bg-transparent text-gray-900 dark:text-white resize-none"
                  style={{ fontFamily: 'monospace' }}
                />
              </div>
            ) : (
              <div className="flex justify-center py-8 relative" style={{ position: 'relative' }}>
                {/* Selection Button - Appears when text is selected but not yet added */}
                {selectionButtonPosition && selectedText && !textAddedToChat && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      handleAddToChat()
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                    }}
                    className="fixed z-[9999] bg-black dark:bg-white text-white dark:text-black px-3 py-1.5 rounded-lg shadow-lg hover:bg-blue-600 dark:hover:bg-blue-500 transition-colors text-sm font-medium flex items-center gap-1.5 whitespace-nowrap"
                    style={{
                      top: `${Math.max(0, selectionButtonPosition.top)}px`,
                      left: `${Math.max(0, selectionButtonPosition.left)}px`,
                      pointerEvents: 'auto',
                      position: 'fixed',
                    }}
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Zu Chat hinzufügen
                  </button>
                )}

                {/* Debug info - remove in production */}
                {process.env.NODE_ENV === 'development' && selectionButtonPosition && selectedText && !textAddedToChat && (
                  <div className="fixed top-20 right-4 bg-yellow-100 p-2 rounded text-xs z-[10000]">
                    <div>Button should be at: {selectionButtonPosition.top}, {selectionButtonPosition.left}</div>
                    <div>Selected: {selectedText.substring(0, 30)}...</div>
                  </div>
                )}

                <div
                  ref={previewRef}
                  onMouseUp={handleTextSelection}
                  className="thesis-document shadow-2xl"
                  style={{
                    width: '210mm', // A4 width - fixed
                    minWidth: '210mm', // Prevent shrinking
                    minHeight: '297mm', // A4 height
                    padding: '25mm 30mm',
                    fontFamily: '"Times New Roman", "Times", serif',
                    fontSize: '12pt',
                    lineHeight: '1.5',
                    color: '#000',
                    backgroundColor: '#ffffff', // Always white, regardless of dark mode
                    flexShrink: 0, // Prevent shrinking
                    position: 'relative',
                  }}
                >
                  {/* Cover Page */}
                  <div className="cover-page thesis-page" style={{
                    minHeight: '247mm', // Full page minus padding (297mm - 25mm top - 25mm bottom)
                    height: '247mm',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    textAlign: 'center',
                    pageBreakAfter: 'always',
                    marginBottom: '10mm',
                    borderBottom: '1px solid #e0e0e0',
                  }}>
                    {/* Top section - Title */}
                    <div style={{
                      marginTop: '50mm',
                      width: '100%',
                      padding: '0 20mm',
                    }}>
                      <h1 style={{
                        fontSize: '24pt',
                        fontWeight: 'bold',
                        lineHeight: '1.3',
                        marginBottom: '0',
                        textAlign: 'center',
                        letterSpacing: '0.5px',
                        color: '#000',
                      }}>
                        {thesis?.topic || 'Thesis Title'}
                      </h1>
                    </div>

                    {/* Bottom section - Metadata */}
                    <div style={{
                      marginBottom: '50mm',
                      width: '100%',
                    }}>
                      <div style={{
                        borderTop: '1px solid #000',
                        borderBottom: '1px solid #000',
                        padding: '8mm 0',
                        margin: '0 20mm 15mm 20mm',
                      }}>
                        <p style={{ fontSize: '12pt', marginBottom: '4mm', fontWeight: 'bold' }}>
                          {thesis?.field || 'Fachbereich'}
                        </p>
                        <p style={{ fontSize: '12pt', marginBottom: '0' }}>
                          {thesis?.thesis_type === 'hausarbeit' ? 'Hausarbeit' :
                            thesis?.thesis_type === 'seminararbeit' ? 'Seminararbeit' :
                              thesis?.thesis_type === 'bachelor' ? 'Bachelorarbeit' : 'Thesis'}
                        </p>
                      </div>
                      <p style={{ fontSize: '12pt', marginTop: '10mm' }}>
                        {thesis?.completed_at
                          ? new Date(thesis.completed_at).getFullYear()
                          : new Date().getFullYear()}
                      </p>
                      {userProfile?.full_name && (
                        <p style={{ fontSize: '11pt', marginTop: '5mm', color: '#666' }}>
                          {userProfile.full_name}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Table of Contents - Generated from Outline JSON */}
                  {thesis?.outline && (
                    <div style={{
                      position: 'relative',
                      pageBreakAfter: 'always',
                      marginBottom: '10mm',
                    }}>
                      <TableOfContents
                        outline={thesis.outline as OutlineChapter[]}
                        language={thesis.metadata?.language || 'german'}
                      />
                    </div>
                  )}

                  {/* Document Content with Page Numbers */}
                  <div
                    ref={contentRef}
                    className="thesis-content"
                    style={{
                      position: 'relative',
                    }}
                    data-thesis-content="true"
                    id="thesis-content-container"
                  >
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                      components={{
                        // Text component - footnotes are handled at paragraph level to avoid double processing
                        text: ({ node, children, ...props }: any) => {
                          return <>{children}</>
                        },
                        h1: ({ node, children, ...props }: any) => {
                          // Check if this is the first content heading after TOC
                          // We want to ensure it starts on a new page
                          return (
                            <h1 style={{
                              fontSize: '16pt',
                              fontWeight: 'bold',
                              textAlign: 'left',
                              marginTop: '12mm',
                              marginBottom: '8mm',
                              pageBreakBefore: 'always',
                              breakBefore: 'page',
                            }} {...props}>{children}</h1>
                          )
                        },
                        h2: ({ node, children, ...props }: any) => {
                          // Skip TOC heading if we're rendering TOC from JSON
                          const text = String(children || '')
                          const isTOCHeading = text.includes('Inhaltsverzeichnis') || text.includes('Table of Contents')

                          if (isTOCHeading && thesis?.outline) {
                            // Don't render TOC heading from markdown if we have outline JSON
                            return null
                          }

                          return (
                            <h2 style={{
                              fontSize: '14pt',
                              fontWeight: 'bold',
                              marginTop: '8mm',
                              marginBottom: '4mm',
                              textAlign: 'left',
                            }} {...props}>{children}</h2>
                          )
                        },
                        h3: ({ node, ...props }) => (
                          <h3 style={{
                            fontSize: '12pt',
                            fontWeight: 'bold',
                            marginTop: '8mm',
                            marginBottom: '4mm',
                            textAlign: 'left',
                          }} {...props} />
                        ),
                        h4: ({ node, ...props }) => (
                          <h4 style={{
                            fontSize: '11pt',
                            fontWeight: 'bold',
                            marginTop: '6mm',
                            marginBottom: '3mm',
                            textAlign: 'left',
                          }} {...props} />
                        ),
                        p: ({ node, children, ...props }: any) => {
                          // Extract footnotes from content (format: [^1]: Citation text)
                          const extractFootnotesFromContent = (text: string): Record<number, string> => {
                            const footnotes: Record<number, string> = {}
                            const footnoteRegex = /\[\^(\d+)\]:\s*(.+?)(?=\n\[\^|\n\n|$)/gs
                            let match
                            while ((match = footnoteRegex.exec(text)) !== null) {
                              footnotes[parseInt(match[1], 10)] = match[2].trim()
                            }
                            return footnotes
                          }

                          // Try multiple sources for footnotes:
                          // 1. metadata.footnotes (legacy)
                          // 2. Extract from content (markdown format)
                          // 3. metadata.citations (new format - convert to footnotes)
                          let footnotes: Record<number, string> = thesis?.metadata?.footnotes || {}

                          if (Object.keys(footnotes).length === 0 && content) {
                            footnotes = extractFootnotesFromContent(content)
                          }

                          // If still no footnotes and we have citations, create footnotes from them
                          if (Object.keys(footnotes).length === 0 && thesis?.metadata?.citations) {
                            const citations = thesis.metadata.citations as any[]
                            citations.forEach((citation, idx) => {
                              const authors = Array.isArray(citation.authors)
                                ? citation.authors.join(', ')
                                : citation.authors || 'Unbekannt'
                              const year = citation.year || ''
                              const title = citation.title || ''
                              const pages = citation.pages || ''
                              footnotes[idx + 1] = `${authors} (${year}): ${title}${pages ? `, S. ${pages}` : ''}`
                            })
                          }

                          // Build a map of footnote numbers to PDF URLs by matching citation text with sources
                          // STRICT matching: must match BOTH year AND first author's last name
                          const footnotePdfUrls: Record<number, string | null> = {}
                          if (bibliographySources && bibliographySources.length > 0) {
                            Object.entries(footnotes).forEach(([numStr, citationText]) => {
                              const num = parseInt(numStr, 10)
                              const citation = citationText as string

                              // Extract year from citation (e.g., "(2022)" or "2022:" or ", 2022,")
                              const yearMatch = citation.match(/[\(\s,](\d{4})[\)\s,:]/)
                              const citationYear = yearMatch ? yearMatch[1] : null

                              // Extract first author's last name from citation
                              // Patterns: "Merola (2022)" or "Merola, Korinek (2022)" or "Korinek/Stiglitz (2017)"
                              const authorMatch = citation.match(/^([A-ZÄÖÜa-zäöüß][a-zäöüß]+)(?:\s|,|\/|\(|\:)/)
                              const citationAuthorLastName = authorMatch ? authorMatch[1].toLowerCase() : null

                              if (!citationYear && !citationAuthorLastName) {
                                return // Can't match without year or author
                              }

                              // Find source with matching year AND first author's last name
                              const matchingSource = bibliographySources.find((source: any) => {
                                const meta = source.metadata || source
                                const sourceYear = String(meta.year || source.year || '')
                                const authors = meta.authors || []

                                // Get first author's last name from source
                                const firstAuthor = authors[0] || ''
                                const sourceAuthorLastName = firstAuthor.split(' ').pop()?.toLowerCase() || ''

                                // STRICT: Must match year AND author (if we have both)
                                if (citationYear && citationAuthorLastName) {
                                  return sourceYear === citationYear && sourceAuthorLastName === citationAuthorLastName
                                }
                                // If only year available, match by year
                                if (citationYear) {
                                  return sourceYear === citationYear
                                }
                                // If only author available, match by author
                                if (citationAuthorLastName) {
                                  return sourceAuthorLastName === citationAuthorLastName
                                }
                                return false
                              })

                              if (matchingSource) {
                                footnotePdfUrls[num] = matchingSource.sourceUrl || matchingSource.metadata?.sourceUrl || matchingSource.pdfUrl || null
                              }
                            })
                          }

                          const citationStyle = thesis?.citation_style

                          // Check if this paragraph should be highlighted (related passage)
                          const getTextContent = (node: any): string => {
                            if (typeof node === 'string') return node
                            if (Array.isArray(node)) {
                              return node.map(getTextContent).join('')
                            }
                            if (node?.props?.children) {
                              return getTextContent(node.props.children)
                            }
                            return ''
                          }

                          const paragraphText = getTextContent(children)
                          const isHighlighted = highlightedPassages.some(passage =>
                            paragraphText.includes(passage.text.substring(0, 50)) ||
                            passage.text.includes(paragraphText.substring(0, 50))
                          )

                          // Check if this paragraph contains the pending edit's old text
                          const hasPendingEdit = pendingEdit && paragraphText.includes(pendingEdit.oldText)

                          // Process footnotes in paragraphs (for any citation style that uses ^N markers)
                          if (paragraphText.includes('^') && Object.keys(footnotes).length > 0) {
                            // Convert entire paragraph content to string for processing
                            const getTextContent = (node: any): string => {
                              if (typeof node === 'string') return node
                              if (Array.isArray(node)) {
                                return node.map(getTextContent).join('')
                              }
                              if (node?.props?.children) {
                                return getTextContent(node.props.children)
                              }
                              return ''
                            }

                            const paragraphText = getTextContent(children)

                            // Check if paragraph contains footnotes
                            if (paragraphText.includes('^')) {
                              // Split by footnote pattern and rebuild with React elements
                              const parts = paragraphText.split(/(\^\d+)/g)

                              if (parts.length > 1) {
                                const processedParts: any[] = []
                                parts.forEach((part, idx) => {
                                  const footnoteMatch = part.match(/^\^(\d+)$/)
                                  if (footnoteMatch) {
                                    const footnoteNum = parseInt(footnoteMatch[1], 10)
                                    const footnoteText = footnotes[footnoteNum] || `[Fußnote ${footnoteNum}]`
                                    const pdfUrl = footnotePdfUrls[footnoteNum]
                                    const hasPdf = !!pdfUrl
                                    processedParts.push(
                                      <sup
                                        key={`fn-${idx}`}
                                        style={{
                                          fontSize: '0.75em',
                                          verticalAlign: 'super',
                                          lineHeight: 0,
                                          cursor: hasPdf ? 'pointer' : 'help',
                                          color: hasPdf ? '#0066cc' : '#666',
                                          textDecoration: 'underline',
                                          textDecorationStyle: hasPdf ? 'solid' : 'dotted',
                                          fontWeight: 'normal',
                                          marginLeft: '1px',
                                        }}
                                        title={hasPdf ? `${footnoteText}\n\n📄 Klicken zum Öffnen der PDF` : footnoteText}
                                        onClick={(e) => {
                                          if (pdfUrl) {
                                            e.preventDefault()
                                            e.stopPropagation()
                                            window.open(pdfUrl, '_blank', 'noopener,noreferrer')
                                          }
                                        }}
                                        onMouseEnter={(e) => {
                                          const tooltip = document.createElement('div')
                                          tooltip.id = `footnote-tooltip-${footnoteNum}`
                                          tooltip.innerHTML = hasPdf
                                            ? `${footnoteText}<br/><span style="color: #4CAF50; font-size: 10pt; margin-top: 4px; display: block;">📄 Klicken zum Öffnen der PDF</span>`
                                            : footnoteText
                                          tooltip.style.cssText = `
                                          position: fixed;
                                          background: #333;
                                          color: white;
                                          padding: 8px 12px;
                                          border-radius: 4px;
                                          font-size: 11pt;
                                          max-width: 400px;
                                          white-space: normal;
                                          z-index: 10000;
                                          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                                          pointer-events: none;
                                        `
                                          document.body.appendChild(tooltip)
                                          const rect = e.currentTarget.getBoundingClientRect()
                                          tooltip.style.left = `${rect.left + rect.width / 2}px`
                                          tooltip.style.top = `${rect.top - tooltip.offsetHeight - 5}px`
                                          tooltip.style.transform = 'translateX(-50%)'
                                        }}
                                        onMouseLeave={(e) => {
                                          const tooltip = document.getElementById(`footnote-tooltip-${footnoteNum}`)
                                          if (tooltip) {
                                            tooltip.remove()
                                          }
                                        }}
                                      >
                                        {footnoteNum}
                                      </sup>
                                    )
                                  } else if (part) {
                                    processedParts.push(part)
                                  }
                                })

                                return (
                                  <p style={{
                                    marginBottom: '6mm',
                                    textAlign: 'justify',
                                    textIndent: '0mm',
                                    lineHeight: '1.6',
                                    fontSize: '12pt',
                                  }} {...props}>{processedParts}</p>
                                )
                              }
                            }
                          }

                          // TOC should be in lists, not paragraphs
                          // Apply yellow highlight if this is a related passage
                          const paragraphStyle: React.CSSProperties = {
                            marginBottom: '6mm',
                            textAlign: 'justify',
                            textIndent: '0mm',
                            lineHeight: '1.6',
                            fontSize: '12pt',
                          }

                          if (isHighlighted) {
                            paragraphStyle.backgroundColor = '#fef3c7' // Light yellow
                            paragraphStyle.padding = '2mm 4mm'
                            paragraphStyle.borderRadius = '2px'
                            paragraphStyle.borderLeft = '3px solid #fbbf24' // Amber border
                          }

                          // If this paragraph contains the pending edit, show diff inline
                          if (hasPendingEdit && pendingEdit) {
                            const oldTextIndex = paragraphText.indexOf(pendingEdit.oldText)
                            if (oldTextIndex >= 0) {
                              const beforeText = paragraphText.substring(0, oldTextIndex)
                              const afterText = paragraphText.substring(oldTextIndex + pendingEdit.oldText.length)

                              return (
                                <p style={paragraphStyle} {...props}>
                                  {beforeText}
                                  <span style={{
                                    backgroundColor: '#fee2e2',
                                    padding: '2px 4px',
                                    borderRadius: '2px',
                                    textDecoration: 'line-through',
                                  }}>
                                    {pendingEdit.oldText}
                                  </span>
                                  <span style={{
                                    backgroundColor: '#dcfce7',
                                    padding: '2px 4px',
                                    borderRadius: '2px',
                                    marginLeft: '4px',
                                  }}>
                                    {pendingEdit.newText}
                                  </span>
                                  {afterText}
                                  <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
                                    <button
                                      onClick={handleApproveEdit}
                                      style={{
                                        padding: '4px 12px',
                                        backgroundColor: '#16a34a',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        fontSize: '11pt',
                                      }}
                                    >
                                      ✓ Übernehmen
                                    </button>
                                    <button
                                      onClick={handleRejectEdit}
                                      style={{
                                        padding: '4px 12px',
                                        backgroundColor: '#6b7280',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        fontSize: '11pt',
                                      }}
                                    >
                                      ✗ Ablehnen
                                    </button>
                                  </div>
                                </p>
                              )
                            }
                          }

                          return (
                            <p style={paragraphStyle} {...props}>{children}</p>
                          )
                        },
                        ul: ({ node, children, ...props }: any) => {
                          // Check if this is TOC by examining children
                          const childrenArray = Array.isArray(children) ? children : [children]
                          let isTOC = false
                          let tocEntryCount = 0

                          // Check if any child looks like TOC entry
                          for (const child of childrenArray) {
                            const text = String(child?.props?.children || child || '')
                            // More flexible TOC detection - check for number patterns
                            if (/^\d+\.(?:\d+\.)*\s+/.test(text.trim())) {
                              isTOC = true
                              tocEntryCount++
                              console.log('[TOC Detection] Found TOC entry in ul:', text.substring(0, 50))
                            }
                          }

                          // If at least 2 entries match TOC pattern, treat as TOC
                          if (isTOC && tocEntryCount >= 2) {
                            console.log('[TOC Detection] Rendering TOC ul list with', tocEntryCount, 'entries')
                            return (
                              <ul className="toc-list" style={{
                                marginBottom: '6mm',
                                marginLeft: '0',
                                paddingLeft: '0',
                                fontSize: '12pt',
                                listStyle: 'none',
                                display: 'block',
                              }} {...props}>{children}</ul>
                            )
                          }

                          return (
                            <ul style={{
                              marginBottom: '6mm',
                              marginLeft: '10mm',
                              paddingLeft: '5mm',
                              fontSize: '12pt',
                            }} {...props}>{children}</ul>
                          )
                        },
                        ol: ({ node, children, ...props }: any) => {
                          const childrenArray = Array.isArray(children) ? children : [children]
                          let isTOC = false
                          let tocEntryCount = 0

                          // Check if any child looks like TOC entry
                          for (const child of childrenArray) {
                            const text = String(child?.props?.children || child || '')
                            // More flexible TOC detection - check for number patterns
                            if (/^\d+\.(?:\d+\.)*\s+/.test(text.trim())) {
                              isTOC = true
                              tocEntryCount++
                              console.log('[TOC Detection] Found TOC entry in ol:', text.substring(0, 50))
                            }
                          }

                          // If at least 2 entries match TOC pattern, treat as TOC
                          if (isTOC && tocEntryCount >= 2) {
                            console.log('[TOC Detection] Rendering TOC ol list with', tocEntryCount, 'entries')
                            return (
                              <ol className="toc-list" style={{
                                marginBottom: '6mm',
                                marginLeft: '0',
                                paddingLeft: '0',
                                fontSize: '12pt',
                                listStyle: 'none',
                                display: 'block',
                              }} {...props}>{children}</ol>
                            )
                          }

                          return (
                            <ol style={{
                              marginBottom: '6mm',
                              marginLeft: '10mm',
                              paddingLeft: '5mm',
                              fontSize: '12pt',
                            }} {...props}>{children}</ol>
                          )
                        },
                        li: ({ node, children, ...props }: any) => {
                          // Extract text to check for TOC entry - handle nested React elements
                          let text = ''
                          const extractText = (node: any): string => {
                            if (typeof node === 'string') return node
                            if (typeof node === 'number') return String(node)
                            if (Array.isArray(node)) {
                              return node.map(extractText).join(' ').trim()
                            }
                            if (node?.props?.children) {
                              return extractText(node.props.children)
                            }
                            return ''
                          }

                          text = extractText(children)
                          const trimmedText = text.trim()

                          console.log('[TOC li] Raw text:', trimmedText.substring(0, 100))

                          // TOC entries format: "1. Einleitung" or "1.1 Hinführung..." or "1. Title ......... 5"
                          // More flexible pattern matching
                          const tocPattern = /^(\d+\.(?:\d+\.)*)\s+(.+?)(?:\s+[\.]{2,}\s+(\d+))?$|^(\d+\.(?:\d+\.)*)\s+(.+?)\s+(\d+)$|^(\d+\.(?:\d+\.)*)\s+(.+)$/
                          const tocMatch = trimmedText.match(tocPattern)

                          if (tocMatch) {
                            // Extract parts - handle multiple pattern groups
                            const numberPart = tocMatch[1] || tocMatch[4] || tocMatch[7] || ''
                            const titlePart = (tocMatch[2] || tocMatch[5] || tocMatch[8] || '').trim()
                            const pagePart = tocMatch[3] || tocMatch[6] || ''

                            if (numberPart) {
                              console.log('[TOC Entry] ✓ Matched:', { numberPart, titlePart, pagePart })

                              // Determine indentation level
                              const numberSegments = numberPart.split('.').filter(Boolean)
                              const level = Math.max(0, numberSegments.length - 1)
                              const isMainChapter = level === 0
                              const indent = level * 8

                              return (
                                <li
                                  className={`toc-entry toc-entry-level-${level}`}
                                  style={{
                                    marginBottom: '4mm',
                                    lineHeight: '1.6',
                                    listStyle: 'none',
                                    paddingLeft: '0',
                                    marginLeft: `${indent}mm`,
                                    fontSize: '12pt',
                                    display: 'block',
                                    breakInside: 'avoid',
                                    pageBreakInside: 'avoid',
                                  }}
                                  {...props}
                                >
                                  <span style={{
                                    fontWeight: isMainChapter ? 'bold' : 'normal',
                                  }}>
                                    {numberPart} {titlePart}
                                  </span>
                                  {pagePart && (
                                    <span style={{
                                      float: 'right',
                                      fontVariantNumeric: 'tabular-nums',
                                      marginLeft: '4mm',
                                    }}>
                                      {pagePart}
                                    </span>
                                  )}
                                </li>
                              )
                            }
                          }

                          // If it looks like a TOC entry but didn't match, log it
                          if (trimmedText && /^\d+\./.test(trimmedText)) {
                            console.warn('[TOC Entry] ✗ Not matched:', trimmedText.substring(0, 100))
                          }

                          return (
                            <li style={{
                              marginBottom: '4mm',
                              fontSize: '12pt',
                              lineHeight: '1.6',
                            }} {...props}>{children}</li>
                          )
                        },
                        blockquote: ({ node, ...props }) => (
                          <blockquote style={{
                            borderLeft: '3px solid #666',
                            paddingLeft: '8mm',
                            marginLeft: '10mm',
                            marginRight: '10mm',
                            marginTop: '4mm',
                            marginBottom: '4mm',
                            fontStyle: 'italic',
                            fontSize: '11pt',
                            color: '#333',
                          }} {...props} />
                        ),
                        code: ({ node, inline, ...props }: any) => {
                          if (inline) {
                            return (
                              <code style={{
                                backgroundColor: '#f5f5f5',
                                padding: '1mm 2mm',
                                borderRadius: '2px',
                                fontSize: '11pt',
                                fontFamily: '"Courier New", monospace',
                                color: '#000',
                              }} {...props} />
                            )
                          }
                          return (
                            <code style={{
                              display: 'block',
                              backgroundColor: '#f5f5f5',
                              padding: '4mm',
                              borderRadius: '2px',
                              fontSize: '10pt',
                              fontFamily: '"Courier New", monospace',
                              marginBottom: '6mm',
                              overflowX: 'auto',
                              border: '1px solid #ddd',
                            }} {...props} />
                          )
                        },
                      }}
                    >
                      {content || '*Kein Inhalt verfügbar*'}
                    </ReactMarkdown>

                    {/* Literaturverzeichnis - built from uploaded sources */}
                    {bibliographySources && bibliographySources.length > 0 && (
                      <div style={{ pageBreakBefore: 'always', marginTop: '24mm' }}>
                        <h2 style={{
                          fontSize: '14pt',
                          fontWeight: 'bold',
                          marginBottom: '8mm',
                          textAlign: 'left',
                        }}>
                          Literaturverzeichnis
                        </h2>
                        <div style={{ fontSize: '11pt', lineHeight: '1.6' }}>
                          {bibliographySources
                            .sort((a: any, b: any) => {
                              // Sort by first author's last name
                              const getLastName = (source: any) => {
                                const authors = source.metadata?.authors || source.authors || []
                                // Filter out "et al." variations to get real authors
                                const realAuthors = authors.filter((auth: string) => {
                                  const lower = (auth || '').toLowerCase().trim()
                                  return lower !== 'et al.' && lower !== 'et al' && lower !== 'et' && lower !== 'al.' && !lower.match(/^et\s+al/)
                                })
                                if (realAuthors.length === 0) return 'ZZZ'
                                // Clean "et al." from the end of author names
                                const firstAuthor = (realAuthors[0] || '').replace(/\s+et\s+al\.?$/i, '').trim()
                                const parts = firstAuthor.split(' ')
                                return parts[parts.length - 1] || 'ZZZ'
                              }
                              return getLastName(a).localeCompare(getLastName(b), 'de')
                            })
                            .map((source: any, index: number) => {
                              // Format source for bibliography
                              const meta = source.metadata || source
                              const authors = meta.authors || []
                              const year = meta.year || 'o.J.'
                              const title = meta.title || source.title || 'Ohne Titel'
                              const journal = meta.journal || source.journal
                              const pages = meta.pages || (meta.pageStart && meta.pageEnd ? `${meta.pageStart}-${meta.pageEnd}` : '')
                              const doi = meta.doi || source.doi

                              // Format authors (Last, First; Last, First)
                              // First, clean and filter authors - remove "et al." variations
                              const cleanedAuthors = authors
                                .map((a: string) => a.trim())
                                // Remove "et al." from end of names like "Thomas Knaus et al."
                                .map((a: string) => a.replace(/\s+et\s+al\.?$/i, '').trim())
                                // Filter out standalone "et al.", "et", "al.", etc.
                                .filter((a: string) => {
                                  const lower = a.toLowerCase().trim()
                                  return a.length > 0 &&
                                    lower !== 'et al.' &&
                                    lower !== 'et al' &&
                                    lower !== 'et' &&
                                    lower !== 'al.' &&
                                    lower !== 'al' &&
                                    lower !== 'u.a.' &&
                                    lower !== 'u. a.' &&
                                    !lower.match(/^et\s+al/)
                                })

                              const formattedAuthors = cleanedAuthors.length > 0
                                ? cleanedAuthors.slice(0, 3).map((a: string) => {
                                  const parts = a.trim().split(' ')
                                  if (parts.length >= 2) {
                                    const lastName = parts[parts.length - 1]
                                    const firstName = parts.slice(0, -1).join(' ')
                                    return `${lastName}, ${firstName}`
                                  }
                                  return a
                                }).join('; ') + (cleanedAuthors.length > 3 ? ' et al.' : '')
                                : 'o.V.'

                              return (
                                <p key={index} style={{
                                  marginBottom: '4mm',
                                  textIndent: '-10mm',
                                  paddingLeft: '10mm',
                                  textAlign: 'left',
                                }}>
                                  {formattedAuthors} ({year}): {title}.
                                  {journal && ` In: ${journal}.`}
                                  {pages && ` S. ${pages}.`}
                                  {doi && ` DOI: ${doi}.`}
                                </p>
                              )
                            })}
                        </div>
                      </div>
                    )}

                  </div>
                </div>

              </div>
            )}
          </div>

          {/* Word Counter Footer - Fixed at bottom */}
          <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-6 py-3 flex items-center justify-between flex-shrink-0">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              <span className="font-medium">Wörter:</span> {wordCount.toLocaleString()}
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              <span className="font-medium">Zeichen:</span> {content.length.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Sources Modal */}
      {
        showSourcesModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setShowSourcesModal(false)}>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
              {/* Modal Header */}
              <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center">
                  <BookOpen className="w-6 h-6 mr-2" />
                  Verwendete Quellen
                </h2>
                <button
                  onClick={() => setShowSourcesModal(false)}
                  className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto p-6">
                {bibliographySources && bibliographySources.length > 0 ? (
                  <div className="space-y-4">
                    {bibliographySources.map((source: any, index: number) => (
                      <div
                        key={index}
                        className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <h3 className="font-semibold text-lg text-gray-900 dark:text-white mb-2">
                              {source.title || source.metadata?.title || 'Unbekannter Titel'}
                            </h3>

                            <div className="space-y-1 text-sm text-gray-600 dark:text-gray-300">
                              {/* Authors - handle both flat and nested formats */}
                              {(source.authors || source.metadata?.authors) && (
                                <p>
                                  <span className="font-medium">Autoren:</span>{' '}
                                  {Array.isArray(source.authors || source.metadata?.authors)
                                    ? (source.authors || source.metadata?.authors).join(', ')
                                    : (source.authors || source.metadata?.authors)}
                                </p>
                              )}

                              {/* Year - handle both flat and nested */}
                              {(source.year || source.metadata?.year) && (
                                <p>
                                  <span className="font-medium">Jahr:</span> {source.year || source.metadata?.year}
                                </p>
                              )}

                              {/* Journal - handle both flat and nested */}
                              {(source.journal || source.metadata?.journal) && (
                                <p>
                                  <span className="font-medium">Journal:</span> {source.journal || source.metadata?.journal}
                                </p>
                              )}

                              {/* DOI */}
                              {(source.doi || source.metadata?.doi) && (
                                <p>
                                  <span className="font-medium">DOI:</span>{' '}
                                  <a
                                    href={`https://doi.org/${source.doi || source.metadata?.doi}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-yellow-600 dark:text-yellow-500 hover:underline"
                                  >
                                    {source.doi || source.metadata?.doi}
                                  </a>
                                </p>
                              )}

                              {/* PDF URL */}
                              {(source.pdf_url || source.pdfUrl) && (
                                <p>
                                  <span className="font-medium">PDF:</span>{' '}
                                  <a
                                    href={source.pdf_url || source.pdfUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-green-600 dark:text-green-500 hover:underline"
                                  >
                                    PDF öffnen
                                  </a>
                                </p>
                              )}

                              {/* URL */}
                              {(source.url || source.sourceUrl) && (
                                <p>
                                  <span className="font-medium">URL:</span>{' '}
                                  <a
                                    href={source.url || source.sourceUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 dark:text-blue-400 hover:underline break-all"
                                  >
                                    {(source.url || source.sourceUrl).length > 60
                                      ? `${(source.url || source.sourceUrl).substring(0, 60)}...`
                                      : (source.url || source.sourceUrl)}
                                  </a>
                                </p>
                              )}

                              {/* Relevance Score */}
                              {source.relevance_score && (
                                <p>
                                  <span className="font-medium">Relevanz:</span> {Math.round(source.relevance_score * 100)}%
                                </p>
                              )}

                              {/* Chapter assignment */}
                              {source.chapter_title && (
                                <p>
                                  <span className="font-medium">Kapitel:</span> {source.chapter_number} {source.chapter_title}
                                </p>
                              )}

                              {/* Abstract */}
                              {(source.abstract || source.metadata?.abstract) && (
                                <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                                  <p className="font-medium mb-1">Abstract:</p>
                                  <p className="text-gray-600 dark:text-gray-400 italic text-xs line-clamp-3">
                                    {source.abstract || source.metadata?.abstract}
                                  </p>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                    <BookOpen className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p>Keine Quellen verfügbar</p>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="p-6 border-t border-gray-200 dark:border-gray-700 flex justify-end">
                <button
                  onClick={() => setShowSourcesModal(false)}
                  className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
                >
                  Schließen
                </button>
              </div>
            </div>
          </div>
        )
      }

      {/* Versions Modal */}
      {
        showVersionsModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setShowVersionsModal(false)}>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
              {/* Modal Header */}
              <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center">
                  <FileText className="w-6 h-6 mr-2" />
                  Versionsverlauf
                </h2>
                <button
                  onClick={() => setShowVersionsModal(false)}
                  className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto p-6">
                {thesisVersions.length > 0 ? (
                  <div className="space-y-4">
                    {thesisVersions.map((version) => (
                      <div
                        key={version.id}
                        className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div>
                            <h3 className="font-semibold text-gray-900 dark:text-white">
                              Version {version.version_number}
                            </h3>
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              {version.change_description || `Erstellt am ${new Date(version.created_at).toLocaleString('de-DE')}`}
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={async () => {
                                try {
                                  const response = await fetch('/api/rollback-thesis', {
                                    method: 'POST',
                                    headers: {
                                      'Content-Type': 'application/json',
                                    },
                                    body: JSON.stringify({
                                      thesisId,
                                      versionNumber: version.version_number,
                                    }),
                                  })

                                  if (response.ok) {
                                    await loadThesis()
                                    setShowVersionsModal(false)
                                    const successMessage: ChatMessage = {
                                      id: Date.now().toString(),
                                      role: 'assistant',
                                      content: `✓ Zur Version ${version.version_number} zurückgesetzt.`,
                                      timestamp: new Date(),
                                    }
                                    setChatMessages(prev => [...prev, successMessage])
                                  }
                                } catch (error) {
                                  console.error('Error rolling back:', error)
                                  alert('Fehler beim Zurücksetzen')
                                }
                              }}
                              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                            >
                              Wiederherstellen
                            </button>
                          </div>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                          {new Date(version.created_at).toLocaleString('de-DE')}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                    <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p>Noch keine Versionen vorhanden</p>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="p-6 border-t border-gray-200 dark:border-gray-700 flex justify-end">
                <button
                  onClick={() => setShowVersionsModal(false)}
                  className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
                >
                  Schließen
                </button>
              </div>
            </div>
          </div>
        )
      }

      {/* Winston Modal */}
      {
        showWinstonModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setShowWinstonModal(false)}>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
              {/* Modal Header */}
              <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center">
                  <Shield className="w-6 h-6 mr-2" />
                  Winston AI-Erkennung
                </h2>
                <button
                  onClick={() => setShowWinstonModal(false)}
                  className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto p-6">
                {thesis?.metadata?.winstonResult ? (
                  <div className="space-y-6">
                    <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-6">
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                        Erkennungsergebnis (Human Score)
                      </h3>

                      <div className="grid grid-cols-1 gap-4 mb-4">
                        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 flex flex-col items-center justify-center">
                          <div className="text-sm text-blue-700 dark:text-blue-300 font-medium mb-1">
                            Menschlichkeits-Score
                          </div>
                          <div className="text-5xl font-bold text-blue-600 dark:text-blue-400">
                            {thesis.metadata.winstonResult.score}%
                          </div>
                          <div className="text-xs text-blue-600 dark:text-blue-400 mt-2">
                            (0% = KI, 100% = Mensch)
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
                        {thesis.metadata.winstonResult.checkedAt && (
                          <div>
                            <span className="font-medium">Geprüft am:</span>{' '}
                            {new Date(thesis.metadata.winstonResult.checkedAt).toLocaleString('de-DE')}
                          </div>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={handleCheckWinston}
                      disabled={isCheckingWinston}
                      className="w-full mt-4 inline-flex items-center justify-center px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-blue-600 dark:hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isCheckingWinston ? (
                        <>
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                          Prüfe erneut...
                        </>
                      ) : (
                        <>
                          <Shield className="w-5 h-5 mr-2" />
                          Erneut prüfen
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                    <Shield className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p className="text-lg font-medium mb-2">Kein Winston-Ergebnis verfügbar</p>
                    <p className="text-sm mb-6">
                      Prüfe deine Thesis auf KI-Erkennung mit Winston AI.
                    </p>
                    <button
                      onClick={handleCheckWinston}
                      disabled={isCheckingWinston || !thesis?.latex_content}
                      className="inline-flex items-center px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-blue-600 dark:hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isCheckingWinston ? (
                        <>
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                          Prüfe...
                        </>
                      ) : (
                        <>
                          <Shield className="w-5 h-5 mr-2" />
                          Winston-Check starten
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="p-6 border-t border-gray-200 dark:border-gray-700 flex justify-end">
                <button
                  onClick={() => setShowWinstonModal(false)}
                  className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
                >
                  Schließen
                </button>
              </div>
            </div>
          </div>
        )
      }



      {/* Unified AI Analysis Modal */}
      {
        showAIModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setShowAIModal(false)}>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
              {/* Modal Header */}
              <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center">
                  <Shield className="w-6 h-6 mr-2" />
                  AI Content Analysis
                </h2>
                <button
                  onClick={() => setShowAIModal(false)}
                  className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                  {/* Winston AI Card */}
                  <div className="bg-gray-50 dark:bg-gray-700/50 rounded-3xl p-8 border border-gray-200 dark:border-gray-600 flex flex-col items-center text-center">
                    <div className="h-20 mb-6 flex items-center justify-center">
                      <img src="/assets/winston.png" alt="Winston AI" className="h-16 object-contain" />
                    </div>

                    {thesis?.metadata?.winstonResult ? (
                      <div className="w-full">
                        <div className="relative w-32 h-32 mx-auto mb-4 flex items-center justify-center">
                          <svg className="w-full h-full transform -rotate-90">
                            <circle cx="64" cy="64" r="60" stroke="currentColor" strokeWidth="8" fill="transparent" className="text-gray-200 dark:text-gray-600" />
                            <circle cx="64" cy="64" r="60" stroke="currentColor" strokeWidth="8" fill="transparent"
                              strokeDasharray={2 * Math.PI * 60}
                              strokeDashoffset={2 * Math.PI * 60 * (1 - thesis.metadata.winstonResult.score / 100)}
                              className="text-blue-600 dark:text-blue-500" />
                          </svg>
                          <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <span className="text-3xl font-bold text-gray-900 dark:text-white">{thesis.metadata.winstonResult.score}%</span>
                            <span className="text-xs text-gray-500">Human</span>
                          </div>
                        </div>
                        <p className="text-sm text-gray-500 dark:text-gray-400">Probability of human-written content</p>
                      </div>
                    ) : (
                      <div className="py-8 text-gray-400">
                        <p>No data available</p>
                      </div>
                    )}
                  </div>

                  {/* ZeroGPT Card */}
                  <div className="bg-gray-50 dark:bg-gray-700/50 rounded-3xl p-8 border border-gray-200 dark:border-gray-600 flex flex-col items-center text-center">
                    <div className="h-20 mb-6 flex items-center justify-center">
                      <img src="/assets/zerogpt.png" alt="ZeroGPT" className="h-14 object-contain" />
                    </div>

                    {thesis?.metadata?.zeroGptResult ? (
                      <div className="w-full">
                        <div className="relative w-32 h-32 mx-auto mb-4 flex items-center justify-center">
                          <svg className="w-full h-full transform -rotate-90">
                            <circle cx="64" cy="64" r="60" stroke="currentColor" strokeWidth="8" fill="transparent" className="text-gray-200 dark:text-gray-600" />
                            <circle cx="64" cy="64" r="60" stroke="currentColor" strokeWidth="8" fill="transparent"
                              strokeDasharray={2 * Math.PI * 60}
                              strokeDashoffset={2 * Math.PI * 60 * (1 - thesis.metadata.zeroGptResult.isHumanWritten / 100)}
                              className="text-orange-500 dark:text-orange-400" />
                          </svg>
                          <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <span className="text-3xl font-bold text-gray-900 dark:text-white">{thesis.metadata.zeroGptResult.isHumanWritten}%</span>
                            <span className="text-xs text-gray-500">Human</span>
                          </div>
                        </div>
                        <div className="flex justify-center items-center space-x-4 text-xs">
                          <span className="text-orange-600 dark:text-orange-400 font-medium">AI: {thesis.metadata.zeroGptResult.isGptGenerated}%</span>
                        </div>
                      </div>
                    ) : (
                      <div className="py-8 text-gray-400">
                        <p>No data available</p>
                      </div>
                    )}
                  </div>

                </div>

                <div className="flex justify-center mt-8">
                  <button
                    onClick={handleAICheck}
                    disabled={isCheckingAI}
                    className="flex items-center px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-full font-medium shadow-lg hover:scale-105 transition-transform disabled:opacity-50 disabled:scale-100"
                  >
                    {isCheckingAI ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : <RefreshCw className="w-5 h-5 mr-2" />}
                    Run New Analysis
                  </button>
                </div>

              </div>
            </div>
          </div>
        )
      }

      {/* ZeroGPT Modal - HIDDEN/DEPRECATED - Kept for fallback access if needed, or remove completely */}
      {
        false && showZeroGptModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setShowZeroGptModal(false)}>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
              {/* Modal Header */}
              <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center">
                  <Shield className="w-6 h-6 mr-2" />
                  ZeroGPT AI-Erkennung
                </h2>
                <button
                  onClick={() => setShowZeroGptModal(false)}
                  className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto p-6">
                {thesis?.metadata?.zeroGptResult ? (
                  <div className="space-y-6">
                    <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-6">
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                        Erkennungsergebnis
                      </h3>

                      <div className="grid grid-cols-2 gap-4 mb-4">
                        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                          <div className="text-sm text-green-700 dark:text-green-300 font-medium mb-1">
                            Menschlich geschrieben
                          </div>
                          <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                            {thesis.metadata.zeroGptResult.isHumanWritten}%
                          </div>
                        </div>

                        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                          <div className="text-sm text-red-700 dark:text-red-300 font-medium mb-1">
                            KI-generiert
                          </div>
                          <div className="text-3xl font-bold text-red-600 dark:text-red-400">
                            {thesis.metadata.zeroGptResult.isGptGenerated}%
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
                        <div>
                          <span className="font-medium">Wörter geprüft:</span>{' '}
                          {thesis.metadata.zeroGptResult.wordsCount?.toLocaleString() || 'N/A'}
                        </div>
                        {thesis.metadata.zeroGptResult.checkedAt && (
                          <div>
                            <span className="font-medium">Geprüft am:</span>{' '}
                            {new Date(thesis.metadata.zeroGptResult.checkedAt).toLocaleString('de-DE')}
                          </div>
                        )}
                        {thesis.metadata.zeroGptResult.feedbackMessage && (
                          <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded">
                            <span className="font-medium text-blue-700 dark:text-blue-300">Hinweis:</span>{' '}
                            <span className="text-blue-600 dark:text-blue-400">
                              {thesis.metadata.zeroGptResult.feedbackMessage}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                      <p className="text-sm text-yellow-800 dark:text-yellow-200">
                        <strong>Hinweis:</strong> Die Erkennungsgenauigkeit kann variieren und sollte nur als Indikator verwendet werden.
                      </p>
                    </div>
                    <button
                      onClick={handleCheckZeroGpt}
                      disabled={isCheckingZeroGpt}
                      className="w-full mt-4 inline-flex items-center justify-center px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-blue-600 dark:hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isCheckingZeroGpt ? (
                        <>
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                          Prüfe erneut...
                        </>
                      ) : (
                        <>
                          <Shield className="w-5 h-5 mr-2" />
                          Erneut prüfen
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                    <Shield className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p className="text-lg font-medium mb-2">Kein ZeroGPT-Ergebnis verfügbar</p>
                    <p className="text-sm mb-6">
                      Prüfe deine Thesis auf KI-Erkennung mit ZeroGPT.
                    </p>
                    <button
                      onClick={handleCheckZeroGpt}
                      disabled={isCheckingZeroGpt || !thesis?.latex_content}
                      className="inline-flex items-center px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-blue-600 dark:hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isCheckingZeroGpt ? (
                        <>
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                          Prüfe...
                        </>
                      ) : (
                        <>
                          <Shield className="w-5 h-5 mr-2" />
                          ZeroGPT-Check starten
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="p-6 border-t border-gray-200 dark:border-gray-700 flex justify-end">
                <button
                  onClick={() => setShowZeroGptModal(false)}
                  className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
                >
                  Schließen
                </button>
              </div>
            </div>
          </div>
        )
      }

      {/* Plagiarism Modal */}
      {
        showPlagiarismModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setShowPlagiarismModal(false)}>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
              {/* Modal Header */}
              <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center">
                  <FileText className="w-6 h-6 mr-2" />
                  Plagiat-Erkennung (Grammarly)
                </h2>
                <button
                  onClick={() => setShowPlagiarismModal(false)}
                  className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto p-6">
                {thesis?.metadata?.plagiarismResult ? (
                  <div className="space-y-6">
                    <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-6">
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                        Originalitäts-Ergebnis
                      </h3>

                      <div className="grid grid-cols-2 gap-4 mb-4">
                        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                          <div className="text-sm text-green-700 dark:text-green-300 font-medium mb-1">
                            Originalität
                          </div>
                          <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                            {thesis.metadata.plagiarismResult.originalityPercentage}%
                          </div>
                          <div className="text-xs text-green-600 dark:text-green-400 mt-1">
                            Score: {thesis.metadata.plagiarismResult.originality.toFixed(2)}
                          </div>
                        </div>

                        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                          <div className="text-sm text-red-700 dark:text-red-300 font-medium mb-1">
                            Potentiell plagiiert
                          </div>
                          <div className="text-3xl font-bold text-red-600 dark:text-red-400">
                            {thesis.metadata.plagiarismResult.plagiarismPercentage}%
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
                        {thesis.metadata.plagiarismResult.checkedAt && (
                          <div>
                            <span className="font-medium">Geprüft am:</span>{' '}
                            {new Date(thesis.metadata.plagiarismResult.checkedAt).toLocaleString('de-DE')}
                          </div>
                        )}
                        {thesis.metadata.plagiarismResult.scoreRequestId && (
                          <div>
                            <span className="font-medium">Request ID:</span>{' '}
                            <span className="font-mono text-xs">{thesis.metadata.plagiarismResult.scoreRequestId}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                      <p className="text-sm text-yellow-800 dark:text-yellow-200">
                        <strong>Hinweis:</strong> Die Plagiat-Erkennung vergleicht den Text mit Milliarden von Webseiten und akademischen Arbeiten. Ein niedriger Originalitäts-Score bedeutet nicht automatisch Plagiat, sondern kann auch auf korrekte Zitationen zurückzuführen sein.
                      </p>
                    </div>
                    <button
                      onClick={handleCheckPlagiarism}
                      disabled={isCheckingPlagiarism}
                      className="w-full mt-4 inline-flex items-center justify-center px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-purple-600 dark:hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isCheckingPlagiarism ? (
                        <>
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                          Prüfe erneut...
                        </>
                      ) : (
                        <>
                          <FileText className="w-5 h-5 mr-2" />
                          Erneut prüfen
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                    <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p className="text-lg font-medium mb-2">Kein Plagiat-Ergebnis verfügbar</p>
                    <p className="text-sm mb-6">
                      Prüfe deine Thesis auf Plagiate mit Grammarly.
                    </p>
                    <button
                      onClick={handleCheckPlagiarism}
                      disabled={isCheckingPlagiarism || !thesis?.latex_content}
                      className="inline-flex items-center px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-purple-600 dark:hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isCheckingPlagiarism ? (
                        <>
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                          Prüfe...
                        </>
                      ) : (
                        <>
                          <FileText className="w-5 h-5 mr-2" />
                          Plagiat-Check starten
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="p-6 border-t border-gray-200 dark:border-gray-700 flex justify-end">
                <button
                  onClick={() => setShowPlagiarismModal(false)}
                  className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
                >
                  Schließen
                </button>
              </div>
            </div>
          </div>
        )
      }
    </div >
  )
}

