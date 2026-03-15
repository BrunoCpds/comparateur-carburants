/* ============================================================
   map.js — Carte interactive Leaflet
   + Marker clustering (Leaflet.markercluster)
   + Tuiles sombres (CartoDB dark_all)
   ============================================================ */

const CarburantMap = (() => {
  'use strict';

  let _map = null;
  let _markers = [];
  let _markerGroup = null;
  let _userMarker = null;
  let _selectedFuel = 'e10';
  let _onStationClick = null;
  let _tileLayer = null;
  let _isDark = false;

  const TILES_LIGHT = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const TILES_DARK  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  const ATTR_LIGHT  = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const ATTR_DARK   = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>';

  /* ---- Initialisation ---- */
  function init(containerId, options = {}) {
    if (_map) { _map.remove(); }

    _isDark = document.documentElement.getAttribute('data-theme') === 'dark';

    _map = L.map(containerId, {
      zoomControl: false,
      attributionControl: true,
    }).setView([46.603354, 1.888334], 6);

    L.control.zoom({ position: 'topright' }).addTo(_map);

    _tileLayer = L.tileLayer(_isDark ? TILES_DARK : TILES_LIGHT, {
      attribution: _isDark ? ATTR_DARK : ATTR_LIGHT,
      maxZoom: 19,
    }).addTo(_map);

    // Utiliser markerClusterGroup si disponible, sinon layerGroup classique
    if (typeof L.markerClusterGroup === 'function') {
      _markerGroup = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        disableClusteringAtZoom: 15,
        chunkedLoading: true,
      });
    } else {
      _markerGroup = L.layerGroup();
    }
    _markerGroup.addTo(_map);

    if (options.onStationClick) {
      _onStationClick = options.onStationClick;
    }

    return _map;
  }

  /* ---- Basculer tuiles sombre / clair ---- */
  function setDarkTiles(dark) {
    if (_isDark === dark || !_map || !_tileLayer) return;
    _isDark = dark;
    _map.removeLayer(_tileLayer);
    _tileLayer = L.tileLayer(dark ? TILES_DARK : TILES_LIGHT, {
      attribution: dark ? ATTR_DARK : ATTR_LIGHT,
      maxZoom: 19,
    }).addTo(_map);
  }

  /* ---- Afficher les stations ---- */
  function showStations(stations, fuelKey) {
    _selectedFuel = fuelKey || _selectedFuel;
    _markerGroup.clearLayers();
    _markers = [];

    const prices = stations
      .filter(s => s.fuels[_selectedFuel])
      .map(s => s.fuels[_selectedFuel].prix);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    stations.forEach(station => {
      if (!station.lat || !station.lon) return;

      const fuel = station.fuels[_selectedFuel];
      const price = fuel ? fuel.prix : null;

      const marker = L.marker([station.lat, station.lon], {
        icon: _createIcon(price, minPrice, maxPrice),
      });

      marker.on('click', () => {
        if (_onStationClick) _onStationClick(station);
      });

      marker._stationData = station;
      _markers.push(marker);
      _markerGroup.addLayer(marker);
    });

    if (_markers.length > 0) {
      const group = L.featureGroup(_markers);
      _map.fitBounds(group.getBounds().pad(0.1));
    }
  }

  /* ---- Marqueur utilisateur ---- */
  function showUserPosition(lat, lon) {
    if (_userMarker) _map.removeLayer(_userMarker);

    _userMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'user-marker',
        html: '<div class="user-marker-dot"></div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      }),
    }).addTo(_map);

    _userMarker.bindPopup('<strong>Votre position</strong>');
  }

  /* ---- Centrer sur une station ---- */
  function focusStation(station) {
    if (!station.lat || !station.lon) return;
    _map.setView([station.lat, station.lon], 15);

    const marker = _markers.find(m => m._stationData && m._stationData.id === station.id);
    if (marker) {
      if (_markerGroup.zoomToShowLayer) {
        _markerGroup.zoomToShowLayer(marker, () => {
          if (_onStationClick) _onStationClick(station);
        });
      } else {
        if (_onStationClick) _onStationClick(station);
      }
    }
  }

  /* ---- Icone personnalisee ---- */
  function _createIcon(price, minPrice, maxPrice) {
    let color = '#6b7280';
    if (price != null && minPrice !== maxPrice) {
      const ratio = (price - minPrice) / (maxPrice - minPrice);
      if (ratio <= 0.33) color = '#16a34a';
      else if (ratio <= 0.66) color = '#f59e0b';
      else color = '#dc2626';
    } else if (price != null) {
      color = '#3b82f6';
    }

    const label = price != null ? price.toFixed(3) : '—';

    return L.divIcon({
      className: 'station-marker',
      html: `<div class="station-marker-pin" style="background:${color}">
               <span class="station-marker-price">${label}</span>
             </div>`,
      iconSize: [60, 36],
      iconAnchor: [30, 36],
    });
  }

  /* ---- Resize ---- */
  function invalidateSize() {
    if (_map) setTimeout(() => _map.invalidateSize(), 100);
  }

  function getMap() { return _map; }

  return { init, showStations, showUserPosition, focusStation, invalidateSize, getMap, setDarkTiles };
})();
