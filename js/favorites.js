/* ============================================================
   favorites.js — Gestion des stations favorites (localStorage)
   + Historique de prix pour chaque favori
   ============================================================ */

const Favorites = (() => {
  'use strict';

  const STORAGE_KEY = 'carburant_favorites';
  const HISTORY_KEY = 'carburant_price_history';
  const MAX_HISTORY = 30; // max 30 releves par station/carburant

  function _load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch { return []; }
  }

  function _save(favs) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(favs));
  }

  function getAll() {
    return _load();
  }

  function isFavorite(stationId) {
    return _load().some(f => f.id === stationId);
  }

  function add(station) {
    const favs = _load();
    if (favs.some(f => f.id === station.id)) return;
    favs.push({
      id: station.id,
      adresse: station.adresse,
      ville: station.ville,
      cp: station.cp,
      lat: station.lat,
      lon: station.lon,
      nom: station.nom || '',
      enseigne: station.enseigne || '',
      addedAt: new Date().toISOString(),
    });
    _save(favs);
  }

  function remove(stationId) {
    const favs = _load().filter(f => f.id !== stationId);
    _save(favs);
  }

  function toggle(station) {
    if (isFavorite(station.id)) {
      remove(station.id);
      return false;
    } else {
      add(station);
      return true;
    }
  }

  function count() {
    return _load().length;
  }

  /** Mettre a jour nom/enseigne d'un favori existant */
  function updateInfo(stationId, nom, enseigne) {
    const favs = _load();
    const fav = favs.find(f => f.id === stationId);
    if (!fav) return;
    let changed = false;
    if (nom && fav.nom !== nom) { fav.nom = nom; changed = true; }
    if (enseigne && fav.enseigne !== enseigne) { fav.enseigne = enseigne; changed = true; }
    if (changed) _save(favs);
  }

  /* ---- Historique de prix ---- */
  function _loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || {};
    } catch { return {}; }
  }

  function _saveHistory(h) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  }

  /**
   * Enregistrer les prix d'une ou plusieurs stations
   * @param {object|Array} stationOrArray - Station ou tableau de stations
   */
  function recordPrices(stationOrArray) {
    const stations = Array.isArray(stationOrArray) ? stationOrArray : [stationOrArray];
    if (stations.length === 0) return;

    const history = _loadHistory();
    const today = new Date().toISOString().slice(0, 10);
    let changed = false;

    stations.forEach(station => {
      if (!station || !station.id || !station.fuels) return;
      const key = String(station.id);
      if (!history[key]) history[key] = {};

      Object.entries(station.fuels).forEach(([fuelKey, fuel]) => {
        if (!fuel || !fuel.prix) return;
        if (!history[key][fuelKey]) history[key][fuelKey] = [];

        const entries = history[key][fuelKey];
        const last = entries[entries.length - 1];
        if (last && last.date === today && last.prix === fuel.prix) return;

        entries.push({ date: today, prix: fuel.prix });
        if (entries.length > MAX_HISTORY) {
          history[key][fuelKey] = entries.slice(-MAX_HISTORY);
        }
        changed = true;
      });
    });

    if (changed) _saveHistory(history);
  }

  /**
   * Obtenir l'historique de prix d'une station
   * @param {string|number} stationId
   * @returns {object} { fuelKey: [{date, prix}, ...] }
   */
  function getPriceHistory(stationId) {
    const history = _loadHistory();
    return history[String(stationId)] || {};
  }

  return { getAll, isFavorite, add, remove, toggle, count, updateInfo, recordPrices, getPriceHistory };
})();
