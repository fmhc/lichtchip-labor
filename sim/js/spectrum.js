// Same frequency order, phase recurrence and accumulation order as the original direct DFT.
// Yield after four frequencies; cancellation is checked before any next block/result.
export async function spectrumDFT(ts, n, nts, w0, bw, dt, valid, progress) {
  const nf = 700, wls = [], power = Array.from({ length: nts }, () => new Float64Array(nf));
  for (let i = 0; i < nf; i++) wls.push(2 * Math.PI / (w0 * (1 + bw * 1.2 * (1 - 2 * i / (nf - 1)))));
  for (let i = 0; i < nf; i++) {
    if (i % 4 === 0) {
      progress(100 * i / nf); await new Promise(resolve => setTimeout(resolve, 0));
      if (!valid()) return null;
    }
    const om = 2 * Math.PI / wls[i], cr = Math.cos(om * dt), si = Math.sin(om * dt);
    const re = new Float64Array(nts), im = new Float64Array(nts);
    let c = 1, s = 0;
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < nts; j++) { const v = ts[k * nts + j]; re[j] += v * c; im[j] -= v * s; }
      const c2 = c * cr - s * si; s = s * cr + c * si; c = c2;
    }
    for (let j = 0; j < nts; j++) power[j][i] = re[j] * re[j] + im[j] * im[j];
  }
  return { wls, power };
}

export function resonance(spec, k, near) {
  if (k < 0 || !spec || spec.tailRatio > 1e-4) return null;
  const { wl } = spec, T = spec.T[k];
  let best = -1, score = Infinity;
  for (let i = 2; i < T.length - 2; i++) if (T[i] < T[i - 1] && T[i] <= T[i + 1] && T[i] < 0.8) {
    const value = Math.abs(wl[i] - near) * (0.3 + T[i]);
    if (value < score) { score = value; best = i; }
  }
  if (best < 0) return null;
  let l = best - 1, r = best + 1;
  while (l > 0 && T[l - 1] >= T[l]) l--;
  while (r < T.length - 1 && T[r + 1] >= T[r]) r++;
  const base = x => T[l] + (T[r] - T[l]) * (x - wl[l]) / (wl[r] - wl[l]);
  const depth = base(wl[best]) - T[best];
  if (!(depth > 0.05) || T[l] - T[best] < depth / 2 || T[r] - T[best] < depth / 2) return null;
  const delta = i => T[i] - (base(wl[i]) - depth / 2);
  let a = best, b = best;
  while (a > l && delta(a) < 0) a--;
  while (b < r && delta(b) < 0) b++;
  if (!(delta(a) >= 0 && delta(b) >= 0) || a === best || b === best) return null;
  const cross = (i, j) => wl[i] - delta(i) * (wl[j] - wl[i]) / (delta(j) - delta(i));
  const left = cross(a, a + 1), right = cross(b - 1, b), width = right - left;
  const resolution = wl[best] ** 2 / spec.duration;
  if (!(width > 2 * resolution) || b - a < 3) return null;
  // A clipped dip can manufacture a false half-depth if its endpoint is used as a
  // shoulder. Require baseline support at least two fitted widths on each side.
  if (wl[best] - wl[l] < 2 * width || wl[r] - wl[best] < 2 * width) return null;
  return { wl: wl[best], width, Q: wl[best] / width, left, right, resolution, baseline: base(wl[best]) };
}
