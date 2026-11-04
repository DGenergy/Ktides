/* Tide map — MapLibre basemap with:
   - your location + the tide source (NOAA station or model sea cell)
   - wind: the RoamingRadar particle field (wind.js) over a speed heat map
   - swell: arrows on a sea grid pointing where the swell travels, sized/coloured by height, labelled in m/ft
   Everything follows the time shown on the tide chart (now, the selected day, or where you drag). */
'use strict';
const TideMap = (() => {
  const SPAN_LAT = 1.6, WIND_N = [11, 9], SWELL_N = [13, 11];
  const dark = () => !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
  const STYLE = () => 'https://tiles.openfreemap.org/styles/' + (dark() ? 'dark' : 'positron');
  const SW_RAMP = [[0, '#9ad1f0'], [1, '#4fb3e8'], [2, '#3b82f6'], [3, '#8b5cf6'], [4.5, '#d946ef'], [6, '#f43f5e']];
  let map = null, loaded = false, visible = false, wanted = null, loc = null, src = null, t = Date.now();
  let wind = null, swell = null, ext = null, meMarker = null, srcMarker = null, fetching = false;

  const $ = (s) => document.querySelector(s);
  const swColor = (h) => { let c = SW_RAMP[0][1]; for (const [k, col] of SW_RAMP) if (h >= k) c = col; return c; };
  const wrap = (l) => ((l + 540) % 360) - 180;

  function extentFor(l) {
    const spanLon = SPAN_LAT / Math.max(0.35, Math.cos(l.lat * Math.PI / 180)) * 1.2;
    return { s: Math.max(-84, l.lat - SPAN_LAT), n: Math.min(84, l.lat + SPAN_LAT), w: l.lon - spanLon, e: l.lon + spanLon };
  }
  function grid(e, nx, ny) {
    const la = [], lo = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { la.push((e.s + (e.n - e.s) * j / (ny - 1)).toFixed(3)); lo.push(wrap(e.w + (e.e - e.w) * i / (nx - 1)).toFixed(3)); }
    return [la, lo];
  }
  async function get(url) {
    for (let k = 0; ; k++) {
      try { const r = await fetch(url); const j = await r.json(); if (j.error) throw new Error(j.reason); if (!r.ok) throw new Error('HTTP ' + r.status); return j; }
      catch (e) { if (k >= 1) throw e; await new Promise((r) => setTimeout(r, 2500)); }
    }
  }

  function arrowImage() {
    const s = 48, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.beginPath();
    g.moveTo(24, 3); g.lineTo(38, 22); g.lineTo(29, 22); g.lineTo(29, 45); g.lineTo(19, 45); g.lineTo(19, 22); g.lineTo(10, 22); g.closePath(); g.fill();
    return g.getImageData(0, 0, s, s);
  }

  function ensureMap() {
    if (map || typeof maplibregl === 'undefined') return;
    map = new maplibregl.Map({ container: 'map', style: STYLE(), center: [loc.lon, loc.lat], zoom: 7.3, minZoom: 5.5, maxZoom: 12,
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, cooperativeGestures: false });
    map.touchZoomRotate.disableRotation();
    WindLayer.init(map, $('#windCanvas'));
    WindLayer.setBackground(dark() ? 0 : 1); WindLayer.setContrast(dark() ? 0.35 : 0);
    map.on('load', () => {
      loaded = true;
      map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
      map.addImage('swarrow', arrowImage(), { sdf: true });
      map.addSource('windheat', { type: 'image', url: blank(), coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
      map.addLayer({ id: 'windheat', type: 'raster', source: 'windheat', paint: { 'raster-opacity': 0.35, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, firstSymbol());
      map.addSource('swell', { type: 'geojson', data: fc([]) });
      map.addLayer({ id: 'swell-arrows', type: 'symbol', source: 'swell', layout: {
        'icon-image': 'swarrow', 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true,
        'icon-size': ['interpolate', ['linear'], ['get', 'h'], 0, 0.3, 2, 0.48, 5, 0.72],
        'text-field': ['get', 'lbl'], 'text-size': 11, 'text-offset': [0, 1.5], 'text-allow-overlap': false, 'text-font': ['Noto Sans Bold'] },
        paint: { 'icon-color': ['get', 'col'], 'icon-halo-color': dark() ? 'rgba(0,0,0,.75)' : 'rgba(255,255,255,.9)', 'icon-halo-width': 1.5,
          'text-color': dark() ? '#e8f1f8' : '#0d2233', 'text-halo-color': dark() ? 'rgba(0,0,0,.8)' : 'rgba(255,255,255,.95)', 'text-halo-width': 1.4 } });
      placeMarkers(); paint();
    });
    map.on('click', (e) => {
      const s = WindLayer.sampleAt(e.lngLat.lng, e.lngLat.lat); if (!s) return;
      const from = (Math.atan2(-s[0], -s[1]) * 180 / Math.PI + 360) % 360;
      new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setHTML(`<b>${window.TideFmt.wind(s[2])}</b> from ${window.TideFmt.compass(from)}`).addTo(map);
    });
  }
  const fc = (f) => ({ type: 'FeatureCollection', features: f });
  const blank = () => { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL(); };
  const firstSymbol = () => (map.getStyle().layers.find((l) => l.type === 'symbol') || {}).id;

  function placeMarkers() {
    if (!map) return;
    if (!meMarker) { const el = document.createElement('div'); el.className = 'me-dot'; meMarker = new maplibregl.Marker({ element: el }); }
    meMarker.setLngLat([loc.lon, loc.lat]).addTo(map);
    if (srcMarker) srcMarker.remove(); srcMarker = null;
    if (src && src.d > 0.5) {
      const el = document.createElement('div'); el.className = 'src-dot'; el.title = src.label;
      srcMarker = new maplibregl.Marker({ element: el }).setLngLat([src.lon, src.lat])
        .setPopup(new maplibregl.Popup({ closeButton: false, offset: 10 }).setText(src.label)).addTo(map);
    }
  }

  async function load() {
    if (fetching || !loc) return; fetching = true;
    const key = loc.lat + ',' + loc.lon; ext = extentFor(loc);
    $('#mapNote').textContent = 'Loading wind & swell…';
    try {
      const [wla, wlo] = grid(ext, ...WIND_N), [sla, slo] = grid(ext, ...SWELL_N);
      const [wj, sj] = await Promise.all([
        get(`https://api.open-meteo.com/v1/forecast?latitude=${wla}&longitude=${wlo}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&timeformat=unixtime&past_days=1&forecast_days=8`),
        get(`https://marine-api.open-meteo.com/v1/marine?latitude=${sla}&longitude=${slo}&hourly=swell_wave_height,swell_wave_direction,wave_height,wave_direction&timeformat=unixtime&past_days=1&forecast_days=8`).catch(() => null),
      ]);
      if (key !== loc.lat + ',' + loc.lon) return; // moved on meanwhile
      const pts = Array.isArray(wj) ? wj : [wj], times = pts[0].hourly.time.map((x) => x * 1000);
      const hours = times.map((tm, h) => {
        const n = pts.length, u = new Float32Array(n), v = new Float32Array(n), spd = new Float32Array(n), gust = new Float32Array(n);
        pts.forEach((p, k) => { const sp = p.hourly.wind_speed_10m[h] || 0, d = (p.hourly.wind_direction_10m[h] || 0) * Math.PI / 180;
          u[k] = -sp * Math.sin(d); v[k] = -sp * Math.cos(d); spd[k] = sp; gust[k] = p.hourly.wind_gusts_10m[h] || 0; });
        return { u, v, spd, gust, time: tm };
      });
      wind = Object.assign({ nx: WIND_N[0], ny: WIND_N[1], hours, times }, ext);
      swell = null;
      if (sj) {
        const sp = Array.isArray(sj) ? sj : [sj];
        swell = { times: sp[0].hourly.time.map((x) => x * 1000), cells: [] };
        // the marine API snaps land points to the nearest sea cell — draw at that cell, once
        const seen = new Set();
        for (const p of sp) {
          const k = p.latitude.toFixed(3) + ',' + p.longitude.toFixed(3); if (seen.has(k)) continue; seen.add(k);
          if ((p.hourly.swell_wave_height || p.hourly.wave_height || []).some((x) => x != null)) swell.cells.push({ lat: p.latitude, lon: p.longitude, hh: p.hourly });
        }
      }
      $('#mapNote').textContent = '';
      WindLayer.setField(wind); paint(); if (visible) WindLayer.start();
    } catch (e) {
      console.warn(e); $('#mapNote').textContent = 'Wind/swell map unavailable right now — tap ↻ to retry';
    } finally { fetching = false; }
  }
  const idxAt = (times, tm) => { let b = 0; for (let i = 0; i < times.length; i++) if (Math.abs(times[i] - tm) < Math.abs(times[b] - tm)) b = i; return b; };

  function paint() {
    if (!map || !loaded) return;
    if (wind) {
      const h = idxAt(wind.times, t); WindLayer.setHour(h);
      const im = WindLayer.heatImage(wind, h, 1); map.getSource('windheat').updateImage({ url: im.url, coordinates: im.coordinates });
    }
    const feats = [];
    if (swell) {
      const h = idxAt(swell.times, t);
      for (const c of swell.cells) {
        const hh = c.hh.swell_wave_height?.[h] ?? c.hh.wave_height?.[h], d = c.hh.swell_wave_direction?.[h] ?? c.hh.wave_direction?.[h];
        if (hh == null || d == null) continue;
        feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
          properties: { h: hh, rot: (d + 180) % 360, col: swColor(hh), lbl: window.TideFmt.height(hh) } });
      }
    }
    map.getSource('swell').setData(fc(feats));
    $('#mapTime').textContent = window.TideFmt.when(t);
    const F = window.TideFmt, ft = F.hUnit() === 'ft';
    $('#lgW').textContent = 'Wind ' + F.wUnit(); $('#lgS').textContent = 'Swell ' + F.hUnit();
    $('#lgWt').innerHTML = [0, 10, 20, 30, 40].map((k, i) => `<i>${F.wConv(k)}${i === 4 ? '+' : ''}</i>`).join('');
    $('#lgSt').innerHTML = [0, 1, 2, 3, 4.5, 6].map((k, i) => `<i>${ft ? Math.round(k * 3.28) : k}${i === 5 ? '+' : ''}</i>`).join('');
  }

  return {
    setLocation(l, source) {
      const moved = !loc || l.lat !== loc.lat || l.lon !== loc.lon; loc = l; src = source;
      if (!map) { if (visible) { ensureMap(); load(); } else wanted = true; return; }
      if (moved) { map.jumpTo({ center: [l.lon, l.lat], zoom: 7.3 }); wind = swell = null; WindLayer.setField(null); paint(); load(); }
      placeMarkers();
    },
    setTime(tm) { t = tm; paint(); },
    refreshLabels() { paint(); },
    retry() { load(); },
    recenter() { if (map && loc) map.easeTo({ center: [loc.lon, loc.lat], zoom: 7.3 }); },
    resize() { if (map) setTimeout(() => map.resize(), 60); },
    setVisible(v) {
      visible = v;
      if (v && loc && !map) { ensureMap(); load(); }
      else if (v && wind) WindLayer.start(); else WindLayer.stop();
    },
  };
})();
