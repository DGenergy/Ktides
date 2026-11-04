/* Tides — client-only PWA.
   Tide source: NOAA CO-OPS station predictions when a US station is within NOAA_RADIUS_KM,
   otherwise the Open-Meteo marine model (sea_level_height_msl, global, ~8 km grid).
   Wind/sun: Open-Meteo forecast. Swell: Open-Meteo marine. Moon: computed locally. */
'use strict';

const NOAA_RADIUS_KM = 30;
const H = 3600e3, D = 24 * H;
const $ = (s) => document.querySelector(s);

// ---------- storage ----------
const load = (k, d) => { try { const v = localStorage.getItem('tide.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem('tide.' + k, JSON.stringify(v)); } catch {} };

const S = {
  loc: load('loc', null),
  favs: load('favs', []),
  units: load('units', { h: 'm', w: 'kn' }),
  pref: load('srcPref', 'auto'),       // 'auto' | 'model'
  day: 0, scrubT: null, data: null,
};

// ---------- helpers ----------
const rad = (d) => d * Math.PI / 180;
function distKm(a, b, c, d) {
  const R = 6371, dLat = rad(c - a), dLon = rad(d - b);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function destPoint(lat, lon, brg, km) {
  const R = 6371, d = km / R, b = rad(brg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI + 540) % 360) - 180];
}
async function getJSON(url, ms = 15000, retry = 1) {
  try { return await getJSON1(url, ms); }
  catch (e) { if (retry > 0 && /^(429|5\d\d)/.test(e.message)) { await new Promise((r) => setTimeout(r, 2000)); return getJSON(url, ms, retry - 1); } throw e; }
}
async function getJSON1(url, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error(r.status + ' ' + url.split('?')[0]); return await r.json(); }
  finally { clearTimeout(t); }
}
function status(msg, ms) {
  const el = $('#status'); if (!msg) { el.hidden = true; return; }
  el.textContent = msg; el.hidden = false;
  clearTimeout(status._t); if (ms) status._t = setTimeout(() => (el.hidden = true), ms);
}
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

// ---------- time zones ----------
function tzOffset(tz, t) {
  const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(t)) p[x.type] = +x.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
function localMidnight(tz, t, addDays = 0) {
  const loc = new Date(t + tzOffset(tz, t));
  let m = Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate() + addDays);
  let u = m - tzOffset(tz, m); u = m - tzOffset(tz, u); return u;
}
const fmt = (tz, t, o) => new Intl.DateTimeFormat(undefined, { timeZone: tz, ...o }).format(t);
const fTime = (t) => fmt(S.data.tz, t, { hour: 'numeric', minute: '2-digit' });
const fHour = (t) => fmt(S.data.tz, t, { hour: 'numeric' });
function fDur(ms) { const m = Math.round(ms / 60000); const h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m`; }

// ---------- units ----------
const fH = (m, d = 2) => m == null ? '–' : S.units.h === 'ft' ? (m * 3.28084).toFixed(d === 2 ? 1 : d) + ' ft' : m.toFixed(d) + ' m';
const WCONV = { kn: [1, 'kn'], kmh: [1.852, 'km/h'], mph: [1.15078, 'mph'] };
const fW = (kn) => kn == null ? '–' : Math.round(kn * WCONV[S.units.w][0]);
const wU = () => WCONV[S.units.w][1];
const compass = (d) => ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d / 22.5) % 16];
// arrow pointing the direction the wind/swell travels TO
const arrow = (from) => `<span class="arrow" style="transform:rotate(${(from + 180) % 360}deg)">↑</span>`;

// ---------- NOAA ----------
async function noaaStations() {
  const c = load('noaaStations', null);
  if (c && Date.now() - c.at < 30 * D) return c.s;
  const j = await getJSON('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions', 30000);
  const s = j.stations.map((x) => [x.id, x.name, x.state || '', +x.lat, +x.lng]);
  save('noaaStations', { at: Date.now(), s }); return s;
}
async function nearestNoaa(lat, lon) {
  // NOAA predictions cover US states/territories plus a few Pacific/Caribbean stations.
  if (!(lat > -20 && lat < 75 && (lon < -50 || lon > 130))) return null;
  const st = await noaaStations();
  let best = null;
  for (const s of st) { const d = distKm(lat, lon, s[3], s[4]); if (!best || d < best.d) best = { id: s[0], name: s[1], state: s[2], lat: s[3], lon: s[4], d }; }
  return best && best.d <= NOAA_RADIUS_KM ? best : null;
}
async function noaaTide(st, t0, t1) {
  const u = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=TidesPWA&station=${st.id}` +
    `&begin_date=${ymd(t0)}&end_date=${ymd(t1)}&datum=MLLW&units=metric&time_zone=gmt&interval=hilo&format=json`;
  const j = await getJSON(u);
  if (!j.predictions) throw new Error(j.error?.message || 'NOAA: no predictions');
  const ex = j.predictions.map((p) => ({ t: Date.parse(p.t.replace(' ', 'T') + ':00Z'), h: +p.v, type: p.type }));
  return { extremes: ex, at: (t) => cosineAt(ex, t), datum: 'MLLW', src: 'noaa' };
}
function cosineAt(ex, t) {
  let i = 0; while (i < ex.length - 1 && ex[i + 1].t < t) i++;
  const a = ex[i], b = ex[i + 1]; if (!a || !b || t < a.t) return null;
  const f = (t - a.t) / (b.t - a.t);
  return a.h + (b.h - a.h) * (1 - Math.cos(Math.PI * f)) / 2;
}

// ---------- Open-Meteo marine (global model) ----------
async function findSeaCell(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`, cache = load('cells', {});
  if (cache[key]) return cache[key];
  const pts = [[lat, lon]];
  for (const r of [4, 8, 14, 22, 32, 45]) for (let b = 0; b < 360; b += 30) pts.push(destPoint(lat, lon, b, r));
  const u = `https://marine-api.open-meteo.com/v1/marine?latitude=${pts.map((p) => p[0].toFixed(3))}&longitude=${pts.map((p) => p[1].toFixed(3))}` +
    `&hourly=sea_level_height_msl&forecast_days=1`;
  let j = await getJSON(u, 20000); if (!Array.isArray(j)) j = [j];
  let best = null;
  j.forEach((r, i) => {
    const v = r.hourly?.sea_level_height_msl; if (!v || v.every((x) => x == null)) return;
    const d = distKm(lat, lon, pts[i][0], pts[i][1]);
    if (!best || d < best.d) best = { lat: pts[i][0], lon: pts[i][1], d };
  });
  if (best) { cache[key] = best; const ks = Object.keys(cache); if (ks.length > 40) delete cache[ks[0]]; save('cells', cache); }
  return best;
}
async function marine(cell) {
  const u = `https://marine-api.open-meteo.com/v1/marine?latitude=${cell.lat.toFixed(3)}&longitude=${cell.lon.toFixed(3)}` +
    `&minutely_15=sea_level_height_msl&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction` +
    `&timeformat=unixtime&timezone=auto&past_days=1&forecast_days=9&cell_selection=sea`;
  return getJSON(u, 20000);
}
function modelTide(m) {
  const t = m.minutely_15.time.map((x) => x * 1000), v = m.minutely_15.sea_level_height_msl;
  const pts = []; t.forEach((x, i) => v[i] != null && pts.push([x, v[i]]));
  const ex = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1][1], pts[i][1], pts[i + 1][1]];
    const isH = b >= a && b > c, isL = b <= a && b < c; if (!isH && !isL) continue;
    const den = a - 2 * b + c, off = den ? 0.5 * (a - c) / den : 0; // parabolic refine
    const step = pts[i + 1][0] - pts[i][0];
    const e = { t: pts[i][0] + off * step, h: b - 0.25 * (a - c) * off, type: isH ? 'H' : 'L' };
    const prev = ex[ex.length - 1];
    if (prev && prev.type === e.type) { if ((e.type === 'H') === (e.h > prev.h)) ex[ex.length - 1] = e; continue; }
    if (prev && e.t - prev.t < 2 * H && Math.abs(e.h - prev.h) < 0.03) { ex.pop(); continue; } // jitter
    ex.push(e);
  }
  const at = (x) => {
    let lo = 0, hi = pts.length - 1; if (!pts.length || x < pts[0][0] || x > pts[hi][0]) return null;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; pts[mid][0] <= x ? (lo = mid) : (hi = mid); }
    const [t0, v0] = pts[lo], [t1, v1] = pts[hi]; return v0 + (v1 - v0) * (x - t0) / (t1 - t0 || 1);
  };
  return { extremes: ex, at, datum: 'MSL', src: 'model' };
}
function waves(m) {
  if (!m?.hourly) return [];
  const h = m.hourly;
  return h.time.map((x, i) => ({
    t: x * 1000,
    h: h.swell_wave_height?.[i] ?? h.wave_height?.[i], p: h.swell_wave_period?.[i] ?? h.wave_period?.[i],
    d: h.swell_wave_direction?.[i] ?? h.wave_direction?.[i], sea: h.wave_height?.[i],
  })).filter((w) => w.h != null);
}

// ---------- forecast (wind, sun, tz) ----------
async function forecast(lat, lon) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&daily=sunrise,sunset` +
    `&wind_speed_unit=kn&timezone=auto&timeformat=unixtime&past_days=1&forecast_days=9`;
  const j = await getJSON(u);
  const h = j.hourly;
  return {
    tz: j.timezone,
    wind: h.time.map((x, i) => ({ t: x * 1000, s: h.wind_speed_10m[i], g: h.wind_gusts_10m[i], d: h.wind_direction_10m[i] })).filter((w) => w.s != null),
    sun: j.daily.time.map((_, i) => ({ rise: j.daily.sunrise[i] * 1000, set: j.daily.sunset[i] * 1000 })),
  };
}
const nearest = (arr, t) => { let b = null; for (const x of arr) if (!b || Math.abs(x.t - t) < Math.abs(b.t - t)) b = x; return b && Math.abs(b.t - t) < 2 * H ? b : null; };

// ---------- moon ----------
function moonAge(t) { // fraction of synodic month, 0 = new
  const days = (t - Date.UTC(2000, 0, 6, 18, 14)) / D; const f = (days / 29.530588853) % 1; return f < 0 ? f + 1 : f;
}
function moonInfo(t) {
  const a = moonAge(t), illum = (1 - Math.cos(2 * Math.PI * a)) / 2, days = a * 29.5306;
  const names = ['New moon','Waxing crescent','First quarter','Waxing gibbous','Full moon','Waning gibbous','Last quarter','Waning crescent'];
  const name = names[Math.floor((a * 8 + 0.5)) % 8];
  const dSpring = Math.min(days, Math.abs(days - 14.765), 29.53 - days);
  const dNeap = Math.min(Math.abs(days - 7.38), Math.abs(days - 22.15));
  const tideHint = dSpring <= 2 ? 'Spring tides (bigger range)' : dNeap <= 2 ? 'Neap tides (smaller range)' : (days % 14.765) < 7.38 ? 'Heading to neaps' : 'Heading to springs';
  return { a, illum, name, tideHint };
}
function moonSVG(a, south) {
  const R = 20, illum = (1 - Math.cos(2 * Math.PI * a)) / 2, rx = Math.abs(Math.cos(2 * Math.PI * a)) * R;
  const sweep = illum < 0.5 ? 0 : 1, flip = (a > 0.5) !== !!south ? -1 : 1;
  const lit = `M0,${-R} A${R},${R} 0 0 1 0,${R} A${rx.toFixed(2)},${R} 0 0 ${sweep} 0,${-R}Z`;
  return `<svg width="48" height="48" viewBox="-24 -24 48 48"><circle r="${R}" fill="#334155"/>` +
    `<path d="${lit}" fill="#f5e6b4" transform="scale(${flip},1)"/></svg>`;
}

// ---------- loading ----------
async function loadLocation(loc, { quiet } = {}) {
  S.loc = loc; save('loc', loc); S.day = 0; S.scrubT = null;
  $('#locName').textContent = loc.name || `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`;
  updateFavBtn();
  if (!quiet) status('Loading tides…');
  const now = Date.now();
  try {
    const [fc, st, cell] = await Promise.all([
      forecast(loc.lat, loc.lon).catch((e) => { console.warn(e); return null; }),
      nearestNoaa(loc.lat, loc.lon).catch(() => null),
      findSeaCell(loc.lat, loc.lon).catch(() => null),
    ]);
    const mar = cell ? await marine(cell).catch(() => null) : null;
    let tide = null, srcLabel = '';
    if (st && S.pref !== 'model') {
      tide = await noaaTide(st, now - 2 * D, now + 9 * D).catch(() => null);
      if (tide) srcLabel = `NOAA ${st.name}${st.state ? ', ' + st.state : ''} · ${st.d.toFixed(0)} km`;
    }
    if (!tide && mar?.minutely_15) {
      tide = modelTide(mar);
      srcLabel = `Model · ${cell.d < 1 ? 'at location' : cell.d.toFixed(0) + ' km offshore'}`;
    }
    if (!tide) throw new Error('No sea found within 45 km of this spot');
    const tz = fc?.tz || mar?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!fc) status('Wind/sun forecast unavailable right now', 4000);
    S.data = { tz, tide, wind: fc?.wind || [], sun: fc?.sun || [], waves: waves(mar), st, srcLabel, hasNoaa: !!st };
    $('#locSrc').textContent = srcLabel;
    if (fc) status(null); render();
  } catch (e) {
    console.error(e); status('Couldn’t load: ' + e.message, 6000);
  }
}

async function useGps() {
  if (!navigator.geolocation) return status('Location not available', 4000);
  status('Finding you…');
  navigator.geolocation.getCurrentPosition(async (p) => {
    const lat = +p.coords.latitude.toFixed(4), lon = +p.coords.longitude.toFixed(4);
    let name = 'My location';
    try {
      const g = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, 6000);
      name = g.locality || g.city || g.principalSubdivision || name;
    } catch {}
    loadLocation({ name, lat, lon });
  }, (e) => status('Location error: ' + e.message, 5000), { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
}

// ---------- render ----------
function render() {
  const d = S.data; if (!d) return;
  const now = Date.now(), T = d.tide;
  // hero
  const h = T.at(now), h2 = T.at(now + 10 * 60e3);
  $('#nowH').textContent = fH(h);
  $('#nowDir').textContent = h != null && h2 != null ? (h2 > h ? '↑' : '↓') : '';
  const nx = T.extremes.find((e) => e.t > now), pv = [...T.extremes].reverse().find((e) => e.t <= now);
  $('#nowSub').textContent = h2 != null && h != null ? (h2 > h ? 'Rising' : 'Falling') + (pv ? ` · ${pv.type === 'H' ? 'high' : 'low'} was ${fTime(pv.t)}` : '') : '';
  if (nx) {
    $('#nextLbl').textContent = 'Next ' + (nx.type === 'H' ? 'high' : 'low');
    $('#nextTime').textContent = fTime(nx.t);
    $('#nextIn').textContent = `in ${fDur(nx.t - now)} · ${fH(nx.h)}`;
  }
  // day chips
  const days = $('#days'); days.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const m = localMidnight(d.tz, now, i), b = document.createElement('button');
    b.className = 'day' + (i === S.day ? ' sel' : '');
    b.innerHTML = `<b>${i === 0 ? 'Today' : fmt(d.tz, m + 12 * H, { weekday: 'short' })}</b><span>${fmt(d.tz, m + 12 * H, { day: 'numeric', month: 'short' })}</span>`;
    b.onclick = () => { S.day = i; S.scrubT = null; render(); };
    days.appendChild(b);
  }
  days.children[S.day]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderDay();
  // units/footer
  $('#uH').textContent = 'Height: ' + S.units.h;
  $('#uW').textContent = 'Wind: ' + wU();
  const src = $('#uSrc'); src.hidden = !d.hasNoaa;
  src.textContent = 'Source: ' + (T.src === 'noaa' ? 'NOAA station' : 'Model');
  $('#disclaimer').textContent = T.src === 'noaa'
    ? 'Official NOAA predictions (heights above MLLW). Curve between highs/lows is interpolated.'
    : 'Global model estimate (heights relative to mean sea level). Timing is usually good; heights and harbour/estuary effects are approximate.';
}

function dayBounds() { const m = localMidnight(S.data.tz, Date.now(), S.day); return [m, localMidnight(S.data.tz, m + 12 * H, 1)]; }

function renderDay() {
  const d = S.data, [t0, t1] = dayBounds(), now = Date.now();
  $('#dayTitle').textContent = fmt(d.tz, t0 + 12 * H, { weekday: 'long', day: 'numeric', month: 'long' });
  $('#prevDay').disabled = S.day === 0; $('#nextDay').disabled = S.day === 7;
  drawChart(t0, t1);
  // extremes
  const ex = d.tide.extremes.filter((e) => e.t >= t0 && e.t < t1);
  $('#extremes').innerHTML = ex.map((e) => `<div class="ex ${e.type}"><div class="k">${e.type === 'H' ? 'High' : 'Low'}</div>` +
    `<div class="t">${fTime(e.t)}</div><div class="h">${fH(e.h)}</div></div>`).join('') || '<div class="empty">No data for this day</div>';
  // sun
  const sun = d.sun.find((s) => s.rise >= t0 && s.rise < t1) || {};
  $('#sunrise').textContent = sun.rise ? fTime(sun.rise) : '–';
  $('#sunset').textContent = sun.set ? fTime(sun.set) : '–';
  const mi = moonInfo(S.day === 0 ? now : t0 + 12 * H);
  $('#moonIcon').innerHTML = moonSVG(mi.a, S.loc.lat < 0);
  $('#moonName').textContent = mi.name;
  $('#moonSub').textContent = `${Math.round(mi.illum * 100)}% lit · ${mi.tideHint}`;
  renderConditions();
  renderHourly(t0, t1);
}

function renderConditions() {
  const d = S.data, [t0] = dayBounds();
  const t = S.scrubT ?? (S.day === 0 ? Date.now() : t0 + 12 * H);
  $('#condAt').textContent = '· ' + (S.scrubT || S.day ? fmt(d.tz, t, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'now');
  const w = nearest(d.wind, t), v = nearest(d.waves, t);
  $('#windNow').innerHTML = w ? `${arrow(w.d)} ${fW(w.s)} <small>${wU()}</small>` : '–';
  $('#windSub').textContent = w ? `${compass(w.d)} · gusts ${fW(w.g)}` : '';
  $('#waveNow').innerHTML = v ? `${arrow(v.d)} ${fH(v.h, 1)}` : '–';
  $('#waveSub').textContent = v ? `${v.p ? v.p.toFixed(0) + ' s · ' : ''}from ${compass(v.d)}` : 'No wave data here';
}

function renderHourly(t0, t1) {
  const d = S.data, now = Date.now(); let html = '';
  for (let t = t0; t < t1; t += 3 * H) {
    const w = nearest(d.wind, t), v = nearest(d.waves, t);
    const isNow = now >= t && now < t + 3 * H;
    html += `<div class="hr${isNow ? ' now' : ''}"><div class="tm">${fHour(t)}</div>` +
      (w ? `<div>${arrow(w.d)}</div><div class="ws">${fW(w.s)}</div><div class="tm">g${fW(w.g)}</div>` : '<div>–</div>') +
      `<div class="wv">${v ? fH(v.h, 1) : ''}${v?.p ? '<br>' + v.p.toFixed(0) + 's' : ''}</div></div>`;
  }
  $('#hourly').innerHTML = html;
}

// ---------- chart ----------
let chartGeom = null;
function drawChart(t0, t1) {
  const d = S.data, el = $('#chart');
  const W = Math.max(300, el.clientWidth || 340), Hh = 190, padL = 30, padR = 8, padT = 22, padB = 22;
  // stable y-range across the whole week
  const all = d.tide.extremes.map((e) => e.h); let yMin = Math.min(...all), yMax = Math.max(...all);
  if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
  const pad = (yMax - yMin) * 0.12 || 0.2; yMin -= pad; yMax += pad;
  const x = (t) => padL + (t - t0) / (t1 - t0) * (W - padL - padR);
  const y = (h) => padT + (yMax - h) / (yMax - yMin) * (Hh - padT - padB);
  chartGeom = { t0, t1, x, y, W, padL, padR };
  let s = `<svg viewBox="0 0 ${W} ${Hh}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--water1)"/><stop offset="1" stop-color="var(--water2)"/></linearGradient></defs>`;
  // night shading
  for (const sn of d.sun) {
    const prevSet = d.sun[d.sun.indexOf(sn) - 1]?.set ?? sn.rise - 12 * H;
    const a = Math.max(t0, prevSet), b = Math.min(t1, sn.rise);
    if (b > a) s += `<rect x="${x(a)}" y="${padT - 14}" width="${x(b) - x(a)}" height="${Hh - padB - padT + 14}" fill="var(--night)"/>`;
  }
  const last = d.sun[d.sun.length - 1]; if (last && last.set < t1) s += `<rect x="${x(Math.max(t0, last.set))}" y="${padT - 14}" width="${x(t1) - x(Math.max(t0, last.set))}" height="${Hh - padB - padT + 14}" fill="var(--night)"/>`;
  // grid
  const step = niceStep((yMax - yMin) / 4);
  for (let g = Math.ceil(yMin / step) * step; g <= yMax; g += step) {
    s += `<line x1="${padL}" x2="${W - padR}" y1="${y(g)}" y2="${y(g)}" stroke="var(--grid)"/>` +
      `<text x="${padL - 4}" y="${y(g) + 3}" text-anchor="end">${S.units.h === 'ft' ? (g * 3.28084).toFixed(0) : +g.toFixed(1)}</text>`;
  }
  for (let t = t0; t <= t1 + 1; t += 3 * H) {
    s += `<line x1="${x(t)}" x2="${x(t)}" y1="${padT - 14}" y2="${Hh - padB}" stroke="var(--grid)"/>`;
    if (t < t1 - H) s += `<text x="${x(t) + 2}" y="${Hh - 7}">${fHour(t)}</text>`;
  }
  // curve
  const pts = [];
  for (let t = t0; t <= t1; t += 10 * 60e3) { const h = d.tide.at(t); if (h != null) pts.push([x(t), y(h)]); }
  if (pts.length) {
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
    s += `<path d="${line}L${pts[pts.length - 1][0]},${Hh - padB}L${pts[0][0]},${Hh - padB}Z" fill="url(#wg)"/>` +
      `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.2"/>`;
  }
  // extremes
  for (const e of d.tide.extremes.filter((e) => e.t >= t0 && e.t < t1)) {
    const ex = x(e.t), ey = y(e.h), col = e.type === 'H' ? 'var(--hi)' : 'var(--lo)';
    const ty = e.type === 'H' ? ey - 7 : ey + 14, anchor = ex < padL + 24 ? 'start' : ex > W - 30 ? 'end' : 'middle';
    s += `<circle cx="${ex}" cy="${ey}" r="3.5" fill="${col}"/><text class="xl" x="${ex}" y="${Math.max(10, Math.min(Hh - padB - 2, ty))}" text-anchor="${anchor}">${fTime(e.t)}</text>`;
  }
  // now
  const now = Date.now();
  if (now >= t0 && now < t1) { const h = d.tide.at(now);
    s += `<line x1="${x(now)}" x2="${x(now)}" y1="${padT - 14}" y2="${Hh - padB}" stroke="var(--now)" stroke-width="1.5" stroke-dasharray="3 3"/>` +
      (h != null ? `<circle cx="${x(now)}" cy="${y(h)}" r="5" fill="var(--now)" stroke="var(--card)" stroke-width="2"/>` : ''); }
  // scrub
  if (S.scrubT != null) { const h = d.tide.at(S.scrubT);
    s += `<line x1="${x(S.scrubT)}" x2="${x(S.scrubT)}" y1="${padT - 14}" y2="${Hh - padB}" stroke="var(--ink)" stroke-opacity=".6"/>` +
      (h != null ? `<circle cx="${x(S.scrubT)}" cy="${y(h)}" r="4.5" fill="var(--ink)"/>` : '');
    $('#scrub').textContent = `${fTime(S.scrubT)} · ${fH(h)}`;
  } else $('#scrub').textContent = 'Drag across the chart to read heights';
  el.innerHTML = s + '</svg>';
}
function niceStep(r) { const p = 10 ** Math.floor(Math.log10(r)), n = r / p; return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p; }

function chartTime(ev) {
  const g = chartGeom, r = $('#chart').getBoundingClientRect();
  const px = (ev.clientX - r.left) / r.width * g.W;
  const f = Math.min(1, Math.max(0, (px - g.padL) / (g.W - g.padL - g.padR)));
  return g.t0 + f * (g.t1 - g.t0);
}
function bindChart() {
  const el = $('#chart'); let down = false, sx = 0, sy = 0, dragging = false;
  el.addEventListener('pointerdown', (e) => { down = true; dragging = false; sx = e.clientX; sy = e.clientY; });
  el.addEventListener('pointermove', (e) => {
    if (!down || !chartGeom) return;
    if (!dragging && Math.abs(e.clientX - sx) > 6 && Math.abs(e.clientX - sx) > Math.abs(e.clientY - sy)) { dragging = true; el.setPointerCapture(e.pointerId); }
    if (dragging) { S.scrubT = chartTime(e); drawChart(chartGeom.t0, chartGeom.t1); renderConditions(); }
  });
  const up = (e) => { if (down && !dragging && chartGeom && e.type === 'pointerup') { S.scrubT = chartTime(e); drawChart(chartGeom.t0, chartGeom.t1); renderConditions(); } down = false; };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}

// ---------- search & favourites ----------
function openSheet() { $('#sheet').hidden = false; renderFavs(); $('#results').innerHTML = ''; $('#q').value = ''; setTimeout(() => $('#q').focus(), 50); }
function closeSheet() { $('#sheet').hidden = true; }
let qTimer;
async function search(q) {
  if (q.trim().length < 2) { $('#results').innerHTML = ''; return; }
  try {
    const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=10&language=en&format=json`);
    const res = j.results || [];
    $('#results').innerHTML = res.length ? '' : '<div class="empty">No matches</div>';
    for (const r of res) {
      const b = document.createElement('button'); b.className = 'row';
      b.innerHTML = `<span>${r.name}<small>${[r.admin1, r.country].filter(Boolean).join(', ')}</small></span>`;
      b.onclick = () => { closeSheet(); loadLocation({ name: r.name, lat: r.latitude, lon: r.longitude }); };
      $('#results').appendChild(b);
    }
  } catch { $('#results').innerHTML = '<div class="empty">Search failed — offline?</div>'; }
}
function renderFavs() {
  const el = $('#favs'); el.innerHTML = S.favs.length ? '' : '<div class="empty">Tap ☆ on a location to save it here.</div>';
  S.favs.forEach((f, i) => {
    const b = document.createElement('div'); b.className = 'row';
    b.innerHTML = `<span>${f.name}<small>${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}</small></span><button class="del" aria-label="Remove">✕</button>`;
    b.onclick = (e) => { if (e.target.classList.contains('del')) { S.favs.splice(i, 1); save('favs', S.favs); renderFavs(); updateFavBtn(); return; } closeSheet(); loadLocation(f); };
    el.appendChild(b);
  });
}
const favIdx = () => S.loc ? S.favs.findIndex((f) => Math.abs(f.lat - S.loc.lat) < 1e-3 && Math.abs(f.lon - S.loc.lon) < 1e-3) : -1;
function updateFavBtn() { const on = favIdx() >= 0; $('#btnFav').textContent = on ? '★' : '☆'; $('#btnFav').classList.toggle('on', on); }
function toggleFav() {
  if (!S.loc) return; const i = favIdx();
  if (i >= 0) S.favs.splice(i, 1);
  else { const name = prompt('Name this spot', S.loc.name || '') ; if (name === null) return; S.loc.name = name || S.loc.name; $('#locName').textContent = S.loc.name; save('loc', S.loc); S.favs.push({ ...S.loc }); }
  save('favs', S.favs); updateFavBtn();
}

// ---------- init ----------
function init() {
  bindChart();
  $('#btnGps').onclick = useGps;
  $('#btnSearch').onclick = openSheet;
  $('#closeSheet').onclick = closeSheet;
  $('#sheet').onclick = (e) => { if (e.target.id === 'sheet') closeSheet(); };
  $('#q').oninput = (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => search(e.target.value), 300); };
  $('#btnFav').onclick = toggleFav;
  $('#prevDay').onclick = () => { if (S.day > 0) { S.day--; S.scrubT = null; render(); } };
  $('#nextDay').onclick = () => { if (S.day < 7) { S.day++; S.scrubT = null; render(); } };
  $('#uH').onclick = () => { S.units.h = S.units.h === 'm' ? 'ft' : 'm'; save('units', S.units); render(); };
  $('#uW').onclick = () => { const k = Object.keys(WCONV); S.units.w = k[(k.indexOf(S.units.w) + 1) % k.length]; save('units', S.units); render(); };
  $('#uSrc').onclick = () => { S.pref = S.pref === 'model' ? 'auto' : 'model'; save('srcPref', S.pref); loadLocation(S.loc); };
  window.addEventListener('resize', () => S.data && renderDay());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.data) render(); });
  setInterval(() => !document.hidden && S.data && S.scrubT == null && render(), 60e3);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (S.loc) loadLocation(S.loc); else useGps();
}
init();
