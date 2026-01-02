
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

async function listStores() {
    const apiKey = process.env.GEMINI_KEY;
    if (!apiKey) {
        console.error('Error: GEMINI_KEY is not set in .env.local');
        process.exit(1);
    }

    console.log('Checking active Google FileSearch Stores via REST API...');

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/fileSearchStores?key=${apiKey}`);

        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const stores = data.fileSearchStores || [];

        console.log(`\nFound ${stores.length} active stores:`);

        if (stores.length === 0) {
            console.log("✅ No active stores found. Clean slate confirmed.");
        } else {
            stores.forEach((store: any) => {
                console.log(`- ID: ${store.name} | Status: ${store.state || 'Unknown'}`);
            });
            console.log("\n⚠️ Some stores still exist.");
        }

    } catch (error) {
        console.error('Failed to list stores:', error);
    }
}

listStores();
