/* ============================================================
   route.js — Itinéraire + stations le long du trajet
   Géocodage : Nominatim (OSM, gratuit)
   Routage : OSRM (normal) / OpenRouteService (sans autoroute)
   ============================================================ */

const RouteManager = (() => {
  'use strict';

  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const ORS_API = 'https://api.openrouteservice.org/v2/directions/driving-car/geojson';
  const ORS_KEY = ''; // clé API ORS — configurable via l'UI (localStorage carburant_ors_key)
  const SAMPLE_INTERVAL_KM = 25; // chercher des stations tous les 25 km
  const SEARCH_RADIUS_KM = 5;    // rayon de recherche autour de chaque point

  let _routeControl = null;
  let _routeStations = [];
  let _routeLayer = null;
  let _stationMarkersGroup = null;
  let _onStationsFound = null;
  let _onRouteInfo = null;
  let _lastRouteInfo = null;
  let _lastRouteCoords = null; // [lng, lat] coords for polyline encoding

  /* ---- Géocodage via Nominatim ---- */
  async function geocode(query) {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      countrycodes: 'fr',
      limit: '5',
      addressdetails: '1',
    });
    const res = await fetch(`${NOMINATIM}?${params}`, {
      headers: { 'Accept-Language': 'fr' },
    });
    if (!res.ok) throw new Error('Erreur de géocodage');
    const data = await res.json();
    return data.map(r => ({
      label: r.display_name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
    }));
  }

  /* ---- Initialiser le contrôle d'itinéraire ---- */
  function init(map, options = {}) {
    _onStationsFound = options.onStationsFound || null;
    _onRouteInfo = options.onRouteInfo || null;

    if (_stationMarkersGroup) map.removeLayer(_stationMarkersGroup);
    _stationMarkersGroup = L.layerGroup().addTo(map);

    return { geocode, calculateRoute, clearRoute };
  }

  /* ---- Calculer l'itinéraire entre deux points ---- */
  async function calculateRoute(map, from, to, fuelKey, progressCb, options = {}) {
    // Nettoyer l'ancien itinéraire
    clearRoute(map);

    // Géocoder si nécessaire
    const fromCoords = from.lat ? from : (await geocode(from.text))[0];
    const toCoords = to.lat ? to : (await geocode(to.text))[0];

    if (!fromCoords || !toCoords) {
      throw new Error('Impossible de g\u00e9ocoder les adresses');
    }

    _lastRouteInfo = { from: fromCoords, to: toCoords };

    if (progressCb) progressCb('Calcul de l\'itin\u00e9raire...');

    // Choisir le moteur de routage
    let routeResult;
    if (options.avoidTolls) {
      routeResult = await _routeViaORS(fromCoords, toCoords);
    } else {
      routeResult = await _routeViaOSRM(fromCoords, toCoords);
    }

    const { routeCoords, distanceKm, durationMin } = routeResult;
    _lastRouteCoords = routeCoords; // stocker pour TollGuru

    // Dessiner l'itinéraire sur la carte
    const latLngs = routeCoords.map(c => [c[1], c[0]]);
    _routeLayer = L.polyline(latLngs, {
      color: '#2f64ff',
      weight: 5,
      opacity: 0.8,
    }).addTo(map);

    // Marqueurs départ / arrivée
    const startIcon = L.divIcon({
      className: 'route-marker',
      html: '<div class="route-marker-pin route-start"><i class="bi bi-geo-alt-fill"></i></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 30],
    });
    const endIcon = L.divIcon({
      className: 'route-marker',
      html: '<div class="route-marker-pin route-end"><i class="bi bi-flag-fill"></i></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 30],
    });

    L.marker([fromCoords.lat, fromCoords.lon], { icon: startIcon })
      .bindPopup(`<strong>Départ</strong><br>${fromCoords.label || ''}`)
      .addTo(_stationMarkersGroup);

    L.marker([toCoords.lat, toCoords.lon], { icon: endIcon })
      .bindPopup(`<strong>Arrivée</strong><br>${toCoords.label || ''}`)
      .addTo(_stationMarkersGroup);

    // Ajuster la vue
    map.fitBounds(_routeLayer.getBounds().pad(0.1));

    // Info itinéraire
    if (_onRouteInfo) {
      _onRouteInfo({
        distance: distanceKm,
        duration: durationMin,
        from: fromCoords,
        to: toCoords,
      });
    }

    // Échantillonner des points le long de l'itinéraire
    if (progressCb) progressCb('Recherche des stations le long du trajet...');
    const samplePoints = _sampleRoute(latLngs, SAMPLE_INTERVAL_KM);

    // Rechercher des stations autour de chaque point
    const allStations = new Map(); // id -> station (dédoublonner)
    let searched = 0;

    for (const point of samplePoints) {
      try {
        const stations = await CarburantAPI.searchByGeo(point[0], point[1], SEARCH_RADIUS_KM);
        stations.forEach(s => {
          if (!allStations.has(s.id)) {
            // Calculer la distance depuis le point d'itinéraire le plus proche
            s._routeKm = _findClosestRouteKm(s, latLngs);
            allStations.set(s.id, s);
          }
        });
      } catch {}
      searched++;
      if (progressCb) progressCb(`Recherche des stations... ${Math.round(searched / samplePoints.length * 100)}%`);
    }

    let stationsList = Array.from(allStations.values());

    // Exclure les stations d'autoroute si demande
    if (options.avoidTolls) {
      stationsList = stationsList.filter(s => s.pop !== 'A');
    }

    _routeStations = stationsList;

    // Trier par position sur le trajet
    _routeStations.sort((a, b) => (a._routeKm || 0) - (b._routeKm || 0));

    // Afficher les stations sur la carte
    _showRouteStations(map, _routeStations, fuelKey);

    if (_onStationsFound) {
      _onStationsFound(_routeStations, { distance: distanceKm, duration: durationMin });
    }

    return _routeStations;
  }

  /* ---- Routage OSRM (mode normal) ---- */
  async function _routeViaOSRM(from, to) {
    const c = `${from.lon},${from.lat};${to.lon},${to.lat}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${c}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Erreur de calcul d\'itin\u00e9raire');
    const data = await res.json();
    if (!data.routes || data.routes.length === 0) throw new Error('Aucun itin\u00e9raire trouv\u00e9');
    const route = data.routes[0];
    return {
      routeCoords: route.geometry.coordinates,
      distanceKm: route.distance / 1000,
      durationMin: route.duration / 60,
    };
  }

  /* ---- Routage ORS (mode sans autoroute) ---- */
  async function _routeViaORS(from, to) {
    const orsKey = localStorage.getItem('carburant_ors_key') || ORS_KEY;
    if (!orsKey) {
      throw new Error('Cl\u00e9 API OpenRouteService requise. Cliquez sur \u2699 pour la configurer (gratuit).');
    }
    const body = {
      coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
      options: { avoid_features: ['highways'] },
    };
    const res = await fetch(ORS_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': orsKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 403 || res.status === 401) {
        throw new Error('Cl\u00e9 API OpenRouteService invalide. Configurez-la dans les param\u00e8tres.');
      }
      throw new Error(err.error?.message || 'Erreur de calcul d\'itin\u00e9raire sans autoroute');
    }
    const data = await res.json();
    // Format GeoJSON : FeatureCollection > features[0]
    const features = data.features;
    if (!features || features.length === 0) throw new Error('Aucun itin\u00e9raire trouv\u00e9 sans autoroute');
    const feature = features[0];
    const summary = feature.properties?.summary || {};
    return {
      routeCoords: feature.geometry.coordinates,
      distanceKm: (summary.distance || 0) / 1000,
      durationMin: (summary.duration || 0) / 60,
    };
  }

  /* ---- Échantillonner des points le long de la route ---- */
  function _sampleRoute(latLngs, intervalKm) {
    const points = [latLngs[0]];
    let accum = 0;

    for (let i = 1; i < latLngs.length; i++) {
      const d = _haversine(latLngs[i - 1][0], latLngs[i - 1][1], latLngs[i][0], latLngs[i][1]);
      accum += d;
      if (accum >= intervalKm) {
        points.push(latLngs[i]);
        accum = 0;
      }
    }

    // Toujours inclure le dernier point
    const last = latLngs[latLngs.length - 1];
    if (points[points.length - 1] !== last) points.push(last);

    return points;
  }

  /* ---- Trouver le km le plus proche sur le trajet ---- */
  function _findClosestRouteKm(station, routeLatLngs) {
    if (!station.lat || !station.lon) return 0;
    let minDist = Infinity;
    let kmAtMin = 0;
    let cumKm = 0;

    for (let i = 0; i < routeLatLngs.length; i++) {
      const d = _haversine(station.lat, station.lon, routeLatLngs[i][0], routeLatLngs[i][1]);
      if (d < minDist) {
        minDist = d;
        kmAtMin = cumKm;
      }
      if (i > 0) {
        cumKm += _haversine(routeLatLngs[i - 1][0], routeLatLngs[i - 1][1], routeLatLngs[i][0], routeLatLngs[i][1]);
      }
    }
    return kmAtMin;
  }

  /* ---- Afficher les marqueurs de stations sur la route ---- */
  function _showRouteStations(map, stations, fuelKey) {
    const prices = stations.filter(s => s.fuels[fuelKey]).map(s => s.fuels[fuelKey].prix);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);

    stations.forEach(station => {
      if (!station.lat || !station.lon) return;
      const fuel = station.fuels[fuelKey];
      if (!fuel) return;

      const ratio = maxP > minP ? (fuel.prix - minP) / (maxP - minP) : 0.5;
      const color = ratio <= 0.33 ? '#16a34a' : ratio <= 0.66 ? '#f59e0b' : '#dc2626';

      const icon = L.divIcon({
        className: 'station-marker',
        html: `<div class="station-marker-pin" style="background:${color}">
                 <span class="station-marker-price">${fuel.prix.toFixed(3)}</span>
               </div>`,
        iconSize: [60, 36],
        iconAnchor: [30, 36],
        popupAnchor: [0, -36],
      });

      const km = station._routeKm ? `${station._routeKm.toFixed(0)} km` : '';
      const marker = L.marker([station.lat, station.lon], { icon })
        .bindPopup(`<strong>${station.adresse}</strong><br>
          ${station.cp} ${station.ville}<br>
          <strong style="color:${color}">${fuel.prix.toFixed(3)} €/L</strong>
          ${km ? `<br><small>~${km} depuis le départ</small>` : ''}`)
        .addTo(_stationMarkersGroup);
    });
  }

  /* ---- Nettoyer ---- */
  function clearRoute(map) {
    if (_routeLayer) { map.removeLayer(_routeLayer); _routeLayer = null; }
    if (_stationMarkersGroup) _stationMarkersGroup.clearLayers();
    _routeStations = [];
  }

  /* ---- Haversine ---- */
  function _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function getLastRouteInfo() { return _lastRouteInfo; }
  function getLastRouteCoords() { return _lastRouteCoords; }

  return { init, geocode, calculateRoute, clearRoute, getLastRouteInfo, getLastRouteCoords };
})();
