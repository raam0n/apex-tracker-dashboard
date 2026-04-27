import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STEAM_PATH = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Apex Legends\\LiveAPI\\events.proto";
const OUTPUT_PATH = path.join(__dirname, 'events_fixed.proto');

const fixProto = () => {
  try {
    if (!fs.existsSync(STEAM_PATH)) {
      console.error('Source proto not found!');
      return;
    }

    const content = fs.readFileSync(STEAM_PATH, 'utf8');
    const lines = content.split('\n');
    
    const importLines = [];
    const otherLines = [];
    
    lines.forEach(line => {
      if (line.trim().startsWith('import ')) {
        importLines.push(line);
      } else {
        otherLines.push(line);
      }
    });

    // Reconstruct with imports at the top (after syntax declaration if present)
    const fixedContent = [
      'syntax = "proto3";', // Force proto3 just in case
      ...importLines,
      ...otherLines
    ].join('\n');

    fs.writeFileSync(OUTPUT_PATH, fixedContent);
    console.log('Successfully created events_fixed.proto with imports at the top.');
  } catch (err) {
    console.error('Fix failed:', err);
  }
};

fixProto();
