import { WebSocket } from 'ws';
import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, 'events_fixed.proto');

async function runSimulator() {
  console.log('🚀 Loading Protobuf for simulation...');
  const root = await protobuf.load(PROTO_PATH);
  const LiveAPIEvent = root.lookupType("LiveAPIEvent");
  const MatchSetup = root.lookupType("MatchSetup");
  const MatchStateEnd = root.lookupType("MatchStateEnd");

  const ws = new WebSocket('ws://localhost:7777');

  ws.on('open', () => {
    console.log('📡 Connected to Companion Server');

    // 1. Send Match Setup
    const setupData = {
      timestamp: Date.now(),
      map: 'Broken Moon',
      squad: [{ name: 'ram0n' }, { name: 'Aceu' }, { name: 'ImperialHal' }]
    };
    
    const setupBuffer = MatchSetup.encode(setupData).finish();
    const setupEnvelope = LiveAPIEvent.encode({
      gameMessage: {
        type_url: 'type.googleapis.com/MatchSetup',
        value: setupBuffer
      }
    }).finish();

    console.log('📤 Sending Simulated Match Setup...');
    ws.send(setupEnvelope);

  setTimeout(() => {
    // 2. Send Squad Eliminated (The real "End Snap" event)
    const resultData = {
      timestamp: Date.now(),
      players: [{ name: 'Aceu' }, { name: 'ImperialHal' }, { name: 'ram0n' }],
      placement: 1
    };

    const resultBuffer = root.lookupType("SquadEliminated").encode(resultData).finish();
    const resultEnvelope = LiveAPIEvent.encode({
      gameMessage: {
        type_url: 'type.googleapis.com/SquadEliminated',
        value: resultBuffer
      }
    }).finish();

    console.log('📤 Sending Simulated Squad Eliminated (Match End)...');
    ws.send(resultEnvelope);
    console.log('✅ Simulation Complete!');
    ws.close();
  }, 3000);
  });
}

runSimulator().catch(console.error);
