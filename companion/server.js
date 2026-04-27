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
        console.log(`📄 Texto procesado. Aplicando reglas secuenciales...`);

        // --- 3. EXTRACCIÓN GLOBAL (Placement y Kills) ---
        // Soporta "SQUAD PLACED #7" o "PLACED 7"
        let placementMatch = text.match(/PLACED\s*#?\s*(\d{1,2})/i);
        const placement = placementMatch ? placementMatch[1] : "??";

        const totalKillsMatch = text.match(/(?:TOTAL KILLS|KILLS WITH SQUAD)\s*(\d+)/i);
        const totalKillsHeader = totalKillsMatch ? totalKillsMatch[1] : "0";

        // --- 4. EXTRACCIÓN SECUENCIAL (VLM Mode) ---
        const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0);
        let rawPlayers = [];

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].match(/Kills\s*\/\s*Assists/i)) {

                let nameCandidate = i > 0 ? lines[i - 1] : "Legend";
                if (nameCandidate.match(/TOTAL KILLS|SQUAD|PLACED/i) || nameCandidate.length <= 1) {
                    nameCandidate = i > 1 ? lines[i - 2] : "Legend";
                }

                // Función interna para extraer el valor de la línea actual o la siguiente
                const getVal = (currIdx) => {
                    const line = lines[currIdx];
                    if (line.includes(':')) {
                        const parts = line.split(':');
                        const after = parts.slice(1).join(':').trim();
                        if (after.length > 0) return after;
                    }
                    return currIdx + 1 < lines.length ? lines[currIdx + 1] : "";
                };

                let kakCandidate = getVal(i);

                let damageCandidate = "0";
                let survivalCandidate = "0:00";
                let revivesCandidate = "0";
                let respawnsCandidate = "0";

                for (let j = i; j < Math.min(i + 15, lines.length); j++) {
                    if (lines[j].match(/Damage Dealt/i)) {
                        damageCandidate = getVal(j);
                    }
                    if (lines[j].match(/Survival Time/i)) {
                        survivalCandidate = getVal(j);
                    }
                    if (lines[j].match(/Revive Given/i)) {
                        revivesCandidate = getVal(j);
                    }
                    if (lines[j].match(/Respawn Given/i)) {
                        respawnsCandidate = getVal(j);
                        break; 
                    }
                }

                rawPlayers.push({
                    rawName: nameCandidate,
                    rawKak: kakCandidate,
                    rawDamage: damageCandidate.replace(/\D/g, ''),
                    rawSurvival: survivalCandidate.replace(/[^\d:]/g, ''),
                    rawRevives: revivesCandidate.replace(/\D/g, ''),
                    rawRespawns: respawnsCandidate.replace(/\D/g, '')
                });
            }
        }

        // Aseguramos tener 3 jugadores (rellenamos si faltan)
        if (rawPlayers.length > 3) rawPlayers = rawPlayers.slice(0, 3);
        while (rawPlayers.length < 3) rawPlayers.push({ rawName: "Legend", rawKak: "0/0/0", rawDamage: "0" });


        // --- 5. SANITIZACIÓN DE DATOS ---

        // Función Limpiadora de KAK (Idéntica y robusta)
        const parseKAK = (raw) => {
            let clean = raw.replace(/[^\d/]/g, '');
            if (clean === '1711') return ['1', '1', '1'];

            let parts = clean.split('/');
            let fixedParts = parts.map(p => {
                if (p.length >= 2 && parseInt(p) >= 60 && p.startsWith('7')) return p.substring(1);
                return p;
            }).filter(p => p !== '');

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

        // Diccionario de Autocompletado (Antitruncamiento)
        const sanitizeName = (rawName) => {
            if (!rawName) return "??";
            // Eliminamos asteriscos y hashtags que a veces pone el modelo de lenguaje
            let clean = rawName.replace(/[\*#]/g, '').trim();
            const lower = clean.toLowerCase();

            if (lower.startsWith('[sl] ray')) return '[SL] RayMalubi';
            if (lower.startsWith('el amigable')) return 'El amigable tio Pencil';
            if (lower.startsWith('invisibl') || lower.startsWith('jnioms')) return 'Invisible Drax';
            if (lower.startsWith('ramo') || lower.startsWith('ram0')) return 'ramOn';
            if (lower.startsWith('webbe')) return 'webber';
            if (lower.startsWith('mrkryst')) return 'MrKrysteen';
            if (lower.startsWith('lt. col')) return 'Lt. Col. Syyid Al-Massad [Bot]';
            if (lower.startsWith('bewater')) return 'BeWaterMyFriend';

            return clean;
        };

        // --- 6. ENSAMBLE FINAL ---
        const squad = rawPlayers.map(p => {
            const cleanKak = parseKAK(p.rawKak);
            return {
                name: sanitizeName(p.rawName),
                kills: cleanKak[0],
                assists: cleanKak[1],
                knocks: cleanKak[2],
                damage: p.rawDamage || '0',
                survivalTime: p.rawSurvival || '0:00', // Nuevo
                revives: p.rawRevives || '0',          // Nuevo
                respawns: p.rawRespawns || '0'         // Nuevo
            };
        });

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
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(matchHistory, null, 2));

        // --- DASHBOARD DE TERMINAL ---
        console.log('\n======================================================');
        console.log(`🏆 RESUMEN DE PARTIDA | Puesto: #${snapshot.results.placement}`);
        console.log(`💀 Kills Totales: ${snapshot.results.totalKills}`);
        console.log(`💥 Daño Total: ${snapshot.results.totalDamage}`);
        console.log('------------------------------------------------------');
        console.table(squad);
        console.log('======================================================\n');

        // --- AUTO-DEPLOY TO GITHUB ---
        console.log('☁️  Sincronizando con GitHub (Public Data sin imágenes)...');
        try {
            const projectRoot = path.join(__dirname, '..');
            await execAsync('git add companion/history.json', { cwd: projectRoot });
            await execAsync('git commit -m "Auto-update match history"', { cwd: projectRoot });
            await execAsync('git push', { cwd: projectRoot });
            console.log('✅ Sincronización exitosa.');
        } catch (gitErr) {
            console.log('⚠️  Aviso: No se pudo subir a GitHub automáticamente. (Si no configuraste el repo aún, ignora esto).');
        }

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