'use client'

import { useState } from 'react'
import { X, Edit2, Save, Loader2, CheckCircle, AlertCircle, FileText } from 'lucide-react'
import type { FileMetadata } from '@/lib/supabase/types'

interface UploadedFile {
  id: string
  file: File
  metadata: FileMetadata
  isEditing: boolean
  uploadStatus: 'pending' | 'extracting' | 'ready' | 'uploading' | 'uploaded' | 'error'
  uploadProgress: number
  operationName?: string
  mandatory?: boolean
}

interface FileMetadataCardProps {
  uploadedFile: UploadedFile
  onUpdate: (updates: Partial<UploadedFile>) => void
  onRemove: () => void
  onSave: () => void
  onMandatoryToggle?: (mandatory: boolean) => void
}

export function FileMetadataCard({
  uploadedFile,
  onUpdate,
  onRemove,
  onSave,
  onMandatoryToggle,
}: FileMetadataCardProps) {
  const [localMetadata, setLocalMetadata] = useState<FileMetadata>(uploadedFile.metadata)

  const handleSave = () => {
    onUpdate({ metadata: localMetadata, isEditing: false })
  }

  const handleEdit = () => {
    setLocalMetadata(uploadedFile.metadata)
    onUpdate({ isEditing: true })
  }

  const getStatusIcon = () => {
    switch (uploadedFile.uploadStatus) {
      case 'extracting':
        return <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
      case 'uploading':
        return <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
      case 'uploaded':
        return <CheckCircle className="w-4 h-4 text-green-500" />
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-500" />
      default:
        return null
    }
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6 bg-gray-50 dark:bg-gray-700/50">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h4 className="font-semibold text-gray-900 dark:text-white">
              {uploadedFile.file.name}
            </h4>
            {getStatusIcon()}
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {(uploadedFile.file.size / 1024).toFixed(2)} KB
          </p>
        </div>
        <div className="flex items-center gap-2">
          {uploadedFile.uploadStatus === 'ready' && !uploadedFile.isEditing && (
            <button
              onClick={handleEdit}
              className="p-2 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded-lg transition-colors"
              title="Metadaten bearbeiten"
            >
              <Edit2 className="w-4 h-4" />
            </button>
          )}
          {uploadedFile.uploadStatus === 'ready' && uploadedFile.isEditing && (
            <button
              onClick={handleSave}
              className="p-2 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition-colors"
              title="Speichern"
            >
              <Save className="w-4 h-4" />
            </button>
          )}
          {uploadedFile.uploadStatus !== 'uploading' && (
            <button
              onClick={onRemove}
              className="p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
              title="Entfernen"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Upload Progress */}
      {uploadedFile.uploadStatus === 'uploading' && (
        <div className="mb-4">
          <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400 mb-1">
            <span>Wird hochgeladen...</span>
            <span>{uploadedFile.uploadProgress}%</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div
              className="bg-purple-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${uploadedFile.uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Mandatory Source Toggle */}
      {uploadedFile.uploadStatus === 'ready' && (
        <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-amber-900 dark:text-amber-100">
                  Pflichtquelle
                </span>
                {uploadedFile.mandatory && (
                  <span className="px-2 py-0.5 text-xs font-semibold bg-amber-500 text-white rounded">
                    MANDATORY
                  </span>
                )}
              </div>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Diese Quelle muss in der Arbeit zitiert werden (z.B. Arbeit des Professors)
              </p>
            </div>
            <button
              onClick={() => onMandatoryToggle?.(!uploadedFile.mandatory)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${uploadedFile.mandatory
                ? 'bg-amber-600'
                : 'bg-gray-300 dark:bg-gray-600'
                }`}
              role="switch"
              aria-checked={uploadedFile.mandatory}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${uploadedFile.mandatory ? 'translate-x-6' : 'translate-x-1'
                  }`}
              />
            </button>
          </div>
        </div>
      )}

      {/* Metadata Form */}
      {uploadedFile.isEditing ? (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Titel *
            </label>
            <input
              type="text"
              value={localMetadata.title}
              onChange={(e) => setLocalMetadata({ ...localMetadata, title: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Autoren (kommagetrennt) *
            </label>
            <input
              type="text"
              value={localMetadata.authors.join(', ')}
              onChange={(e) =>
                setLocalMetadata({
                  ...localMetadata,
                  authors: e.target.value.split(',').map(a => a.trim()).filter(Boolean),
                })
              }
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
              placeholder="Autor 1, Autor 2, Autor 3"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Jahr
              </label>
              <input
                type="text"
                value={localMetadata.year || ''}
                onChange={(e) => setLocalMetadata({ ...localMetadata, year: e.target.value || null })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                placeholder="2024"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                DOI
              </label>
              <input
                type="text"
                value={localMetadata.doi || ''}
                onChange={(e) => setLocalMetadata({ ...localMetadata, doi: e.target.value || undefined })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                placeholder="10.1234/example"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Zeitschrift/Journal
            </label>
            <input
              type="text"
              value={localMetadata.journal || ''}
              onChange={(e) => setLocalMetadata({ ...localMetadata, journal: e.target.value || undefined })}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Verlag/Publisher
            </label>
            <input
              type="text"
              value={localMetadata.publisher || ''}
              onChange={(e) => setLocalMetadata({ ...localMetadata, publisher: e.target.value || undefined })}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Seiten (von)
              </label>
              <input
                type="text"
                value={localMetadata.pageStart || ''}
                onChange={(e) => {
                  const pageStart = e.target.value || undefined
                  const pages = pageStart && localMetadata.pageEnd
                    ? `${pageStart}-${localMetadata.pageEnd}`
                    : pageStart || localMetadata.pageEnd || undefined
                  setLocalMetadata({
                    ...localMetadata,
                    pageStart,
                    pages
                  })
                }}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                placeholder="123"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Seiten (bis)
              </label>
              <input
                type="text"
                value={localMetadata.pageEnd || ''}
                onChange={(e) => {
                  const pageEnd = e.target.value || undefined
                  const pages = localMetadata.pageStart && pageEnd
                    ? `${localMetadata.pageStart}-${pageEnd}`
                    : localMetadata.pageStart || pageEnd || undefined
                  setLocalMetadata({
                    ...localMetadata,
                    pageEnd,
                    pages
                  })
                }}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                placeholder="145"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Band/Volume
            </label>
            <input
              type="text"
              value={localMetadata.volume || ''}
              onChange={(e) => setLocalMetadata({ ...localMetadata, volume: e.target.value || undefined })}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Vollständige Zitation
            </label>
            <textarea
              value={localMetadata.citation || ''}
              onChange={(e) => setLocalMetadata({ ...localMetadata, citation: e.target.value || undefined })}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <div>
            <span className="font-medium text-gray-700 dark:text-gray-300">Titel: </span>
            <span className="text-gray-900 dark:text-white">{uploadedFile.metadata.title}</span>
          </div>
          {uploadedFile.metadata.authors.length > 0 && (
            <div>
              <span className="font-medium text-gray-700 dark:text-gray-300">Autoren: </span>
              <span className="text-gray-900 dark:text-white">{uploadedFile.metadata.authors.join(', ')}</span>
            </div>
          )}
          {uploadedFile.metadata.year && (
            <div>
              <span className="font-medium text-gray-700 dark:text-gray-300">Jahr: </span>
              <span className="text-gray-900 dark:text-white">{uploadedFile.metadata.year}</span>
            </div>
          )}
          {(uploadedFile.metadata.pageStart || uploadedFile.metadata.pageEnd || uploadedFile.metadata.pages) && (
            <div>
              <span className="font-medium text-gray-700 dark:text-gray-300">Seiten: </span>
              <span className="text-gray-900 dark:text-white">
                {uploadedFile.metadata.pages ||
                  (uploadedFile.metadata.pageStart && uploadedFile.metadata.pageEnd
                    ? `${uploadedFile.metadata.pageStart}-${uploadedFile.metadata.pageEnd}`
                    : uploadedFile.metadata.pageStart || uploadedFile.metadata.pageEnd)}
              </span>
            </div>
          )}
          {uploadedFile.metadata.doi && (
            <div>
              <span className="font-medium text-gray-700 dark:text-gray-300">DOI: </span>
              <span className="text-gray-900 dark:text-white">{uploadedFile.metadata.doi}</span>
            </div>
          )}
          {uploadedFile.metadata.journal && (
            <div>
              <span className="font-medium text-gray-700 dark:text-gray-300">Journal: </span>
              <span className="text-gray-900 dark:text-white">{uploadedFile.metadata.journal}</span>
            </div>
          )}
        </div>
      )}

      {/* Upload Button */}
      {uploadedFile.uploadStatus === 'ready' && !uploadedFile.isEditing && (
        <button
          onClick={onSave}
          className="mt-4 w-full py-2 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 transition-colors"
        >
          Hochladen
        </button>
      )}
    </div>
  )
}

