'use client'

import React, { useState, useEffect, useRef, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2, Send, Edit2, Save, X, Copy, Check, MessageSquare, FileText, BookOpen, Download, Shield, Home, RefreshCw, Menu, ChevronRight, ChevronLeft, Brain } from 'lucide-react'
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
  thinking?: string // AI reasoning process
  timestamp: Date
}

const ThesisPreviewContent = () => {
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
  const [mobileChatOpen, setMobileChatOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

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

  // Helper to fix inline headings (e.g. "Sentence. ## Heading")
  // This ensures they render as proper Markdown headings
  const ensureHeadingsOnNewLines = (text: string): string => {
    if (!text) return ''
    // Look for:
    // 1. Non-newline character
    // 2. Optional whitespace (including none!)
    // 3. One to six hashes
    // 4. Space
    // 5. Text
    // Replace with: char + \n\n + hashes + space + text
    return text.replace(/([^\n])\s*(#{1,6}\s+)/g, '$1\n\n$2')
  }

  // Helper to normalize heading levels based on numbering
  // Ensures 1. -> ##, 1.1 -> ###, etc. regardless of generation errors
  const normalizeHeadingLevels = (text: string): string => {
    if (!text) return ''
    return text.split('\n').map(line => {
      // Match numeric headings (e.g. "# 1. Title", "## 2.3 Title")
      const match = line.match(/^(\#{1,6})\s+(\d+(?:\.\d+)*)\.?\s+(.+)$/)
      if (match) {
        const [_, hashes, number, content] = match
        // Count levels: "1" = 1, "1.2" = 2, "1.2.3" = 3
        const level = number.split('.').filter(n => n.trim().length > 0).length

        // Mapping: Level 1 -> ## (Heading 2), Level 2 -> ### (Heading 3)
        // This ensures consistent hierarchy even if AI generated wrong hashes
        const targetHashes = '#'.repeat(Math.min(6, level + 1))
        return `${targetHashes} ${number} ${content}`
      }
      return line
    }).join('\n')
  }

  // Helper to remove stray empty headers and excessive whitespace
  const cleanThesisContent = (text: string): string => {
    if (!text) return ''
    return text
      // Remove lines that are just hashes and whitespace (empty headers)
      .replace(/^\s*#{1,6}\s*$/gm, '')
      // Remove double blank lines (keep max one blank line = 2 newlines)
      // This fixes the "huge gaps" issue
      .replace(/\n{3,}/g, '\n\n')
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
      let thesisContent = thesisData.latex_content || ''

      // Fix formatting issues immediately on load
      thesisContent = ensureHeadingsOnNewLines(thesisContent)
      thesisContent = normalizeHeadingLevels(thesisContent)

      // Sanitize: clean up stray headers and excessive gaps
      thesisContent = cleanThesisContent(thesisContent)

      setContent(thesisContent)
      setOriginalContent(thesisContent)

      // Load sources - prioritize strictly used sources from metadata
      // This ensures the "Sources" tab matches the bibliography exactly ("not a single more or less")
      const strictUsedSources = thesisData.metadata?.used_sources
      const uploadedSources = thesisData.uploaded_sources || []

      if (Array.isArray(strictUsedSources) && strictUsedSources.length > 0) {
        // Strict mode: use sources actually used in thesis
        setBibliographySources(strictUsedSources)
      } else if (uploadedSources.length > 0) {
        // Fallback: use all uploaded sources (less precise)
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
          fileSearchStoreId: thesis?.file_search_store_id,
          uploadedSources: thesis?.uploaded_sources,
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
        thinking: data.thinking, // Store thinking process
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
      let finalNewContent = pendingEdit.newContent
      const oldContent = content

      // Robustness Check: If API failed to replace (content unchanged), try client-side replacement
      if (!finalNewContent || finalNewContent === oldContent) {
        console.log('[ApproveEdit] API did not return different content. Attempting client-side replacement...')
        // Strategy 1: Exact string replacement
        if (oldContent.includes(pendingEdit.oldText)) {
          finalNewContent = oldContent.replace(pendingEdit.oldText, pendingEdit.newText)
        } else {
          // Strategy 2: Relaxed whitespace replacement
          // Create a regex that allows variable whitespace between words of oldText
          const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const looseMatcher = new RegExp(
            escapeRegExp(pendingEdit.oldText).replace(/\s+/g, '\\s+'),
            'g' // Global just in case, but usually we want one. Ideally finding the specific instance is hard without index.
          )
          // We replace ONLY the first occurrence or rely on context if we had it.
          // For now, replacing the first relaxed match is better than nothing.
          finalNewContent = oldContent.replace(looseMatcher, pendingEdit.newText)
        }
      }

      // Verify legitimate change
      if (finalNewContent === oldContent) {
        alert('Fehler: Der zu ersetzende Text konnte im Dokument nicht eindeutig gefunden werden. Bitte versuchen Sie es erneut.')
        return // Do not clear state so user can try manual fix or copy text
      }

      setContent(finalNewContent)
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
        const updatedSources = extractBibliographySources(finalNewContent, thesis.uploaded_sources)
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
              newContent: finalNewContent,
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

  const handleManualCritique = async () => {
    if (!thesisId) return
    if (!confirm("Start manual critique & repair? WARN: This runs for 2-3 minutes and will modify the thesis content.")) return;

    try {
      setIsProcessing(true)
      const response = await fetch('/api/trigger-critique', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ thesisId }),
      })

      if (!response.ok) {
        throw new Error('Failed to trigger critique')
      }

      const data = await response.json()

      const successMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: `✓ Critique job started (ID: ${data.jobId}). The thesis status is now 'generating'. Please reload in a few minutes to see changes.`,
        timestamp: new Date(),
      }
      setChatMessages(prev => [...prev, successMessage])
    } catch (error) {
      console.error('Error triggering critique:', error)
      alert('Error starting critique: ' + (error instanceof Error ? error.message : 'Unknown error'))
    } finally {
      setIsProcessing(false)
    }
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


  // Memoize markdown components to avoid re-rendering and losing text selection

  const markdownComponents = React.useMemo(() => ({
    // Text component - footnotes are handled at paragraph level to avoid double processing
    p: ({ node, children, ...props }: any) => {
      // Helper to extract text from children robustly
      const getTextContent = (n: any): string => {
        if (typeof n === 'string') return n
        if (Array.isArray(n)) return n.map(getTextContent).join('')
        if (n?.props?.children) return getTextContent(n.props.children)
        return ''
      }
      const text = getTextContent(children)
      const normalizedText = text.replace(/\s+/g, ' ').trim()

      if (text.trim() === '$$PAGE_BREAK$$') {
        return <div style={{ pageBreakAfter: 'always', height: 0, margin: 0 }} />
      }

      // --- Footnote Logic (Restored from User Snippet) ---
      const extractFootnotesFromContent = (text: string): Record<number, string> => {
        const footnotes: Record<number, string> = {}
        const footnoteRegex = /\[\^(\d+)\]:\s*(.+?)(?=\n\[\^|\n\n|$)/gs
        let match
        while ((match = footnoteRegex.exec(text)) !== null) {
          footnotes[parseInt(match[1], 10)] = match[2].trim()
        }
        return footnotes
      }

      let footnotes: Record<number, string> = thesis?.metadata?.footnotes || {}
      if (Object.keys(footnotes).length === 0 && content) {
        footnotes = extractFootnotesFromContent(content)
      }
      // Fallback citation citations
      if (Object.keys(footnotes).length === 0 && thesis?.metadata?.citations) {
        const citations = thesis.metadata.citations as any[]
        citations.forEach((citation, idx) => {
          const authors = Array.isArray(citation.authors) ? citation.authors.join(', ') : citation.authors || 'Unbekannt'
          footnotes[idx + 1] = `${authors} (${citation.year || ''}): ${citation.title || ''}${citation.pages ? `, S. ${citation.pages}` : ''}`
        })
      }

      // Build footnote PDF URLs
      const footnotePdfUrls: Record<number, string | null> = {}
      if (bibliographySources && bibliographySources.length > 0) {
        Object.entries(footnotes).forEach(([numStr, citationText]) => {
          const num = parseInt(numStr, 10)
          const citation = citationText as string
          const yearMatch = citation.match(/[\(\s,](\d{4})[\)\s,:]/)
          const citationYear = yearMatch ? yearMatch[1] : null
          const authorMatch = citation.match(/^([A-ZÄÖÜa-zäöüß][a-zäöüß]+)(?:\s|,|\/|\(|\:)/)
          const citationAuthorLastName = authorMatch ? authorMatch[1].toLowerCase() : null

          if (!citationYear && !citationAuthorLastName) return

          const matchingSource = bibliographySources.find((source: any) => {
            const meta = source.metadata || source
            const sourceYear = String(meta.year || source.year || '')
            const authors = meta.authors || []
            const firstAuthor = authors[0] || ''
            const sourceAuthorLastName = firstAuthor.split(' ').pop()?.toLowerCase() || ''

            if (citationYear && citationAuthorLastName) return sourceYear === citationYear && sourceAuthorLastName === citationAuthorLastName
            if (citationYear) return sourceYear === citationYear
            if (citationAuthorLastName) return sourceAuthorLastName === citationAuthorLastName
            return false
          })

          if (matchingSource) {
            footnotePdfUrls[num] = matchingSource.sourceUrl || matchingSource.metadata?.sourceUrl || matchingSource.pdfUrl || null
          }
        })
      }

      // --- Identification Logic ---
      const isHighlighted = highlightedPassages.some(passage =>
        text.includes(passage.text.substring(0, 50)) ||
        passage.text.includes(text.substring(0, 50))
      )

      let hasExactPendingMatch = false
      if (pendingEdit) {
        const normalizedOldText = pendingEdit.oldText.replace(/\s+/g, ' ').trim()
        hasExactPendingMatch = text.includes(pendingEdit.oldText) || normalizedText.includes(normalizedOldText)
      }

      const hasPendingEdit = !!pendingEdit && (hasExactPendingMatch || isHighlighted)

      // --- Rendering Logic ---

      // Case 1: Active Edit (Show Diff View)
      if (hasPendingEdit && pendingEdit) {
        // Fallback to block diff for robustness (safest for user requirement)
        return (
          <div className="my-4 border rounded-lg overflow-hidden ring-2 ring-blue-500/20">
            <div className="bg-red-50 dark:bg-red-900/20 p-4 border-b border-red-100">
              <span className="text-xs font-bold text-red-600 uppercase mb-1 block">Original</span>
              <p className="line-through text-red-800 dark:text-red-300 opacity-70" {...props}>{children}</p>
            </div>
            <div className="bg-green-50 dark:bg-green-900/20 p-4">
              <span className="text-xs font-bold text-green-600 uppercase mb-1 block">Vorschlag</span>
              <div className="text-green-800 dark:text-green-300 font-medium">
                <ReactMarkdown components={{ p: ({ node, ...pProps }: any) => <p {...pProps} /> }}>
                  {pendingEdit.newText}
                </ReactMarkdown>
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 p-2 flex justify-end gap-2 border-t border-gray-200">
              <button onClick={handleRejectEdit} className="px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 border border-red-200 rounded">Ablehnen</button>
              <button onClick={handleApproveEdit} className="px-3 py-1 text-xs font-medium text-green-600 hover:bg-green-50 border border-green-200 rounded">Übernehmen</button>
            </div>
          </div>
        )
      }

      // Case 2: Standard Paragraph with Highlight/Footnotes
      return (
        <p style={{
          marginBottom: '0',
          textAlign: 'justify',
          backgroundColor: isHighlighted ? '#fef3c7' : 'transparent',
          padding: isHighlighted ? '2px 4px' : '0',
          borderRadius: isHighlighted ? '2px' : '0',
        }} {...props}>
          {React.Children.map(children, (child) => {
            if (typeof child === 'string') {
              // Regex for footnotes: [^1], [^12] etc.
              const parts = child.split(/(\[\^\d+\])/g)
              return parts.map((part, index) => {
                const match = part.match(/\[\^(\d+)\]/)
                if (match) {
                  const num = parseInt(match[1], 10)
                  const pdfUrl = footnotePdfUrls[num]
                  const hasPdf = !!pdfUrl

                  return (
                    <span key={index} className="group relative inline-block">
                      <sup style={{
                        fontSize: '0.7em',
                        verticalAlign: 'super',
                        marginRight: '1px',
                        cursor: hasPdf ? 'pointer' : 'default',
                        color: hasPdf ? '#2563eb' : 'inherit',
                        fontWeight: hasPdf ? 'bold' : 'normal',
                      }}
                        onClick={(e) => {
                          if (hasPdf && pdfUrl) {
                            e.stopPropagation()
                            window.open(pdfUrl, '_blank')
                          }
                        }}
                        title={footnotes[num] || `Fußnote ${num}`}
                      >
                        {num}
                      </sup>
                    </span>
                  )
                }
                // Handle standard carat footnotes if mixed schema ^1
                const caratParts = part.split(/(\^\d+)/g)
                if (caratParts.length > 1) {
                  return caratParts.map((cp, cpi) => {
                    const cmatch = cp.match(/^\^(\d+)$/)
                    if (cmatch) {
                      const num = parseInt(cmatch[1])
                      return <sup key={`${index}-${cpi}`} className="text-blue-600 ml-0.5">{num}</sup>
                    }
                    return cp
                  })
                }
                return part
              })
            }
            return child
          })}
        </p>
      )
    },
    h1: ({ node, ...props }: any) => (
      <h1 style={{ fontSize: '16pt', fontWeight: 'bold', textAlign: 'left', marginTop: '12mm', marginBottom: '8mm', pageBreakBefore: 'always', breakBefore: 'page' }} {...props} />
    ),
    h2: ({ node, children, ...props }: any) => {
      const text = String(children || '')
      const isTOCHeading = text.includes('Inhaltsverzeichnis') || text.includes('Table of Contents')
      if (isTOCHeading && thesis?.outline) return null
      return <h2 style={{ fontSize: '14pt', fontWeight: 'bold', marginTop: '8mm', marginBottom: '4mm', textAlign: 'left' }} {...props}>{children}</h2>
    },
    h3: ({ node, ...props }: any) => (
      <h3 style={{ fontSize: '12pt', fontWeight: 'bold', marginTop: '8mm', marginBottom: '4mm', textAlign: 'left' }} {...props} />
    ),
    h4: ({ node, ...props }: any) => (
      <h4 style={{ fontSize: '11pt', fontWeight: 'bold', marginTop: '6mm', marginBottom: '3mm', textAlign: 'left' }} {...props} />
    ),
    li: ({ node, ...props }: any) => (
      <li style={{ marginBottom: '4mm' }} {...props} />
    ),
    blockquote: ({ node, ...props }: any) => (
      <blockquote style={{ borderLeft: '4px solid #e0e0e0', paddingLeft: '5mm', marginLeft: '0', marginRight: '0', fontStyle: 'italic', color: '#555' }} {...props} />
    )
  }), [thesis, content, bibliographySources, highlightedPassages, pendingEdit])

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
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 sm:px-6 py-4 relative z-30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 overflow-hidden">
            <Link
              href="/"
              className="hidden sm:inline-flex items-center text-sm text-gray-600 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors flex-shrink-0"
            >
              <Home className="w-4 h-4 mr-1" />
              Startseite
            </Link>
            <div className="hidden sm:block h-6 w-px bg-gray-300 dark:bg-gray-600 flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-lg sm:text-2xl font-bold text-gray-900 dark:text-white truncate">
                {thesis.topic || 'Thesis Preview'}
              </h1>
              <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-0.5 sm:mt-1 truncate">
                {thesis.field} • {thesis.thesis_type}
              </p>
            </div>
          </div>


          // Desktop Toolbar - Hidden on Mobile
          <div className="hidden md:flex items-center gap-3 flex-shrink-0">
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
              onClick={handleManualCritique}
              disabled={isProcessing}
              className="inline-flex items-center px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Manuelle Kritik & Reparatur starten"
            >
              {isProcessing ? (
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3 mr-1" />
              )}
              Repair
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

          {/* Mobile Menu Toggle Button */}
          <div className="flex md:hidden items-center gap-2">
            {hasUnsavedChanges && (
              <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                Ungespeichert
              </span>
            )}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>

        {/* Mobile Menu Dropdown */}
        {mobileMenuOpen && (
          <div className="md:hidden absolute top-full left-0 right-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-xl p-4 flex flex-col gap-3 rounded-b-xl animate-in slide-in-from-top-2">
            {!isEditing ? (
              <button
                onClick={() => { handleManualEdit(); setMobileMenuOpen(false); }}
                className="flex items-center w-full px-4 py-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <Edit2 className="w-5 h-5 mr-3 text-gray-500" />
                <span className="font-medium text-gray-900 dark:text-white">Bearbeiten</span>
              </button>
            ) : (
              <button
                onClick={() => { handleCancelEdit(); setMobileMenuOpen(false); }}
                className="flex items-center w-full px-4 py-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg"
              >
                <X className="w-5 h-5 mr-3" />
                <span className="font-medium">Abbrechen</span>
              </button>
            )}

            <button
              onClick={() => { handleSave(); setMobileMenuOpen(false); }}
              disabled={!hasUnsavedChanges || isProcessing}
              className="flex items-center w-full px-4 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg disabled:opacity-50"
            >
              {isProcessing ? <Loader2 className="w-5 h-5 mr-3 animate-spin" /> : <Save className="w-5 h-5 mr-3" />}
              <span className="font-medium">Speichern</span>
            </button>

            <div className="h-px bg-gray-100 dark:bg-gray-700 my-1" />

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { setShowSourcesModal(true); setMobileMenuOpen(false); }}
                className="flex flex-col items-center justify-center p-3 bg-gray-50 dark:bg-gray-700/30 rounded-lg hover:bg-gray-100"
              >
                <BookOpen className="w-6 h-6 mb-2 text-gray-600 dark:text-gray-400" />
                <span className="text-xs font-medium text-gray-900 dark:text-white">Quellen</span>
              </button>

              <button
                onClick={() => { setShowVersionsModal(true); setMobileMenuOpen(false); }}
                className="flex flex-col items-center justify-center p-3 bg-gray-50 dark:bg-gray-700/30 rounded-lg hover:bg-gray-100"
              >
                <FileText className="w-6 h-6 mb-2 text-blue-600" />
                <span className="text-xs font-medium text-gray-900 dark:text-white">Versionen ({thesisVersions.length})</span>
              </button>

              <button
                onClick={() => { setShowAIModal(true); setMobileMenuOpen(false); }}
                className="flex flex-col items-center justify-center p-3 bg-gray-50 dark:bg-gray-700/30 rounded-lg hover:bg-gray-100"
              >
                <Shield className="w-6 h-6 mb-2 text-indigo-600" />
                <span className="text-xs font-medium text-gray-900 dark:text-white">GPT-Check</span>
              </button>

              <button
                onClick={() => { setShowPlagiarismModal(true); setMobileMenuOpen(false); }}
                className="flex flex-col items-center justify-center p-3 bg-gray-50 dark:bg-gray-700/30 rounded-lg hover:bg-gray-100"
              >
                <FileText className="w-6 h-6 mb-2 text-purple-600" />
                <span className="text-xs font-medium text-gray-900 dark:text-white">Plagiat</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { handleExportDoc(); setMobileMenuOpen(false); }}
                className="flex items-center justify-center px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50"
              >
                <Download className="w-4 h-4 mr-2 text-green-600" />
                <span className="text-sm">Word</span>
              </button>
              <button
                onClick={() => { handleExportLaTeX(); setMobileMenuOpen(false); }}
                className="flex items-center justify-center px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50"
              >
                <Download className="w-4 h-4 mr-2 text-blue-600" />
                <span className="text-sm">LaTeX</span>
              </button>
            </div>

            <Link href="/thesis" className="flex items-center justify-center px-4 py-3 mt-2 text-gray-500 hover:text-gray-900">
              <Home className="w-4 h-4 mr-2" /> Zurück zur Übersicht
            </Link>
          </div>
        )}
      </div>

      {/* Split View: Chat (Left) + Preview (Right) */}
      <div className="flex-1 flex overflow-hidden h-full relative">
        {/* Mobile Chat Overlay */}
        {mobileChatOpen && (
          <div
            className="md:hidden absolute inset-0 bg-black/50 z-30 backdrop-blur-sm transition-opacity"
            onClick={() => setMobileChatOpen(false)}
          />
        )}

        {/* Chat Panel (Left) - Responsive */}
        <div className={`
          absolute md:static inset-y-0 left-0 z-40
          w-85 md:w-96 
          bg-white dark:bg-gray-800 
          border-r border-gray-200 dark:border-gray-700 
          flex flex-col h-full flex-shrink-0
          transition-transform duration-300 ease-in-out
          ${mobileChatOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full md:translate-x-0'}
        `}>
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
                  {/* AI Thinking Process */}
                  {message.thinking && (
                    <div className="mb-3 text-xs opacity-90 italic bg-black/5 dark:bg-white/10 p-2 rounded border border-black/10 dark:border-white/10">
                      <details>
                        <summary className="cursor-pointer hover:font-bold select-none list-none flex items-center gap-1 text-blue-600 dark:text-blue-400">
                          <span className="opacity-90">🧠 KI-Gedankengang anzeigen</span>
                        </summary>
                        <p className="mt-2 whitespace-pre-wrap leading-relaxed opacity-90 text-gray-700 dark:text-gray-300">
                          {message.thinking}
                        </p>
                      </details>
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
                <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-3 flex items-center gap-2">
                  <Brain className="w-4 h-4 animate-pulse text-purple-600 dark:text-purple-400" />
                  <span className="text-xs text-gray-500 dark:text-gray-400 animate-pulse">Thinking...</span>
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
        <div className="flex-1 flex flex-col overflow-hidden bg-gray-100 dark:bg-gray-800 relative">
          {/* Mobile Chat Toggle Button */}
          <button
            onClick={() => setMobileChatOpen(!mobileChatOpen)}
            className="md:hidden absolute bottom-6 left-6 z-30 p-3 bg-black dark:bg-white text-white dark:text-black rounded-full shadow-xl hover:scale-105 transition-transform"
          >
            {mobileChatOpen ? <ChevronLeft className="w-6 h-6" /> : <MessageSquare className="w-6 h-6" />}
          </button>
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
                      components={markdownComponents}
                    >
                      {content}
                    </ReactMarkdown>
                  </div>


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
                            Score: {thesis.metadata.plagiarismResult.originalityPercentage?.toFixed(2)}
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
    </div>
  )
}


export default function ThesisPreviewPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-white dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-purple-600 mx-auto mb-4" />
          <p className="text-gray-500 dark:text-gray-400">Lade Dokument...</p>
        </div>
      </div>
    }>
      <ThesisPreviewContent />
    </Suspense>
  )
}

