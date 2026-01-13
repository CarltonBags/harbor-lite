/**
 * Cleanup script to delete all FileSearchStores from the Gemini API
 * Run with: npx tsx scripts/cleanup-filesearch-stores.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'

// Load environment variables from .env.local manually
function loadEnvFile(filePath: string): void {
    try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed && !trimmed.startsWith('#')) {
                const [key, ...valueParts] = trimmed.split('=')
                if (key && valueParts.length > 0) {
                    let value = valueParts.join('=')
                    // Remove quotes if present
                    if ((value.startsWith('"') && value.endsWith('"')) ||
                        (value.startsWith("'") && value.endsWith("'"))) {
                        value = value.slice(1, -1)
                    }
                    process.env[key] = value
                }
            }
        }
    } catch (e) {
        console.error(`Failed to load env file: ${filePath}`)
    }
}

loadEnvFile(path.resolve(process.cwd(), '.env.local'))

// Load environment variables
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_PROJECT_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const GOOGLE_API_KEY = process.env.GEMINI_KEY || process.env.GOOGLE_AI_API_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables')
    console.error('SUPABASE_URL:', SUPABASE_URL ? 'set' : 'missing')
    console.error('SUPABASE_SERVICE_KEY:', SUPABASE_SERVICE_KEY ? 'set' : 'missing')
    process.exit(1)
}

if (!GOOGLE_API_KEY) {
    console.error('Missing GOOGLE_AI_API_KEY environment variable')
    process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

async function deleteFileSearchStore(storeId: string): Promise<boolean> {
    try {
        // The storeId should be in format "fileSearchStores/xxx"
        const storeName = storeId.startsWith('fileSearchStores/') ? storeId : `fileSearchStores/${storeId}`

        console.log(`  Deleting: ${storeName}`)

        // Use direct API call with force=true
        const url = `https://generativelanguage.googleapis.com/v1beta/${storeName}?force=true&key=${GOOGLE_API_KEY}`

        const response = await fetch(url, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            }
        })

        if (response.ok) {
            console.log(`  ✓ Deleted: ${storeName}`)
            return true
        }

        // Check if store was already deleted (404)
        if (response.status === 404) {
            console.log(`  ⚠️ Store not found (already deleted?): ${storeId}`)
            return true // Consider this a success
        }

        const errorText = await response.text()
        console.error(`  ✗ Failed to delete ${storeId}: ${response.status} ${errorText}`)
        return false
    } catch (error: any) {
        console.error(`  ✗ Error deleting ${storeId}:`, error?.message || error)
        return false
    }
}

async function main() {
    console.log('='.repeat(60))
    console.log('FileSearchStore Cleanup Script')
    console.log('='.repeat(60))
    console.log('')

    // Step 1: Get all file_search_store_ids from the theses table
    console.log('[1/3] Fetching FileSearchStore IDs from database...')

    const { data: theses, error } = await supabase
        .from('theses')
        .select('id, title, file_search_store_id')
        .not('file_search_store_id', 'is', null)

    if (error) {
        console.error('Failed to fetch theses:', error)
        process.exit(1)
    }

    if (!theses || theses.length === 0) {
        console.log('No theses with FileSearchStore IDs found.')
        process.exit(0)
    }

    console.log(`Found ${theses.length} theses with FileSearchStore IDs`)
    console.log('')

    // Step 2: Delete each FileSearchStore
    console.log('[2/3] Deleting FileSearchStores...')
    console.log('')

    let successCount = 0
    let failCount = 0
    const failedIds: string[] = []

    for (const thesis of theses) {
        console.log(`Thesis: "${thesis.title?.substring(0, 50)}..." (${thesis.id})`)
        const success = await deleteFileSearchStore(thesis.file_search_store_id)

        if (success) {
            successCount++
        } else {
            failCount++
            failedIds.push(thesis.file_search_store_id)
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200))
    }

    console.log('')
    console.log('[3/3] Cleanup Summary')
    console.log('='.repeat(60))
    console.log(`✓ Successfully deleted: ${successCount}`)
    console.log(`✗ Failed to delete: ${failCount}`)

    if (failedIds.length > 0) {
        console.log('')
        console.log('Failed IDs:')
        failedIds.forEach(id => console.log(`  - ${id}`))
    }

    console.log('')
    console.log('Done!')
}

main().catch(console.error)
