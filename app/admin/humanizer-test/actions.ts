'use server'

import { createSupabaseServerClient } from '@/lib/supabase/client'

export async function getThesisContent(thesisId: string) {
    const supabase = createSupabaseServerClient()

    // We fetch 'latex_content' which historically holds the main markdown content
    const { data, error } = await supabase
        .from('theses')
        .select('latex_content, metadata')
        .eq('id', thesisId)
        .single()

    if (error) {
        throw new Error(`Failed to fetch content: ${error.message}`)
    }

    return {
        content: data?.latex_content || '',
        metadata: data?.metadata || {}
    }
}

export async function sendToHumanizer(endpoint: string, payload: any) {
    const whitelistHash = process.env.WHITELIST_HASH

    if (!whitelistHash) {
        throw new Error('WHITELIST_HASH is not configured in environment variables')
    }

    if (!endpoint) {
        throw new Error('Endpoint URL is required')
    }

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-whitelist-hash': whitelistHash
            },
            body: JSON.stringify(payload)
        })

        if (!response.ok) {
            const text = await response.text()
            throw new Error(`API Error (${response.status}): ${text}`)
        }

        const data = await response.json()
        return { success: true, data }

    } catch (error: any) {
        console.error('Humanizer API Error:', error)
        return { success: false, error: error.message }
    }
}
