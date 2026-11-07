// Presentation only: all measured data remain in their original units in app.js.
const $ = s => document.querySelector(s);
const COLORS = ['#ffb347', '#6fb7ff', '#b98bff', '#7be0a6', '#ff7a8a'];
const number = (v, digits = 1) => v.toLocaleString('en', { maximumFractionDigits: digits });

function canvas(id) {
  const c = $(id), rect = c.getBoundingClientRect();
  const W = Math.max(240, rect.width), H = rect.height || 240, dpr = window.devicePixelRatio || 1;
  const width = Math.round(W * dpr), height = Math.round(H * dpr);
  if (c.width !== width || c.height !== height) { c.width = width; c.height = height; }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H); g.font = '11px system-ui, sans-serif';
  return { g, W, H };
}
function empty({ g, W, H }, title, detail) {
  g.strokeStyle = '#2b3b46'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(W / 2 - 16, H / 2 - 30); g.lineTo(W / 2 - 7, H / 2 - 40); g.lineTo(W / 2 + 2, H / 2 - 26); g.lineTo(W / 2 + 16, H / 2 - 44); g.stroke();
  g.textAlign = 'center'; g.fillStyle = '#cad7df'; g.font = '13px system-ui, sans-serif';
  g.fillText(title, W / 2, H / 2);
  g.fillStyle = '#96a9b8'; g.font = '11px system-ui, sans-serif';
  // Wrap the explanatory empty state on narrow phones.
  const words = detail.split(' '); let line = '', y = H / 2 + 23;
  for (const word of words) { if (g.measureText(line + word).width > W - 30) { g.fillText(line.trim(), W / 2, y); y += 17; line = ''; } line += word + ' '; }
  g.fillText(line.trim(), W / 2, y); g.textAlign = 'left';
}
function axes({ g, W, H }, xl, yl, xr, yr, fmtX = v => number(v), fmtY = v => number(v, 0)) {
  const L = 46, B = 46, T = 29, R = 22, right = W - R, bottom = H - B;
  g.font = '10px system-ui, sans-serif'; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const x = L + (right - L) * i / 4, y = T + (bottom - T) * i / 4;
    g.strokeStyle = '#26343e'; g.beginPath(); g.moveTo(L, y); g.lineTo(right, y); g.stroke();
    g.fillStyle = '#96a9b8'; g.textAlign = 'right'; g.fillText(fmtY(yr[1] - (yr[1] - yr[0]) * i / 4), L - 8, y + 3);
    g.textAlign = 'center'; g.fillText(fmtX(xr[0] + (xr[1] - xr[0]) * i / 4), x, bottom + 17);
  }
  g.strokeStyle = '#4a5b68'; g.beginPath(); g.moveTo(L, T); g.lineTo(L, bottom); g.lineTo(right, bottom); g.stroke();
  g.fillStyle = '#b9cbd7'; g.textAlign = 'left'; g.fillText(yl, L, 13);
  g.textAlign = 'center'; g.fillText(xl, (L + right) / 2, H - 7); g.textAlign = 'left';
  return { L, T, right, bottom, mx: v => L + (right - L) * (v - xr[0]) / (xr[1] - xr[0] || 1), my: v => bottom - (bottom - T) * (v - yr[0]) / (yr[1] - yr[0] || 1) };
}
function outputs(S) { return S.sc ? S.sc.probes.map((p, k) => ({ p, k })).filter(o => o.p.role === 'out') : []; }
function legend(id, outs, laser = false) {
  const html = outs.map(o => `<span style="color:${COLORS[o.k % COLORS.length]}"><i></i>${o.p.name}</span>`).join('') + (laser ? '<span style="color:#7be0a6">┆ Laser</span>' : '');
  if ($(id).innerHTML !== html) $(id).innerHTML = html;
}
function clip(g, ax) { g.save(); g.beginPath(); g.rect(ax.L, ax.T, ax.right - ax.L, ax.bottom - ax.T); g.clip(); }

export function drawTransfer(S) {
  const ctx = canvas('#plotT'), { g } = ctx, d = S.sweepData, control = S.controlData || [], outs = outputs(S);
  legend('#transferLegend', outs);
  if (control.length) $('#transferLegend').insertAdjacentHTML('beforeend', '<span style="color:#aab0b8"><i></i>Control χ³ = 0</span>');
  let xmax = 0, ymax = 0;
  for (const data of [d, control]) for (const r of data) { xmax = Math.max(xmax, r.pin); for (const o of outs) ymax = Math.max(ymax, r.v[o.k]); }
  if (Math.max(d.length, control.length) < 2 || !(xmax > 0) || !(ymax > 0)) {
    empty(ctx, S.sweep ? 'Measurement starting …' : 'No ramp loop yet', S.preset?.sweep ? 'Start a ramp: increase and then decrease the amplitude.' : 'This preset has no ramp.');
    $('#transferNote').textContent = '↗ Up: solid · ↘ Down: dashed'; return;
  }
  // Both axes share the same reference. Unlike instantaneous output/input this preserves the hysteresis shape.
  const top = Math.max(100, Math.ceil(ymax / xmax * 100 / 20) * 20), soliton = S.preset.id === 'soliton';
  const ax = axes(ctx, soliton ? 'Rel. total intensity / maximum (%)' : 'Rel. input intensity / maximum (%)', soliton ? 'Rel. center intensity (%)' : 'Rel. output intensity / input max. (%)', [0, 100], [0, top]);
  clip(g, ax);
  for (const data of [control, d]) for (const o of outs) for (const dir of [1, -1]) {
    g.strokeStyle = data === control ? '#aab0b8' : COLORS[o.k % COLORS.length]; g.globalAlpha = dir > 0 ? 1 : .75; g.setLineDash(dir > 0 ? [] : [6, 4]); g.lineWidth = 1.8;
    g.beginPath(); let first = true;
    for (const r of data) {
      if (r.dir !== dir) { first = true; continue; }
      const x = ax.mx(100 * r.pin / xmax), y = ax.my(100 * r.v[o.k] / xmax);
      if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y);
    }
    g.stroke();
  }
  g.restore();
  $('#transferNote').textContent = `↗ Up: solid · ↘ Down: dashed. Both axes: 100 % = ${soliton ? 'highest total intensity measured so far' : 'highest input measured so far'}.`;
}

export function drawSpectrum(S) {
  const ctx = canvas('#plotS'), { g } = ctx, outs = outputs(S);
  legend('#spectrumLegend', outs, !!S.spec);
  if (!S.spec) {
    empty(ctx, S.spectrum ? 'Measuring spectrum …' : 'No spectrum yet', S.preset?.spectrum ? 'Start step 1 to find the resonances.' : 'The “Kerr ring resonator” preset provides a spectrum measurement.'); return;
  }
  const { wl, T } = S.spec;
  const ax = axes(ctx, 'Vacuum wavelength λ₀ (cells)', 'Single-point proxy: out / in (%)', [wl[0], wl[wl.length - 1]], [0, 100], v => number(v, 2));
  clip(g, ax);
  for (const o of outs) {
    g.strokeStyle = COLORS[o.k % COLORS.length]; g.lineWidth = 1.6; g.beginPath();
    T[o.k].forEach((v, i) => { const x = ax.mx(wl[i]), y = ax.my(v * 100); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
  }
  g.strokeStyle = '#7be0a6'; g.setLineDash([3, 4]); const x = ax.mx(S.p.wl); g.beginPath(); g.moveTo(x, ax.T); g.lineTo(x, ax.bottom); g.stroke();
  g.restore(); S.spec.ax = ax;
}
