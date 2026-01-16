'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import { ArrowLeft, ArrowRight, Loader2, FileText, BookOpen, Target, CheckCircle, RefreshCw, List, Plus, Trash2, Save, Upload, Search, X, Download, ExternalLink, ChevronDown, ChevronUp, Mail } from 'lucide-react'
import { FileMetadataCard } from '@/components/file-metadata-card'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createSupabaseClient } from '@/lib/supabase/client'
import { createThesis, updateThesis, getThesisById } from '@/lib/supabase/theses'
import type { User as SupabaseUser } from '@supabase/supabase-js'
import type { FileMetadata } from '@/lib/supabase/types'

type ThesisType = 'hausarbeit' | 'seminararbeit' | 'bachelor'
type LengthUnit = 'pages' | 'words'
type CitationStyle = 'apa' | 'mla' | 'harvard' | 'deutsche-zitierweise'

interface OutlineSection {
  number: string
  title: string
  subsections: { number: string; title: string }[]
}

interface OutlineChapter {
  number: string
  title: string
  sections: OutlineSection[]
}

interface ThesisFormData {
  language: 'german' | 'english' | null
  type: ThesisType | null
  lengthMin: string
  lengthMax: string
  lengthWords: string // For words unit (single value)
  lengthUnit: LengthUnit
  hasResearchQuestion: boolean | null
  researchQuestion: string
  topic: string
  field: string
  customField: string // For "Andere" option
  citationStyle: CitationStyle | null
  hasOwnOutline: boolean | null
  uploadedOutline: File | null
}

const thesisTypes = [
  { value: 'hausarbeit', label: 'Hausarbeit', description: 'Kürzere Arbeiten ohne eigene Forschung' },
  { value: 'seminararbeit', label: 'Seminararbeit', description: 'Quellenbasierte Seminararbeiten' },
  { value: 'bachelor', label: 'Bachelorarbeit', description: 'Abschlussarbeit mit eigener Forschung' },
]

const citationStyles = [
  {
    value: 'apa',
    label: 'APA',
    description: 'American Psychological Association',
    example: 'Müller, A. (2023). Künstliche Intelligenz in der Medizin. Springer.'
  },
  {
    value: 'mla',
    label: 'MLA',
    description: 'Modern Language Association',
    example: 'Müller, Anna. Künstliche Intelligenz in der Medizin. Springer, 2023.'
  },
  {
    value: 'harvard',
    label: 'Harvard',
    description: 'Harvard Referencing Style',
    example: 'Müller, A 2023, Künstliche Intelligenz in der Medizin, Springer, Berlin.'
  },
  {
    value: 'deutsche-zitierweise',
    label: 'Deutsche Zitierweise',
    description: 'Fußnoten-Zitierweise',
    example: '¹Anna Müller, Künstliche Intelligenz in der Medizin (Berlin: Springer, 2023), S. 45.'
  },
]

const academicFields = [
  'Agrarwissenschaften',
  'Anglistik',
  'Anthropologie',
  'Archäologie',
  'Architektur',
  'Astronomie',
  'Betriebswirtschaftslehre',
  'Biochemie',
  'Biologie',
  'Biomedizin',
  'Biotechnologie',
  'Chemie',
  'Design',
  'Erziehungswissenschaften',
  'Ethnologie',
  'Filmwissenschaft',
  'Geographie',
  'Geologie',
  'Germanistik',
  'Geschichte',
  'Gesundheitswissenschaften',
  'Informatik',
  'Ingenieurwesen',
  'Journalismus',
  'Kunstgeschichte',
  'Kunstwissenschaft',
  'Linguistik',
  'Literaturwissenschaft',
  'Marketing',
  'Mathematik',
  'Medienwissenschaft',
  'Medizin',
  'Molekularbiologie',
  'Musikwissenschaft',
  'Naturwissenschaften',
  'Neurowissenschaften',
  'Pädagogik',
  'Pharmazie',
  'Philosophie',
  'Physik',
  'Politikwissenschaft',
  'Psychologie',
  'Public Health',
  'Rechtswissenschaften',
  'Romanistik',
  'Sozialwissenschaften',
  'Soziologie',
  'Sprachwissenschaft',
  'Sportwissenschaft',
  'Statistik',
  'Theaterwissenschaft',
  'Theologie',
  'Umweltwissenschaften',
  'Veterinärmedizin',
  'Volkswirtschaftslehre',
  'Wirtschaftsinformatik',
  'Wirtschaftswissenschaften',
  'Zahnmedizin',
  'Andere',
].sort()

const NewThesisContent = () => {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [researchQuestionSuggestions, setResearchQuestionSuggestions] = useState<string[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)
  const [outline, setOutline] = useState<OutlineChapter[]>([])
  const [loadingOutline, setLoadingOutline] = useState(false)
  const [user, setUser] = useState<SupabaseUser | null>(null)
  const [thesisId, setThesisId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadingExisting, setLoadingExisting] = useState(false)

  // File upload state
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

  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  const [fileSearchStoreId, setFileSearchStoreId] = useState<string | null>(null)
  const [uploadedCount, setUploadedCount] = useState(0)
  const [storeInfo, setStoreInfo] = useState<any>(null)
  const [loadingStoreInfo, setLoadingStoreInfo] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Search queries state
  interface SearchQuerySection {
    sectionNumber: string
    sectionTitle: string
    queries: string[]
  }
  const [searchQueries, setSearchQueries] = useState<SearchQuerySection[]>([])
  const [loadingQueries, setLoadingQueries] = useState(false)
  const [showGenerationModal, setShowGenerationModal] = useState(false)

  const [formData, setFormData] = useState<ThesisFormData>({
    language: null,
    type: null,
    lengthMin: '',
    lengthMax: '',
    lengthWords: '',
    lengthUnit: 'pages',
    hasResearchQuestion: null,
    researchQuestion: '',
    topic: '',
    field: '',
    customField: '',
    citationStyle: null,
    hasOwnOutline: null,
    uploadedOutline: null,
  })

  // Get current user session
  useEffect(() => {
    const supabase = createSupabaseClient()

    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  // Load existing thesis if ID is provided in URL
  useEffect(() => {
    const loadExistingThesis = async () => {
      const id = searchParams.get('id')
      if (!id || !user) return

      setLoadingExisting(true)
      try {
        const existingThesis = await getThesisById(id)
        if (existingThesis && existingThesis.user_id === user.id) {
          setThesisId(existingThesis.id)

          // Populate form data
          // Check if field is in the predefined list, otherwise set to "Andere" and use customField
          const fieldInList = academicFields.includes(existingThesis.field)
          // Determine if we should use pages or words based on stored length_unit
          // Default to pages if length_unit is not stored
          const storedUnit = existingThesis.length_unit || 'words'
          const targetLength = existingThesis.target_length || 0

          let lengthMin = ''
          let lengthMax = ''
          let lengthWords = ''
          let lengthUnit: LengthUnit = 'pages'

          if (storedUnit === 'pages') {
            // If stored as pages, use pages
            const pages = Math.round(targetLength / 250)
            lengthMin = String(Math.max(1, pages - 5))
            lengthMax = String(pages + 5)
            lengthUnit = 'pages'
          } else {
            // If stored as words, use words (assume it was the minimum, calculate 5% more for max)
            lengthWords = String(targetLength)
            lengthUnit = 'words'
          }

          setFormData({
            language: 'german', // Default, can be updated if stored in DB
            type: existingThesis.thesis_type as ThesisType,
            lengthMin,
            lengthMax,
            lengthWords,
            lengthUnit,
            hasResearchQuestion: existingThesis.research_question ? true : null,
            researchQuestion: existingThesis.research_question,
            topic: existingThesis.topic,
            field: fieldInList ? existingThesis.field : 'Andere',
            customField: fieldInList ? '' : existingThesis.field,
            citationStyle: existingThesis.citation_style as CitationStyle,
            hasOwnOutline: null,
            uploadedOutline: null,
          })

          // Load file search store ID if it exists
          if (existingThesis.file_search_store_id) {
            setFileSearchStoreId(existingThesis.file_search_store_id)
            // Fetch store info
            fetchStoreInfo(existingThesis.file_search_store_id)
          }

          // Load uploaded sources count
          if (existingThesis.uploaded_sources && Array.isArray(existingThesis.uploaded_sources)) {
            setUploadedCount(existingThesis.uploaded_sources.length)
          }

          // Load outline if it exists
          if (existingThesis.outline && Array.isArray(existingThesis.outline) && existingThesis.outline.length > 0) {
            setOutline(existingThesis.outline)
            setStep(6) // Jump to file upload step if outline exists
          } else if (existingThesis.research_question) {
            setStep(4) // Jump to overview step if research question exists
          } else {
            setStep(3) // Jump to research question step
          }
        }
      } catch (error) {
        console.error('Error loading existing thesis:', error)
      } finally {
        setLoadingExisting(false)
      }
    }

    if (user) {
      loadExistingThesis()
    }
  }, [searchParams, user])

  const generateSearchQueries = async () => {
    if (!outline || outline.length === 0) {
      alert('Bitte erstelle zuerst eine Gliederung.')
      return
    }

    setLoadingQueries(true)
    try {
      const fieldValue = formData.field === 'Andere' ? formData.customField : formData.field

      // Ensure outline is in the correct format (array of chapters)
      let outlineToSend = outline
      if (typeof outline === 'string') {
        try {
          outlineToSend = JSON.parse(outline)
        } catch (e) {
          console.error('Failed to parse outline string:', e)
        }
      }

      console.log('Sending request to generate search queries:', {
        topic: formData.topic,
        field: fieldValue,
        outlineLength: Array.isArray(outlineToSend) ? outlineToSend.length : 'not array',
      })

      const response = await fetch('/api/generate-search-queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thesisTitle: formData.topic,
          topic: formData.topic,
          field: fieldValue,
          researchQuestion: formData.researchQuestion,
          outline: outlineToSend,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to generate queries' }))
        console.error('API error response:', errorData)
        throw new Error(errorData.error || `Failed to generate search queries (${response.status})`)
      }

      const data = await response.json()
      console.log('Search queries generated:', data.queries?.length || 0, 'sections')
      setSearchQueries(data.queries || [])
    } catch (error) {
      console.error('Error generating search queries:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unbekannter Fehler'
      alert(`Fehler beim Generieren der Suchanfragen: ${errorMessage}`)
    } finally {
      setLoadingQueries(false)
    }
  }

  const handleNext = async () => {
    if (step === 1 && !formData.language) return
    if (step === 2 && !formData.type) return
    if (step === 3) {
      if (!formData.topic || !formData.citationStyle) return
      // Check length based on unit
      if (formData.lengthUnit === 'pages') {
        if (!formData.lengthMin || !formData.lengthMax) return
        if (parseInt(formData.lengthMax) > 80) {
          alert('Die maximale Länge darf 80 Seiten nicht überschreiten.')
          return
        }
      } else {
        if (!formData.lengthWords) return
        if (parseInt(formData.lengthWords) > 20000) {
          alert('Die maximale Länge darf 20.000 Wörter nicht überschreiten.')
          return
        }
      }
      // Check field: either a predefined field or custom field if "Andere" is selected
      if (!formData.field || formData.field.trim() === '') return
      if (formData.field === 'Andere' && (!formData.customField || formData.customField.trim() === '')) return
    }
    if (step === 4 && formData.hasResearchQuestion === null) return
    if (step === 4 && formData.hasResearchQuestion && !formData.researchQuestion) return
    if (step === 4 && !formData.hasResearchQuestion && !formData.researchQuestion) return

    // Generate search queries when moving from step 7 to step 8
    if (step === 7) {
      // Navigate to step 8 first, then generate queries in the background
      setStep(8)
      // Generate queries asynchronously (don't await, let it happen in background)
      generateSearchQueries().catch((error) => {
        console.error('Failed to generate queries:', error)
        // Error is already handled in generateSearchQueries with alert
      })
      return
    }

    // Save thesis data when moving from step 4 to step 5 (after research question)
    if (step === 4 && user) {
      setSaving(true)
      try {
        const fieldValue = formData.field === 'Andere' ? formData.customField : formData.field

        // Calculate target length in words
        let minWords: number
        let maxWords: number

        if (formData.lengthUnit === 'pages') {
          // Pages: convert to words (pages * 250)
          const minPages = parseInt(formData.lengthMin) || 0
          const maxPages = parseInt(formData.lengthMax) || 0
          minWords = minPages * 250
          maxWords = maxPages * 250
        } else {
          // Words: use provided value as minimum, max is 5% more
          const minWordsInput = parseInt(formData.lengthWords) || 0
          minWords = minWordsInput
          maxWords = Math.round(minWordsInput * 1.05) // 5% more
        }

        const avgWords = Math.round((minWords + maxWords) / 2)

        if (thesisId) {
          // Update existing thesis
          await updateThesis(thesisId, {
            topic: formData.topic,
            field: fieldValue,
            thesis_type: formData.type || 'bachelor',
            research_question: formData.researchQuestion,
            citation_style: formData.citationStyle || 'apa',
            target_length: avgWords,
            length_unit: formData.lengthUnit, // Store the original unit (pages or words)
          })
        } else {
          // Create new thesis
          const newThesis = await createThesis(user.id, {
            topic: formData.topic,
            field: fieldValue,
            thesis_type: formData.type || 'bachelor',
            research_question: formData.researchQuestion,
            citation_style: formData.citationStyle || 'apa',
            target_length: avgWords,
            length_unit: formData.lengthUnit, // Store the original unit (pages or words)
          })
          setThesisId(newThesis.id)
        }
      } catch (error) {
        console.error('Error saving thesis:', error)
        // Continue anyway, but log the error
      } finally {
        setSaving(false)
      }
    }

    setStep(step + 1)
  }

  const handleBack = () => {
    setStep(step - 1)
  }

  const handleResearchQuestionChange = async (hasQuestion: boolean) => {
    const updatedFormData = { ...formData, hasResearchQuestion: hasQuestion, researchQuestion: '' }
    setFormData(updatedFormData)

    if (!hasQuestion) {
      const fieldValue = updatedFormData.field === 'Andere' ? updatedFormData.customField : updatedFormData.field
      if (updatedFormData.topic && fieldValue) {
        await generateSuggestions(updatedFormData)
      } else {
        setResearchQuestionSuggestions([])
      }
    } else {
      setResearchQuestionSuggestions([])
    }
  }

  const generateSuggestions = async (currentFormData?: typeof formData) => {
    const dataToUse = currentFormData || formData
    const fieldValue = dataToUse.field === 'Andere' ? dataToUse.customField : dataToUse.field
    if (!dataToUse.topic || !fieldValue) {
      console.warn('Missing topic or field for research question generation')
      return
    }

    setLoadingSuggestions(true)
    setFormData({ ...dataToUse, researchQuestion: '' })
    try {
      const suggestions = await generateResearchQuestionSuggestions(
        dataToUse.topic,
        fieldValue,
        dataToUse.type || 'bachelor',
        dataToUse.language || 'german' // Default to german if missing
      )
      setResearchQuestionSuggestions(suggestions)
    } catch (error) {
      console.error('Error generating suggestions:', error)
      setResearchQuestionSuggestions([])
    } finally {
      setLoadingSuggestions(false)
    }
  }

  const handleStartGeneration = async () => {
    // Save thesis data before moving to outline step
    if (!user) {
      alert('Bitte melde Dich an, um fortzufahren.')
      return
    }

    setSaving(true)
    try {
      const fieldValue = formData.field === 'Andere' ? formData.customField : formData.field

      // Calculate target length in words
      let minWords: number
      let maxWords: number

      if (formData.lengthUnit === 'pages') {
        // Pages: convert to words (pages * 250)
        const minPages = parseInt(formData.lengthMin) || 0
        const maxPages = parseInt(formData.lengthMax) || 0
        minWords = minPages * 250
        maxWords = maxPages * 250
      } else {
        // Words: use provided value as minimum, max is 5% more
        const minWordsInput = parseInt(formData.lengthWords) || 0
        minWords = minWordsInput
        maxWords = Math.round(minWordsInput * 1.05) // 5% more
      }

      const avgWords = Math.round((minWords + maxWords) / 2)

      if (thesisId) {
        // Update existing thesis
        await updateThesis(thesisId, {
          topic: formData.topic,
          field: fieldValue,
          thesis_type: formData.type || 'bachelor',
          research_question: formData.researchQuestion,
          citation_style: formData.citationStyle || 'apa',
          target_length: avgWords,
          length_unit: formData.lengthUnit, // Store the original unit (pages or words)
          language: formData.language || 'german',
          metadata: { language: formData.language || 'german' },
        })
      } else {
        // Create new thesis
        const newThesis = await createThesis(user.id, {
          topic: formData.topic,
          field: fieldValue,
          thesis_type: formData.type || 'bachelor',
          research_question: formData.researchQuestion,
          citation_style: formData.citationStyle || 'apa',
          target_length: avgWords,
          length_unit: formData.lengthUnit, // Store the original unit (pages or words)
          language: formData.language || 'german',
          metadata: { language: formData.language || 'german' },
        })
        setThesisId(newThesis.id)
      }
    } catch (error) {
      console.error('Error saving thesis:', error)
      alert('Fehler beim Speichern. Bitte versuche es erneut.')
      setSaving(false)
      return
    } finally {
      setSaving(false)
    }

    // Just navigate to outline step - don't generate yet
    // User will choose to upload or generate in step 6
    setStep(6)
  }

  const handleSaveOutline = async () => {
    if (!user || !thesisId) {
      alert('Bitte melde Dich an, um fortzufahren.')
      return
    }

    setSaving(true)
    try {
      await updateThesis(thesisId, {
        outline: outline,
      })
      alert('Gliederung erfolgreich gespeichert!')
    } catch (error) {
      console.error('Error saving outline:', error)
      alert('Fehler beim Speichern. Bitte versuche es erneut.')
    } finally {
      setSaving(false)
    }
  }

  const generateOutline = async () => {
    setLoadingOutline(true)
    try {
      const fieldValue = formData.field === 'Andere' ? formData.customField : formData.field

      // Calculate target length in words
      let minWords: number
      let maxWords: number

      if (formData.lengthUnit === 'pages') {
        // Pages: convert to words (pages * 250)
        const minPages = parseInt(formData.lengthMin) || 0
        const maxPages = parseInt(formData.lengthMax) || 0
        minWords = minPages * 250
        maxWords = maxPages * 250
      } else {
        // Words: use provided value as minimum, max is 5% more
        const minWordsInput = parseInt(formData.lengthWords) || 0
        minWords = minWordsInput
        maxWords = Math.round(minWordsInput * 1.05) // 5% more
      }

      const generatedOutline = await fetchThesisOutline({
        topic: formData.topic,
        field: fieldValue,
        thesisType: formData.type || 'bachelor',
        researchQuestion: formData.researchQuestion,
        lengthMin: minWords,
        lengthMax: maxWords,
        citationStyle: formData.citationStyle || 'apa',
        language: formData.language || 'german',
      })
      setOutline(generatedOutline)
    } catch (error) {
      console.error('Error generating outline:', error)
      // Set a default outline structure if generation fails
      // Use different structure based on thesis type
      const isSourceBasedThesis = formData.type === 'hausarbeit' || formData.type === 'seminararbeit'

      if (isSourceBasedThesis) {
        // Source-based thesis: No methodology chapter
        setOutline([
          {
            number: '1',
            title: 'Einleitung',
            sections: [
              { number: '1.1', title: 'Hintergrund und Problemstellung', subsections: [] },
              { number: '1.2', title: 'Zielsetzung und Forschungsfrage', subsections: [] },
            ],
          },
          {
            number: '2',
            title: 'Theoretischer Hintergrund',
            sections: [
              { number: '2.1', title: 'Grundlegende Konzepte', subsections: [] },
              { number: '2.2', title: 'Aktueller Forschungsstand', subsections: [] },
            ],
          },
          {
            number: '3',
            title: 'Hauptteil',
            sections: [
              { number: '3.1', title: 'Aspekt 1', subsections: [] },
              { number: '3.2', title: 'Aspekt 2', subsections: [] },
            ],
          },
          {
            number: '4',
            title: 'Diskussion',
            sections: [
              { number: '4.1', title: 'Kritische Würdigung', subsections: [] },
              { number: '4.2', title: 'Limitationen', subsections: [] },
            ],
          },
          {
            number: '5',
            title: 'Fazit',
            sections: [
              { number: '5.1', title: 'Zusammenfassung', subsections: [] },
              { number: '5.2', title: 'Ausblick', subsections: [] },
            ],
          },
        ])
      } else {
        // Bachelorarbeit: Can include methodology
        setOutline([
          {
            number: '1',
            title: 'Einleitung',
            sections: [
              { number: '1.1', title: 'Hintergrund und Problemstellung', subsections: [] },
              { number: '1.2', title: 'Zielsetzung und Forschungsfrage', subsections: [] },
            ],
          },
          {
            number: '2',
            title: 'Theoretischer Hintergrund',
            sections: [
              { number: '2.1', title: 'Grundlegende Konzepte', subsections: [] },
              { number: '2.2', title: 'Aktueller Forschungsstand', subsections: [] },
            ],
          },
          {
            number: '3',
            title: 'Methodik',
            sections: [
              { number: '3.1', title: 'Forschungsdesign', subsections: [] },
              { number: '3.2', title: 'Datenerhebung', subsections: [] },
              { number: '3.3', title: 'Datenanalyse', subsections: [] },
            ],
          },
          {
            number: '4',
            title: 'Ergebnisse',
            sections: [
              { number: '4.1', title: 'Präsentation der Ergebnisse', subsections: [] },
            ],
          },
          {
            number: '5',
            title: 'Diskussion',
            sections: [
              { number: '5.1', title: 'Interpretation', subsections: [] },
              { number: '5.2', title: 'Limitationen', subsections: [] },
            ],
          },
          {
            number: '6',
            title: 'Fazit',
            sections: [
              { number: '6.1', title: 'Zusammenfassung', subsections: [] },
              { number: '6.2', title: 'Ausblick', subsections: [] },
            ],
          },
        ])
      }
    } finally {
      setLoadingOutline(false)
    }
  }

  const updateChapterNumber = (index: number) => {
    const newOutline = [...outline]
    newOutline[index].number = String(index + 1)
    // Update all section numbers
    newOutline[index].sections = newOutline[index].sections.map((section, secIdx) => {
      const newSectionNumber = `${index + 1}.${secIdx + 1}`
      return {
        ...section,
        number: newSectionNumber,
        subsections: section.subsections.map((subsection, subIdx) => ({
          ...subsection,
          number: `${newSectionNumber}.${subIdx + 1}`,
        })),
      }
    })
    setOutline(newOutline)
  }

  const updateSectionNumber = (chapterIndex: number, sectionIndex: number) => {
    const newOutline = [...outline]
    const chapter = newOutline[chapterIndex]
    const newSectionNumber = `${chapter.number}.${sectionIndex + 1}`
    chapter.sections[sectionIndex].number = newSectionNumber
    // Update subsection numbers
    chapter.sections[sectionIndex].subsections = chapter.sections[sectionIndex].subsections.map(
      (subsection, subIdx) => ({
        ...subsection,
        number: `${newSectionNumber}.${subIdx + 1}`,
      })
    )
    setOutline(newOutline)
  }

  const handleChapterTitleChange = (index: number, title: string) => {
    const newOutline = [...outline]
    newOutline[index].title = title
    setOutline(newOutline)
  }

  const handleSectionTitleChange = (chapterIndex: number, sectionIndex: number, title: string) => {
    const newOutline = [...outline]
    newOutline[chapterIndex].sections[sectionIndex].title = title
    setOutline(newOutline)
  }

  const handleSubsectionTitleChange = (
    chapterIndex: number,
    sectionIndex: number,
    subsectionIndex: number,
    title: string
  ) => {
    const newOutline = [...outline]
    newOutline[chapterIndex].sections[sectionIndex].subsections[subsectionIndex].title = title
    setOutline(newOutline)
  }

  const addChapter = () => {
    const newChapterNumber = String(outline.length + 1)
    setOutline([
      ...outline,
      {
        number: newChapterNumber,
        title: 'Neues Kapitel',
        sections: [
          {
            number: `${newChapterNumber}.1`,
            title: 'Neuer Abschnitt',
            subsections: [],
          },
        ],
      },
    ])
  }

  const removeChapter = (index: number) => {
    const newOutline = outline.filter((_, i) => i !== index)
    // Renumber all chapters
    const renumberedOutline = newOutline.map((chapter, idx) => {
      const newNumber = String(idx + 1)
      return {
        ...chapter,
        number: newNumber,
        sections: chapter.sections.map((section, secIdx) => {
          const newSectionNumber = `${newNumber}.${secIdx + 1}`
          return {
            ...section,
            number: newSectionNumber,
            subsections: section.subsections.map((subsection, subIdx) => ({
              ...subsection,
              number: `${newSectionNumber}.${subIdx + 1}`,
            })),
          }
        }),
      }
    })
    setOutline(renumberedOutline)
  }

  const addSection = (chapterIndex: number) => {
    const newOutline = [...outline]
    const chapter = newOutline[chapterIndex]
    const newSectionNumber = `${chapter.number}.${chapter.sections.length + 1}`
    chapter.sections.push({
      number: newSectionNumber,
      title: 'Neuer Abschnitt',
      subsections: [],
    })
    setOutline(newOutline)
  }

  const removeSection = (chapterIndex: number, sectionIndex: number) => {
    const newOutline = [...outline]
    const chapter = newOutline[chapterIndex]
    chapter.sections = chapter.sections.filter((_, i) => i !== sectionIndex)
    // Renumber sections
    chapter.sections = chapter.sections.map((section, idx) => {
      const newSectionNumber = `${chapter.number}.${idx + 1}`
      return {
        ...section,
        number: newSectionNumber,
        subsections: section.subsections.map((subsection, subIdx) => ({
          ...subsection,
          number: `${newSectionNumber}.${subIdx + 1}`,
        })),
      }
    })
    setOutline(newOutline)
  }

  const addSubsection = (chapterIndex: number, sectionIndex: number) => {
    const newOutline = [...outline]
    const section = newOutline[chapterIndex].sections[sectionIndex]
    const newSubsectionNumber = `${section.number}.${section.subsections.length + 1}`
    section.subsections.push({
      number: newSubsectionNumber,
      title: 'Neuer Unterabschnitt',
    })
    setOutline(newOutline)
  }

  const removeSubsection = (chapterIndex: number, sectionIndex: number, subsectionIndex: number) => {
    const newOutline = [...outline]
    const section = newOutline[chapterIndex].sections[sectionIndex]
    section.subsections = section.subsections.filter((_, i) => i !== subsectionIndex)
    // Renumber subsections
    section.subsections = section.subsections.map((subsection, idx) => ({
      ...subsection,
      number: `${section.number}.${idx + 1}`,
    }))
    setOutline(newOutline)
  }

  const fetchStoreInfo = async (storeId: string) => {
    setLoadingStoreInfo(true)
    try {
      const response = await fetch('/api/list-files-in-store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileSearchStoreId: storeId }),
      })

      if (response.ok) {
        const data = await response.json()
        setStoreInfo(data.store)
      }
    } catch (error) {
      console.error('Error fetching store info:', error)
    } finally {
      setLoadingStoreInfo(false)
    }
  }

  const ensureFileSearchStore = async (): Promise<string | null> => {
    if (fileSearchStoreId) return fileSearchStoreId
    if (!thesisId) return null

    try {
      const response = await fetch('/api/create-file-search-store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thesisId,
          displayName: `Thesis: ${formData.topic || 'Unbenannt'}`,
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      if (data.fileSearchStoreId) {
        setFileSearchStoreId(data.fileSearchStoreId)
        fetchStoreInfo(data.fileSearchStoreId)
        return data.fileSearchStoreId
      }
      return null
    } catch (error) {
      console.error('Error creating/fetching FileSearchStore:', error)
      alert('Fehler beim Erstellen/Abrufen des File Search Stores. Bitte versuche es erneut.')
      return null
    }
  }

  const handleFiles = async (files: File[]) => {
    // Ensure we have a FileSearchStore (will fetch existing or create new)
    await ensureFileSearchStore()

    // Process each file
    for (const file of files) {
      const fileId = `${Date.now()}-${Math.random().toString(36).substring(7)}`
      const newFile: UploadedFile = {
        id: fileId,
        file,
        metadata: {
          title: file.name.replace(/\.[^/.]+$/, ''),
          authors: [],
          year: null,
        },
        isEditing: false,
        uploadStatus: 'extracting',
        uploadProgress: 0,
      }

      setUploadedFiles(prev => [...prev, newFile])

      // Extract metadata
      try {
        const formData = new FormData()
        formData.append('file', file)

        const response = await fetch('/api/extract-file-metadata', {
          method: 'POST',
          body: formData,
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }))
          throw new Error(errorData.error || `HTTP ${response.status}: Failed to extract metadata`)
        }

        const data = await response.json()

        if (data.error) {
          throw new Error(data.error)
        }

        setUploadedFiles(prev =>
          prev.map(f =>
            f.id === fileId
              ? {
                ...f,
                metadata: data.metadata,
                uploadStatus: 'ready',
              }
              : f
          )
        )
      } catch (error) {
        console.error('Error extracting metadata:', error)
        setUploadedFiles(prev =>
          prev.map(f =>
            f.id === fileId
              ? { ...f, uploadStatus: 'error' }
              : f
          )
        )
      }
    }
  }

  const handleFileUpload = async (uploadedFile: UploadedFile) => {
    // Ensure store exists before uploading
    let storeId = fileSearchStoreId
    if (!storeId) {
      storeId = await ensureFileSearchStore()
      if (!storeId) return // Already alerted in helper
    }

    setUploadedFiles(prev =>
      prev.map(f =>
        f.id === uploadedFile.id
          ? { ...f, uploadStatus: 'uploading', uploadProgress: 0 }
          : f
      )
    )

    try {
      const formData = new FormData()
      formData.append('file', uploadedFile.file)
      formData.append('fileSearchStoreId', storeId)
      formData.append('thesisId', thesisId || '')
      formData.append('metadata', JSON.stringify(uploadedFile.metadata))
      formData.append('displayName', uploadedFile.metadata.title || uploadedFile.file.name)
      formData.append('mandatory', String(uploadedFile.mandatory || false))

      const response = await fetch('/api/upload-to-file-search', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Upload failed' }))
        if (errorData.duplicate) {
          alert(`Diese Quelle wurde bereits hochgeladen: ${errorData.existingSource?.title || uploadedFile.metadata.title}`)
          setUploadedFiles(prev =>
            prev.map(f =>
              f.id === uploadedFile.id
                ? { ...f, uploadStatus: 'error', uploadProgress: 0 }
                : f
            )
          )
          return
        }
        throw new Error(errorData.error || 'Upload failed')
      }

      // Server-side polling is now done in the upload route
      // The response will only return when the upload is complete
      const data = await response.json()

      // Show progress while waiting (the request is still in progress)
      setUploadedFiles(prev =>
        prev.map(f =>
          f.id === uploadedFile.id
            ? { ...f, uploadProgress: 90 } // Show 90% while server is polling
            : f
        )
      )

      // Check if upload completed successfully
      // Note: Database update is now done server-side in the upload route
      if (data.done && !data.error) {
        setUploadedFiles(prev =>
          prev.map(f =>
            f.id === uploadedFile.id
              ? { ...f, uploadStatus: 'uploaded', uploadProgress: 100 }
              : f
          )
        )
        setUploadedCount(prev => prev + 1)
        // Refresh store info after successful upload
        if (fileSearchStoreId) {
          setTimeout(() => fetchStoreInfo(fileSearchStoreId), 1000)
        }
      } else {
        // Upload failed
        setUploadedFiles(prev =>
          prev.map(f =>
            f.id === uploadedFile.id
              ? { ...f, uploadStatus: 'error', uploadProgress: 0 }
              : f
          )
        )
        alert(`Upload-Fehler: ${data.error || 'Unbekannter Fehler'}`)
      }
    } catch (error) {
      console.error('Error uploading file:', error)
      setUploadedFiles(prev =>
        prev.map(f =>
          f.id === uploadedFile.id
            ? { ...f, uploadStatus: 'error', uploadProgress: 0 }
            : f
        )
      )
    }
  }

  const handleUploadAll = async () => {
    // Ensure store exists before uploading
    let storeId = fileSearchStoreId
    if (!storeId) {
      storeId = await ensureFileSearchStore()
      if (!storeId) return // Already alerted in helper
    }

    const readyFiles = uploadedFiles.filter(f => f.uploadStatus === 'ready')
    for (const file of readyFiles) {
      await handleFileUpload(file)
      // Small delay between uploads
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    // Refresh store info after all uploads
    if (fileSearchStoreId) {
      setTimeout(() => fetchStoreInfo(fileSearchStoreId), 2000)
    }
  }

  const handleFinalStart = async () => {
    if (!user) {
      alert('Bitte melde Dich an, um fortzufahren.')
      return
    }

    // Ensure thesis is saved before starting generation
    if (!outline || outline.length === 0) {
      alert('Bitte speichere zuerst die Gliederung.')
      return
    }

    // Ensure we have all required form data
    if (!formData.topic || !formData.field || !formData.type) {
      alert('Bitte fülle alle erforderlichen Felder aus.')
      return
    }

    setLoading(true)

    try {
      // Ensure thesis exists in database - create or update it
      let currentThesisId = thesisId

      if (!currentThesisId) {
        // Create new thesis
        const fieldValue = formData.field === 'Andere' ? formData.customField : formData.field

        // Calculate target length in words
        let minWords: number
        let maxWords: number

        if (formData.lengthUnit === 'pages') {
          const minPages = parseInt(formData.lengthMin) || 0
          const maxPages = parseInt(formData.lengthMax) || 0
          minWords = minPages * 250
          maxWords = maxPages * 250
        } else {
          const minWordsInput = parseInt(formData.lengthWords) || 0
          minWords = minWordsInput
          maxWords = Math.round(minWordsInput * 1.05)
        }

        const avgWords = Math.round((minWords + maxWords) / 2)

        const newThesis = await createThesis(user.id, {
          topic: formData.topic,
          field: fieldValue,
          thesis_type: formData.type || 'bachelor',
          research_question: formData.researchQuestion || '',
          citation_style: formData.citationStyle || 'apa',
          target_length: avgWords,
          length_unit: formData.lengthUnit,
          outline: outline,
          language: formData.language || 'german',
          metadata: { language: formData.language || 'german' },
        })
        currentThesisId = newThesis.id
        setThesisId(currentThesisId)
      } else {
        // Update existing thesis with outline and any missing data
        const fieldValue = formData.field === 'Andere' ? formData.customField : formData.field

        // Calculate target length in words
        let minWords: number
        let maxWords: number

        if (formData.lengthUnit === 'pages') {
          const minPages = parseInt(formData.lengthMin) || 0
          const maxPages = parseInt(formData.lengthMax) || 0
          minWords = minPages * 250
          maxWords = maxPages * 250
        } else {
          const minWordsInput = parseInt(formData.lengthWords) || 0
          minWords = minWordsInput
          maxWords = Math.round(minWordsInput * 1.05)
        }

        const avgWords = Math.round((minWords + maxWords) / 2)

        await updateThesis(currentThesisId, {
          topic: formData.topic,
          field: fieldValue,
          thesis_type: formData.type || 'bachelor',
          research_question: formData.researchQuestion || '',
          citation_style: formData.citationStyle || 'apa',
          target_length: avgWords,
          length_unit: formData.lengthUnit,
          outline: outline,
          language: formData.language || 'german',
          metadata: { language: formData.language || 'german' },
        })
      }

      if (!currentThesisId) {
        throw new Error('Failed to create or update thesis')
      }

      // Trigger background worker for full thesis generation
      const response = await fetch('/api/start-thesis-generation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ thesisId: currentThesisId }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Fehler beim Starten der Generierung')
      }

      const data = await response.json()
      console.log('Generation started:', data)

      // Show notification modal
      setShowGenerationModal(true)

      // Navigate to generation page after a short delay
      setTimeout(() => {
        router.push(`/thesis/generate?id=${currentThesisId}`)
      }, 2000)
    } catch (error) {
      console.error('Error starting generation:', error)
      alert(error instanceof Error ? error.message : 'Fehler beim Starten der Generierung')
      setLoading(false)
    }
  }

  if (loadingExisting) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-yellow-600 dark:text-yellow-500" />
            <span className="ml-3 text-gray-600 dark:text-gray-400">
              Lade Projekt...
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center text-gray-600 dark:text-gray-400 hover:text-yellow-600 dark:hover:text-yellow-500 mb-4 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Zurück zur Startseite
          </Link>
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            Neue Thesis erstellen
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Schritt {step} von 8
          </p>
        </div>

        {/* Progress Bar */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
              <div
                key={s}
                className={`flex-1 h-2 mx-1 rounded-full ${s <= step
                  ? 'bg-black dark:bg-white'
                  : 'bg-gray-200 dark:bg-gray-700'
                  }`}
              />
            ))}
          </div>
        </div>

        {/* Step 1: Language Selection */}
        {step === 1 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
            <div className="flex items-center mb-6">
              <FileText className="w-8 h-8 text-black dark:text-white mr-3" />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                In welcher Sprache schreibst Du Deine Thesis?
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <button
                onClick={() => setFormData({ ...formData, language: 'german' })}
                className={`p-6 rounded-lg border-2 text-left transition-all ${formData.language === 'german'
                  ? 'border-yellow-600 dark:border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                  : 'border-gray-200 dark:border-gray-700 hover:border-yellow-400 dark:hover:border-yellow-500'
                  }`}
              >
                <div className="font-semibold text-lg text-gray-900 dark:text-white mb-2">
                  Deutsch
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  Die Thesis wird auf Deutsch verfasst
                </div>
              </button>

              <button
                onClick={() => setFormData({ ...formData, language: 'english' })}
                className={`p-6 rounded-lg border-2 text-left transition-all ${formData.language === 'english'
                  ? 'border-yellow-600 dark:border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                  : 'border-gray-200 dark:border-gray-700 hover:border-yellow-400 dark:hover:border-yellow-500'
                  }`}
              >
                <div className="font-semibold text-lg text-gray-900 dark:text-white mb-2">
                  English
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  The thesis will be written in English
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Thesis Type */}
        {step === 2 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
            <div className="flex items-center mb-6">
              <FileText className="w-8 h-8 text-black dark:text-white mr-3" />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                Welche Art von Thesis schreibst Du?
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {thesisTypes.map((type) => (
                <button
                  key={type.value}
                  onClick={() => setFormData({ ...formData, type: type.value as ThesisType })}
                  className={`p-6 rounded-lg border-2 text-left transition-all ${formData.type === type.value
                    ? 'border-yellow-600 dark:border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                    : 'border-gray-200 dark:border-gray-700 hover:border-yellow-300 dark:hover:border-yellow-600'
                    }`}
                >
                  <h3 className="font-semibold text-lg mb-1 text-gray-900 dark:text-white">
                    {type.label}
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {type.description}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: Topic, Field, and Length */}
        {step === 3 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
            <div className="flex items-center mb-6">
              <BookOpen className="w-8 h-8 text-black dark:text-white mr-3" />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                Dein Thema und Umfang
              </h2>
            </div>

            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Thema / Forschungsgebiet *
                </label>
                <input
                  type="text"
                  value={formData.topic}
                  onChange={(e) => setFormData({ ...formData, topic: e.target.value })}
                  placeholder="z.B. Künstliche Intelligenz in der Medizin"
                  className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Fachbereich *
                </label>
                <select
                  value={academicFields.includes(formData.field) ? formData.field : (formData.field === 'Andere' || formData.customField ? 'Andere' : '')}
                  onChange={(e) => {
                    const value = e.target.value
                    if (value === 'Andere') {
                      setFormData({ ...formData, field: 'Andere', customField: '' })
                    } else if (value) {
                      setFormData({ ...formData, field: value, customField: '' })
                    } else {
                      setFormData({ ...formData, field: '', customField: '' })
                    }
                  }}
                  className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
                >
                  <option value="">Bitte wählen...</option>
                  {academicFields.map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </select>
                {formData.field === 'Andere' && (
                  <div className="mt-3">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Bitte gib Deinen Fachbereich ein *
                    </label>
                    <input
                      type="text"
                      value={formData.customField}
                      onChange={(e) => {
                        setFormData({ ...formData, customField: e.target.value })
                      }}
                      placeholder="z.B. Mechatronik, Ernährungswissenschaften..."
                      className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Umfang *
                </label>
                <div className="mb-3">
                  <select
                    value={formData.lengthUnit}
                    onChange={(e) => {
                      const unit = e.target.value as LengthUnit
                      setFormData({
                        ...formData,
                        lengthUnit: unit,
                        // Clear the other unit's values when switching
                        lengthMin: unit === 'pages' ? formData.lengthMin : '',
                        lengthMax: unit === 'pages' ? formData.lengthMax : '',
                        lengthWords: unit === 'words' ? formData.lengthWords : '',
                      })
                    }}
                    className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
                  >
                    <option value="pages">Seiten</option>
                    <option value="words">Wörter</option>
                  </select>
                </div>

                {formData.lengthUnit === 'pages' ? (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                          Von (min)
                        </label>
                        <input
                          type="number"
                          value={formData.lengthMin}
                          onChange={(e) => setFormData({ ...formData, lengthMin: e.target.value })}
                          placeholder="z.B. 40"
                          min="1"
                          className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                          Bis (max)
                        </label>
                        <input
                          type="number"
                          value={formData.lengthMax}
                          onChange={(e) => setFormData({ ...formData, lengthMax: e.target.value })}
                          placeholder="z.B. 50"
                          min="1"
                          className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
                          max="80"
                        />
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      Hinweis: Seiten werden automatisch in Wörter umgerechnet (1 Seite = 250 Wörter). Maximum: 80 Seiten.
                    </p>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                        Mindestanzahl Wörter
                      </label>
                      <input
                        type="number"
                        value={formData.lengthWords}
                        onChange={(e) => setFormData({ ...formData, lengthWords: e.target.value })}
                        placeholder="z.B. 10000"
                        min="1"
                        className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
                        max="20000"
                      />
                    </div>
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      Hinweis: Die Thesis kann bis zu 5% länger sein als die angegebene Mindestanzahl. Maximum: 20.000 Wörter.
                    </p>
                  </>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Zitationsstil *
                </label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {citationStyles.map((style) => (
                    <button
                      key={style.value}
                      type="button"
                      onClick={() => setFormData({ ...formData, citationStyle: style.value as CitationStyle })}
                      className={`p-4 rounded-lg border-2 text-left transition-all ${formData.citationStyle === style.value
                        ? 'border-yellow-600 dark:border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-yellow-300 dark:hover:border-yellow-600'
                        }`}
                    >
                      <div className="font-semibold text-gray-900 dark:text-white mb-1">
                        {style.label}
                      </div>
                      <div className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                        {style.description}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-500 italic mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                        Beispiel: {style.example}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Research Question */}
        {step === 4 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
            <div className="flex items-center mb-6">
              <Target className="w-8 h-8 text-black dark:text-white mr-3" />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                Forschungsfrage
              </h2>
            </div>

            <div className="space-y-6">
              <div>
                <p className="text-lg font-medium text-gray-900 dark:text-white mb-4">
                  Hast Du bereits eine Forschungsfrage?
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    onClick={() => handleResearchQuestionChange(true)}
                    className={`p-4 rounded-lg border-2 transition-all ${formData.hasResearchQuestion === true
                      ? 'border-yellow-600 dark:border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:border-yellow-300 dark:hover:border-yellow-600'
                      }`}
                  >
                    <span className="font-semibold text-gray-900 dark:text-white">Ja</span>
                  </button>
                  <button
                    onClick={() => handleResearchQuestionChange(false)}
                    className={`p-4 rounded-lg border-2 transition-all ${formData.hasResearchQuestion === false
                      ? 'border-yellow-600 dark:border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:border-yellow-300 dark:hover:border-yellow-600'
                      }`}
                  >
                    <span className="font-semibold text-gray-900 dark:text-white">Nein</span>
                  </button>
                </div>
              </div>

              {formData.hasResearchQuestion === true && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Deine Forschungsfrage *
                  </label>
                  <textarea
                    value={formData.researchQuestion}
                    onChange={(e) => setFormData({ ...formData, researchQuestion: e.target.value })}
                    placeholder="Formuliere Deine Forschungsfrage..."
                    rows={4}
                    className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
                  />
                </div>
              )}

              {formData.hasResearchQuestion === false && (
                <div>
                  {loadingSuggestions ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-8 h-8 animate-spin text-black dark:text-white" />
                      <span className="ml-3 text-gray-600 dark:text-gray-400">
                        KI generiert Vorschläge...
                      </span>
                    </div>
                  ) : researchQuestionSuggestions.length > 0 ? (
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                          Wähle eine Forschungsfrage aus:
                        </label>
                        <button
                          onClick={() => generateSuggestions()}
                          disabled={loadingSuggestions}
                          className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                        >
                          {loadingSuggestions ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <RefreshCw className="w-4 h-4 mr-2" />
                          )}
                          Neu generieren
                        </button>
                      </div>
                      <div className="space-y-3">
                        {researchQuestionSuggestions.map((suggestion, index) => (
                          <button
                            key={index}
                            onClick={() => setFormData({ ...formData, researchQuestion: suggestion })}
                            className={`w-full p-4 rounded-lg border-2 text-left transition-all ${formData.researchQuestion === suggestion
                              ? 'border-yellow-600 dark:border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                              : 'border-gray-200 dark:border-gray-700 hover:border-yellow-300 dark:hover:border-yellow-600'
                              }`}
                          >
                            <p className="text-gray-900 dark:text-white">{suggestion}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-8 text-gray-600 dark:text-gray-400">
                      Bitte wähle "Nein" aus, um Vorschläge zu generieren.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 5: Preview */}
        {step === 5 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
            <div className="flex items-center mb-6">
              <CheckCircle className="w-8 h-8 text-black dark:text-white mr-3" />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                Übersicht
              </h2>
            </div>

            <div className="space-y-6">
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-6">
                <h3 className="font-semibold text-lg mb-4 text-gray-900 dark:text-white">Deine Angaben:</h3>
                <dl className="space-y-3">
                  <div>
                    <dt className="text-sm font-medium text-gray-600 dark:text-gray-400">Sprache:</dt>
                    <dd className="text-gray-900 dark:text-white">
                      {formData.language === 'german' ? 'Deutsch' : formData.language === 'english' ? 'English' : '-'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-600 dark:text-gray-400">Art der Thesis:</dt>
                    <dd className="text-gray-900 dark:text-white">
                      {thesisTypes.find(t => t.value === formData.type)?.label}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-600 dark:text-gray-400">Thema:</dt>
                    <dd className="text-gray-900 dark:text-white">{formData.topic}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-600 dark:text-gray-400">Fachbereich:</dt>
                    <dd className="text-gray-900 dark:text-white">
                      {formData.field === 'Andere' ? formData.customField : formData.field}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-600 dark:text-gray-400">Umfang:</dt>
                    <dd className="text-gray-900 dark:text-white">
                      {formData.lengthUnit === 'pages' && formData.lengthMin && formData.lengthMax
                        ? `${formData.lengthMin}-${formData.lengthMax} Seiten (${parseInt(formData.lengthMin) * 320}-${parseInt(formData.lengthMax) * 320} Wörter)`
                        : formData.lengthUnit === 'words' && formData.lengthWords
                          ? `${formData.lengthWords} Wörter (ca. ${Math.ceil(parseInt(formData.lengthWords) / 250)} Seiten)`
                          : '-'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-600 dark:text-gray-400">Zitationsstil:</dt>
                    <dd className="text-gray-900 dark:text-white">
                      {citationStyles.find(s => s.value === formData.citationStyle)?.label || '-'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-600 dark:text-gray-400">Forschungsfrage:</dt>
                    <dd className="text-gray-900 dark:text-white">{formData.researchQuestion}</dd>
                  </div>
                </dl>
              </div>

              <button
                onClick={handleStartGeneration}
                disabled={loadingOutline}
                className="w-full py-4 bg-black dark:bg-white text-white dark:text-black rounded-lg font-semibold text-lg hover:bg-blue-600 dark:hover:bg-blue-500 transition-all shadow-lg hover:shadow-xl flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Weiter zur Gliederung
                <ArrowRight className="w-5 h-5 ml-2" />
              </button>
            </div>
          </div>
        )}

        {/* Step 6: Thesis Outline */}
        {step === 6 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
            <div className="flex items-center mb-6">
              <List className="w-8 h-8 text-black dark:text-white mr-3" />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                Thesis-Gliederung
              </h2>
            </div>

            {/* Regeneration Button */}
            {outline.length > 0 && !loadingOutline && (
              <div className="mb-6 flex justify-end">
                <button
                  onClick={() => {
                    if (window.confirm('Möchtest Du die Gliederung wirklich neu generieren? Alle aktuellen Änderungen gehen verloren.')) {
                      generateOutline()
                    }
                  }}
                  className="flex items-center text-sm text-gray-600 dark:text-gray-400 hover:text-yellow-600 dark:hover:text-yellow-500 transition-colors"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Neu generieren
                </button>
              </div>
            )}

            {!outline.length && !loadingOutline && (
              <div className="space-y-6 mb-6">
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  Hast Du bereits eine Gliederung, die Du hochladen möchtest?
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    onClick={() => setFormData({ ...formData, hasOwnOutline: true })}
                    className={`p-4 rounded-lg border-2 transition-all ${formData.hasOwnOutline === true
                      ? 'border-yellow-600 dark:border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:border-yellow-300 dark:hover:border-yellow-600'
                      }`}
                  >
                    <div className="font-semibold text-gray-900 dark:text-white mb-1">
                      Ja, ich habe eine Gliederung
                    </div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      Lade Deine Gliederung hoch
                    </div>
                  </button>

                  <button
                    onClick={() => setFormData({ ...formData, hasOwnOutline: false })}
                    className={`p-4 rounded-lg border-2 transition-all ${formData.hasOwnOutline === false
                      ? 'border-yellow-600 dark:border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:border-yellow-300 dark:hover:border-yellow-600'
                      }`}
                  >
                    <div className="font-semibold text-gray-900 dark:text-white mb-1">
                      Nein, KI generieren
                    </div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      Lass die KI eine Gliederung erstellen
                    </div>
                  </button>
                </div>

                {formData.hasOwnOutline === true && (
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Gliederung hochladen (PDF, DOCX, TXT)
                    </label>
                    <input
                      type="file"
                      accept=".pdf,.docx,.txt"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) {
                          setFormData({ ...formData, uploadedOutline: file })
                        }
                      }}
                      className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
                    />
                    {formData.uploadedOutline && (
                      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                        Ausgewählt: {formData.uploadedOutline.name}
                      </p>
                    )}
                  </div>
                )}

                {formData.hasOwnOutline !== null && (
                  <button
                    onClick={async () => {
                      if (formData.hasOwnOutline === true && formData.uploadedOutline) {
                        // Parse uploaded outline
                        setLoadingOutline(true)
                        try {
                          const formDataToSend = new FormData()
                          formDataToSend.append('file', formData.uploadedOutline)
                          formDataToSend.append('topic', formData.topic)
                          formDataToSend.append('field', formData.field === 'Andere' ? formData.customField : formData.field)
                          formDataToSend.append('thesisType', formData.type || '')
                          formDataToSend.append('researchQuestion', formData.researchQuestion)
                          formDataToSend.append('language', formData.language || 'german')
                          formDataToSend.append('lengthUnit', formData.lengthUnit)
                          if (formData.lengthUnit === 'pages') {
                            formDataToSend.append('lengthMin', formData.lengthMin || '')
                            formDataToSend.append('lengthMax', formData.lengthMax || '')
                          } else {
                            formDataToSend.append('lengthWords', formData.lengthWords || '')
                          }

                          const response = await fetch('/api/parse-outline', {
                            method: 'POST',
                            body: formDataToSend,
                          })

                          if (!response.ok) {
                            const errorData = await response.json()
                            throw new Error(errorData.error || 'Failed to parse outline')
                          }

                          const data = await response.json()
                          setOutline(data.outline || [])
                        } catch (error) {
                          console.error('Error parsing outline:', error)
                          alert(`Fehler beim Parsen der Gliederung: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}`)
                        } finally {
                          setLoadingOutline(false)
                        }
                      } else if (formData.hasOwnOutline === false) {
                        // Generate outline with AI
                        await generateOutline()
                      }
                    }}
                    disabled={loadingOutline || (formData.hasOwnOutline === true && !formData.uploadedOutline)}
                    className="w-full py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-semibold hover:bg-blue-600 dark:hover:bg-blue-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loadingOutline ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                        {formData.hasOwnOutline === true ? 'Gliederung wird verarbeitet...' : 'Gliederung wird generiert...'}
                      </>
                    ) : (
                      formData.hasOwnOutline === true ? 'Gliederung hochladen und konvertieren' : 'Gliederung generieren'
                    )}
                  </button>
                )}
              </div>
            )}

            {loadingOutline && outline.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-black dark:text-white" />
                <span className="ml-3 text-gray-600 dark:text-gray-400">
                  {formData.hasOwnOutline === true ? 'KI verarbeitet Gliederung...' : 'KI generiert Gliederung...'}
                </span>
              </div>
            ) : outline.length > 0 ? (
              <div className="space-y-6">
                <p className="text-gray-600 dark:text-gray-400 mb-6">
                  Überprüfe und bearbeite die Gliederung. Du kannst Kapitel hinzufügen, entfernen oder anpassen.
                </p>

                {outline.map((chapter, chapterIndex) => (
                  <div
                    key={chapterIndex}
                    className="border border-gray-200 dark:border-gray-700 rounded-lg p-6 bg-gray-50 dark:bg-gray-700/50"
                  >
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3 flex-1">
                        <span className="text-lg font-bold text-black dark:text-white min-w-[2rem]">
                          {chapter.number}.
                        </span>
                        <input
                          type="text"
                          value={chapter.title}
                          onChange={(e) => handleChapterTitleChange(chapterIndex, e.target.value)}
                          className="flex-1 text-lg font-semibold bg-transparent border-b-2 border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-yellow-500 dark:focus:border-yellow-400 focus:outline-none px-2 py-1 text-gray-900 dark:text-white"
                          placeholder="Kapitelname"
                        />
                      </div>
                      <button
                        onClick={() => removeChapter(chapterIndex)}
                        className="ml-4 p-2 text-yellow-600 dark:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 rounded-lg transition-colors"
                        title="Kapitel entfernen"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </div>

                    {/* Sections */}
                    <div className="ml-8 space-y-3 mt-4">
                      {chapter.sections.map((section, sectionIndex) => (
                        <div key={sectionIndex} className="border-l-2 border-yellow-200 dark:border-yellow-800 pl-4">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 flex-1">
                              <span className="text-sm font-semibold text-black dark:text-white min-w-[3rem]">
                                {section.number}
                              </span>
                              <input
                                type="text"
                                value={section.title}
                                onChange={(e) => handleSectionTitleChange(chapterIndex, sectionIndex, e.target.value)}
                                className="flex-1 text-base font-medium bg-transparent border-b border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-yellow-500 dark:focus:border-yellow-400 focus:outline-none px-2 py-1 text-gray-800 dark:text-gray-200"
                                placeholder="Abschnittsname"
                              />
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => addSubsection(chapterIndex, sectionIndex)}
                                className="p-1 text-yellow-600 dark:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 rounded transition-colors"
                                title="Unterabschnitt hinzufügen"
                              >
                                <Plus className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => removeSection(chapterIndex, sectionIndex)}
                                className="p-1 text-yellow-600 dark:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 rounded transition-colors"
                                title="Abschnitt entfernen"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>

                          {/* Subsections */}
                          {section.subsections.length > 0 && (
                            <div className="ml-6 space-y-2 mt-2">
                              {section.subsections.map((subsection, subsectionIndex) => (
                                <div key={subsectionIndex} className="flex items-center justify-between group">
                                  <div className="flex items-center gap-2 flex-1">
                                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400 min-w-[4rem]">
                                      {subsection.number}
                                    </span>
                                    <input
                                      type="text"
                                      value={subsection.title}
                                      onChange={(e) => handleSubsectionTitleChange(chapterIndex, sectionIndex, subsectionIndex, e.target.value)}
                                      className="flex-1 text-sm bg-transparent border-b border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-yellow-500 dark:focus:border-yellow-400 focus:outline-none px-2 py-1 text-gray-700 dark:text-gray-300"
                                      placeholder="Unterabschnittsname"
                                    />
                                  </div>
                                  <button
                                    onClick={() => removeSubsection(chapterIndex, sectionIndex, subsectionIndex)}
                                    className="p-1 text-yellow-600 dark:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 rounded transition-colors opacity-0 group-hover:opacity-100"
                                    title="Unterabschnitt entfernen"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      <button
                        onClick={() => addSection(chapterIndex)}
                        className="flex items-center gap-2 text-sm text-yellow-600 dark:text-yellow-500 hover:text-yellow-700 dark:hover:text-yellow-400 mt-2 ml-4"
                      >
                        <Plus className="w-4 h-4" />
                        Abschnitt hinzufügen
                      </button>
                    </div>
                  </div>
                ))}

                <button
                  onClick={addChapter}
                  className="w-full py-3 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-400 hover:border-yellow-500 dark:hover:border-yellow-400 hover:text-yellow-600 dark:hover:text-yellow-500 transition-all flex items-center justify-center"
                >
                  <Plus className="w-5 h-5 mr-2" />
                  Neues Kapitel hinzufügen
                </button>
              </div>
            ) : null}
          </div>
        )}

        {/* Step 7: File Upload */}
        {step === 7 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
            <div className="flex items-center mb-6">
              <Upload className="w-8 h-8 text-black dark:text-white mr-3" />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                Literatur hochladen
              </h2>
            </div>

            <div className="space-y-6">
              <p className="text-gray-600 dark:text-gray-400">
                Lade wissenschaftliche Dokumente hoch, die für Deine Thesis relevant sind.
                Die KI extrahiert automatisch bibliographische Informationen und die Dokumente werden für die Recherche indiziert.
              </p>

              {/* File Upload Area */}
              <div
                onClick={() => fileInputRef.current?.click()}
                onDrop={(e) => {
                  e.preventDefault()
                  handleFiles(Array.from(e.dataTransfer.files))
                }}
                onDragOver={(e) => e.preventDefault()}
                className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-12 text-center hover:border-yellow-500 dark:hover:border-yellow-400 transition-colors cursor-pointer"
              >
                <Upload className="w-12 h-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
                <p className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                  Dateien hier ablegen oder klicken zum Auswählen
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  PDF, Word, oder andere Dokumente unterstützt
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.txt"
                  onChange={(e) => {
                    if (e.target.files) {
                      handleFiles(Array.from(e.target.files))
                    }
                  }}
                  className="hidden"
                />
              </div>

              {/* FileSearchStore Information */}
              {fileSearchStoreId && (
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-yellow-900 dark:text-yellow-300">
                      FileSearchStore Status
                    </h3>
                    <button
                      onClick={() => fetchStoreInfo(fileSearchStoreId)}
                      disabled={loadingStoreInfo}
                      className="text-sm text-yellow-600 dark:text-yellow-500 hover:text-yellow-700 dark:hover:text-yellow-400 disabled:opacity-50"
                    >
                      {loadingStoreInfo ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                    </button>
                  </div>

                  {storeInfo ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="bg-white dark:bg-gray-800 rounded-lg p-3">
                        <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">Aktive Dokumente</div>
                        <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                          {storeInfo.activeDocumentsCount || 0}
                        </div>
                      </div>

                      <div className="bg-white dark:bg-gray-800 rounded-lg p-3">
                        <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">In Bearbeitung</div>
                        <div className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">
                          {storeInfo.pendingDocumentsCount || 0}
                        </div>
                      </div>

                      <div className="bg-white dark:bg-gray-800 rounded-lg p-3">
                        <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">Fehlgeschlagen</div>
                        <div className="text-2xl font-bold text-black dark:text-white">
                          {storeInfo.failedDocumentsCount || 0}
                        </div>
                      </div>

                      <div className="bg-white dark:bg-gray-800 rounded-lg p-3">
                        <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">Gesamtgröße</div>
                        <div className="text-lg font-bold text-blue-600 dark:text-blue-400">
                          {storeInfo.sizeBytes ? (storeInfo.sizeBytes / 1024 / 1024).toFixed(2) + ' MB' : '0 MB'}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      {loadingStoreInfo ? 'Lade Store-Informationen...' : 'Klicke auf Aktualisieren, um Store-Informationen zu laden'}
                    </div>
                  )}

                  {storeInfo && (
                    <div className="mt-4 pt-4 border-t border-yellow-200 dark:border-yellow-700">
                      <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
                        <div><strong>Store Name:</strong> {storeInfo.displayName || storeInfo.name}</div>
                        {storeInfo.createTime && (
                          <div><strong>Erstellt:</strong> {new Date(storeInfo.createTime).toLocaleString('de-DE')}</div>
                        )}
                        {storeInfo.updateTime && (
                          <div><strong>Zuletzt aktualisiert:</strong> {new Date(storeInfo.updateTime).toLocaleString('de-DE')}</div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="mt-4 pt-4 border-t border-yellow-200 dark:border-yellow-700">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-yellow-900 dark:text-yellow-300">
                        Dokumente in Datenbank:
                      </span>
                      <span className="text-lg font-bold text-yellow-600 dark:text-yellow-500">
                        {uploadedCount}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Uploaded Files List */}
              {uploadedFiles.length > 0 && (
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    Hochgeladene Dateien ({uploadedFiles.length})
                  </h3>
                  {uploadedFiles.map((uploadedFile) => (
                    <FileMetadataCard
                      key={uploadedFile.id}
                      uploadedFile={uploadedFile}
                      onUpdate={(updated) => {
                        setUploadedFiles(files =>
                          files.map(f => f.id === uploadedFile.id ? { ...f, ...updated } : f)
                        )
                      }}
                      onRemove={() => {
                        setUploadedFiles(files => files.filter(f => f.id !== uploadedFile.id))
                      }}
                      onSave={async () => {
                        await handleFileUpload(uploadedFile)
                      }}
                      onMandatoryToggle={(mandatory) => {
                        setUploadedFiles(files =>
                          files.map(f => f.id === uploadedFile.id ? { ...f, mandatory } : f)
                        )
                      }}
                    />
                  ))}
                </div>
              )}

              {/* Upload All Button */}
              {uploadedFiles.length > 0 && uploadedFiles.some(f => f.uploadStatus === 'ready') && (
                <button
                  onClick={handleUploadAll}
                  disabled={uploadedFiles.some(f => f.uploadStatus === 'uploading')}
                  className="w-full py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-semibold hover:bg-blue-600 dark:hover:bg-blue-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                >
                  {uploadedFiles.some(f => f.uploadStatus === 'uploading') ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin mr-2" />
                      Lade hoch...
                    </>
                  ) : (
                    <>
                      <Upload className="w-5 h-5 mr-2" />
                      Alle Dateien hochladen ({uploadedFiles.filter(f => f.uploadStatus === 'ready').length})
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step 8: Search Queries */}
        {step === 8 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
            <div className="flex items-center mb-6">
              <Search className="w-8 h-8 text-black dark:text-white mr-3" />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                Recherche-Anfragen generieren
              </h2>
            </div>

            <div className="space-y-6">
              <p className="text-gray-600 dark:text-gray-400">
                Für jede Sektion Deiner Gliederung wurden 3 Suchanfragen generiert, die Dir bei der Literaturrecherche helfen.
                Du kannst diese bearbeiten, bevor Du fortfährst.
              </p>

              {loadingQueries ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-black dark:text-white mr-3" />
                  <span className="text-gray-600 dark:text-gray-400">Generiere Suchanfragen...</span>
                </div>
              ) : searchQueries.length > 0 ? (
                <div className="space-y-6">
                  {searchQueries.map((section, sectionIndex) => (
                    <div
                      key={sectionIndex}
                      className="border border-gray-200 dark:border-gray-700 rounded-lg p-6 bg-gray-50 dark:bg-gray-900/50"
                    >
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                        {section.sectionNumber} {section.sectionTitle}
                      </h3>
                      <div className="space-y-3">
                        {section.queries.map((query, queryIndex) => (
                          <div key={queryIndex} className="flex items-start gap-3">
                            <span className="text-sm font-medium text-gray-500 dark:text-gray-400 mt-2 min-w-[2rem]">
                              {queryIndex + 1}.
                            </span>
                            <input
                              type="text"
                              value={query}
                              onChange={(e) => {
                                const updatedQueries = [...searchQueries]
                                updatedQueries[sectionIndex].queries[queryIndex] = e.target.value
                                setSearchQueries(updatedQueries)
                              }}
                              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                              placeholder="Suchanfrage eingeben..."
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                  <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>Keine Suchanfragen generiert. Bitte klicke auf "Weiter" um sie zu generieren.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Save button for outline */}
        {step === 6 && !loadingOutline && outline.length > 0 && (
          <div className="mt-6 flex justify-end">
            <button
              onClick={handleSaveOutline}
              disabled={saving || !user || !thesisId}
              className="px-6 py-3 bg-gray-600 dark:bg-gray-700 text-white rounded-lg font-semibold hover:bg-gray-700 dark:hover:bg-gray-600 transition-all flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                  Speichere...
                </>
              ) : (
                <>
                  <Save className="w-5 h-5 mr-2" />
                  Gliederung speichern
                </>
              )}
            </button>
          </div>
        )}

        {/* Navigation Buttons */}
        {(step < 5 || step === 6) && (
          <div className="flex justify-between mt-8">
            <button
              onClick={handleBack}
              disabled={step === 1}
              className="px-6 py-3 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Zurück
            </button>
            <button
              onClick={handleNext}
              disabled={saving || (step === 6 && outline.length === 0)}
              className="px-6 py-3 bg-yellow-600 dark:bg-yellow-500 text-black dark:text-white rounded-lg font-semibold hover:bg-yellow-700 dark:hover:bg-yellow-400 transition-all flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Speichere...
                </>
              ) : (
                <>
                  Weiter
                  <ArrowRight className="w-4 h-4 ml-2" />
                </>
              )}
            </button>
          </div>
        )}

        {/* Final step navigation - Start Generation */}
        {step === 7 && (
          <div className="flex justify-between mt-8">
            <button
              onClick={handleBack}
              className="px-6 py-3 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-all"
            >
              Zurück
            </button>
            <button
              onClick={handleFinalStart}
              disabled={loading || !thesisId || !outline || outline.length === 0}
              className="px-6 py-3 bg-yellow-600 dark:bg-yellow-500 text-black dark:text-white rounded-lg font-semibold hover:bg-yellow-700 dark:hover:bg-yellow-400 transition-all flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                  Starte Generierung...
                </>
              ) : (
                <>
                  Generierung starten
                  <ArrowRight className="w-4 h-4 ml-2" />
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Generation Started Modal */}
      {showGenerationModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-md w-full p-6">
            <div className="text-center">
              <div className="w-16 h-16 bg-yellow-100 dark:bg-yellow-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-yellow-600 dark:text-yellow-500" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                Generierung gestartet!
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                Ihre Thesis wird jetzt im Hintergrund generiert. Dies kann einige Minuten dauern.
              </p>
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 mb-6">
                <div className="flex items-center justify-center gap-2 text-yellow-700 dark:text-yellow-300 mb-1">
                  <Mail className="w-5 h-5" />
                  <span className="font-semibold">E-Mail-Benachrichtigung</span>
                </div>
                <p className="text-sm text-yellow-600 dark:text-yellow-500">
                  Sie erhalten eine E-Mail, sobald Ihre Thesis fertig ist.
                </p>
              </div>
              <button
                onClick={() => {
                  setShowGenerationModal(false)
                  router.push('/thesis')
                }}
                className="w-full px-6 py-3 bg-yellow-600 dark:bg-yellow-500 text-black dark:text-white rounded-lg font-semibold hover:bg-yellow-700 dark:hover:bg-yellow-400 transition-all"
              >
                Zur Übersicht
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

async function generateResearchQuestionSuggestions(
  topic: string,
  field: string,
  thesisType: ThesisType,
  language: 'german' | 'english'
): Promise<string[]> {
  const response = await fetch('/api/generate-research-questions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topic,
      field,
      thesisType,
      language,
    }),
  })

  if (!response.ok) {
    throw new Error('Failed to generate research question suggestions')
  }

  const data = await response.json()
  return data.suggestions
}

async function fetchThesisOutline(params: {
  topic: string
  field: string
  thesisType: ThesisType
  researchQuestion: string
  lengthMin: number
  lengthMax: number
  citationStyle: CitationStyle
  language: 'german' | 'english'
}): Promise<OutlineChapter[]> {
  const response = await fetch('/api/generate-thesis-outline', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })

  if (!response.ok) {
    throw new Error('Failed to generate thesis outline')
  }

  const data = await response.json()
  return data.outline
}


export default function NewThesisPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-purple-600 mx-auto mb-4" />
          <p className="text-gray-500">Lade...</p>
        </div>
      </div>
    }>
      <NewThesisContent />
    </Suspense>
  )
}
