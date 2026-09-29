/* Maldonado Oportunidades — componentes compartidos: gestor de fotos y mapa (OpenStreetMap + Leaflet) */
(() => {
  'use strict';

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const MAX_SIZE = 5 * 1024 * 1024;
  const DEFAULT_CENTER = [-34.905, -54.958]; // Maldonado

  function parseImages(listing) {
    if (!listing) return [];
    let list = [];
    try {
      list = JSON.parse(listing.images || '[]');
    } catch {
      list = [];
    }
    if (!list.length && listing.image) list = [listing.image];
    return list;
  }

  /**
   * Gestor de fotos: muestra las fotos actuales, permite quitar, elegir portada y agregar nuevas.
   * `apply(formData)` escribe keep_images y los archivos nuevos en el FormData antes de enviarlo.
   */
  function photoManager(container, { initial = [], max = 8, onMessage = () => {} } = {}) {
    let kept = initial.slice(0, max);
    let added = []; // { file, url }

    container.innerHTML = `
      <div class="pm-grid" aria-live="polite"></div>
      <label class="btn btn-sm pm-add"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden> ＋ Agregar fotos</label>
      <small class="pm-hint"></small>`;
    const grid = container.querySelector('.pm-grid');
    const input = container.querySelector('input[type=file]');
    const hint = container.querySelector('.pm-hint');

    function render() {
      const items = [...kept.map((url) => ({ url, kind: 'kept' })), ...added.map((a) => ({ url: a.url, kind: 'new' }))];
      grid.innerHTML = items
        .map(
          (it, i) => `<figure class="pm-item">
            <img src="${esc(it.url)}" alt="Foto ${i + 1}">
            ${i === 0 ? '<span class="pm-cover">Portada</span>' : `<button type="button" class="pm-btn pm-first" data-i="${i}" title="Usar como portada" aria-label="Usar como portada">★</button>`}
            <button type="button" class="pm-btn pm-del" data-i="${i}" title="Quitar" aria-label="Quitar foto ${i + 1}">✕</button>
          </figure>`,
        )
        .join('');
      const total = items.length;
      hint.textContent = total ? `${total} de ${max} fotos · la primera es la portada` : `Hasta ${max} fotos de 5 MB cada una`;
      container.querySelector('.pm-add').hidden = total >= max;
      grid.querySelectorAll('.pm-del').forEach((b) =>
        b.addEventListener('click', () => {
          const i = Number(b.dataset.i);
          if (i < kept.length) kept.splice(i, 1);
          else {
            const [a] = added.splice(i - kept.length, 1);
            URL.revokeObjectURL(a.url);
          }
          render();
        }),
      );
      grid.querySelectorAll('.pm-first').forEach((b) =>
        b.addEventListener('click', () => {
          const i = Number(b.dataset.i);
          if (i < kept.length) kept.unshift(...kept.splice(i, 1));
          else if (kept.length === 0) added.unshift(...added.splice(i, 1));
          else onMessage('Guardá primero para usar una foto nueva como portada.');
          render();
        }),
      );
    }

    input.addEventListener('change', () => {
      for (const file of input.files) {
        if (kept.length + added.length >= max) {
          onMessage(`Podés subir hasta ${max} fotos.`);
          break;
        }
        if (file.size > MAX_SIZE) {
          onMessage(`"${file.name}" supera los 5 MB.`);
          continue;
        }
        added.push({ file, url: URL.createObjectURL(file) });
      }
      input.value = '';
      render();
    });
    render();

    return {
      apply(fd) {
        fd.delete('imageFiles');
        fd.delete('imageFile');
        fd.set('keep_images', JSON.stringify(kept));
        added.forEach((a) => fd.append('imageFiles', a.file, a.file.name));
      },
      count: () => kept.length + added.length,
    };
  }

  // ---------- Mapa ----------
  let leafletPromise = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/vendor/leaflet/leaflet.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = '/vendor/leaflet/leaflet.js';
      js.onload = () => resolve(window.L);
      js.onerror = () => {
        leafletPromise = null;
        reject(new Error('No se pudo cargar el mapa'));
      };
      document.head.appendChild(js);
    });
    return leafletPromise;
  }

  function baseMap(L, el, center, zoom) {
    const map = L.map(el, { scrollWheelZoom: false }).setView(center, zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    return map;
  }

  const pin = (L) =>
    L.divIcon({ className: 'mo-pin', html: '<span></span>', iconSize: [28, 28], iconAnchor: [14, 28] });

  /** Selector de ubicación: tocar el mapa marca el punto y completa los campos lat/lng del formulario. */
  function mapPicker(container, { lat = null, lng = null, bounds = null, latInput, lngInput } = {}) {
    container.innerHTML = `
      <div class="mo-map" role="application" aria-label="Mapa para marcar la ubicación"></div>
      <div class="mo-map-actions"><small>Tocá el mapa para marcar la ubicación. Puede ser aproximada.</small>
      <button type="button" class="btn btn-sm mo-map-clear" ${lat == null ? 'hidden' : ''}>Quitar ubicación</button></div>`;
    const el = container.querySelector('.mo-map');
    const clear = container.querySelector('.mo-map-clear');
    const set = (a, b) => {
      latInput.value = a == null ? '' : a.toFixed(5);
      lngInput.value = b == null ? '' : b.toFixed(5);
      clear.hidden = a == null;
    };
    set(lat, lng);
    loadLeaflet()
      .then((L) => {
        const has = lat != null && lng != null;
        const map = baseMap(L, el, has ? [lat, lng] : DEFAULT_CENTER, has ? 15 : 11);
        let marker = has ? L.marker([lat, lng], { icon: pin(L), draggable: true }).addTo(map) : null;
        const inside = (p) => !bounds || (p.lat >= bounds.minLat && p.lat <= bounds.maxLat && p.lng >= bounds.minLng && p.lng <= bounds.maxLng);
        const place = (p) => {
          if (!inside(p)) return;
          if (!marker) {
            marker = L.marker(p, { icon: pin(L), draggable: true }).addTo(map);
            marker.on('dragend', () => place(marker.getLatLng()));
          } else marker.setLatLng(p);
          set(p.lat, p.lng);
        };
        if (marker) marker.on('dragend', () => place(marker.getLatLng()));
        map.on('click', (e) => place(e.latlng));
        clear.addEventListener('click', () => {
          if (marker) map.removeLayer(marker);
          marker = null;
          set(null, null);
        });
        setTimeout(() => map.invalidateSize(), 150);
      })
      .catch(() => {
        el.innerHTML = '<p class="muted" style="padding:12px">No se pudo cargar el mapa. Revisá tu conexión.</p>';
      });
  }

  /** Mapa de solo lectura con un marcador. */
  function mapView(el, lat, lng) {
    loadLeaflet()
      .then((L) => {
        const map = baseMap(L, el, [lat, lng], 15);
        L.marker([lat, lng], { icon: pin(L) }).addTo(map);
        setTimeout(() => map.invalidateSize(), 150);
      })
      .catch(() => {
        el.hidden = true;
      });
  }

  window.MO = { photoManager, mapPicker, mapView, parseImages, loadLeaflet };
})();
