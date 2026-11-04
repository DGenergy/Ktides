/* Particle wind layer — a canvas over the map, particles advected through an
   interpolated 10 m wind grid, trails fading each frame (the marine-app look).
   Field: { w, s, e, n, nx, ny, hours: [{ u: Float32Array, v: Float32Array, spd: Float32Array, gust: Float32Array }] }
   u/v in knots (east/north), spd in knots. Grid row j runs south→north, column i west→east. */
const WindLayer = (() => {
  let map, canvas, ctx, field = null, hour = 0, particles = [], running = false, paused = false, raf = 0, moving = false, dpr = 1, W = 0, H = 0;
  let lastFrame = 0, contrast = 0; // 0..1 — how opaque the heat map under the particles is
  let bgLight = 0;                 // 0..1 — how light the basemap under the particles is (dark style 0, positron/topo 1)
  const RAMP = [[0, '#7FA7C4'], [5, '#6FBFD8'], [10, '#5FD68A'], [15, '#C9DE7A'], [20, '#F0C95A'], [25, '#F0A35A'], [30, '#E8774F'], [40, '#E0554D'], [50, '#C41E9F']];
  function color(kt) { let c = RAMP[0][1]; for (const [t, col] of RAMP) if (kt >= t) c = col; return c; }
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const RAMP_RGB = RAMP.map(([t, c]) => [t, hex(c)]);
  function colorSmooth(kt) { // interpolated ramp -> [r,g,b]
    if (kt <= RAMP_RGB[0][0]) return RAMP_RGB[0][1]; const last = RAMP_RGB[RAMP_RGB.length - 1]; if (kt >= last[0]) return last[1];
    for (let i = 1; i < RAMP_RGB.length; i++) { const [t1, c1] = RAMP_RGB[i], [t0, c0] = RAMP_RGB[i - 1]; if (kt <= t1) { const f = (kt - t0) / (t1 - t0); return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f]; } }
    return last[1];
  }
  function mixWhite(h, f) { const c = hex(h); return `rgb(${Math.round(c[0] + (255 - c[0]) * f)},${Math.round(c[1] + (255 - c[1]) * f)},${Math.round(c[2] + (255 - c[2]) * f)})`; }
  function mixBlack(h, f) { const c = hex(h); return `rgb(${Math.round(c[0] * (1 - f))},${Math.round(c[1] * (1 - f))},${Math.round(c[2] * (1 - f))})`; }
  // Zoom factor 0..1: zoomed out (≤5) 0, street-level (≥10) 1. Streaks get thicker and longer as you zoom in
  // so they read at the same visual weight against more detailed maps instead of shrinking to hairlines.
  function zoomF() { const z = map ? map.getZoom() : 6; return Math.max(0, Math.min(1, (z - 5) / 5)); }
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const invMercY = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
  // Render the speed field for an hour as an image aligned to the field's bounds in web-mercator,
  // ready for a MapLibre image source. Returns { url, coordinates }.
  function heatImage(f, h, alpha) {
    const IW = 160, IH = 120; const cv = document.createElement('canvas'); cv.width = IW; cv.height = IH; const c2 = cv.getContext('2d');
    const img = c2.createImageData(IW, IH); const d = img.data; const hr = f.hours[h]; const yN = mercY(f.n), yS = mercY(f.s);
    for (let r = 0; r < IH; r++) {
      const lat = invMercY(yN + (yS - yN) * r / (IH - 1)); const fy = Math.max(0, Math.min(f.ny - 1, (lat - f.s) / (f.n - f.s) * (f.ny - 1)));
      const j0 = Math.floor(fy), j1 = Math.min(j0 + 1, f.ny - 1), ty = fy - j0;
      for (let q = 0; q < IW; q++) {
        const fx = q / (IW - 1) * (f.nx - 1); const i0 = Math.floor(fx), i1 = Math.min(i0 + 1, f.nx - 1), tx = fx - i0;
        const s00 = hr.spd[j0 * f.nx + i0], s10 = hr.spd[j0 * f.nx + i1], s01 = hr.spd[j1 * f.nx + i0], s11 = hr.spd[j1 * f.nx + i1];
        const sp = (s00 + (s10 - s00) * tx) + ((s01 + (s11 - s01) * tx) - (s00 + (s10 - s00) * tx)) * ty;
        const rgb = colorSmooth(sp); const k = (r * IW + q) * 4; d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2]; d[k + 3] = Math.round(255 * alpha);
      }
    }
    c2.putImageData(img, 0, 0);
    return { url: cv.toDataURL('image/png'), coordinates: [[f.w, f.n], [f.e, f.n], [f.e, f.s], [f.w, f.s]] };
  }

  function resize() {
    const r = map.getContainer().getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.round(r.width * dpr); H = Math.round(r.height * dpr);
    canvas.width = W; canvas.height = H; canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
    ctx.clearRect(0, 0, W, H);
    if (field) seed();
  }
  // fewer, bolder particles when zoomed in (they are drawn larger there)
  function count() { const base = Math.round((W * H) / (dpr * dpr) / 380); return Math.max(700, Math.min(4000, Math.round(base * (1 - 0.45 * zoomF())))); }
  function bounds() { const b = map.getBounds(); return { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() }; }
  const HIST = 22;                  // history buffer; the streak uses 14 points zoomed out, all 22 zoomed in
  function spawn(p, b) { p.lng = b.w + Math.random() * (b.e - b.w); p.lat = b.s + Math.random() * (b.n - b.s); p.age = 0; p.life = 60 + Math.random() * 100; p.h = []; return p; }
  function seed() { const b = bounds(); const n = count(); particles = []; for (let i = 0; i < n; i++) { const p = spawn({}, b); p.age = Math.random() * p.life; particles.push(p); } }

  // bilinear sample of the selected hour at lng/lat -> [u, v, spd] in knots, or null outside the field
  function sample(lng, lat) {
    const f = field; if (!f || !f.hours[hour]) return null;
    if (lng < f.w && lng + 360 <= f.e) lng += 360; else if (lng > f.e && lng - 360 >= f.w) lng -= 360; // view re-wrapped across the antimeridian
    const fx = (lng - f.w) / (f.e - f.w) * (f.nx - 1), fy = (lat - f.s) / (f.n - f.s) * (f.ny - 1);
    if (fx < 0 || fy < 0 || fx > f.nx - 1 || fy > f.ny - 1) return null;
    const i0 = Math.floor(fx), j0 = Math.floor(fy), i1 = Math.min(i0 + 1, f.nx - 1), j1 = Math.min(j0 + 1, f.ny - 1);
    const tx = fx - i0, ty = fy - j0; const h = f.hours[hour];
    const k00 = j0 * f.nx + i0, k10 = j0 * f.nx + i1, k01 = j1 * f.nx + i0, k11 = j1 * f.nx + i1;
    const lerp = (a, b, t) => a + (b - a) * t;
    const u = lerp(lerp(h.u[k00], h.u[k10], tx), lerp(h.u[k01], h.u[k11], tx), ty);
    const v = lerp(lerp(h.v[k00], h.v[k10], tx), lerp(h.v[k01], h.v[k11], tx), ty);
    return [u, v, Math.hypot(u, v)];
  }

  function frame(t) {
    raf = 0; if (!running) return;
    if (paused || !field) { raf = requestAnimationFrame(frame); return; }
    const dt = Math.min(50, t - lastFrame || 16); lastFrame = t;
    const b = bounds();
    // degrees per screen pixel at this view, so particle speed on screen is independent of zoom (px/frame ∝ knots)
    const degPerPxX = (b.e - b.w) / (W / dpr), degPerPxY = (b.n - b.s) / (H / dpr);
    const zf = zoomF();
    const pxPerKt = 0.03 * (dt / 16) * (1 + 0.8 * zf); // 20 kt ≈ 0.6 px per frame at 60 fps zoomed out, ~1.1 zoomed in
    const maxPts = 14 + Math.round((HIST - 14) * zf);  // streak point budget grows with zoom
    if (moving) { ctx.clearRect(0, 0, W, H); }
    else { ctx.globalCompositeOperation = 'destination-in'; ctx.fillStyle = 'rgba(0,0,0,0.84)'; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'source-over'; }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const byColor = new Map();
    for (const p of particles) {
      const s = sample(p.lng, p.lat);
      if (!s || p.age++ > p.life) { spawn(p, b); continue; }
      const nlng = p.lng + s[0] * pxPerKt * degPerPxX, nlat = p.lat + s[1] * pxPerKt * degPerPxY;
      p.h.push(p.lng, p.lat); if (p.h.length > HIST * 2) p.h.splice(0, 2);
      p.lng = nlng; p.lat = nlat;
      const c = map.project([nlng, nlat]);
      if (c.x < -20 || c.y < -20 || c.x > W / dpr + 20 || c.y > H / dpr + 20) { spawn(p, b); continue; }
      // streak length grows with speed: 2 history points at calm, the full budget at 35 kt+
      const n = Math.min(p.h.length / 2, 2 + Math.round(3 * zf) + Math.round(Math.min(s[2], 35) / 35 * (maxPts - 5)));
      const col = color(s[2]); let list = byColor.get(col); if (!list) { list = []; byColor.set(col, list); }
      const seg = [c.x * dpr, c.y * dpr]; for (let k = 1; k <= n; k++) { const idx = p.h.length - 2 * k; const q = map.project([p.h[idx], p.h[idx + 1]]); seg.push(q.x * dpr, q.y * dpr); }
      list.push({ seg, kt: s[2] });
    }
    // Legibility has two enemies. An opaque heat map puts the same ramp colours underneath, so the
    // core blends toward white over a dark halo. A light basemap washes the pale ramp colours out, so
    // there the streak is drawn as a tapered comet — a darkened, opaque head thinning and fading to
    // the tail — which reads as direction + gradient without an outline (outlines looked like ants).
    const lift = Math.min(1, contrast * 1.4);
    const scale = 1 + 0.35 * zf;                          // stroke width scale with zoom
    const light = lift < 0.05 && bgLight > 0.3;
    // three taper stages from head to tail: [alpha, width factor, share of the streak]
    const STAGES = light ? [[1, 1.15, 0.34], [0.62, 0.85, 0.33], [0.3, 0.55, 0.33]] : [[1, 1, 1]];
    for (const [col, list] of byColor) {
      const w = (0.9 + Math.min(list[0].kt, 40) / 36) * dpr * scale;
      let core = col;
      if (lift > 0.05) core = mixWhite(col, 0.75 * lift);
      else if (light) core = mixBlack(col, 0.38 * bgLight);
      if (!light && lift > 0.05) { // dark halo under the strokes over the heat map
        ctx.beginPath();
        for (const { seg } of list) { ctx.moveTo(seg[0], seg[1]); for (let k = 2; k < seg.length; k += 2) ctx.lineTo(seg[k], seg[k + 1]); }
        ctx.strokeStyle = 'rgb(5,10,14)'; ctx.lineWidth = w + 2.2 * dpr * lift; ctx.globalAlpha = 0.45 * lift; ctx.stroke();
      }
      let from = 0;
      for (const [alpha, wf, share] of STAGES) {
        ctx.beginPath();
        for (const { seg } of list) {
          const pts = seg.length / 2; const a = Math.floor(pts * from), b2 = Math.min(pts - 1, Math.ceil(pts * (from + share)));
          if (b2 <= a) continue;
          ctx.moveTo(seg[a * 2], seg[a * 2 + 1]); for (let k = a + 1; k <= b2; k++) ctx.lineTo(seg[k * 2], seg[k * 2 + 1]);
        }
        ctx.strokeStyle = core; ctx.lineWidth = w * wf; ctx.globalAlpha = (light ? 1 : 0.75 + 0.2 * lift) * alpha; ctx.stroke();
        from += share;
      }
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }

  return {
    init(m, cv) {
      map = m; canvas = cv; ctx = cv.getContext('2d');
      resize(); window.addEventListener('resize', resize); map.on('resize', resize);
      map.on('movestart', () => { moving = true; }); map.on('moveend', () => { moving = false; if (field) seed(); });
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.stop(); else if (field && this.wanted) this.start(); });
    },
    wanted: false,
    setField(f) { field = f; if (f) seed(); else ctx.clearRect(0, 0, W, H); },
    setHour(h) { hour = Math.max(0, Math.min((field ? field.hours.length : 1) - 1, h)); },
    start() { this.wanted = true; if (running) return; running = true; lastFrame = performance.now(); raf = requestAnimationFrame(frame); },
    stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
    off() { this.wanted = false; this.stop(); field = null; ctx.clearRect(0, 0, W, H); },
    pause(p) { paused = p; },
    setContrast(k) { contrast = Math.max(0, Math.min(1, k || 0)); },
    setBackground(l) { bgLight = Math.max(0, Math.min(1, l || 0)); },
    sampleAt(lng, lat) { return sample(lng, lat); },
    heatImage, colorSmooth, color, RAMP
  };
})();
