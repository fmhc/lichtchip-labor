// Shared URL/UI limits. Keep documented bounds in README in sync.
export function number(value, name, min, max, integer = false) {
  const n = typeof value === 'string' && !value.trim() ? NaN : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n)))
    throw new Error(`${name}: ${integer ? 'integer' : 'finite number'} from ${min} to ${max} required.`);
  return n;
}
export function parameters(preset, values, instant, tauPeriods) {
  for (const key of Object.keys(values)) if (!preset.params.some(q => q.k === key)) throw new Error(`Unknown parameter: ${key}`);
  const p = Object.fromEntries(preset.params.map(q => [q.k, number(values[q.k] ?? q.v, q.label, q.min, q.max, q.k === 'drop')]));
  if ('nCore' in p && p.nCore <= p.nClad) throw new Error('Guided mode requires nCore > nClad.');
  relaxation(instant, tauPeriods, p.wl);
  return p;
}
export function relaxation(instant, tau, wl) {
  number(tau, 'τ in periods', 0.05, 1000);
  if (!instant && tau * wl < 0.5) throw new Error('Debye requires Δt/τ ≤ 1.');
}
export function gridBudget(W, H, limits = {}) {
  number(W, 'Grid width', 1, 8192, true); number(H, 'Grid height', 1, 8192, true);
  const cells = W * H;
  // 44 bytes/cell GPU + CPU maps/staging; transactional load holds two scenes.
  if (!Number.isSafeInteger(cells) || cells > 3_000_000 || 2 * 80 * cells > 480_000_000)
    throw new Error('Cell budget exceeded (maximum 3 million cells; 480 MB build budget).');
  if (8 * cells > Math.min(limits.maxStorageBufferBindingSize ?? 134217728, limits.maxBufferSize ?? 268435456))
    throw new Error('Grid exceeds GPU binding/buffer limit.');
  if (Math.max(W, H) > (limits.maxTextureDimension2D ?? 8192) || Math.ceil(Math.max(W, H) / 16) > (limits.maxComputeWorkgroupsPerDimension ?? 65535))
    throw new Error('Grid exceeds GPU canvas/dispatch limit.');
}
