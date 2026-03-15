/* ============================================================
   utils.js — Utilitaires : formatage, géolocalisation, calculs
   ============================================================ */

const Utils = (() => {
  'use strict';

  /* ---- Géolocalisation navigateur ---- */
  function getUserPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Géolocalisation non supportée par ce navigateur'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        err => {
          const msgs = {
            1: 'Accès à la géolocalisation refusé',
            2: 'Position indisponible',
            3: 'Délai de géolocalisation dépassé',
          };
          reject(new Error(msgs[err.code] || 'Erreur de géolocalisation'));
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
      );
    });
  }

  /* ---- Formatage prix ---- */
  function formatPrice(prix) {
    if (prix == null) return '—';
    return prix.toFixed(3).replace('.', ',') + ' €/L';
  }

  /* ---- Formatage distance ---- */
  function formatDistance(km) {
    if (km == null) return '';
    if (km < 1) return `${Math.round(km * 1000)} m`;
    return `${km.toFixed(1)} km`;
  }

  /* ---- Formatage date relative ---- */
  function formatRelativeDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffH = Math.floor(diffMs / 3600000);
    const diffD = Math.floor(diffMs / 86400000);

    if (diffH < 1) return 'il y a moins d\'une heure';
    if (diffH < 24) return `il y a ${diffH}h`;
    if (diffD === 1) return 'hier';
    if (diffD < 7) return `il y a ${diffD} jours`;
    return d.toLocaleDateString('fr-FR');
  }

  /**
   * Retourne un objet { text, level } pour la fraicheur d'un releve.
   * level: 'fresh' (<3h), 'recent' (<12h), 'aging' (<24h), 'old' (<3j), 'stale' (>3j)
   */
  function priceFreshness(dateStr) {
    if (!dateStr) return { text: '', level: '' };
    const d = new Date(dateStr);
    const now = new Date();
    const diffH = (now - d) / 3600000;

    let text, level;
    if (diffH < 1)       { text = '< 1h';  level = 'fresh'; }
    else if (diffH < 3)  { text = `${Math.floor(diffH)}h`;  level = 'fresh'; }
    else if (diffH < 12) { text = `${Math.floor(diffH)}h`;  level = 'recent'; }
    else if (diffH < 24) { text = `${Math.floor(diffH)}h`;  level = 'aging'; }
    else if (diffH < 48) { text = 'hier';   level = 'old'; }
    else if (diffH < 72) { text = `${Math.floor(diffH / 24)}j`; level = 'old'; }
    else                  { text = `${Math.floor(diffH / 24)}j`; level = 'stale'; }

    return { text, level };
  }

  /* ---- Calcul économie sur un plein ---- */
  function calculateSavings(price1, price2, volume) {
    if (price1 == null || price2 == null) return null;
    return Math.abs(price1 - price2) * volume;
  }

  /* ---- Tri des stations ---- */
  function sortStations(stations, fuelKey, sortBy = 'price') {
    const copy = [...stations];
    switch (sortBy) {
      case 'price':
        return copy.sort((a, b) => {
          const pa = a.fuels[fuelKey]?.prix ?? Infinity;
          const pb = b.fuels[fuelKey]?.prix ?? Infinity;
          return pa - pb;
        });
      case 'distance':
        return copy.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
      case 'date':
        return copy.sort((a, b) => {
          const da = a.fuels[fuelKey]?.maj ? new Date(a.fuels[fuelKey].maj) : new Date(0);
          const db = b.fuels[fuelKey]?.maj ? new Date(b.fuels[fuelKey].maj) : new Date(0);
          return db - da;
        });
      default:
        return copy;
    }
  }

  /* ---- Filtre par carburant disponible ---- */
  function filterByFuel(stations, fuelKey) {
    return stations.filter(s => s.fuels[fuelKey] && !s.fuels[fuelKey].rupture);
  }

  /* ---- Statistiques sur un ensemble de stations ---- */
  function computeStats(stations, fuelKey) {
    const prices = stations
      .filter(s => s.fuels[fuelKey])
      .map(s => s.fuels[fuelKey].prix)
      .filter(p => p > 0);

    if (prices.length === 0) return null;

    prices.sort((a, b) => a - b);
    const sum = prices.reduce((a, b) => a + b, 0);

    return {
      count: prices.length,
      min: prices[0],
      max: prices[prices.length - 1],
      avg: sum / prices.length,
      median: prices[Math.floor(prices.length / 2)],
    };
  }

  /* ---- Debounce ---- */
  function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  return {
    getUserPosition,
    formatPrice,
    formatDistance,
    formatRelativeDate,
    priceFreshness,
    calculateSavings,
    sortStations,
    filterByFuel,
    computeStats,
    debounce,
  };
})();
