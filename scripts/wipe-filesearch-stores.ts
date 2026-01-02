
import { GoogleGenAI } from '@google/genai';
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
if (!GEMINI_KEY) {
    console.error('GEMINI_KEY not found in .env.local');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

async function wipeStores() {
    console.log('Listing all FileSearch stores...');
    try {
        const listResponse = await ai.fileSearchStores.list();
        const stores = listResponse.fileSearchStores || [];

        console.log(`Found ${stores.length} stores.`);

        if (stores.length === 0) {
            console.log('No stores to delete.');
            return;
        }

        for (const store of stores) {
            if (!store.name) continue;
            console.log(`Deleting store: ${store.name} (${store.displayName})`);
            try {
                await ai.fileSearchStores.delete({ name: store.name });
                console.log(`  ✓ Deleted ${store.name}`);
            } catch (e) {
                console.error(`  ✗ Failed to delete ${store.name}:`, e);
            }
        }
        console.log('Done.');
    } catch (error) {
        console.error('Error listing stores:', error);
    }
}

wipeStores();
