const COMPANION_URL = 'http://localhost:7778';

export const getBaseUrl = () => {
  if (import.meta.env.PROD) {
    // Reemplaza esto con tu usuario y nombre de repo si no usas variables de entorno.
    return import.meta.env.VITE_GITHUB_RAW_URL || 'https://raw.githubusercontent.com/TU_USUARIO/TU_REPO/main/companion';
  }
  return COMPANION_URL;
};

export const fetchLiveStatus = async () => {
  try {
    if (import.meta.env.PROD) {
       // En Vercel no hay servidor local "Live", así que siempre devolvemos offline
       return { online: false };
    }
    const response = await fetch(`${COMPANION_URL}/status`);
    if (!response.ok) return { online: false };
    return await response.json();
  } catch (error) {
    return { online: false };
  }
};

export const fetchMatchHistory = async () => {
  try {
    const url = import.meta.env.PROD ? `${getBaseUrl()}/history.json` : `${COMPANION_URL}/history`;
    // Add cache busting for raw github urls to avoid staleness
    const timestamp = new Date().getTime();
    const fetchUrl = import.meta.env.PROD ? `${url}?t=${timestamp}` : url;
    
    const response = await fetch(fetchUrl);
    if (!response.ok) return [];
    return await response.json();
  } catch (error) {
    console.error('Failed to fetch history:', error);
    return [];
  }
};
