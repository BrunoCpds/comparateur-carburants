/* ============================================================
   api.js — Module d'acces a l'API data.economie.gouv.fr
   Flux instantane v2 — Prix des carburants en France
   + Indicateur cache/live
   ============================================================ */

const CarburantAPI = (() => {
  'use strict';

  const BASE = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2';
  const CACHE_KEY = 'carburant_cache';
  const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

  const FUEL_TYPES = [
    { key: 'gazole',  label: 'Gazole',  color: '#f59e0b' },
    { key: 'sp95',    label: 'SP95',    color: '#10b981' },
    { key: 'sp98',    label: 'SP98',    color: '#3b82f6' },
    { key: 'e10',     label: 'E10',     color: '#8b5cf6' },
    { key: 'e85',     label: 'E85',     color: '#06b6d4' },
    { key: 'gplc',    label: 'GPLc',    color: '#ef4444' },
  ];

  // Metadata de la derniere requete
  let _lastMeta = { fromCache: false, cacheAge: 0 };

  /* ---- Cache localStorage ---- */
  function _getCached(cacheKey) {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      const age = Date.now() - ts;
      if (age > CACHE_TTL) { localStorage.removeItem(cacheKey); return null; }
      _lastMeta = { fromCache: true, cacheAge: age };
      return data;
    } catch { return null; }
  }

  function _setCache(cacheKey, data) {
    try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data })); } catch {}
  }

  function getLastMeta() { return { ..._lastMeta }; }

  /* ---- Fetch generique avec pagination ---- */
  async function _fetchRecords(where, limit = 100, offset = 0) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (where) params.set('where', where);
    const url = `${BASE}/records?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const json = await res.json();
    _lastMeta = { fromCache: false, cacheAge: 0 };
    return json;
  }

  /* ---- Recherche par code postal ---- */
  async function searchByPostalCode(cp) {
    const cacheKey = `${CACHE_KEY}_cp_${cp}`;
    const cached = _getCached(cacheKey);
    if (cached) return cached;

    const json = await _fetchRecords(`cp="${cp}"`, 50);
    const records = _normalizeRecords(json.results || []);
    _setCache(cacheKey, records);
    return records;
  }

  /* ---- Recherche par ville ---- */
  async function searchByCity(ville) {
    const cacheKey = `${CACHE_KEY}_ville_${ville.toLowerCase()}`;
    const cached = _getCached(cacheKey);
    if (cached) return cached;

    const json = await _fetchRecords(`search(ville, "${ville}")`, 50);
    const records = _normalizeRecords(json.results || []);
    _setCache(cacheKey, records);
    return records;
  }

  /* ---- Recherche par departement ---- */
  async function searchByDepartment(codeDept) {
    const cacheKey = `${CACHE_KEY}_dept_${codeDept}`;
    const cached = _getCached(cacheKey);
    if (cached) return cached;

    const json = await _fetchRecords(`code_departement="${codeDept}"`, 100);
    const records = _normalizeRecords(json.results || []);
    _setCache(cacheKey, records);
    return records;
  }

  /* ---- Recherche geographique (rayon en km) ---- */
  async function searchByGeo(lat, lon, radiusKm = 10) {
    const cacheKey = `${CACHE_KEY}_geo_${lat.toFixed(3)}_${lon.toFixed(3)}_${radiusKm}`;
    const cached = _getCached(cacheKey);
    if (cached) return cached;

    const distanceMeters = radiusKm * 1000;
    const where = `within_distance(geom, geom'POINT(${lon} ${lat})', ${distanceMeters}m)`;
    const json = await _fetchRecords(where, 100);
    const records = _normalizeRecords(json.results || []);

    records.forEach(r => {
      if (r.lat && r.lon) {
        r.distance = _haversine(lat, lon, r.lat, r.lon);
      }
    });
    records.sort((a, b) => (a.distance || 999) - (b.distance || 999));

    _setCache(cacheKey, records);
    return records;
  }

  /* ---- Normalisation d'un record API ---- */
  function _normalizeRecords(results) {
    return results.map(r => {
      const station = {
        id: r.id,
        adresse: r.adresse || '',
        ville: r.ville || '',
        cp: r.cp || '',
        departement: r.departement || '',
        codeDepartement: r.code_departement || '',
        region: r.region || '',
        lat: null,
        lon: null,
        pop: r.pop || '',
        automate24h: r.horaires_automate_24_24 === 'Oui',
        services: [],
        horaires: r.horaires_jour || '',
        fuels: {},
        availableFuels: [],
        distance: null,
      };

      if (r.geom) {
        station.lat = r.geom.lat;
        station.lon = r.geom.lon;
      } else {
        if (r.latitude) station.lat = parseFloat(r.latitude) / 100000;
        if (r.longitude) station.lon = parseFloat(r.longitude) / 100000;
      }

      if (r.services_service) {
        station.services = typeof r.services_service === 'string'
          ? r.services_service.split('//').map(s => s.trim()).filter(Boolean)
          : (Array.isArray(r.services_service) ? r.services_service : []);
      }

      FUEL_TYPES.forEach(ft => {
        const prix = r[`${ft.key}_prix`];
        if (prix != null && prix > 0) {
          station.fuels[ft.key] = {
            prix: prix,
            maj: r[`${ft.key}_maj`] || null,
            rupture: r[`${ft.key}_rupture_type`] || null,
          };
          station.availableFuels.push(ft.key);
        }
      });

      if (r.carburants_disponibles) {
        const dispo = typeof r.carburants_disponibles === 'string'
          ? r.carburants_disponibles.split('·').map(s => s.trim().toLowerCase())
          : [];
        station._carburantsDispo = dispo;
      }

      return station;
    });
  }

  /* ---- Haversine (distance en km) ---- */
  function _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = _deg2rad(lat2 - lat1);
    const dLon = _deg2rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(_deg2rad(lat1)) * Math.cos(_deg2rad(lat2)) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function _deg2rad(d) { return d * Math.PI / 180; }

  /* ---- Enrichissement nom/enseigne via API 2aaz ---- */
  const STATION_CACHE_KEY = 'carburant_station_info';
  const STATION_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — les noms ne changent pas souvent

  function _getStationInfoCache() {
    try {
      const raw = localStorage.getItem(STATION_CACHE_KEY);
      if (!raw) return {};
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > STATION_CACHE_TTL) { localStorage.removeItem(STATION_CACHE_KEY); return {}; }
      return data;
    } catch { return {}; }
  }

  function _saveStationInfoCache(data) {
    try { localStorage.setItem(STATION_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch {}
  }

  /**
   * Enrichir un tableau de stations avec nom + enseigne (max 25, parallele)
   * @param {Array} stations — tableau de stations normalisees
   * @returns {Promise<Array>} — meme tableau, mute avec .nom et .enseigne
   */
  async function enrichStationNames(stations, maxCount = 50) {
    const cache = _getStationInfoCache();
    const toFetch = [];

    stations.slice(0, maxCount).forEach(s => {
      const key = String(s.id);
      if (cache[key]) {
        s.nom = cache[key].nom;
        s.enseigne = cache[key].enseigne;
      } else {
        toFetch.push(s);
      }
    });

    if (toFetch.length === 0) return stations;

    const results = await Promise.allSettled(
      toFetch.map(s =>
        fetch(`https://api.prix-carburants.2aaz.fr/station/${s.id}`, {
          headers: { 'Accept': 'application/json' }
        })
        .then(r => r.ok ? r.json() : null)
        .then(json => {
          if (!json) return;
          const nom = json.name || '';
          const enseigne = (json.Brand && json.Brand.name) ? json.Brand.name : '';
          s.nom = nom;
          s.enseigne = enseigne;
          cache[String(s.id)] = { nom, enseigne };
        })
      )
    );

    _saveStationInfoCache(cache);
    return stations;
  }

  /* ---- Utilitaires ---- */
  function getFuelTypes() { return FUEL_TYPES; }

  function getFuelLabel(key) {
    const f = FUEL_TYPES.find(ft => ft.key === key);
    return f ? f.label : key;
  }

  function getFuelColor(key) {
    const f = FUEL_TYPES.find(ft => ft.key === key);
    return f ? f.color : '#6b7280';
  }

  function clearCache() {
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith(CACHE_KEY)) localStorage.removeItem(k);
    });
  }

  return {
    searchByPostalCode,
    searchByCity,
    searchByDepartment,
    searchByGeo,
    getFuelTypes,
    getFuelLabel,
    getFuelColor,
    clearCache,
    getLastMeta,
    enrichStationNames,
    FUEL_TYPES,
  };
})();
