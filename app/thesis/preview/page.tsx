'use client'

import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2, Send, Edit2, Save, X, Copy, Check, MessageSquare, FileText } from 'lucide-react'
import { createSupabaseClient } from '@/lib/supabase/client'
import { getThesisById, updateThesis } from '@/lib/supabase/theses'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

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
  
  const chatEndRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
      await updateThesis(thesisId, {
        latex_content: content,
      })
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

        {/* Preview Panel (Right) */}
        <div className="flex-1 overflow-y-auto bg-white dark:bg-gray-900">
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
            <div
              ref={previewRef}
              onMouseUp={handleTextSelection}
              className="max-w-4xl mx-auto p-8 prose prose-lg dark:prose-invert max-w-none"
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                  h1: ({ node, ...props }) => (
                    <h1 className="text-4xl font-bold mt-8 mb-4 text-gray-900 dark:text-white" {...props} />
                  ),
                  h2: ({ node, ...props }) => (
                    <h2 className="text-3xl font-semibold mt-6 mb-3 text-gray-900 dark:text-white" {...props} />
                  ),
                  h3: ({ node, ...props }) => (
                    <h3 className="text-2xl font-semibold mt-4 mb-2 text-gray-900 dark:text-white" {...props} />
                  ),
                  p: ({ node, ...props }) => (
                    <p className="mb-4 text-gray-800 dark:text-gray-200 leading-relaxed" {...props} />
                  ),
                  ul: ({ node, ...props }) => (
                    <ul className="list-disc list-inside mb-4 space-y-2 text-gray-800 dark:text-gray-200" {...props} />
                  ),
                  ol: ({ node, ...props }) => (
                    <ol className="list-decimal list-inside mb-4 space-y-2 text-gray-800 dark:text-gray-200" {...props} />
                  ),
                  li: ({ node, ...props }) => (
                    <li className="ml-4 text-gray-800 dark:text-gray-200" {...props} />
                  ),
                  blockquote: ({ node, ...props }) => (
                    <blockquote className="border-l-4 border-purple-500 pl-4 italic my-4 text-gray-700 dark:text-gray-300" {...props} />
                  ),
                  code: ({ node, inline, ...props }: any) => {
                    if (inline) {
                      return (
                        <code className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-sm font-mono text-purple-600 dark:text-purple-400" {...props} />
                      )
                    }
                    return (
                      <code className="block bg-gray-100 dark:bg-gray-800 p-4 rounded-lg overflow-x-auto text-sm font-mono" {...props} />
                    )
                  },
                }}
              >
                {content || '*Kein Inhalt verfügbar*'}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

