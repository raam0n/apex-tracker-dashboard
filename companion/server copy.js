import { WebSocketServer } from 'ws';
import protobuf from 'protobufjs';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import screenshot from 'screenshot-desktop';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { Jimp } from 'jimp';
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
    console.log('👁️ Vision Engine: Ejecutando OCR con LM Studio...');
    
    try {
        // 1. EJECUTAR EL SCRIPT DE PYTHON
        const pythonScript = path.join(SNAPS_DIR, 'ocr.py');
        console.log(`🏃 Ejecutando: python "${pythonScript}" "${imagePath}"`);
        
        await execAsync(`python "${pythonScript}" "${imagePath}"`);

        // 2. LEER EL ARCHIVO TXT GENERADO
        const txtPath = imagePath.replace(/\.(jpg|jpeg|png)$/i, '.txt');
        
        if (!fs.existsSync(txtPath)) {
            throw new Error(`No se encontró el archivo de texto generado: ${txtPath}`);
        }

        const text = fs.readFileSync(txtPath, 'utf8');
        console.log(`📄 OCR completado. Procesando texto...`);

        // Guardar copia en debug por si acaso
        const rawTextPath = path.join(DEBUG_DIR, `raw_ocr_output_${Date.now()}.txt`);
        fs.writeFileSync(rawTextPath, text);

        // --- EXTRACCIÓN DE PLACEMENT ---
        const placementPattern = /PLACED\s*#\s*(\d{1,2})/i;
        let placementMatch = text.match(placementPattern);
        const placement = placementMatch ? placementMatch[1] : "??";

        const totalKillsMatch = text.match(/(?:TOTAL KILLS|KILLS WITH SQUAD)\s*(\d+)/i);
        const totalKillsHeader = totalKillsMatch ? totalKillsMatch[1] : "0";

        // --- PREPARACIÓN DE ÍNDICES ---
        const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0);

        const withSquadIdx = lines.findIndex(l => l.match(/WITH SQUAD/i));
        const firstKillsIdx = lines.findIndex(l => l.match(/Kills\s*\/\s*Assists/i));
        const firstDamageIdx = lines.findIndex(l => l.match(/Damage Dealt/i));

        // --- EXTRACCIÓN DE NOMBRES ---
        let playerNames = ["Legend 1", "Legend 2", "Legend 3"];

        if (withSquadIdx !== -1 && firstKillsIdx !== -1 && firstKillsIdx > withSquadIdx) {
            let candidatesBlock = lines.slice(withSquadIdx + 1, firstKillsIdx);
            let indexedCandidates = candidatesBlock
                .map((txt, index) => ({ text: txt, index }))
                .filter(obj => !/^\d+\)?$/.test(obj.text) && obj.text.length > 1);

            let top3Longest = indexedCandidates
                .sort((a, b) => b.text.length - a.text.length)
                .slice(0, 3);

            top3Longest.sort((a, b) => a.index - b.index);

            if (top3Longest.length === 3) {
                playerNames = top3Longest.map(obj => obj.text);
            } else if (top3Longest.length > 0) {
                top3Longest.forEach((obj, i) => playerNames[i] = obj.text);
            }
        }

        // --- EXTRACCIÓN DE K/A/K ---
        let kakLines = [];
        if (firstKillsIdx !== -1 && firstDamageIdx !== -1) {
            for (let i = firstKillsIdx + 1; i < firstDamageIdx; i++) {
                let cleanLine = lines[i].replace(/[^\d/]/g, '');
                if ((cleanLine.includes('/') && /\d/.test(cleanLine)) || cleanLine.length >= 3) {
                    kakLines.push(cleanLine);
                }
            }
        }

        if (kakLines.length > 3) kakLines = kakLines.slice(-3);
        while (kakLines.length < 3) kakLines.push('0/0/0');

        const parseKAK = (raw) => {
            let clean = raw.replace(/[^\d/]/g, '');
            if (clean === '1711') return ['1', '1', '1'];
            let parts = clean.split('/');
            let fixedParts = [];
            for (let p of parts) {
                if (p.length >= 2 && parseInt(p) >= 60 && p.startsWith('7')) {
                    fixedParts.push(p.substring(1));
                } else if (p !== '') {
                    fixedParts.push(p);
                }
            }
            let finalParts = [];
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

        // --- EXTRACCIÓN DE DAÑO ---
        let damageValues = ['0', '0', '0'];
        for (let i = lines.length - 1; i >= 0; i--) {
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

        console.log('\n======================================================');
        console.log(`🏆 RESUMEN DE PARTIDA | Puesto: #${snapshot.results.placement}`);
        console.log(`💀 Kills Totales de la Squad: ${snapshot.results.totalKills}`);
        console.log(`💥 Daño Total de la Squad: ${snapshot.results.totalDamage}`);
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
    } catch (err) { console.error('Error:', err); }
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

// Escuchando en 0.0.0.0
app.listen(API_PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Backend en http://localhost:${API_PORT}`);
});

const wss = new WebSocketServer({
    port: WS_PORT,
    host: '0.0.0.0'
});

wss.on('connection', (ws) => {
    console.log('🔌 Simulator conectado al WebSocket');
    ws.on('message', (data) => {
        console.log('📥 Datos recibidos del simulador');
    });
});