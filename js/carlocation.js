/* ============================================================
   carlocation.js — Localiser ma voiture
   Enregistrement de la position du véhicule (GPS haute précision,
   photo, reverse geocoding) + restitution avec itinéraire piéton
   via Apple Plans ou Google Maps.
   ============================================================ */

const CarLocation = (() => {
  'use strict';

  const STORAGE_KEY = 'carburant_car_position';
  const HIGH_ACCURACY_OPTS = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 };
  const ACCURACY_THRESHOLD_M = 30;
  const PHOTO_MAX_DIM = 1024;
  const PHOTO_QUALITY = 0.7;
  const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';

  /* ---- Helpers ---- */
  function _toast(msg, type = 'info') {
    if (typeof window.showToast === 'function') window.showToast(msg, type);
    else console.log(`[CarLocation] ${type}: ${msg}`);
  }

  function _esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function _haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function _formatMeters(m) {
    if (m == null) return '';
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }

  /* ---- Stockage ---- */
  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null; }
    catch { return null; }
  }

  function save(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
    catch (e) {
      _toast('Stockage plein, photo non enregistrée', 'warning');
      const lighter = { ...data };
      delete lighter.photo;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lighter));
    }
  }

  function clear() {
    localStorage.removeItem(STORAGE_KEY);
    if (window.CarburantMap?.clearCarMarker) CarburantMap.clearCarMarker();
    render();
  }

  /* ---- Capture GPS haute précision avec retry ---- */
  function _getHighAccuracy(opts = HIGH_ACCURACY_OPTS) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Géolocalisation non supportée'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        pos => resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
        err => {
          const msgs = {
            1: 'Accès à la géolocalisation refusé',
            2: 'Position indisponible',
            3: 'Délai de géolocalisation dépassé',
          };
          reject(new Error(msgs[err.code] || 'Erreur de géolocalisation'));
        },
        opts
      );
    });
  }

  async function capturePosition() {
    const first = await _getHighAccuracy();
    if (first.accuracy <= ACCURACY_THRESHOLD_M) return first;
    try {
      const second = await _getHighAccuracy();
      return second.accuracy < first.accuracy ? second : first;
    } catch {
      return first;
    }
  }

  /* ---- Reverse geocoding Nominatim ---- */
  async function reverseGeocode(lat, lon) {
    const params = new URLSearchParams({
      format: 'json',
      lat: String(lat),
      lon: String(lon),
      zoom: '18',
      addressdetails: '1',
    });
    const res = await fetch(`${NOMINATIM_REVERSE}?${params}`, {
      headers: { 'Accept-Language': 'fr' },
    });
    if (!res.ok) throw new Error('Erreur reverse geocoding');
    const data = await res.json();
    if (!data || data.error) return null;
    const a = data.address || {};
    const parts = [
      [a.house_number, a.road].filter(Boolean).join(' '),
      [a.postcode, a.city || a.town || a.village || a.municipality].filter(Boolean).join(' '),
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : data.display_name || null;
  }

  /* ---- Compression photo ---- */
  function compressPhoto(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Lecture du fichier impossible'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Image invalide'));
        img.onload = () => {
          let { width, height } = img;
          const ratio = Math.min(1, PHOTO_MAX_DIM / Math.max(width, height));
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---- Actions ---- */
  async function handleSave() {
    const tile = document.getElementById('btnSaveCarPosition');
    if (tile) tile.classList.add('is-loading');
    try {
      const pos = await capturePosition();
      const data = {
        lat: pos.lat,
        lon: pos.lon,
        accuracy: Math.round(pos.accuracy),
        timestamp: new Date().toISOString(),
      };
      save(data);
      render();
      _toast('Position enregistrée', 'success');

      // Reverse geocoding en arrière-plan
      reverseGeocode(pos.lat, pos.lon)
        .then(addr => {
          if (!addr) return;
          const cur = load();
          if (!cur) return;
          save({ ...cur, address: addr });
          render();
        })
        .catch(() => { /* silencieux : l'adresse est optionnelle */ });
    } catch (e) {
      _toast(e.message || 'Erreur lors de l\'enregistrement', 'error');
    } finally {
      if (tile) tile.classList.remove('is-loading');
    }
  }

  async function handleLocate() {
    const data = load();
    if (!data) {
      _toast('Aucune position enregistrée', 'warning');
      return;
    }
    const tile = document.getElementById('btnLocateCar');
    if (tile) tile.classList.add('is-loading');
    try {
      // Pin voiture
      if (window.CarburantMap?.showCarMarker) CarburantMap.showCarMarker(data.lat, data.lon);

      // Pin utilisateur (best effort)
      let userPos = null;
      try {
        userPos = await Utils.getUserPosition();
        if (window.CarburantMap?.showUserPosition) {
          CarburantMap.showUserPosition(userPos.lat, userPos.lon);
        }
      } catch { /* GPS refusé : on continue sans la position user */ }

      // Ligne pointillée + fit bounds
      if (userPos && window.CarburantMap?.drawWalkingLine) {
        CarburantMap.drawWalkingLine([userPos.lat, userPos.lon], [data.lat, data.lon]);
        if (window.CarburantMap?.fitToCarAndUser) CarburantMap.fitToCarAndUser();
      } else if (window.CarburantMap?.focusLatLon) {
        CarburantMap.focusLatLon(data.lat, data.lon, 17);
      }

      // Distance
      if (userPos) {
        const meters = _haversineMeters(userPos.lat, userPos.lon, data.lat, data.lon);
        const distEl = document.getElementById('carDistance');
        if (distEl) {
          distEl.innerHTML = `<i class="bi bi-signpost-2"></i> À ${_formatMeters(meters)} de vous`;
          distEl.classList.remove('d-none');
        }
      }

      // Sur mobile : basculer vers la carte si bouton dispo et masqué (carte cachée)
      const toggleBtn = document.getElementById('btnToggleMap');
      if (toggleBtn && getComputedStyle(toggleBtn).display !== 'none') {
        const mapPanel = document.querySelector('.map-panel');
        if (mapPanel && mapPanel.style.display !== 'block') toggleBtn.click();
      }
    } finally {
      if (tile) tile.classList.remove('is-loading');
    }
  }

  async function handlePhotoChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressPhoto(file);
      const cur = load();
      if (!cur) {
        _toast('Enregistrez d\'abord la position', 'warning');
        return;
      }
      save({ ...cur, photo: dataUrl });
      render();
      _toast('Photo ajoutée', 'success');
    } catch (e) {
      _toast(e.message || 'Erreur photo', 'error');
    } finally {
      event.target.value = '';
    }
  }

  function handleClear() {
    if (!confirm('Effacer la position enregistrée ?')) return;
    clear();
    _toast('Position effacée', 'info');
  }

  function openAppleMaps(lat, lon) {
    const url = `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=w`;
    window.open(url, '_blank');
  }

  function openGoogleMaps(lat, lon) {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=walking`;
    window.open(url, '_blank');
  }

  /* ---- Rendu ---- */
  function render() {
    const card = document.getElementById('carPositionCard');
    if (!card) return;
    const data = load();

    if (!data) {
      card.innerHTML = `
        <div class="car-position-empty">
          <i class="bi bi-geo-alt" style="font-size:32px;color:var(--muted)"></i>
          <div style="margin-top:8px">Aucune position enregistrée</div>
          <div style="margin-top:4px;font-size:12px">Tapez « Enregistrer ma position » quand vous vous garez.</div>
        </div>`;
      return;
    }

    const when = Utils.formatRelativeDate(data.timestamp);
    const accuracy = data.accuracy != null ? `±${data.accuracy} m` : '';
    const coords = `${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}`;

    card.innerHTML = `
      ${data.photo ? `<img src="${data.photo}" alt="Photo du lieu" class="car-photo">` : ''}
      <div class="car-position-meta">
        <div class="car-position-title">
          <i class="bi bi-geo-alt-fill" style="color:var(--primary)"></i>
          ${data.address ? _esc(data.address) : coords}
        </div>
        <div class="car-position-sub">
          ${when ? `<span><i class="bi bi-clock"></i> ${when}</span>` : ''}
          ${accuracy ? `<span><i class="bi bi-bullseye"></i> ${accuracy}</span>` : ''}
        </div>
        <div id="carDistance" class="car-position-distance d-none"></div>
      </div>
      <div class="car-position-actions">
        <button class="btn btn-primary btn-sm flex-fill" id="btnCarOpenApple">
          <i class="bi bi-apple"></i> Apple Plans
        </button>
        <button class="btn btn-outline-primary btn-sm flex-fill" id="btnCarOpenGoogle">
          <i class="bi bi-google"></i> Google Maps
        </button>
      </div>
      <div class="car-position-actions mt-2">
        <button class="btn btn-outline-secondary btn-sm flex-fill" id="btnCarAddPhoto">
          <i class="bi bi-camera"></i> ${data.photo ? 'Changer la photo' : 'Ajouter une photo'}
        </button>
        <button class="btn btn-outline-danger btn-sm" id="btnCarClear" title="Effacer">
          <i class="bi bi-trash"></i>
        </button>
      </div>`;

    document.getElementById('btnCarOpenApple')?.addEventListener('click', () => openAppleMaps(data.lat, data.lon));
    document.getElementById('btnCarOpenGoogle')?.addEventListener('click', () => openGoogleMaps(data.lat, data.lon));
    document.getElementById('btnCarAddPhoto')?.addEventListener('click', () => document.getElementById('carPhotoInput')?.click());
    document.getElementById('btnCarClear')?.addEventListener('click', handleClear);
  }

  /* ---- Init ---- */
  function init() {
    document.getElementById('btnSaveCarPosition')?.addEventListener('click', handleSave);
    document.getElementById('btnLocateCar')?.addEventListener('click', handleLocate);
    document.getElementById('carPhotoInput')?.addEventListener('change', handlePhotoChange);
    render();
  }

  return { init, render, load, clear };
})();
