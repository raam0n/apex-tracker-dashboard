const API_KEY = import.meta.env.VITE_APEX_API_KEY;
const UID = '76561198074278912';
const PLATFORM = import.meta.env.VITE_APEX_PLATFORM;
const LOCAL_API = import.meta.env.VITE_LOCAL_API_URL; // Nuestra nueva variable

// Función original (Datos globales de la nube)
export const fetchPlayerData = async () => {
  try {
    const response = await fetch(`https://api.mozambiquehe.re/bridge?auth=${API_KEY}&uid=${UID}&platform=${PLATFORM}`);
    if (!response.ok) throw new Error('Failed to fetch player data');
    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
};

// NUEVA FUNCIÓN: Trae tus capturas de F10
export const fetchLocalHistory = async () => {
  try {
    const response = await fetch(`${LOCAL_API}/history`);
    if (!response.ok) throw new Error('Local Companion Offline');
    return await response.json();
  } catch (error) {
    console.error('Companion Error:', error);
    return []; // Devolvemos array vacío si el script de Node no está corriendo
  }
};