/**
 * Migration script to populate clean_markdown_content for existing theses
 * Run this once after adding the new column
 */

import { createClient } from '@supabase/supabase-js'
import { convertToCleanMarkdown } from '../lib/markdown-utils'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required environment variables')
    console.error('Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function migrateTheses() {
    console.log('Starting thesis migration...')

    // Get all theses that don't have clean_markdown_content yet
    const { data: theses, error } = await supabase
        .from('theses')
        .select('id, latex_content')
        .is('clean_markdown_content', null)
        .not('latex_content', 'is', null)

    if (error) {
        console.error('Error fetching theses:', error)
        process.exit(1)
    }

    if (!theses || theses.length === 0) {
        console.log('No theses to migrate')
        return
    }

    console.log(`Found ${theses.length} theses to migrate`)

    let successCount = 0
    let errorCount = 0

    for (const thesis of theses) {
        try {
            console.log(`\nMigrating thesis ${thesis.id}...`)

            // Convert to clean Markdown
            const cleanMarkdown = convertToCleanMarkdown(thesis.latex_content)

            // Update the thesis
            const { error: updateError } = await supabase
                .from('theses')
                .update({ clean_markdown_content: cleanMarkdown })
                .eq('id', thesis.id)

            if (updateError) {
                console.error(`  Error updating thesis ${thesis.id}:`, updateError)
                errorCount++
            } else {
                console.log(`  ✓ Successfully migrated thesis ${thesis.id}`)
                console.log(`    Original length: ${thesis.latex_content.length} chars`)
                console.log(`    Clean length: ${cleanMarkdown.length} chars`)
                successCount++
            }
        } catch (err) {
            console.error(`  Error processing thesis ${thesis.id}:`, err)
            errorCount++
        }
    }

    console.log('\n' + '='.repeat(60))
    console.log('Migration complete!')
    console.log(`  Success: ${successCount}`)
    console.log(`  Errors: ${errorCount}`)
    console.log('='.repeat(60))
}

migrateTheses().catch(console.error)
