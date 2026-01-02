
import fs from 'fs';
import path from 'path';

// Manual simple env parser
function loadEnv() {
    try {
        const envPath = path.resolve(process.cwd(), '.env.local');
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf-8');
            content.split('\n').forEach(line => {
                const match = line.match(/^([^=]+)=(.*)$/);
                if (match) {
                    const key = match[1].trim();
                    let value = match[2].trim();
                    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                        value = value.slice(1, -1);
                    }
                    process.env[key] = value;
                }
            });
        }
    } catch (e) {
        console.warn('Could not load .env.local', e);
    }
}

loadEnv();

async function wipeStores() {
    const apiKey = process.env.GEMINI_KEY;
    if (!apiKey) {
        console.error('Error: GEMINI_KEY is not set in .env.local');
        process.exit(1);
    }

    console.log('Listing and Wiping Google FileSearch Stores via REST API...');

    try {
        const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/fileSearchStores?key=${apiKey}`);
        if (!listResponse.ok) throw new Error(`List API Error: ${listResponse.status}`);

        const data = await listResponse.json();
        const stores = data.fileSearchStores || [];

        console.log(`\nFound ${stores.length} active stores. Starting deletion...`);

        for (const store of stores) {
            console.log(`Deleting ${store.name}...`);
            // Added force=true to handle stores with files
            const deleteResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/${store.name}?key=${apiKey}&force=true`, {
                method: 'DELETE'
            });

            if (deleteResponse.ok) {
                console.log(`✅ Deleted ${store.name}`);
            } else {
                console.error(`❌ Failed to delete ${store.name}: ${deleteResponse.status} ${deleteResponse.statusText}`);
                const text = await deleteResponse.text();
                console.error('Response:', text);
            }

            // Slight delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log('\nWipe complete.');

    } catch (error) {
        console.error('Failed to wipe stores:', error);
    }
}

wipeStores();
