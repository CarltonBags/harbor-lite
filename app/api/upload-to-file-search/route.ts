import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { env } from '@/lib/env'
import { getThesisById, updateThesis } from '@/lib/supabase/theses'
import type { UploadedSource, FileMetadata } from '@/lib/supabase/types'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const fileUrl = formData.get('fileUrl') as string | null
    const fileSearchStoreId = formData.get('fileSearchStoreId') as string
    const thesisIdRaw = formData.get('thesisId') as string | null
    const thesisId = thesisIdRaw && thesisIdRaw.trim() !== '' ? thesisIdRaw.trim() : null
    const metadata = formData.get('metadata') as string
    const displayName = formData.get('displayName') as string | null
    const mandatoryRaw = formData.get('mandatory') as string | null
    const mandatory = mandatoryRaw === 'true'

    console.log('Upload request received:', {
      hasFile: !!file,
      hasFileUrl: !!fileUrl,
      fileSearchStoreId,
      thesisId,
      hasMetadata: !!metadata
    })

    if ((!file && !fileUrl) || !fileSearchStoreId) {
      return NextResponse.json(
        { error: 'Either file or fileUrl, and FileSearchStore ID are required' },
        { status: 400 }
      )
    }

    if (!env.GEMINI_KEY) {
      return NextResponse.json(
        { error: 'GEMINI_KEY is not configured' },
        { status: 500 }
      )
    }

    // Parse metadata if provided
    let parsedMetadata: FileMetadata | null = null
    if (metadata) {
      try {
        parsedMetadata = JSON.parse(metadata)
      } catch (e) {
        console.warn('Failed to parse metadata:', e)
      }
    }

    // Check for duplicate DOI if thesisId is provided
    if (thesisId && parsedMetadata?.doi) {
      const thesis = await getThesisById(thesisId)
      const existingSources: UploadedSource[] = thesis?.uploaded_sources || []

      // Check if DOI already exists
      const duplicateSource = existingSources.find(
        (source) => source.doi && source.doi.toLowerCase() === parsedMetadata!.doi!.toLowerCase()
      )

      if (duplicateSource) {
        return NextResponse.json(
          {
            error: 'This source has already been uploaded',
            duplicate: true,
            existingSource: duplicateSource,
          },
          { status: 409 } // Conflict status code
        )
      }
    }

    // Initialize Google Gen AI SDK
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_KEY })

    // Prepare file source (either File object or URL string)
    let fileSource: File | string
    let fileName: string

    if (fileUrl) {
      // Use URL if provided
      fileSource = fileUrl
      fileName = displayName || fileUrl.split('/').pop() || 'document'
    } else if (file) {
      // Use File object
      fileSource = file
      fileName = displayName || file.name
    } else {
      throw new Error('No file or URL provided')
    }

    // Prepare config for upload with chunking configuration
    let config: any = {
      displayName: fileName,
      chunkingConfig: {
        whiteSpaceConfig: {
          maxTokensPerChunk: 512, // Maximum allowed chunk size (in tokens) - API limit is 512
          maxOverlapTokens: 50, // Overlap between chunks for better context preservation (should be less than chunk size)
        },
      },
    }

    if (parsedMetadata) {
      // Store metadata as separate fields (like the API example)
      // Each field can be up to 256 characters, and we can use numericValue for numbers
      config.customMetadata = []

      if (parsedMetadata.doi && parsedMetadata.doi.length <= 256) {
        config.customMetadata.push({
          key: 'doi',
          stringValue: parsedMetadata.doi,
        })
      }

      if (parsedMetadata.title) {
        const title = parsedMetadata.title.substring(0, 256)
        config.customMetadata.push({
          key: 'title',
          stringValue: title,
        })
      }

      if (parsedMetadata.authors && parsedMetadata.authors.length > 0) {
        // Store first author (or all authors joined if short enough)
        const authors = parsedMetadata.authors.join(', ').substring(0, 256)
        config.customMetadata.push({
          key: 'author',
          stringValue: authors,
        })
      }

      if (parsedMetadata.year) {
        const year = parseInt(parsedMetadata.year)
        if (!isNaN(year)) {
          config.customMetadata.push({
            key: 'year',
            numericValue: year,
          })
        } else {
          // If not a valid number, store as string
          config.customMetadata.push({
            key: 'year',
            stringValue: parsedMetadata.year.substring(0, 256),
          })
        }
      }

      if (parsedMetadata.journal && parsedMetadata.journal.length <= 256) {
        config.customMetadata.push({
          key: 'journal',
          stringValue: parsedMetadata.journal,
        })
      }

      if (parsedMetadata.publisher && parsedMetadata.publisher.length <= 256) {
        config.customMetadata.push({
          key: 'publisher',
          stringValue: parsedMetadata.publisher,
        })
      }
    }

    // Add mandatory flag to metadata
    if (mandatory) {
      if (!config.customMetadata) {
        config.customMetadata = []
      }
      config.customMetadata.push({
        key: 'mandatory',
        stringValue: 'true',
      })
    }

    // Upload to FileSearchStore using SDK
    let operation = await ai.fileSearchStores.uploadToFileSearchStore({
      file: fileSource,
      fileSearchStoreName: fileSearchStoreId,
      config: config,
    })

    // Poll until operation is complete (server-side polling)
    // This keeps the operation object in memory and avoids serialization issues
    const maxWaitTime = 300000 // 5 minutes
    const pollInterval = 2000 // 2 seconds
    const startTime = Date.now()

    while (!operation.done) {
      // Check timeout
      if (Date.now() - startTime > maxWaitTime) {
        return NextResponse.json(
          { error: 'Upload operation timeout', operationName: operation.name },
          { status: 408 }
        )
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval))

      // Poll for completion - pass the operation object directly (as per SDK example)
      operation = await ai.operations.get({ operation })
    }

    // Check if operation had an error
    if (operation.error) {
      return NextResponse.json(
        { error: 'Upload operation failed', details: operation.error },
        { status: 500 }
      )
    }

    // Prepare source data
    const sourceData = thesisId ? {
      doi: parsedMetadata?.doi,
      title: parsedMetadata?.title || fileName,
      fileName: fileName,
      uploadedAt: new Date().toISOString(),
      metadata: parsedMetadata || undefined,
      sourceType: fileUrl ? 'url' : 'file' as const,
      sourceUrl: fileUrl || undefined,
      mandatory: mandatory || undefined,
    } : undefined

    // Update database with the uploaded source if thesisId is provided
    console.log('Attempting to update database:', { thesisId, hasSourceData: !!sourceData })
    if (thesisId && sourceData) {
      try {
        // Use server-side client with service role key to bypass RLS
        const { createSupabaseServerClient } = await import('@/lib/supabase/client')
        const supabase = createSupabaseServerClient()

        console.log('Fetching thesis from database:', thesisId)
        const { data: thesis, error: fetchError } = await supabase
          .from('theses')
          .select('*')
          .eq('id', thesisId)
          .single()

        if (fetchError) {
          if (fetchError.code === 'PGRST116') {
            console.warn(`Thesis ${thesisId} not found, skipping database update`)
          } else {
            console.error('Error fetching thesis:', fetchError)
          }
        } else if (thesis) {
          console.log('Thesis found. Sources count:', (thesis.uploaded_sources || []).length)
          const existingSources: UploadedSource[] = thesis.uploaded_sources || []

          // Check if source already exists (by DOI or fileName)
          const duplicateSource = existingSources.find(
            (s) =>
              (sourceData.doi && s.doi && s.doi.toLowerCase() === sourceData.doi.toLowerCase()) ||
              (s.fileName && s.fileName.toLowerCase() === sourceData.fileName.toLowerCase())
          )

          if (!duplicateSource) {
            // Add new source to the array
            const newSource: UploadedSource = {
              doi: sourceData.doi,
              title: sourceData.title,
              fileName: sourceData.fileName,
              uploadedAt: sourceData.uploadedAt,
              metadata: sourceData.metadata,
              sourceType: sourceData.sourceType as 'file' | 'url',
              sourceUrl: sourceData.sourceUrl,
              mandatory: sourceData.mandatory,
            }

            const updatedSources = [...existingSources, newSource]
            console.log('Updating thesis with new source. Total sources:', updatedSources.length)

            // Update thesis with new source
            const { data: updateData, error: updateError } = await supabase
              .from('theses')
              .update({
                uploaded_sources: updatedSources as any,
                updated_at: new Date().toISOString(),
              })
              .eq('id', thesisId)
              .select()

            if (updateError) {
              console.error('Error updating thesis with uploaded source:', updateError)
              // Don't fail the upload if DB update fails
            } else {
              console.log('Successfully updated database with uploaded source. Updated rows:', updateData?.length || 0)
            }
          } else {
            console.log('Source already exists in database, skipping update')
          }
        }
      } catch (dbError) {
        console.error('Error updating database:', dbError)
        // Don't fail the upload if DB update fails
      }
    } else {
      console.warn('Skipping database update:', { hasThesisId: !!thesisId, hasSourceData: !!sourceData })
    }

    // Operation is complete - return success
    return NextResponse.json({
      done: true,
      operationName: operation.name,
      source: sourceData,
      thesisId: thesisId || undefined,
    })
  } catch (error) {
    console.error('Error uploading to FileSearchStore:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

