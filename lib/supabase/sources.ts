import { getThesisById } from './theses'
import type { UploadedSource, FileMetadata } from './types'

/**
 * Check if a source with the given DOI already exists in the thesis
 */
export async function checkSourceExists(
  thesisId: string,
  doi?: string
): Promise<{ exists: boolean; source?: UploadedSource }> {
  if (!doi) {
    return { exists: false }
  }

  const thesis = await getThesisById(thesisId)
  const existingSources: UploadedSource[] = thesis?.uploaded_sources || []

  const duplicateSource = existingSources.find(
    (source) => source.doi && source.doi.toLowerCase() === doi.toLowerCase()
  )

  return {
    exists: !!duplicateSource,
    source: duplicateSource,
  }
}

/**
 * Get all uploaded sources for a thesis
 */
export async function getThesisSources(thesisId: string): Promise<UploadedSource[]> {
  const thesis = await getThesisById(thesisId)
  return thesis?.uploaded_sources || []
}

/**
 * Check if a source should be uploaded based on DOI
 * Returns true if source doesn't exist or has no DOI
 */
export async function shouldUploadSource(
  thesisId: string,
  metadata?: FileMetadata
): Promise<{ shouldUpload: boolean; reason?: string; existingSource?: UploadedSource }> {
  if (!metadata?.doi) {
    // No DOI to check, allow upload
    return { shouldUpload: true, reason: 'No DOI provided' }
  }

  const { exists, source } = await checkSourceExists(thesisId, metadata.doi)

  if (exists) {
    return {
      shouldUpload: false,
      reason: 'Source with this DOI already exists',
      existingSource: source,
    }
  }

  return { shouldUpload: true }
}

/**
 * Check if a file exists in the FileSearchStore by checking our database
 * This is the recommended approach since FileSearchStore API doesn't provide direct document listing
 */
export async function checkFileInStore(
  thesisId: string,
  doi?: string,
  fileName?: string
): Promise<{ exists: boolean; source?: UploadedSource }> {
  const sources = await getThesisSources(thesisId)
  
  if (doi) {
    const source = sources.find(
      (s) => s.doi && s.doi.toLowerCase() === doi.toLowerCase()
    )
    if (source) {
      return { exists: true, source }
    }
  }
  
  if (fileName) {
    const source = sources.find(
      (s) => s.fileName.toLowerCase() === fileName.toLowerCase()
    )
    if (source) {
      return { exists: true, source }
    }
  }
  
  return { exists: false }
}

