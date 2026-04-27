import { WebSocketServer } from 'ws';
import protobuf from 'protobufjs';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import screenshot from 'screenshot-desktop';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- CONFIGURACIÓN ---
const WS_PORT = 7777;
const API_PORT = 7778;
const HISTORY_FILE = path.join(__dirname, 'history.json');
const SNAPS_DIR = path.join(__dirname, 'snaps');
const DEBUG_DIR = path.join(SNAPS_DIR, 'debug');

if (!fs.existsSync(SNAPS_DIR)) fs.mkdirSync(SNAPS_DIR, { recursive: true });
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// --- STATE ---
let matchHistory = [];
if (fs.existsSync(HISTORY_FILE)) {
    try { matchHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
    catch (e) { console.error('Error cargando historial:', e); }
}

const processSnap = async (imagePath) => {
    console.log('👁️ Vision Engine: Ejecutando Ingesta con VLM Local (LM Studio)...');

    try {
        // 1. EJECUTAR EL PIPELINE DE VISIÓN PYTHON
        const pythonScript = path.join(SNAPS_DIR, 'ocr.py');
        await execAsync(`python "${pythonScript}" "${imagePath}"`);

        // 2. LEER Y ALMACENAR EL RAW DATA
        const txtPath = imagePath.replace(/\.(jpg|jpeg|png)$/i, '.txt');
        if (!fs.existsSync(txtPath)) throw new Error(`El modelo falló al generar: ${txtPath}`);

        const text = fs.readFileSync(txtPath, 'utf8');
        const rawTextPath = path.join(DEBUG_DIR, `raw_ocr_output_${Date.now()}.txt`);
        fs.writeFileSync(rawTextPath, text);
        console.log(`📄 Texto procesado. Aplicando reglas de normalización...`);

        // --- 3. EXTRACCIÓN GLOBAL (Placement y Kills) ---
        // VLM respeta los saltos de línea, buscamos PLACED \n #X o PLACED #X
        let placementMatch = text.match(/PLACED\s*[\r\n]+\s*#\s*(\d{1,2})/i);
        if (!placementMatch) placementMatch = text.match(/PLACED\s*#\s*(\d{1,2})/i);
        const placement = placementMatch ? placementMatch[1] : "??";

        const totalKillsMatch = text.match(/(?:TOTAL KILLS|KILLS WITH SQUAD)\s*(\d+)/i);
        const totalKillsHeader = totalKillsMatch ? totalKillsMatch[1] : "0";

        // --- PREPARACIÓN DE CONTEXTO ---
        const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0);
        const withSquadIdx = lines.findIndex(l => l.match(/WITH SQUAD/i));
        const firstKillsIdx = lines.findIndex(l => l.match(/Kills\s*\/\s*Assists/i));
        const firstDamageIdx = lines.findIndex(l => l.match(/Damage Dealt/i));

        // --- 4. EXTRACCIÓN DE NOMBRES (Heurística de Longitud) ---
        let playerNames = ["Legend 1", "Legend 2", "Legend 3"];

        if (withSquadIdx !== -1 && firstKillsIdx !== -1 && firstKillsIdx > withSquadIdx) {
            let candidatesBlock = lines.slice(withSquadIdx + 1, firstKillsIdx);

            // Filtramos basura visual de 1 dígito o caracteres sueltos (como "WN" no se filtra si > 1)
            let indexedCandidates = candidatesBlock
                .map((txt, index) => ({ text: txt, index }))
                .filter(obj => !/^\d+\)?$/.test(obj.text) && obj.text.length > 1);

            let top3Longest = indexedCandidates
                .sort((a, b) => b.text.length - a.text.length)
                .slice(0, 3)
                .sort((a, b) => a.index - b.index); // Re-ordenamos espacialmente

            if (top3Longest.length === 3) {
                playerNames = top3Longest.map(obj => obj.text);
            } else if (top3Longest.length > 0) {
                top3Longest.forEach((obj, i) => playerNames[i] = obj.text);
            }
        }

        // --- 5. EXTRACCIÓN Y SANITIZACIÓN DE K/A/K ---
        let kakLines = [];
        if (firstKillsIdx !== -1 && firstDamageIdx !== -1) {
            for (let i = firstKillsIdx + 1; i < firstDamageIdx; i++) {
                let cleanLine = lines[i].replace(/[^\d/]/g, '');
                // Captura "1/11", "6/0/7", "0/4/0" limpiamente
                if ((cleanLine.includes('/') && /\d/.test(cleanLine)) || cleanLine.length >= 3) {
                    kakLines.push(cleanLine);
                }
            }
        }

        if (kakLines.length > 3) kakLines = kakLines.slice(-3);
        while (kakLines.length < 3) kakLines.push('0/0/0');

        // Función Limpiadora Optimizada
        const parseKAK = (raw) => {
            let clean = raw.replace(/[^\d/]/g, '');
            if (clean === '1711') return ['1', '1', '1']; // Alucinación común de VLM

            let parts = clean.split('/');

            // Filtro de sietes falsos (ej. 74 -> 4)
            let fixedParts = parts.map(p => {
                if (p.length >= 2 && parseInt(p) >= 60 && p.startsWith('7')) return p.substring(1);
                return p;
            }).filter(p => p !== '');

            let finalParts = [];

            // Separador de bloques pegados (ej. "1/11" -> [1,1,1] o "2/414" -> [2,4,4])
            if (fixedParts.length === 2) {
                if (fixedParts[1].length === 3 && fixedParts[1][1] === '1') {
                    finalParts = [fixedParts[0], fixedParts[1][0], fixedParts[1][2]];
                } else if (fixedParts[1].length === 2) {
                    finalParts = [fixedParts[0], fixedParts[1][0], fixedParts[1][1]];
                } else if (fixedParts[0].length === 2) {
                    finalParts = [fixedParts[0][0], fixedParts[0][1], fixedParts[1]];
                } else {
                    finalParts = fixedParts;
                }
            } else {
                finalParts = [...fixedParts];
            }

            while (finalParts.length < 3) finalParts.push('0');
            return [finalParts[0] || '0', finalParts[1] || '0', finalParts[2] || '0'];
        };

        const parsedKAKs = kakLines.map(parseKAK);

        // --- 6. EXTRACCIÓN DE DAÑO (Búsqueda Ascendente) ---
        let damageValues = ['0', '0', '0'];
        for (let i = lines.length - 1; i >= 0; i--) {
            // Buscamos el ÚLTIMO "Damage Dealt" y leemos los 3 números debajo
            if (lines[i].match(/Damage Dealt/i)) {
                let numbersFound = [];
                for (let j = i + 1; j < lines.length && numbersFound.length < 3; j++) {
                    let num = lines[j].replace(/\D/g, '');
                    if (num.length > 0) numbersFound.push(num);
                }
                if (numbersFound.length === 3) damageValues = numbersFound;
                break;
            }
        }

        // --- 7. DICCIONARIO DE AUTOCOMPLETADO (Antitruncamiento) ---
        const sanitizeName = (rawName) => {
            if (!rawName) return "??";
            const lower = rawName.toLowerCase().trim();

            if (lower.startsWith('[sl] ray')) return '[SL] RayMalubi';
            if (lower.startsWith('el amigable')) return 'El amigable tio Pencil';
            if (lower.startsWith('invisibl')) return 'Invisible Drax';
            if (lower.startsWith('ramo') || lower.startsWith('ram0')) return 'ramOn';
            if (lower.startsWith('webbe')) return 'webber';
            if (lower.startsWith('lt. col')) return 'Lt. Col. Syyid Al-Massad [Bot]';
            if (lower.startsWith('bewater')) return 'BeWaterMyFriend';

            return rawName;
        };

        // --- 8. ENSAMBLE FINAL ---
        const squad = [];
        for (let i = 0; i < 3; i++) {
            squad.push({
                name: sanitizeName(playerNames[i]),
                kills: parsedKAKs[i] ? parsedKAKs[i][0] : '0',
                assists: parsedKAKs[i] ? parsedKAKs[i][1] : '0',
                knocks: parsedKAKs[i] ? parsedKAKs[i][2] : '0',
                damage: damageValues[i]
            });
        }

        const calculatedTotalKills = squad.reduce((sum, p) => sum + (parseInt(p.kills) || 0), 0).toString();
        const calculatedTotalDamage = squad.reduce((sum, p) => sum + (parseInt(p.damage) || 0), 0).toString();

        const snapshot = {
            timestamp: new Date().toISOString(),
            image: path.basename(imagePath),
            rawText: text,
            results: {
                placement: placement,
                totalKills: calculatedTotalKills,
                totalDamage: calculatedTotalDamage
            },
            squad: squad
        };

        matchHistory.unshift(snapshot);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(matchHistory.slice(0, 50), null, 2));

        // --- DASHBOARD DE TERMINAL ---
        console.log('\n======================================================');
        console.log(`🏆 RESUMEN DE PARTIDA | Puesto: #${snapshot.results.placement}`);
        console.log(`💀 Kills Totales: ${snapshot.results.totalKills}`);
        console.log(`💥 Daño Total: ${snapshot.results.totalDamage}`);
        console.log('------------------------------------------------------');
        console.table(squad);
        console.log('======================================================\n');

    } catch (err) {
        console.error('❌ Error en Vision Engine:', err);
    }
};

const takeSnap = async () => {
    const filepath = path.join(SNAPS_DIR, `match_${Date.now()}.jpg`);
    try {
        console.log('📸 Capturando pantalla...');
        await screenshot({ filename: filepath });
        await processSnap(filepath);
    } catch (err) { console.error('Error al capturar:', err); }
};

// --- LISTENERS ---
uIOhook.on('keydown', (e) => {
    if (e.keycode === UiohookKey.F10) takeSnap();
});
uIOhook.start();

// --- SERVIDOR EXPRESS ---
const app = express();
app.use(cors());
app.use('/snaps', express.static(SNAPS_DIR));

app.get('/status', (req, res) => res.json({ online: true, status: "online", matches: matchHistory.length }));
app.get('/history', (req, res) => res.json(matchHistory));
app.get('/', (req, res) => res.send("Apex Tracker Backend is Running"));

app.listen(API_PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Backend en http://localhost:${API_PORT}`);
});

const wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' });

wss.on('connection', (ws) => {
    console.log('🔌 Simulator conectado al WebSocket');
    ws.on('message', (data) => {
        console.log('📥 Datos recibidos del simulador');
    });
});