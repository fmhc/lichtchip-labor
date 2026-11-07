// UI-only state and readouts. No field values are read back from the GPU.
import { DT } from './engine.js';
const $ = s => document.querySelector(s);
export const PARAM_HELP = {
  wl: 'Vacuum wavelength, measured in grid cells.',
  w: 'Width of the guiding core.',
  nCore: 'Core refractive index: determines light speed and confinement.',
  nClad: 'Refractive index of the surrounding material.',
  n: 'Refractive index of the homogeneous material.',
  gap: 'Gap between the guiding cores.',
  sepOut: 'Centerline separation at the inputs and outputs.',
  bendLen: 'Length of the smooth transitions to the coupling section.',
  chi3: 'Nonnegative material response strength. Negative values are disabled for stability.',
  ampA: 'Field amplitude of source A. Intensity grows approximately as A².',
  ampB: 'Field amplitude of source B. Intensity grows approximately as B².',
  phaseB: 'Phase offset of source B relative to A, in degrees.',
  R: 'Radius to the ring waveguide centerline.',
  drop: '1: additional ring output. 0: through bus only.',
  w0: 'Beam radius where the field amplitude falls to 1/e.',
  L: 'Beam propagation distance in grid cells.',
};
const fmt = v => v.toLocaleString('en', { maximumSignificantDigits: 3 });
const colorValue = v => v !== 0 && Math.abs(v) < .001 ? v.toExponential(1).replace('.0e', 'e').replace('e-', 'e−') : fmt(v);
export function updateScale(S) {
  if (!S.sc) return;
  const nm = 1550 / S.p.wl, px = $('#gpu').getBoundingClientRect().width / S.sc.W;
  const target = Math.min(90, $('#stage').clientWidth * .2) / px;
  const power = 10 ** Math.floor(Math.log10(target));
  const cells = [5, 2, 1].map(v => v * power).find(v => v <= target) || power;
  $('#scaleBar').style.width = `${cells * px}px`;
  $('#scaleLabel').textContent = `${fmt(cells)} cells · ${fmt(cells * nm / 1000)} µm`;
  $('#unitNote').textContent = `Conversion for λ₀ ≙ 1550 nm: 1 cell = 1550 / λ₀ nm = ${fmt(nm)} nm. Brightness changes the display only.`;
}
export function updateColorKey(S) {
  const field = S.view.mode === 0, log = S.view.mode === 2;
  $('#colorTitle').textContent = field ? 'Field E ±' : log ? 'Intensity · log' : 'Intensity';
  $('#colorRamp').style.background = field ? 'linear-gradient(90deg, #4d9eff, #090a0e 50%, #ff9e40)' : 'linear-gradient(90deg, #000, #4d0f6b, #c72e57, #fc8c1f, #fff7c7)';
  const max = 1 / (field ? S.view.gainF : S.view.gainI);
  const ticks = field ? [`−${colorValue(max)}`, '0', `+${colorValue(max)}`] : log ? [colorValue(max * 10 ** -S.view.decades), colorValue(max * 10 ** (-S.view.decades / 2)), colorValue(max)] : ['0', colorValue(max / 2), colorValue(max)];
  $('#colorTicks').innerHTML = ticks.map(t => `<span>${t}</span>`).join('');
  $('#colorRamp').title = `Relative units; values beyond the scale saturate. ${field ? '' : 'Time-averaged E².'} Material color is overlaid.`;
}
export function wirePointer(S) {
  const c = $('#gpu'), out = $('#cursorReadout');
  c.addEventListener('pointermove', ev => {
    if (!S.sc) return;
    const r = c.getBoundingClientRect(), x = Math.floor((ev.clientX - r.left) / r.width * S.sc.W), y = Math.floor((ev.clientY - r.top) / r.height * S.sc.H);
    if (x < 0 || y < 0 || x >= S.sc.W || y >= S.sc.H) return;
    const um = 1.55 / S.p.wl, n = Math.sqrt(S.sc.eps[y * S.sc.W + x]);
    out.textContent = `x ${x} · y ${y} cells | ${(x * um).toFixed(2)} · ${(y * um).toFixed(2)} µm | n = ${n.toFixed(3)}`;
  });
  c.addEventListener('pointerleave', () => { out.textContent = 'Hover over the field: position & refractive index'; });
}
export function updateWorkflow(S) {
  const ring = !!S.preset?.spectrum, measuring = !!S.spectrum || !!S.uiAnalyzing;
  const busy = measuring || !!S.sweep;
  $('#run').textContent = S.running ? 'Pause' : 'Resume';
  $('#runState').textContent = S.running ? '● RUNNING' : 'Ⅱ PAUSED';
  $('#sourceNote').hidden = !busy;
  $('#measurement').hidden = !S.preset?.sweep && !ring;
  $('.workflow').classList.toggle('ring', ring);
  $('#measurementHint').textContent = 'Dynamic ramp loop · ⟨E²⟩ proxy';
  $('#sweepNumber').textContent = ring ? '3' : '↗';
  $('#specStart').disabled = busy;
  $('#detune').disabled = !S.spec?.resonance || busy;
  $('#swStart').disabled = busy;
  $('#swControl').disabled = busy;
  $('#exportData').disabled = !S.spec && !S.sweepData.length && !S.controlData.length;
  $('#swStop').disabled = !S.sweep;
  const percent = S.spectrum ? Math.min(100, 100 * (S.engine.step - S.engine.tsBase) / S.spectrum.steps) : S.spec ? 100 : 0;
  $('#specProgress').value = S.uiAnalyzing ? S.analysisProgress : percent;
  $('#specBadge').textContent = S.uiAnalyzing ? `DFT ${Math.round(S.analysisProgress)} %` : S.spectrum ? `${Math.round(percent)} %` : S.spec ? 'Measured' : 'Ready';
  $('#detuneBadge').textContent = S.uiDetuned ? 'Set' : S.spec ? S.spec.resonance ? 'Ready' : 'Unresolved' : 'Next';
  $('#stepSpectrum').classList.toggle('active', measuring || (!S.spec && !busy));
  $('#stepSpectrum').classList.toggle('complete', !!S.spec && !measuring);
  $('#stepDetune').classList.toggle('active', !!S.spec && !S.uiDetuned && !busy);
  $('#stepDetune').classList.toggle('complete', !!S.uiDetuned);
  const u = S.sweep ? Math.max(0, Math.min(2, (S.engine.step * DT - S.sweep.t0) / S.sweep.T)) : 0;
  $('#sweepProgress').value = S.sweep ? u * 50 : S.uiSweepDone ? 100 : 0;
  $('#sweepBadge').textContent = S.sweep ? S.engine.step * DT < S.sweep.t0 ? 'Settling' : `${u <= 1 ? '↗ Up' : '↘ Down'}` : S.uiSweepDone ? 'Complete' : 'Ready';
  $('#sweepPanel').classList.toggle('active', !!S.sweep || (S.uiDetuned && !S.uiSweepDone && !busy));
  $('#sweepPanel').classList.toggle('complete', !!S.uiSweepDone);
  $('#specStart').classList.toggle('primary', ring && !S.spec && !busy);
  $('#detune').classList.toggle('primary', ring && !!S.spec && !S.uiDetuned && !busy);
  $('#swStart').classList.toggle('primary', !busy && (!ring || !!S.uiDetuned));
}
