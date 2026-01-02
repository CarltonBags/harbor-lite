
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Load env
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
            const key = match[1].trim();
            const value = match[2].trim().replace(/^"(.*)"$/, '$1'); // Remove quotes
            process.env[key] = value;
        }
    });
}

const GEMINI_KEY = process.env.GEMINI_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || (process.env.NEXT_PUBLIC_SUPABASE_PROJECT_ID ? `https://${process.env.NEXT_PUBLIC_SUPABASE_PROJECT_ID}.supabase.co` : '');
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error('Missing required env vars (GEMINI_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE)');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false }
});

async function nuclearWipe() {
    console.log('☢️ STARTING NUCLEAR WIPE ☢️');

    // 1. Delete ALL Files
    console.log('\n--- 1. Deleting ALL Files ---');
    try {
        const fileList = await ai.files.list({ pageSize: 100 });
        let count = 0;
        // Iterate using the async iterator or the page
        // Based on the log, listResp is a Pager. Let's try explicit iteration if possible
        // Use 'any' cast to avoid TS issues if types are mismatched
        for await (const file of (fileList as any)) {
            if (file.name) {
                try {
                    console.log(`Deleting file: ${file.name}`);
                    await ai.files.delete({ name: file.name });
                    count++;
                } catch (e: any) {
                    console.error(`  ✗ Failed to delete file ${file.name}:`, e.message);
                }
            }
        }
        console.log(`\nDeleted ${count} files.`);
    } catch (e) {
        console.error('Error listing/deleting files:', e);
    }

    // 2. Delete Stores and Clean DB
    console.log('\n--- 2. Cleaning Stores and DB ---');

    const { data: theses, error } = await supabase
        .from('theses')
        .select('id, file_search_store_id')
        .not('file_search_store_id', 'is', null);

    if (error) {
        console.error('Error fetching theses:', error);
        // The user's provided snippet for this section had an `else` block that was slightly different.
        // Keeping the original logic for processing theses, as the instruction was about `for await` for files and stores.
        // The `theses` are fetched from Supabase, not Google GenAI, so the iteration method for `theses` itself doesn't change.
    } else {
        console.log(`Found ${theses.length} theses with attached FileSearchStores in DB.`);

        for (const thesis of theses) {
            const storeId = thesis.file_search_store_id;
            console.log(`Processing Thesis ${thesis.id} (Store: ${storeId})...`);

            // Delete from Google
            try {
                await ai.fileSearchStores.delete({ name: storeId });
                console.log(`  ✓ Deleted store from Google: ${storeId}`);
            } catch (e: any) {
                if (e.message && (e.message.includes('404') || e.message.includes('NOT_FOUND'))) {
                    console.log(`  - Store not found on Google (already deleted): ${storeId}`);
                } else {
                    console.error(`  ✗ Failed to delete store: ${e.message}`);
                }
            }

            // Remove from DB
            const { error: updateError } = await supabase
                .from('theses')
                .update({ file_search_store_id: null })
                .eq('id', thesis.id);

            if (updateError) {
                console.error(`  ✗ Failed to update DB for thesis ${thesis.id}:`, updateError.message);
            } else {
                console.log(`  ✓ Removed ID from DB`);
            }
        }
    }

    console.log('\n--- 3. Double Check for Orphaned Stores ---');
    // List any remaining stores (orphans) and delete them
    try {
        const storeList = await ai.fileSearchStores.list({ pageSize: 100 });
        for await (const store of (storeList as any)) {
            console.log(`Deleting orphaned store: ${store.name}`);
            try {
                await ai.fileSearchStores.delete({ name: store.name });
                console.log(`  ✓ Deleted`);
            } catch (e: any) {
                console.error(`  ✗ Failed: ${e.message}`);
            }
        }
    } catch (e) {
        console.error('Error listing orphaned stores:', e);
    }

    console.log('\n☢️ NUCLEAR WIPE COMPLETE ☢️');
}

nuclearWipe();
