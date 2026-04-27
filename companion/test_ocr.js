import { createWorker } from 'tesseract.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const testOCR = async () => {
    console.log('🧪 Starting OCR Test...');
    
    // Check if there is a snap to test
    const snapsDir = path.join(__dirname, 'snaps');
    const files = fs.readdirSync(snapsDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
    
    if (files.length === 0) {
        console.log('❌ No images found in companion/snaps/ to test.');
        console.log('👉 Please hit F10 on your desktop once to generate a test snap first.');
        return;
    }

    const testFile = path.join(snapsDir, files[0]);
    console.log(`🔍 Testing OCR on: ${testFile}`);

    const worker = await createWorker('eng');
    try {
        const { data: { text } } = await worker.recognize(testFile);
        console.log('\n--- EXTRACTED TEXT ---');
        console.log(text);
        console.log('----------------------\n');
        
        const placementMatch = text.match(/#\s*(\d+)/i);
        const killsMatch = text.match(/(?:TOTAL\s*)?KILLS\s*[:\s]*(\d+)/i);
        const damageMatch = text.match(/(?:DAMAGE\s*(?:DEALT)?)\s*[:\s]*(\d+)/i);

        console.log('📊 Parsed Stats:');
        console.log('- Placement:', placementMatch ? `#${placementMatch[1]}` : 'Not found');
        console.log('- Kills:', killsMatch ? killsMatch[1] : 'Not found');
        console.log('- Damage:', damageMatch ? damageMatch[1] : 'Not found');

    } catch (err) {
        console.error('OCR Test Error:', err);
    } finally {
        await worker.terminate();
    }
};

testOCR();
