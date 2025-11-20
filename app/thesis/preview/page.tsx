'use client'

import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2, Send, Edit2, Save, X, Copy, Check, MessageSquare, FileText, BookOpen } from 'lucide-react'
import { createSupabaseClient } from '@/lib/supabase/client'
import { getThesisById } from '@/lib/supabase/theses'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import './thesis-document.css'
import { addPageNumbers } from './add-page-numbers'
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
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [userProfile, setUserProfile] = useState<any>(null)
  const [showSourcesModal, setShowSourcesModal] = useState(false)
  
  const chatEndRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    // Debug: Log TOC format from raw content
    if (content && content.includes('Inhaltsverzeichnis')) {
      const tocIndex = content.indexOf('Inhaltsverzeichnis')
      const tocSection = content.substring(tocIndex, Math.min(tocIndex + 1000, content.length))
      console.log('[TOC Debug] Raw markdown TOC section:', tocSection)
    }
    
    // Add page numbers after content is rendered - use multiple attempts
    const tryAddPageNumbers = (attemptCount = 0) => {
      const maxAttempts = 10
      
      console.log(`[PageNumbers useEffect] Attempt ${attemptCount + 1}/${maxAttempts}`, {
        hasContent: !!content,
        hasRef: !!contentRef.current,
        contentLength: content?.length || 0,
        childrenCount: contentRef.current?.children.length || 0
      })
      
      if (!contentRef.current) {
        if (attemptCount < maxAttempts) {
          console.log('[PageNumbers] contentRef.current is null, retrying in 500ms...')
          setTimeout(() => tryAddPageNumbers(attemptCount + 1), 500)
        } else {
          console.error('[PageNumbers] contentRef.current is still null after max attempts!')
        }
        return
      }
      
      if (!content) {
        if (attemptCount < maxAttempts) {
          console.log('[PageNumbers] content is empty, retrying in 500ms...')
          setTimeout(() => tryAddPageNumbers(attemptCount + 1), 500)
        }
        return
      }
      
      // Check if ReactMarkdown has rendered content
      const hasContent = contentRef.current.children.length > 0 || 
                        contentRef.current.textContent?.trim().length > 0
      
      if (hasContent || attemptCount >= maxAttempts) {
        console.log('[PageNumbers] Content ready, processing...', {
          childrenCount: contentRef.current.children.length,
          textLength: contentRef.current.textContent?.trim().length || 0
        })
        
        // Add page numbers
        console.log('[PageNumbers] Calling addPageNumbers')
        addPageNumbers(contentRef.current)
        
        // Re-add page numbers after a delay to ensure they persist
        if (attemptCount < maxAttempts - 1) {
          setTimeout(() => {
            if (contentRef.current) {
              console.log('[PageNumbers] Re-adding page numbers')
              addPageNumbers(contentRef.current)
            }
          }, 2000)
        }
      } else {
        // Content not ready, try again
        console.log('[PageNumbers] Content not ready yet, retrying in 1000ms...')
        setTimeout(() => tryAddPageNumbers(attemptCount + 1), 1000)
      }
    }
    
    // Start trying after a short delay
    if (content) {
      console.log('useEffect triggered for page numbers, content length:', content.length)
      const timeoutId = setTimeout(() => tryAddPageNumbers(), 500)
      return () => clearTimeout(timeoutId)
    } else {
      console.log('Page numbers useEffect: contentRef or content missing', {
        hasRef: !!contentRef.current,
        hasContent: !!content
      })
    }
  }, [content])

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
    } catch (error) {
      console.error('Error loading thesis:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleTextSelection = () => {
    const selection = window.getSelection()
    if (selection && selection.toString().trim().length > 0) {
      setSelectedText(selection.toString().trim())
    } else {
      setSelectedText('')
    }
  }

  const handleCopySelection = () => {
    if (selectedText) {
      setChatInput(`Bitte ändere folgenden Text:\n\n"${selectedText}"\n\n`)
      // Clear selection
      window.getSelection()?.removeAllRanges()
      setSelectedText('')
    }
  }

  const handleSendMessage = async () => {
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
    setSelectedText('')
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
        throw new Error('Failed to process edit request')
      }

      const data = await response.json()
      const { editedContent, explanation } = data

      // Update content
      setContent(editedContent)
      setHasUnsavedChanges(true)

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: explanation || 'Text wurde erfolgreich bearbeitet.',
        timestamp: new Date(),
      }

      setChatMessages(prev => [...prev, assistantMessage])
    } catch (error) {
      console.error('Error processing edit:', error)
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'Fehler beim Bearbeiten des Textes. Bitte versuche es erneut.',
        timestamp: new Date(),
      }
      setChatMessages(prev => [...prev, errorMessage])
    } finally {
      setIsProcessing(false)
    }
  }

  const handleSave = async () => {
    if (!thesisId || !hasUnsavedChanges) return

    try {
      setIsProcessing(true)
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

      setOriginalContent(content)
      setHasUnsavedChanges(false)
      
      // Show success message
      const successMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: '✓ Änderungen wurden gespeichert.',
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
          <Loader2 className="w-8 h-8 animate-spin text-purple-600 dark:text-purple-400" />
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
          <Link href="/thesis" className="text-purple-600 dark:text-purple-400 hover:underline">
            Zurück zu Meine Theses
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col pt-16">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              {thesis.topic || 'Thesis Preview'}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {thesis.field} • {thesis.thesis_type}
            </p>
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
                className="inline-flex items-center px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                <Edit2 className="w-4 h-4 mr-2" />
                Manuell bearbeiten
              </button>
            ) : (
              <button
                onClick={handleCancelEdit}
                className="inline-flex items-center px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                <X className="w-4 h-4 mr-2" />
                Abbrechen
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!hasUnsavedChanges || isProcessing}
              className="inline-flex items-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isProcessing ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Speichern
            </button>
            <button
              onClick={() => setShowSourcesModal(true)}
              className="inline-flex items-center px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
            >
              <BookOpen className="w-4 h-4 mr-2" />
              Quellen
            </button>
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
      <div className="flex-1 flex overflow-hidden">
        {/* Chat Panel (Left) */}
        <div className="w-96 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col">
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
                  className={`max-w-[80%] rounded-lg p-3 ${
                    message.role === 'user'
                      ? 'bg-purple-600 text-white'
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
                  <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Chat Input */}
          <div className="p-4 border-t border-gray-200 dark:border-gray-700">
            {selectedText && (
              <div className="mb-2 p-2 bg-purple-50 dark:bg-purple-900/20 rounded text-sm text-purple-700 dark:text-purple-300">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Ausgewählter Text:</span>
                  <button
                    onClick={handleCopySelection}
                    className="text-purple-600 dark:text-purple-400 hover:underline"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
                <p className="mt-1 text-xs italic line-clamp-2">"{selectedText.substring(0, 100)}..."</p>
              </div>
            )}
            <div className="flex gap-2">
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSendMessage()
                  }
                }}
                placeholder="Beschreibe die gewünschten Änderungen..."
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm resize-none focus:outline-none focus:ring-2 focus:ring-purple-500"
                rows={3}
              />
              <button
                onClick={handleSendMessage}
                disabled={!chatInput.trim() || isProcessing}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Preview Panel (Right) - Document Style */}
        <div className="flex-1 overflow-y-auto overflow-x-auto bg-gray-100 dark:bg-gray-800">
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
            <div className="flex justify-center py-8" style={{ overflowX: 'auto', width: '100%', overflowY: 'visible' }}>
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
                  position: 'relative', // Ensure page numbers can position absolutely
                  overflow: 'visible', // Allow page numbers to be visible
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
                         thesis?.thesis_type === 'bachelor' ? 'Bachelorarbeit' :
                         thesis?.thesis_type === 'master' ? 'Masterarbeit' :
                         thesis?.thesis_type === 'dissertation' ? 'Dissertation' : 'Thesis'}
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
                    minHeight: '247mm',
                    paddingBottom: '30mm', // Space for page numbers
                    overflow: 'visible', // Allow page numbers to be visible
                  }}
                  data-thesis-content="true"
                  id="thesis-content-container"
                  data-test="page-numbers-container"
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={{
                      // Custom text renderer to handle footnote markers ^1, ^2, etc.
                      text: ({ node, children, ...props }: any) => {
                        const text = String(children || '')
                        const footnotes = thesis?.metadata?.footnotes || {}
                        const citationStyle = thesis?.citation_style
                        
                        // Only process footnotes for German citation style
                        if (citationStyle === 'deutsche-zitierweise' && Object.keys(footnotes).length > 0) {
                          // Split text by footnote markers (^1, ^2, etc.)
                          const parts = text.split(/(\^\d+)/g)
                          
                          if (parts.length > 1) {
                            return (
                              <>
                                {parts.map((part, idx) => {
                                  const footnoteMatch = part.match(/^\^(\d+)$/)
                                  if (footnoteMatch) {
                                    const footnoteNum = parseInt(footnoteMatch[1], 10)
                                    const footnoteText = footnotes[footnoteNum] || `[Fußnote ${footnoteNum}]`
                                    return (
                                      <span
                                        key={idx}
                                        style={{
                                          position: 'relative',
                                          display: 'inline-block',
                                        }}
                                      >
                                        <sup
                                          style={{
                                            fontSize: '0.7em',
                                            verticalAlign: 'super',
                                            cursor: 'help',
                                            color: '#0066cc',
                                            textDecoration: 'underline',
                                            textDecorationStyle: 'dotted',
                                          }}
                                          title={footnoteText}
                                          onMouseEnter={(e) => {
                                            // Create tooltip
                                            const tooltip = document.createElement('div')
                                            tooltip.id = `footnote-tooltip-${footnoteNum}`
                                            tooltip.textContent = footnoteText
                                            tooltip.style.cssText = `
                                              position: absolute;
                                              bottom: 100%;
                                              left: 50%;
                                              transform: translateX(-50%);
                                              background: #333;
                                              color: white;
                                              padding: 8px 12px;
                                              border-radius: 4px;
                                              font-size: 11pt;
                                              white-space: nowrap;
                                              max-width: 400px;
                                              white-space: normal;
                                              z-index: 10000;
                                              box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                                              margin-bottom: 5px;
                                            `
                                            e.currentTarget.appendChild(tooltip)
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
                                      </span>
                                    )
                                  }
                                  return <span key={idx}>{part}</span>
                                })}
                              </>
                            )
                          }
                        }
                        
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
                      p: ({ node, children, ...props }: any) => {
                        // TOC should be in lists, not paragraphs
                        return (
                          <p style={{
                            marginBottom: '6mm',
                            textAlign: 'justify',
                            textIndent: '0mm',
                            lineHeight: '1.6',
                            fontSize: '12pt',
                          }} {...props}>{children}</p>
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
                  
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sources Modal */}
      {showSourcesModal && (
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
              {thesis?.uploaded_sources && Array.isArray(thesis.uploaded_sources) && thesis.uploaded_sources.length > 0 ? (
                <div className="space-y-4">
                  {thesis.uploaded_sources.map((source: any, index: number) => (
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
                            {source.metadata?.authors && source.metadata.authors.length > 0 && (
                              <p>
                                <span className="font-medium">Autoren:</span>{' '}
                                {Array.isArray(source.metadata.authors) 
                                  ? source.metadata.authors.join(', ')
                                  : source.metadata.authors}
                              </p>
                            )}
                            
                            {source.metadata?.year && (
                              <p>
                                <span className="font-medium">Jahr:</span> {source.metadata.year}
                              </p>
                            )}
                            
                            {source.metadata?.journal && (
                              <p>
                                <span className="font-medium">Journal:</span> {source.metadata.journal}
                              </p>
                            )}
                            
                            {source.doi && (
                              <p>
                                <span className="font-medium">DOI:</span>{' '}
                                <a
                                  href={`https://doi.org/${source.doi}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-purple-600 dark:text-purple-400 hover:underline"
                                >
                                  {source.doi}
                                </a>
                              </p>
                            )}
                            
                            {source.metadata?.pages && (
                              <p>
                                <span className="font-medium">Seiten:</span> {source.metadata.pages}
                              </p>
                            )}
                            
                            {source.metadata?.pageStart && source.metadata?.pageEnd && (
                              <p>
                                <span className="font-medium">Seitenbereich:</span> {source.metadata.pageStart} - {source.metadata.pageEnd}
                              </p>
                            )}
                            
                            {source.sourceUrl && (
                              <p>
                                <span className="font-medium">URL:</span>{' '}
                                <a
                                  href={source.sourceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-purple-600 dark:text-purple-400 hover:underline break-all"
                                >
                                  {source.sourceUrl.length > 60 ? `${source.sourceUrl.substring(0, 60)}...` : source.sourceUrl}
                                </a>
                              </p>
                            )}
                            
                            {source.metadata?.abstract && (
                              <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                                <p className="font-medium mb-1">Abstract:</p>
                                <p className="text-gray-600 dark:text-gray-400 italic text-xs line-clamp-3">
                                  {source.metadata.abstract}
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
      )}
    </div>
  )
}

