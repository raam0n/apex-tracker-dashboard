import { useState, useEffect, useRef, useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell, PieChart, Pie } from 'recharts';

import { fetchPlayerData } from './api'
import { fetchLiveStatus, fetchMatchHistory, getBaseUrl } from './LiveService'
import './index.css'


// --- HELPERS DE MATEMÁTICA ---
const timeToSeconds = (timeStr) => {
  if (!timeStr) return 0;
  const parts = timeStr.split(':');
  if (parts.length !== 2) return 0;
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
};

const secondsToTime = (totalSec) => {
  if (isNaN(totalSec)) return "0:00";
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// --- DATA NORMALIZATION ENGINE ---
const normalizeSquad = (originalSquad) => {
  let pool = [...(originalSquad || [])];
  const isMe = (name) => name.toLowerCase().includes('ram0n') || name.toLowerCase().includes('ramon');
  const isFriend = (name) => {
    const friends = ["el amigable tio pencil", "invisible drax", "[sl] raymalubi", "[sl] raybalubi", "webber", "mrkrysteen", "lt. col. syyid al-massad [bot]", "bewatermyfriend"];
    return friends.some(f => name.toLowerCase().includes(f));
  };

  let me = null, friendsList = [], randomsList = [];
  pool.forEach(p => {
    if (isMe(p.name)) me = p;
    else if (isFriend(p.name)) friendsList.push(p);
    else randomsList.push(p);
  });

  const baseStats = { kills: 0, assists: 0, knocks: 0, damage: 0, survivalTime: "0:00", revives: 0, respawns: 0 };
  if (!me && randomsList.length > 0) { me = randomsList.shift(); me.name = "ram0n"; }
  else if (!me) { me = { name: "ram0n", ...baseStats }; }

  let p2 = friendsList.length > 0 ? friendsList.shift() : randomsList.shift();
  if (p2 && !isFriend(p2.name) && !isMe(p2.name)) p2.name = "Random 1";

  let p3 = friendsList.length > 0 ? friendsList.shift() : randomsList.shift();
  if (p3 && !isFriend(p3.name) && !isMe(p3.name)) { p3.name = p2?.name === "Random 1" ? "Random 2" : "Random 1"; }

  return [{ ...baseStats, ...me }, { ...baseStats, ...(p2 || { name: '-' }) }, { ...baseStats, ...(p3 || { name: '-' }) }];
};

// --- AGGREGATION ENGINES ---
const calculateIndividualStats = (history) => {
  const statsMap = {};
  history.forEach(match => {
    const p = parseInt(match.results?.placement) || 0;
    normalizeSquad(match.squad).forEach(player => {
      let key = player.name;
      if (key.startsWith('Random')) key = 'Randoms';
      if (key === '-') return;
      if (!statsMap[key]) {
        statsMap[key] = { name: key, matches: 0, total: { k: 0, a: 0, kn: 0, d: 0, rev: 0, res: 0, survSecs: 0 }, max: { k: 0, a: 0, kn: 0, d: 0, rev: 0, res: 0, survSecs: 0 }, placement: { total: 0, validMatches: 0 } };
      }
      const k = parseInt(player.kills) || 0, a = parseInt(player.assists) || 0, kn = parseInt(player.knocks) || 0, d = parseInt(player.damage) || 0, rev = parseInt(player.revives) || 0, res = parseInt(player.respawns) || 0, survSecs = timeToSeconds(player.survivalTime);
      const s = statsMap[key];
      s.matches += 1;
      s.total.k += k; s.total.a += a; s.total.kn += kn; s.total.d += d; s.total.rev += rev; s.total.res += res; s.total.survSecs += survSecs;
      s.max.k = Math.max(s.max.k, k); s.max.a = Math.max(s.max.a, a); s.max.kn = Math.max(s.max.kn, kn); s.max.d = Math.max(s.max.d, d); s.max.rev = Math.max(s.max.rev, rev); s.max.res = Math.max(s.max.res, res); s.max.survSecs = Math.max(s.max.survSecs, survSecs);
      
      if (p > 0) {
        s.placement.total += p;
        s.placement.validMatches += 1;
      }
    });
  });
  return Object.values(statsMap).map(s => ({ ...s, avgPlacement: s.placement.validMatches > 0 ? (s.placement.total / s.placement.validMatches).toFixed(1) : '-', avg: { k: (s.total.k / s.matches).toFixed(1), a: (s.total.a / s.matches).toFixed(1), kn: (s.total.kn / s.matches).toFixed(1), d: Math.round(s.total.d / s.matches), rev: (s.total.rev / s.matches).toFixed(1), res: (s.total.res / s.matches).toFixed(1), surv: secondsToTime(s.total.survSecs / s.matches) }, displayMax: { ...s.max, surv: secondsToTime(s.max.survSecs) }, displayTotal: { ...s.total, surv: secondsToTime(s.total.survSecs) } })).sort((a, b) => a.name === 'ram0n' ? -1 : b.name === 'ram0n' ? 1 : a.name === 'Randoms' ? 1 : b.name === 'Randoms' ? -1 : b.matches - a.matches);
};

// NUEVA LÓGICA DE GRUPO POR ITERACIÓN
const calculateGroupStats = (history) => {
  if (history.length === 0) return [];
  const squadMap = {};

  history.forEach(match => {
    const normalized = normalizeSquad(match.squad);

    // 1. Filtramos vacíos y ordenamos los nombres alfabéticamente para crear una clave única
    const validNames = normalized.filter(p => p.name !== '-').map(p => p.name);
    const squadKey = [...validNames].sort().join(' + ');

    if (!squadMap[squadKey]) {
      squadMap[squadKey] = {
        key: squadKey,
        matches: 0,
        kills: { total: 0, max: 0 },
        placement: { total: 0, best: 99, worst: 0, validMatches: 0 }
      };
    }

    const s = squadMap[squadKey];
    s.matches += 1;

    const k = parseInt(match.results.totalKills) || 0;
    const p = parseInt(match.results.placement) || 0;

    s.kills.total += k;
    s.kills.max = Math.max(s.kills.max, k);

    if (p > 0) {
      s.placement.total += p;
      s.placement.best = Math.min(s.placement.best, p);
      s.placement.worst = Math.max(s.placement.worst, p);
      s.placement.validMatches += 1;
    }
  });

  return Object.values(squadMap).map(s => ({
    ...s,
    kills: { ...s.kills, avg: (s.kills.total / s.matches).toFixed(1) },
    placement: {
      ...s.placement,
      avg: s.placement.validMatches > 0 ? (s.placement.total / s.placement.validMatches).toFixed(1) : '-',
      best: s.placement.best === 99 ? '-' : s.placement.best,
      worst: s.placement.worst === 0 ? '-' : s.placement.worst
    }
  })).sort((a, b) => b.matches - a.matches); // Ordenamos de más jugadas a menos jugadas
};

// --- ANALYTICS ENGINE ---
const calculateAnalytics = (history) => {
  if (!history || history.length === 0) return null;

  // 1. Invertimos para que el gráfico vaya de viejo a nuevo
  const chronicle = [...history].reverse();

  // --- Tendencia Temporal (Por Partida) ---
  const matchTrend = chronicle.map((m, i) => ({
    index: i + 1,
    date: new Date(m.timestamp).toLocaleDateString(),
    damage: parseInt(m.results?.totalDamage) || 0,
    kills: parseInt(m.results?.totalKills) || 0,
    placement: parseInt(m.results?.placement) || 20,
    timestamp: new Date(m.timestamp).getTime()
  }));

  // --- Agrupación por Día de la Semana ---
  const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const dayMap = {};
  dayNames.forEach(d => dayMap[d] = { day: d, damage: 0, count: 0 });

  chronicle.forEach(m => {
    const d = dayNames[new Date(m.timestamp).getDay()];
    dayMap[d].damage += parseInt(m.results?.totalDamage) || 0;
    dayMap[d].count += 1;
  });
  const dayStats = dayNames.map(d => ({
    name: d,
    avgDamage: dayMap[d].count > 0 ? Math.round(dayMap[d].damage / dayMap[d].count) : 0,
    count: dayMap[d].count
  }));

  // --- Agrupación por Hora (Heatmap de rendimiento) ---
  const hourMap = {};
  for(let i=0; i<24; i++) hourMap[i] = { hour: `${i}h`, damage: 0, count: 0 };
  
  chronicle.forEach(m => {
    const h = new Date(m.timestamp).getHours();
    hourMap[h].damage += parseInt(m.results?.totalDamage) || 0;
    hourMap[h].count += 1;
  });
  const hourlyStats = Object.values(hourMap).filter(h => h.count > 0);

  // --- Promedios Móviles (Suavizado) ---
  const windowSize = 10;
  const movingAverages = matchTrend.map((m, i) => {
    const start = Math.max(0, i - windowSize + 1);
    const window = matchTrend.slice(start, i + 1);
    return {
      index: m.index,
      avgDamage: Math.round(window.reduce((s, x) => s + x.damage, 0) / window.length),
      avgKills: (window.reduce((s, x) => s + x.kills, 0) / window.length).toFixed(1),
      avgPlacement: (window.reduce((s, x) => s + x.placement, 0) / window.length).toFixed(1)
    };
  });

  return { matchTrend, dayStats, hourlyStats, movingAverages };
};

// --- BREAKDOWN ENGINE ---
const calculateBreakdown = (history, targetPlayer) => {
  if (!history || history.length === 0) return null;

  const damageMap = {};
  const killsMap = {};
  const placementMap = {};
  let totalMatchesForPlayer = 0;

  history.forEach(match => {
    const normalized = normalizeSquad(match.squad);
    
    // Si buscamos "Randoms", consolidamos los stats de cualquier jugador que sea Random 1 o Random 2
    let playerStats = null;
    if (targetPlayer === 'Randoms') {
      const randoms = normalized.filter(p => p.name.startsWith('Random'));
      if (randoms.length > 0) {
        // Para Randoms, sumamos sus stats si hay más de uno? 
        // O mejor: contamos cada random como una "instancia" de performance.
        // Pero el user quiere "cantidad de partidas". Así que si hay 2 randoms en una partida,
        // tal vez deberíamos promediar o simplemente tomar el primero.
        // Vamos a tomar el primero para mantener la coherencia de "1 match = 1 data point".
        playerStats = randoms[0];
      }
    } else {
      playerStats = normalized.find(p => p.name === targetPlayer);
    }

    if (playerStats && playerStats.name !== '-') {
      totalMatchesForPlayer++;
      const damage = parseInt(playerStats.damage) || 0;
      const kills = parseInt(playerStats.kills) || 0;
      const placement = parseInt(match.results?.placement) || 0;

      // Damage Bins (100)
      const dBin = Math.floor(damage / 100) * 100;
      damageMap[dBin] = (damageMap[dBin] || 0) + 1;

      // Kills Bins
      killsMap[kills] = (killsMap[kills] || 0) + 1;

      // Placement Bins
      if (placement > 0 && placement <= 20) {
        placementMap[placement] = (placementMap[placement] || 0) + 1;
      }
    }
  });

  // Damage Distribution (Continuous bins)
  const maxD = Math.max(...Object.keys(damageMap).map(Number), 0);
  const damageDistribution = [];
  for (let b = 0; b <= Math.max(maxD, 1000); b += 100) {
    damageDistribution.push({
      range: `${b}`,
      fullRange: `${b}-${b + 99} DMG`,
      count: damageMap[b] || 0,
      color: b >= 1000 ? '#FF4B3A' : b >= 500 ? '#FFB300' : b >= 100 ? '#4dd0e1' : '#555'
    });
  }

  // Kills Distribution
  const maxK = Math.max(...Object.keys(killsMap).map(Number), 0);
  const killsDistribution = [];
  for (let k = 0; k <= Math.max(maxK, 5); k++) {
    killsDistribution.push({
      kills: k.toString(),
      count: killsMap[k] || 0,
      color: k >= 5 ? '#FF4B3A' : k >= 3 ? '#FFB300' : k >= 1 ? '#4CAF50' : '#555'
    });
  }

  // Placement Distribution (Fixed 1-20)
  const placementDistribution = [];
  const placementGroups = {
    winner: { name: 'WINNER (#1)', count: 0, color: '#FFD700' },
    podium: { name: 'PODIUM (#2-3)', count: 0, color: '#C0C0C0' },
    top10: { name: 'TOP 10 (#4-10)', count: 0, color: '#4dd0e1' },
    mid: { name: 'MID (#11-15)', count: 0, color: '#3f51b5' },
    bottom: { name: 'BOTTOM (#16-20)', count: 0, color: '#555' }
  };

  for (let p = 1; p <= 20; p++) {
    const count = placementMap[p] || 0;
    let color = '#555';
    if (p === 1) { 
      color = placementGroups.winner.color; 
      placementGroups.winner.count += count; 
    } else if (p <= 3) { 
      color = placementGroups.podium.color; 
      placementGroups.podium.count += count; 
    } else if (p <= 10) { 
      color = placementGroups.top10.color; 
      placementGroups.top10.count += count; 
    } else if (p <= 15) { 
      color = placementGroups.mid.color; 
      placementGroups.mid.count += count; 
    } else { 
      color = placementGroups.bottom.color; 
      placementGroups.bottom.count += count; 
    }

    placementDistribution.push({
      placement: p.toString(),
      count: count,
      color: color
    });
  }

  const placementPieData = Object.values(placementGroups);

  return { 
    damageDistribution, 
    killsDistribution, 
    placementDistribution, 
    placementPieData,
    totalMatches: totalMatchesForPlayer 
  };
};


function App() {
  const [activeTab, setActiveTab] = useState('global');

  const [selectedBreakdownPlayer, setSelectedBreakdownPlayer] = useState('ram0n');

  const [data, setData] = useState(null);
  const [liveData, setLiveData] = useState({ online: false, activeMatch: false, history: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isFetching = useRef(false);

  useEffect(() => {
    const loadData = async () => {
      if (isFetching.current) return;
      isFetching.current = true;
      try {
        const result = await fetchPlayerData();
        setData(result);
        setError(null);
      } catch (err) { setError(err.message); }
      finally { setLoading(false); isFetching.current = false; }
    }
    loadData();
  }, []);

  useEffect(() => {
    const syncLive = async () => {
      const status = await fetchLiveStatus();
      const history = await fetchMatchHistory();
      setLiveData({ ...status, history });
    }
    syncLive();
    const interval = setInterval(syncLive, 3000);
    return () => clearInterval(interval);
  }, []);

  const analytics = useMemo(() => calculateAnalytics(liveData.history), [liveData.history]);
  const individualStats = useMemo(() => calculateIndividualStats(liveData.history), [liveData.history]);
  const breakdown = useMemo(() => calculateBreakdown(liveData.history, selectedBreakdownPlayer), [liveData.history, selectedBreakdownPlayer]);

  if (loading) return <div className="app-container"><div className="glass-panel" style={{ textAlign: 'center' }}><h2 className="highlight">Loading Apex Data...</h2></div></div>;
  if (error) return <div className="app-container"><div className="glass-panel" style={{ borderLeft: '4px solid #f44336' }}><h2>Error Connecting to API</h2><p>{error}</p></div></div>;

  const { global, total } = data;
  // const individualStats = calculateIndividualStats(liveData.history); // Ya está en useMemo arriba
  const groupStatsList = calculateGroupStats(liveData.history);


  return (
    <div className="app-container">
      {/* Navigation Tabs */}
      <div className="glass-panel" style={{ marginBottom: '2rem', display: 'flex', gap: '3rem', padding: '1rem 2rem' }}>
        <button onClick={() => setActiveTab('global')} className={activeTab === 'global' ? 'tab-btn active' : 'tab-btn'}>CAREER</button>
        <button onClick={() => setActiveTab('log')} className={activeTab === 'log' ? 'tab-btn active' : 'tab-btn'}>LOG</button>
        <button onClick={() => setActiveTab('stats')} className={activeTab === 'stats' ? 'tab-btn active' : 'tab-btn'}>STATS</button>
        <button onClick={() => setActiveTab('analytics')} className={activeTab === 'analytics' ? 'tab-btn active' : 'tab-btn'}>EVOLUTION</button>
        <button onClick={() => setActiveTab('breakdown')} className={activeTab === 'breakdown' ? 'tab-btn active' : 'tab-btn'}>BREAKDOWN</button>
      </div>


      {activeTab === 'global' && (
        <>
          <div className="glass-panel profile-card">
            <div className="rank-badge"><img src={global.rank.rankImg} alt={global.rank.rankName} style={{ width: '100px' }} /></div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
                <h1>{global.name} <span style={{ fontSize: '0.8rem', color: '#888' }}>{global.platform}</span></h1>
              </div>
              <div style={{ display: 'flex', gap: '2rem' }}>
                <div><span className="stat-label">Level</span><div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{global.level}</div></div>
                <div><span className="stat-label">Rank</span><div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{global.rank.rankName}</div></div>
              </div>
            </div>
          </div>
          <div className="stats-grid">
            <div className="glass-panel stat-item"><span className="stat-value highlight">{total.kills.value}</span><span className="stat-label">Total Kills</span></div>
            <div className="glass-panel stat-item"><span className="stat-value">{total.kd.value}</span><span className="stat-label">KD Ratio</span></div>
            <div className="glass-panel stat-item"><span className="stat-value">{total.games_played.value}</span><span className="stat-label">Matches</span></div>
          </div>
        </>
      )}



      {activeTab === 'log' && (
        <div className="glass-panel" style={{ padding: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h2>Structured Match Log</h2>
            <span style={{ color: '#888', fontSize: '0.9rem' }}>{liveData.history.length} Matches Recorded</span>
          </div>
          <div style={{ display: 'flex', padding: '0.5rem 1rem', borderBottom: '1px solid #333', color: '#888', fontSize: '0.8rem', fontWeight: 'bold', letterSpacing: '1px' }}>
            <div style={{ width: '80px' }}>PLACE</div>
            <div style={{ flex: 1 }}>PLAYER 1 (YOU)</div>
            <div style={{ flex: 1 }}>PLAYER 2</div>
            <div style={{ flex: 1 }}>PLAYER 3</div>
            <div style={{ width: '80px', textAlign: 'center' }}>TEAM KILLS</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
            {liveData.history.length === 0 ? <p style={{ color: '#666', marginTop: '1rem' }}>No data available.</p> : (
              liveData.history.map((match, i) => {
                const rowSquad = normalizeSquad(match.squad);
                return (
                  <div key={i} style={{ display: 'flex', backgroundColor: 'rgba(0,0,0,0.2)', padding: '0.8rem 1rem', borderRadius: '4px', alignItems: 'center', transition: 'background 0.2s', borderLeft: match.results?.placement === '1' ? '3px solid #FFD700' : '3px solid transparent' }}>
                    <div style={{ width: '80px', display: 'flex', flexDirection: 'column' }}>
                      <span className="highlight" style={{ fontSize: '1.2rem', fontWeight: 'bold', color: match.results?.placement === '1' ? '#FFD700' : '#ff4b3a' }}>
                        #{match.results?.placement || '?'}
                      </span>
                    </div>
                    <div style={{ flex: 1, display: 'flex', gap: '1rem' }}>
                      {rowSquad.map((p, idx) => (
                        <div key={idx} style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: idx < 2 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                          <span style={{ color: idx === 0 ? '#4CAF50' : '#fff', fontWeight: 'bold', fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '140px' }}>
                            {p.name}
                          </span>
                          <div style={{ color: '#aaa', fontSize: '0.85rem', marginTop: '2px' }}>
                            {p.kills}/{p.assists}/{p.knocks} <span style={{ color: '#555', margin: '0 4px' }}>|</span> <span style={{ color: '#ddd' }}>{p.damage} dmg</span>
                          </div>
                          <div style={{ color: '#888', fontSize: '0.75rem', marginTop: '2px' }}>
                            ⏱️ {p.survivalTime} <span style={{ color: '#555', margin: '0 4px' }}>|</span> 💖 {p.revives} <span style={{ color: '#555', margin: '0 4px' }}>|</span> 🚁 {p.respawns}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ width: '80px', textAlign: 'center', fontWeight: 'bold', fontSize: '1.2rem', color: '#ff4b3a', display: 'flex', alignItems: 'center', justifyContent: 'center', borderLeft: '1px solid rgba(255,255,255,0.05)', marginLeft: '1rem' }}>
                      {match.results?.totalKills || '0'}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      {activeTab === 'stats' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

          {/* SECCIÓN INDIVIDUAL */}
          <div className="glass-panel" style={{ padding: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <h2 style={{ margin: 0 }}>Individual Performance</h2>
            </div>

            <div style={{ backgroundColor: 'rgba(0,0,0,0.3)', padding: '0.5rem 1rem', borderRadius: '4px', marginBottom: '1.5rem', fontSize: '0.8rem', color: '#aaa', display: 'inline-block' }}>
              <strong style={{ color: '#fff' }}>REF:</strong> <span style={{ color: '#fff', marginLeft: '5px' }}>K/A/K</span> = Kills / Assists / Knocks <span style={{ margin: '0 8px', color: '#555' }}>|</span> <span style={{ color: '#fff' }}>DMG</span> = Damage <span style={{ margin: '0 8px', color: '#555' }}>|</span> ⏱️ Survival Time <span style={{ margin: '0 8px', color: '#555' }}>|</span> 💖 Revives <span style={{ margin: '0 8px', color: '#555' }}>|</span> 🚁 Respawns
            </div>

            <div style={{ display: 'flex', padding: '0.5rem 1rem', borderBottom: '1px solid #333', color: '#888', fontSize: '0.8rem', fontWeight: 'bold', letterSpacing: '1px' }}>
              <div style={{ width: '180px' }}>PLAYER</div>
              <div style={{ width: '80px', textAlign: 'center' }}>MATCHES</div>
              <div style={{ width: '100px', textAlign: 'center' }}>AVG PLACE</div>
              <div style={{ flex: 1 }}>AVERAGE (K/A/K - DMG)</div>
              <div style={{ flex: 1 }}>MAXIMUM (K/A/K - DMG)</div>
              <div style={{ flex: 1 }}>TOTALS (K/A/K - DMG)</div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
              {individualStats.length === 0 ? <p style={{ color: '#666', marginTop: '1rem' }}>No data to aggregate.</p> : (
                individualStats.map((stat, i) => (
                  <div key={i} style={{ display: 'flex', backgroundColor: stat.name === 'ram0n' ? 'rgba(76, 175, 80, 0.1)' : 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '4px', alignItems: 'center', borderLeft: stat.name === 'ram0n' ? '3px solid #4CAF50' : stat.name === 'Randoms' ? '3px solid #888' : '3px solid #ff4b3a' }}>

                    <div style={{ width: '180px', fontWeight: 'bold', color: stat.name === 'ram0n' ? '#4CAF50' : stat.name === 'Randoms' ? '#aaa' : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {stat.name}
                    </div>

                    <div style={{ width: '80px', textAlign: 'center', fontWeight: 'bold', fontSize: '1.1rem' }}>
                      {stat.matches}
                    </div>

                    <div style={{ width: '100px', textAlign: 'center', fontWeight: 'bold', fontSize: '1.1rem', color: '#FFD700' }}>
                      #{stat.avgPlacement}
                    </div>

                    <div style={{ flex: 1, color: '#aaa', fontSize: '0.85rem' }}>
                      <div style={{ marginBottom: '2px' }}>
                        <span style={{ color: '#fff' }}>{stat.avg.k}</span>/{stat.avg.a}/{stat.avg.kn} <span style={{ margin: '0 4px', color: '#555' }}>|</span> <span style={{ color: '#4dd0e1', fontWeight: 'bold' }}>{stat.avg.d}</span>
                      </div>
                      <div style={{ color: '#888', fontSize: '0.75rem' }}>
                        ⏱️ {stat.avg.surv} <span style={{ margin: '0 4px', color: '#555' }}>|</span> 💖 {stat.avg.rev} <span style={{ margin: '0 4px', color: '#555' }}>|</span> 🚁 {stat.avg.res}
                      </div>
                    </div>

                    <div style={{ flex: 1, color: '#aaa', fontSize: '0.85rem' }}>
                      <div style={{ marginBottom: '2px' }}>
                        <span style={{ color: '#fff' }}>{stat.displayMax.k}</span>/{stat.displayMax.a}/{stat.displayMax.kn} <span style={{ margin: '0 4px', color: '#555' }}>|</span> <span style={{ color: '#FFD700', fontWeight: 'bold' }}>{stat.displayMax.d}</span>
                      </div>
                      <div style={{ color: '#888', fontSize: '0.75rem' }}>
                        ⏱️ {stat.displayMax.surv} <span style={{ margin: '0 4px', color: '#555' }}>|</span> 💖 {stat.displayMax.rev} <span style={{ margin: '0 4px', color: '#555' }}>|</span> 🚁 {stat.displayMax.res}
                      </div>
                    </div>

                    <div style={{ flex: 1, color: '#aaa', fontSize: '0.85rem' }}>
                      <div style={{ marginBottom: '2px' }}>
                        <span style={{ color: '#fff' }}>{stat.displayTotal.k}</span>/{stat.displayTotal.a}/{stat.displayTotal.kn} <span style={{ margin: '0 4px', color: '#555' }}>|</span> <span style={{ color: '#ff4b3a', fontWeight: 'bold' }}>{stat.displayTotal.d}</span>
                      </div>
                      <div style={{ color: '#888', fontSize: '0.75rem' }}>
                        ⏱️ {stat.displayTotal.surv} <span style={{ margin: '0 4px', color: '#555' }}>|</span> 💖 {stat.displayTotal.rev} <span style={{ margin: '0 4px', color: '#555' }}>|</span> 🚁 {stat.displayTotal.res}
                      </div>
                    </div>

                  </div>
                )))}
            </div>
          </div>

          {/* SECCIÓN: GROUP STATS POR ITERACIÓN */}
          <div className="glass-panel" style={{ padding: '2rem', borderTop: '4px solid #FFD700' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
              <div>
                <h2 style={{ color: '#FFD700', margin: 0 }}>Squad Group Performance</h2>
                <p style={{ color: '#888', fontSize: '0.9rem', marginTop: '5px' }}>Metrics aggregated by unique squad compositions.</p>
              </div>
            </div>

            {groupStatsList.length === 0 ? <p style={{ color: '#666' }}>No group data available.</p> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                {groupStatsList.map((group, idx) => (
                  <div key={idx} style={{
                    paddingBottom: idx === groupStatsList.length - 1 ? '0' : '2rem',
                    borderBottom: idx === groupStatsList.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.05)'
                  }}>

                    {/* Header del Squad Específico */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', backgroundColor: 'rgba(255, 215, 0, 0.05)', padding: '1rem', borderRadius: '6px' }}>
                      <h3 style={{ margin: 0, color: '#fff', fontSize: '1.1rem' }}>{group.key}</h3>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ color: '#888', fontSize: '0.8rem', textTransform: 'uppercase' }}>Matches</span>
                        <div style={{ fontSize: '1.5rem', fontWeight: '900', color: '#FFD700' }}>{group.matches}</div>
                      </div>
                    </div>

                    {/* Grilla de Stats para este Squad */}
                    <div className="stats-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      <div className="glass-panel" style={{ background: 'rgba(0,0,0,0.3)' }}>
                        <h4 style={{ fontSize: '0.8rem', color: '#888', textTransform: 'uppercase', marginBottom: '1rem', marginTop: 0 }}>Placement</h4>
                        <div style={{ display: 'flex', justifyContent: 'space-around' }}>
                          <div style={{ textAlign: 'center' }}>
                            <span className="stat-label">Best</span>
                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#FFD700' }}>#{group.placement.best}</div>
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <span className="stat-label">Average</span>
                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#fff' }}>#{group.placement.avg}</div>
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <span className="stat-label">Worst</span>
                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#555' }}>#{group.placement.worst}</div>
                          </div>
                        </div>
                      </div>

                      <div className="glass-panel" style={{ background: 'rgba(0,0,0,0.3)' }}>
                        <h4 style={{ fontSize: '0.8rem', color: '#888', textTransform: 'uppercase', marginBottom: '1rem', marginTop: 0 }}>Squad Kills</h4>
                        <div style={{ display: 'flex', justifyContent: 'space-around' }}>
                          <div style={{ textAlign: 'center' }}>
                            <span className="stat-label">Total</span>
                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#ff4b3a' }}>{group.kills.total}</div>
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <span className="stat-label">Average</span>
                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#fff' }}>{group.kills.avg}</div>
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <span className="stat-label">Record</span>
                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#4CAF50' }}>{group.kills.max}</div>
                          </div>
                        </div>
                      </div>
                    </div>

                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      )}

      {activeTab === 'analytics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          
          <div className="glass-panel" style={{ padding: '2rem' }}>
            <h2 style={{ marginBottom: '1.5rem', color: '#ff4b3a' }}>Performance Trends (Last {liveData.history.length} matches)</h2>
            <div style={{ height: '400px', width: '100%' }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={analytics?.movingAverages}>
                  <defs>
                    <linearGradient id="colorDamage" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ff4b3a" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#ff4b3a" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                  <XAxis dataKey="index" stroke="#888" label={{ value: 'Matches', position: 'insideBottom', offset: -5, fill: '#888' }} />
                  <YAxis stroke="#888" />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }}
                    itemStyle={{ color: '#fff' }}
                    labelStyle={{ color: '#fff' }}
                  />
                  <Legend />
                  <Area type="monotone" dataKey="avgDamage" name="Avg Damage (Window 10)" stroke="#ff4b3a" strokeWidth={3} fillOpacity={1} fill="url(#colorDamage)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p style={{ color: '#888', fontSize: '0.9rem', marginTop: '1.5rem', lineHeight: '1.5' }}>
              <strong>Promedio Móvil de Daño:</strong> Este gráfico no muestra el daño aislado de cada partida, sino el promedio acumulado de tus <strong>últimas 10 partidas</strong> en cada punto. Esto suaviza los picos de suerte o mala suerte y revela la <em>verdadera tendencia</em> de tu desempeño general. Si la curva sube, significa que te estás volviendo más consistente.
            </p>
          </div>

          <div className="stats-grid" style={{ gridTemplateColumns: '1.5fr 1fr' }}>

            
            <div className="glass-panel" style={{ padding: '2rem' }}>
              <h3 style={{ marginBottom: '1.5rem', fontSize: '1rem', color: '#FFD700' }}>Placement Evolution</h3>
              <div style={{ height: '300px', width: '100%' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={analytics?.matchTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                    <XAxis dataKey="index" stroke="#888" />
                    <YAxis reversed domain={[1, 20]} stroke="#888" ticks={[1, 5, 10, 15, 20]} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }}
                      itemStyle={{ color: '#fff' }}
                      labelStyle={{ color: '#fff' }}
                    />
                    <Line type="stepAfter" dataKey="placement" name="Rank" stroke="#FFD700" strokeWidth={2} dot={{ r: 3, fill: '#FFD700' }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '1rem', lineHeight: '1.4' }}>
                <strong>Posición Final (Placement):</strong> Rastrea en qué lugar quedó el escuadrón. El gráfico está invertido para que <strong>el Top 1 esté en la parte superior</strong>. Te ayuda a visualizar fácilmente tus rachas de victorias y qué tan seguido llegas al Top 5.
              </p>
            </div>

            <div className="glass-panel" style={{ padding: '2rem' }}>
              <h3 style={{ marginBottom: '1.5rem', fontSize: '1rem', color: '#4CAF50' }}>Avg Kills Trend</h3>
              <div style={{ height: '300px', width: '100%' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={analytics?.movingAverages}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                    <XAxis dataKey="index" stroke="#888" />
                    <YAxis stroke="#888" />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }}
                      itemStyle={{ color: '#fff' }}
                      labelStyle={{ color: '#fff' }}
                    />
                    <Line type="monotone" dataKey="avgKills" name="Avg Kills" stroke="#4CAF50" strokeWidth={3} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '1rem', lineHeight: '1.4' }}>
                <strong>Evolución de Bajas:</strong> Al igual que el gráfico de daño, muestra tu promedio de kills (ventana de 10 partidas) para ver si la agresividad letal del equipo está aumentando.
              </p>
            </div>

          </div>


          <div className="stats-grid">
            
            <div className="glass-panel" style={{ padding: '2rem' }}>
              <h3 style={{ marginBottom: '1.5rem', fontSize: '1rem', color: '#4dd0e1' }}>Performance by Day</h3>
              <div style={{ height: '250px', width: '100%' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics?.dayStats}>
                    <XAxis dataKey="name" stroke="#888" />
                    <YAxis stroke="#888" />
                    <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }} itemStyle={{ color: '#fff' }} labelStyle={{ color: '#fff' }} />
                    <Bar dataKey="avgDamage" name="Avg Damage">
                      {analytics?.dayStats.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.avgDamage > 1000 ? '#4CAF50' : entry.avgDamage > 500 ? '#4dd0e1' : '#555'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '1rem', lineHeight: '1.4' }}>
                <strong>Rendimiento por Día:</strong> Calcula tu daño promedio dependiendo del día de la semana. Las barras se iluminan en verde si superas los 1000 de daño. Ideal para saber qué días juegan más concentrados.
              </p>
            </div>

            <div className="glass-panel" style={{ padding: '2rem' }}>
              <h3 style={{ marginBottom: '1.5rem', fontSize: '1rem', color: '#ff4b3a' }}>Peak Hours (Damage)</h3>
              <div style={{ height: '250px', width: '100%' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics?.hourlyStats}>
                    <XAxis dataKey="hour" stroke="#888" />
                    <YAxis stroke="#888" />
                    <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }} itemStyle={{ color: '#fff' }} labelStyle={{ color: '#fff' }} />
                    <Bar dataKey="avgDamage" name="Avg Damage" fill="#ff4b3a" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '1rem', lineHeight: '1.4' }}>
                <strong>Horas Pico:</strong> Agrupa todas tus partidas según la hora del día. Útil para descubrir si rinden mejor por la tarde, en la noche o de madrugada.
              </p>
            </div>

          </div>


        </div>
      )}

      {activeTab === 'breakdown' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          
          <div className="glass-panel" style={{ padding: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
              <div>
                <h2 style={{ color: '#ff4b3a' }}>Game Performance Breakdown</h2>
                <p style={{ color: '#888', margin: 0 }}>Distribution of performance across {liveData.history.length} matches.</p>
              </div>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', background: 'rgba(255,255,255,0.05)', padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)' }}>
                <span style={{ fontSize: '0.8rem', color: '#888', fontWeight: 'bold' }}>FILTER BY PLAYER:</span>
                <select 
                  value={selectedBreakdownPlayer} 
                  onChange={(e) => setSelectedBreakdownPlayer(e.target.value)}
                  style={{ 
                    background: 'none', 
                    border: 'none', 
                    color: '#ff4b3a', 
                    fontWeight: 'bold', 
                    fontSize: '1rem', 
                    outline: 'none',
                    cursor: 'pointer'
                  }}
                >
                  {individualStats.map(s => (
                    <option key={s.name} value={s.name} style={{ background: '#1a1a1a', color: '#fff' }}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>
              
              {/* --- DAMAGE PAIR --- */}
              <div className="glass-panel" style={{ background: 'rgba(0,0,0,0.2)', padding: '2rem' }}>
                <h3 style={{ marginBottom: '2rem', color: '#4dd0e1', fontSize: '1.2rem', borderBottom: '1px solid rgba(77, 208, 225, 0.2)', paddingBottom: '0.5rem' }}>Damage Distribution</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '2rem' }}>
                  <div style={{ height: '350px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={breakdown?.damageDistribution}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                        <XAxis dataKey="range" stroke="#888" />
                        <YAxis stroke="#888" />
                        <Tooltip 
                          contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }}
                          itemStyle={{ color: '#fff' }}
                          labelStyle={{ color: '#fff' }}
                          labelFormatter={(label, payload) => payload[0]?.payload?.fullRange || label}
                        />
                        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                          {breakdown?.damageDistribution.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ height: '350px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={breakdown?.damageDistribution.filter(d => d.count > 0)}
                          dataKey="count"
                          nameKey="fullRange"
                          cx="50%"
                          cy="50%"
                          outerRadius={100}
                          innerRadius={60}
                          paddingAngle={5}
                          label={({ percent }) => `${(percent * 100).toFixed(0)}%`}
                        >
                          {breakdown?.damageDistribution.filter(d => d.count > 0).map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }} itemStyle={{ color: '#fff' }} labelStyle={{ color: '#fff' }} />
                        <Legend verticalAlign="bottom" height={36}/>
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '1.5rem', textAlign: 'center' }}>
                  Data for <strong style={{ color: '#fff' }}>{selectedBreakdownPlayer}</strong> across {breakdown?.totalMatches || 0} matches.
                </p>
              </div>

              {/* --- KILLS PAIR --- */}
              <div className="glass-panel" style={{ background: 'rgba(0,0,0,0.2)', padding: '2rem' }}>
                <h3 style={{ marginBottom: '2rem', color: '#FFB300', fontSize: '1.2rem', borderBottom: '1px solid rgba(255, 179, 0, 0.2)', paddingBottom: '0.5rem' }}>Kills per Match</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '2rem' }}>
                  <div style={{ height: '350px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={breakdown?.killsDistribution}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                        <XAxis dataKey="kills" stroke="#888" />
                        <YAxis stroke="#888" />
                        <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }} itemStyle={{ color: '#fff' }} labelStyle={{ color: '#fff' }} />
                        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                          {breakdown?.killsDistribution.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ height: '350px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={breakdown?.killsDistribution.filter(d => d.count > 0)}
                          dataKey="count"
                          nameKey="kills"
                          cx="50%"
                          cy="50%"
                          outerRadius={100}
                          innerRadius={60}
                          paddingAngle={5}
                          label={({ name, percent }) => `${name} K: ${(percent * 100).toFixed(0)}%`}
                        >
                          {breakdown?.killsDistribution.filter(d => d.count > 0).map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }} itemStyle={{ color: '#fff' }} labelStyle={{ color: '#fff' }} />
                        <Legend verticalAlign="bottom" height={36}/>
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              {/* --- PLACEMENT PAIR --- */}
              <div className="glass-panel" style={{ background: 'rgba(0,0,0,0.2)', padding: '2rem' }}>
                <h3 style={{ marginBottom: '2rem', color: '#FFD700', fontSize: '1.2rem', borderBottom: '1px solid rgba(255, 215, 0, 0.2)', paddingBottom: '0.5rem' }}>Placement Frequency</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '2rem' }}>
                  <div style={{ height: '350px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={breakdown?.placementDistribution}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                        <XAxis dataKey="placement" stroke="#888" interval={0} fontSize={10} />
                        <YAxis stroke="#888" />
                        <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }} itemStyle={{ color: '#fff' }} labelStyle={{ color: '#fff' }} />
                        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                          {breakdown?.placementDistribution.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ height: '350px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={breakdown?.placementPieData.filter(d => d.count > 0)}
                          dataKey="count"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={100}
                          innerRadius={60}
                          paddingAngle={2}
                          label={({ name, percent }) => `${name.split(' ')[0]}: ${(percent * 100).toFixed(0)}%`}
                        >
                          {breakdown?.placementPieData.filter(d => d.count > 0).map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }} itemStyle={{ color: '#fff' }} labelStyle={{ color: '#fff' }} />
                        <Legend verticalAlign="bottom" height={36}/>
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

            </div>
          </div>

        </div>
      )}

    </div>
  )
}


export default App