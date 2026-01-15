'use client'

import { useState } from 'react'

import { getThesisContent, sendToHumanizer } from './actions'

interface Props {
    theses: any[]
}

export function ClientPanel({ theses }: Props) {
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [isSending, setIsSending] = useState(false)
    const [payload, setPayload] = useState<string>('')
    const [endpoint, setEndpoint] = useState<string>('https://humanizer-yy5o.onrender.com/api/process')

    const handleGenerate = async () => {
        if (!selectedId) return
        setIsLoading(true)
        setPayload('Fetching content...')
        try {
            const { content, metadata } = await getThesisContent(selectedId)
            if (!content) {
                setPayload('No content found for this thesis.')
                return
            }

            // LOGIC: Split content by Level 2 (##) and Level 3 (###) headers
            // Relaxed regex to catch headers even if formatting is messy (missing newlines)
            const sections = content.split(/(?=#{2,3} )/g)

            const chunks = sections.map((section: string, index: number) => {
                const headingMatch = section.match(/#{2,3}\s+([^\n]+)/);
                const heading = headingMatch ? headingMatch[0].trim() : null;

                return {
                    index,
                    heading, // Use this context to understand what the chunk is
                    content: section // The full text including heading
                }
            }).filter((c: any) => c.content.trim().length > 0)

            const json = {
                jobId: selectedId,
                chunks,
                metadata: {
                    language: metadata?.language || 'german', // Default to german but respect DB
                    strict_formatting: false
                }
            }

            setPayload(JSON.stringify(json, null, 2))

        } catch (err: any) {
            setPayload(`Error: ${err.message}`)
        } finally {
            setIsLoading(false)
        }
    }

    const copyToClipboard = () => {
        if (!payload) return
        navigator.clipboard.writeText(payload)
        alert('Copied to clipboard!')
    }

    const handleSend = async () => {
        if (!payload || !endpoint) return
        setIsSending(true)
        try {
            const jsonPayload = JSON.parse(payload) // Parse back to object to send
            const result = await sendToHumanizer(endpoint, jsonPayload)
            if (result.success) {
                alert('Successfully sent to Humanizer API!')
                console.log('API Response:', result.data)
            } else {
                alert(`Error: ${result.error}`)
            }
        } catch (e: any) {
            alert(`Error: ${e.message}`)
        } finally {
            setIsSending(false)
        }
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 h-[80vh]">
            {/* Left Sidebar */}
            <div className="border rounded-lg overflow-hidden flex flex-col bg-white shadow-sm">
                <div className="p-4 bg-gray-50 border-b font-medium flex justify-between items-center">
                    <span>Theses ({theses.length})</span>
                </div>
                <div className="overflow-y-auto flex-1 p-2 space-y-2">
                    {theses.map(thesis => (
                        <button
                            key={thesis.id}
                            onClick={() => setSelectedId(thesis.id)}
                            className={`w-full text-left p-3 rounded-md text-sm transition-colors border ${selectedId === thesis.id
                                ? 'bg-blue-50 border-blue-200 text-blue-700 shadow-sm'
                                : 'hover:bg-gray-50 border-transparent'
                                }`}
                        >
                            <div className="font-medium truncate">{thesis.topic || 'Untitled Thesis'}</div>
                            <div className="text-xs text-gray-500 mt-1 flex justify-between">
                                <span>{new Date(thesis.created_at).toLocaleDateString('de-DE')}</span>
                                <span className="bg-gray-100 px-1.5 py-0.5 rounded text-[10px] uppercase">{thesis.thesis_type}</span>
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {/* Main Content */}
            <div className="md:col-span-2 flex flex-col gap-4">
                <div className="bg-white p-4 rounded-lg border shadow-sm flex flex-col h-full">
                    <div className="flex justify-between items-center mb-4">
                        <div>
                            <h2 className="font-bold text-lg">Payload Generator</h2>
                            <p className="text-sm text-gray-500">Splits content by chapters (##)</p>

                        </div>

                        <div className="flex gap-2 items-center">
                            <input
                                type="text"
                                placeholder="API Endpoint URL"
                                className="border rounded px-3 py-2 text-sm w-64"
                                value={endpoint}
                                onChange={(e) => setEndpoint(e.target.value)}
                            />
                            <button
                                onClick={handleSend}
                                disabled={!payload || !endpoint || isSending}
                                className="px-3 py-2 text-sm border bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
                            >
                                {isSending ? 'Sending...' : 'Send to API'}
                            </button>
                            <button
                                onClick={copyToClipboard}
                                disabled={!payload}
                                className="px-3 py-2 text-sm border rounded hover:bg-gray-50 transition-colors"
                            >
                                Copy JSON
                            </button>
                            <button
                                onClick={handleGenerate}
                                disabled={!selectedId || isLoading}
                                className="bg-black text-white px-4 py-2 rounded-md disabled:opacity-50 text-sm font-medium hover:bg-gray-800 transition-colors shadow-sm"
                            >
                                {isLoading ? 'Processing...' : 'Generate Format'}
                            </button>
                        </div>
                    </div>

                    <div className="relative border rounded-md bg-gray-900 text-gray-100 font-mono text-xs flex-1 overflow-hidden">
                        <textarea
                            readOnly
                            value={payload}
                            className="w-full h-full p-4 bg-transparent resize-none focus:outline-none"
                            placeholder="Select a thesis from the left list to begin..."
                        />
                    </div>
                </div>
            </div>
        </div>
    )
}
