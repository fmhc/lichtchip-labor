import { Engine, DT } from './engine.js';
import { buildScene } from './scene.js';
import { PRESETS } from './presets.js';
import { selftest, diagColumns } from './selftest.js';
import { drawTransfer as plotTransfer, drawSpectrum as plotSpectrum } from './ui-plots.js';
import { PARAM_HELP, updateScale, updateColorKey, wirePointer, updateWorkflow } from './ui-lab.js';
import { number, parameters, relaxation } from './validation.js';
import { spectrumDFT, resonance } from './spectrum.js';

const $ = s => document.querySelector(s);
const qs = new URLSearchParams(location.search);
const COLORS = ['#ffb347', '#6fb7ff', '#b98bff', '#7be0a6', '#ff7a8a'];

const S = {
	engine: null, preset: null, p: {}, sc: null, running: true, spf: 60, view: { mode: 0, showMat: true, gain: 0, decades: 3 },
	kerrInstant: true, tauPeriods: 30, amp: [], sweep: null, sweepData: [], spectrum: null, spec: null, inflight: false,
	rate: 0, lastT: performance.now(), lastStep: 0,
	generation: 0, building: false, fatal: false, controlData: [], error: '',
};

function showError(e, fatal = false) {
	S.error = e.message || String(e);
	$('#error').hidden = false; $('#errorText').textContent = S.error;
	$('#errorTitle').textContent = fatal ? 'Simulation stopped' : S.sc ? 'Input rejected · previous scene preserved' : 'Input rejected';
	$('#gpuHelp').hidden = !fatal;
	$('#status').textContent = `Error: ${S.error}`; document.title = 'ERR ' + (fatal ? 'webgpu' : 'input');
	if (!S.sc) {
		$('#runState').textContent = 'NOT READY';
		for (const el of document.querySelectorAll('main button, main input, main select:not(#preset)')) el.disabled = true;
	}
	if (fatal) {
		abortMeasurements(); S.running = false; S.fatal = true; S.inflight = false;
		if (S.engine) S.engine.usable = false;
		if (S.sc) updateWorkflow(S);
		for (const el of document.querySelectorAll('main button, main input, main select')) el.disabled = true;
		$('#reload').hidden = false; $('#reload').disabled = false;
		$('#runState').textContent = 'ERROR';
	}
}
function clearError() { S.error = ''; $('#error').hidden = true; document.title = 'Lichtchip Lab'; }
function abortMeasurements() {
	S.generation++; S.spectrum = null; S.sweep = null; S.uiAnalyzing = false; S.analysisProgress = 0;
	S.inflight = false;
	S.lastProbeAt = -1; S.uiSweepDone = false; S.autoSteps = 0;
	if (S.engine) { S.engine.stopRecording(); S.engine.linear = false; }
	$('#specState').textContent = ''; $('#swState').textContent = '';
}
function resetScene() {
	abortMeasurements(); S.engine.reset(); S.amp = []; S.sweepData = []; S.controlData = [];
	S.lastStep = 0; S.lastT = performance.now(); drawTransfer(); probeReadout(); updateWorkflow(S);
}

function srcRuntime() {
	// per-source command: amplitude follows its parameter with a rate limit, so live changes do not kick the field
	const t0 = S.engine.step * DT, t1 = (S.engine.step + S.spf) * DT;
	return S.sc.sources.map((s, k) => {
		const target = s.ampKey ? S.p[s.ampKey] : 0;
		let a = S.amp[k] ?? target;
		let a1;
		if (S.sweep && s.sweep) a1 = sweepAmp(t1);
		else { const r = Math.max(Math.abs(target), 0.05) / (8 * S.p.wl); a1 = a + Math.max(-r * (t1 - t0), Math.min(r * (t1 - t0), target - a)); }
		const a0 = S.sweep && s.sweep ? sweepAmp(t0) : a;
		S.amp[k] = a1;
		const phase0 = s.phaseKey ? S.p[s.phaseKey] * Math.PI / 180 : 0;
		if (S.spectrum && k === 0) {
			const sp = S.spectrum;
			return { omega: s.omega, phase0, mode: 1, a0: sp.amp, a1: sp.amp, rampT0: 0, rampT1: 1, pulseC: sp.tc, pulseW: sp.tw, rise: 0 };
		}
		if (S.spectrum) return { omega: s.omega, phase0, a0: 0, a1: 0, on: 0 };
		return { omega: s.omega, phase0, a0, a1, rampT0: t0, rampT1: t1, rise: 10 * s.wl };
	});
}

function sweepAmp(t) {
	const w = S.sweep, u = (t - w.t0) / w.T;
	if (t < w.prepareEnd) { const f = Math.max(0, Math.min(1, (t - w.prepareStart) / (w.prepareEnd - w.prepareStart))); return w.startAmp + (w.amin - w.startAmp) * f * f * (3 - 2 * f); }
	if (u <= 0) return w.amin;
	if (u <= 1) return w.amin + (w.amax - w.amin) * u;
	if (u <= 2) return w.amax - (w.amax - w.amin) * (u - 1);
	return w.amin;
}

// ---------- UI construction ----------
function buildPresetUI() {
	const sel = $('#preset');
	const titles = { coupler: 'Directional coupler · Switch', ring: 'Ring resonator · Kerr response', soliton: 'Soliton · Self-focusing', xor: 'XOR · Interference' };
	sel.innerHTML = PRESETS.map(p => `<option value="${p.id}">${titles[p.id] || p.title}</option>`).join('');
	sel.onchange = () => selectPreset(sel.value);
}

async function selectPreset(id, overrides = {}) {
	const preset = PRESETS.find(p => p.id === id);
	if (!preset) { showError(new Error('Unknown preset: ' + id)); return false; }
	const ok = await rebuild(preset, overrides);
	if (!ok) { $('#preset').value = S.preset?.id || id; return false; }
	renderParameterUI(); return true;
}
function renderParameterUI() {
	$('#preset').value = S.preset.id; $('#preset').title = S.preset.title;
	$('#desc').textContent = S.preset.desc;
	const box = $('#params');
	box.innerHTML = ''; $('#liveParams').innerHTML = '';
	$('#specState').textContent = ''; S.uiDetuned = false; S.uiSweepDone = false;
	for (const q of S.preset.params) {
		const row = document.createElement('div');
		row.className = 'row';
		const help = PARAM_HELP[q.k] || '', helpId = `help-${q.k}`;
		row.innerHTML = `<span>${q.label}<small class="param-unit">${q.unit || ''}</small></span><input aria-label="${q.label}" aria-describedby="${helpId}" type="range" min="${q.min}" max="${q.max}" step="${q.step}" value="${S.p[q.k]}"><input aria-label="${q.label}: numeric value" aria-describedby="${helpId}" type="number" min="${q.min}" max="${q.max}" step="${q.step}" value="${S.p[q.k]}"><small id="${helpId}" class="param-help">${help}</small>`;
		const [rg, nb] = row.querySelectorAll('input');
		const set = async v => {
			try {
				const candidate = parameters(S.preset, { ...S.p, [q.k]: v }, S.kerrInstant, S.tauPeriods);
				if (q.live) { S.p = candidate; rg.value = candidate[q.k]; nb.value = candidate[q.k]; clearError(); updateGain(); return true; }
				const ok = await rebuild(S.preset, candidate); syncParameterUI(); return ok;
			} catch (e) { showError(e); rg.value = S.p[q.k]; nb.value = S.p[q.k]; return false; }
		};
		rg.oninput = () => set(rg.value); nb.onchange = () => set(nb.value);
		(q.live ? $('#liveParams') : box).appendChild(row);
	}
	$('#sweepPanel').hidden = !S.preset.sweep;
	if (S.preset.sweep) { $('#swMin').value = S.preset.sweep.amin; $('#swMax').value = S.preset.sweep.amax; $('#swDur').value = S.preset.sweep.kilo; }
	$('#specPanel').hidden = !S.preset.spectrum;
	drawSpectrum(); updateWorkflow(S);
}
function syncParameterUI() {
	for (const q of S.preset.params) for (const el of document.querySelectorAll(`[aria-describedby="help-${q.k}"]`)) el.value = S.p[q.k];
}

async function rebuild(preset = S.preset, values = S.p, instant = S.kerrInstant, tau = S.tauPeriods) {
	if (S.building || S.fatal) return false;
	const t0 = performance.now();
	S.building = true; abortMeasurements();
	const gen = S.generation;
	try {
		const p = parameters(preset, values, instant, tau);
		const sc = buildScene(preset.build(p), S.engine.device.limits);
		await S.engine.load(sc, sc.probes.map(probe => probe.center), () => gen === S.generation && !S.fatal);
		if (S.fatal) return false;
		S.preset = preset; S.p = p; S.sc = sc; S.kerrInstant = instant; S.tauPeriods = tau;
	} catch (e) { if (gen === S.generation) showError(e); return false; }
	finally { S.building = false; }
	S.engine.kerrInstant = instant;
	S.engine.tauKerr = tau * S.p.wl;
	S.engine.alphaI = DT / (2 * S.p.wl);
	S.amp = []; S.sweepData = []; S.controlData = []; S.spec = null;
	S.lastStep = 0;
	const ms = performance.now() - t0;
	S.buildMs = ms; updateHint(); clearError();
	for (const el of document.querySelectorAll('main button, main input, main select')) el.disabled = false;
	resizeCanvas();
	updateGain();
	drawTransfer();
	$('#swState').textContent = '';
	S.uiDetuned = false; S.uiSweepDone = false; S.uiAnalyzing = false;
	$('#cursorReadout').textContent = 'Hover over the field: position & refractive index';
	probeReadout(); updateWorkflow(S);
	drawSpectrum(); return true;
}
function updateHint() {
	if (!S.sc) return;
	$('#info').innerHTML = `${S.preset.hint?.(S.p, S.sc, { instant: S.kerrInstant, tauPeriods: S.tauPeriods }) || ''}<br><span class="dim">Grid ${S.sc.W} × ${S.sc.H}; Build ${S.buildMs.toFixed(0)} ms.</span>`;
	if (!S.kerrInstant) {
		const text = document.createElement('p');
		text.textContent = 'Debye: qualitative relaxation. Estimates use the real part c(τ) = ½ + 1/[4(1+(2ωτ)²)] of the continuous-time fundamental response. Quadrature and time-discretization error are omitted; no quantitative prediction for short τ.';
		$('#info').append(text);
	}
}

function updateGain() {
	const aRef = Math.max(0.02, ...S.sc.sources.map(s => s.ampKey ? Math.abs(S.p[s.ampKey]) : 0), S.sweep ? S.sweep.amax : 0);
	const g = Math.pow(10, S.view.gain);
	S.view.gainF = g / (1.1 * aRef); S.view.gainI = g * 2 / (aRef * aRef);
	updateColorKey(S);
}

function resizeCanvas() {
	const wrap = $('#stage'), c = $('#gpu'), o = $('#overlay');
	const cssW = wrap.clientWidth, cssH = Math.min(Math.round(cssW * S.sc.H / S.sc.W), Math.round(window.innerHeight * 0.62));
	const cssW2 = Math.min(cssW, Math.round(cssH * S.sc.W / S.sc.H));
	for (const el of [c, o]) { el.style.width = cssW2 + 'px'; el.style.height = cssH + 'px'; }
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const limit = S.engine.device.limits.maxTextureDimension2D;
	c.width = Math.max(1, Math.min(Math.round(cssW2 * dpr), S.sc.W * 2, limit, Math.floor(limit * S.sc.W / S.sc.H))); c.height = Math.max(1, Math.round(c.width * S.sc.H / S.sc.W));
	o.width = Math.round(cssW2 * dpr); o.height = Math.round(cssH * dpr);
	drawOverlay(); updateScale(S);
}

function drawOverlay() {
	const o = $('#overlay'), g = o.getContext('2d'), sx = o.width / S.sc.W, sy = o.height / S.sc.H;
	const dpr = o.width / parseFloat(o.style.width), fontSize = (window.innerWidth < 600 ? 9 : 12) * dpr;
	g.clearRect(0, 0, o.width, o.height);
	g.lineWidth = Math.max(1, sx * 1.5); g.font = `${fontSize}px system-ui, sans-serif`;
	for (const s of S.sc.sources) {
		g.strokeStyle = '#7be0a6'; g.beginPath(); g.moveTo(s.x * sx, s.y0 * sy); g.lineTo(s.x * sx, (s.y1 + 1) * sy); g.stroke();
		g.fillStyle = '#7be0a6'; g.fillText(s.label || 'Source', s.x * sx + 4 * dpr, Math.min(o.height - 5 * dpr, (s.y1 + 1) * sy + 14 * dpr));
	}
	S.sc.probes.forEach((p, k) => {
		g.strokeStyle = p.role === 'out' ? COLORS[k % COLORS.length] : '#e8e8e8'; g.setLineDash([4 * dpr, 3 * dpr]);
		g.beginPath(); g.moveTo(p.x0 * sx, p.y0 * sy); g.lineTo(p.x1 * sx, p.y1 * sy); g.stroke(); g.setLineDash([]);
		g.fillStyle = g.strokeStyle; const lbl = p.name, tw = g.measureText(lbl).width;
		const lx = Math.min(p.x0 * sx + 4 * dpr, o.width - tw - 4 * dpr);
		g.fillText(lbl, lx, Math.max(fontSize, p.y0 * sy - 4 * dpr));
	});
}

// ---------- readouts and plots ----------
function probeReadout() {
	const v = S.engine.probeVals; if (!v || !S.sc.probes.length) return;
	const inK = S.sc.probes.findIndex(p => p.role === 'in'), pin = inK >= 0 ? v[inK] : 0;
	const max = Math.max(1e-30, ...v), soliton = S.preset.id === 'soliton';
	if (!v.some(x => x > 1e-20)) { $('#probes').innerHTML = '<p class="help">No probe signal yet. Light is traveling from the source to the outputs.</p>'; return; }
	$('#probes').innerHTML = S.sc.probes.map((p, k) => {
		const rel = p.role === 'out' ? (pin > 1e-20 ? `${(100 * v[k] / pin).toFixed(1)} % ${soliton ? 'of total' : 'of input'}` : 'Reference settling …') : p.role === 'in' ? (soliton ? 'Total' : 'Reference') : 'second input';
		const value = v[k] < 1e-20 ? '0' : v[k].toExponential(2);
		return `<div class="pr"><span style="color:${p.role === 'out' ? COLORS[k % COLORS.length] : '#ddd'}">${p.name}</span><div class="bar"><i style="width:${(100 * v[k] / max).toFixed(1)}%;background:${p.role === 'out' ? COLORS[k % COLORS.length] : '#888'}"></i></div><code>${value}</code><span class="ratio">${rel}</span></div>`;
	}).join('');
}
function drawTransfer() { plotTransfer(S); }
function drawSpectrum() { plotSpectrum(S); }

// ---------- spectrum measurement ----------
function startSpectrum() {
	if (!S.sc || S.building || S.fatal) return;
	const cfg = S.preset.spectrum, wl = S.p.wl, omega = 2 * Math.PI / wl;
	const tw = 2 / (cfg.bw * omega); // Gaussian envelope exp(-(t/tw)^2): spectral 1/e half-width 2/tw
	abortMeasurements(); S.engine.reset(); S.engine.linear = true; S.amp = []; S.spec = null;
	S.spectrum = { tc: 3 * tw, tw, amp: 0.05, steps: Math.min(Math.floor(cfg.kilo * 1000 / DT), S.engine.tsCap - 10), omega0: omega, bw: cfg.bw };
	S.engine.startRecording();
	S.running = true; $('#run').textContent = 'Pause';
	$('#specState').textContent = 'measuring …';
	S.uiDetuned = false; S.uiSweepDone = false; updateWorkflow(S); drawSpectrum();
}

async function finishSpectrum() {
	const sp = S.spectrum, engine = S.engine, sc = S.sc, gen = S.generation, n = sp.steps, nts = engine.nts;
	const valid = () => gen === S.generation && !S.fatal;
	S.spectrum = null; S.engine.stopRecording();
	S.uiAnalyzing = true; updateWorkflow(S);
	try {
		await engine.idle(); if (!valid()) return;
		const ts = await engine.readTs(n); if (!valid()) return;
		const result = await spectrumDFT(ts, n, nts, sp.omega0, sp.bw, DT, valid, percent => {
			if (valid()) { S.analysisProgress = percent; $('#specState').textContent = `Analysis: ${percent.toFixed(0)} %`; updateWorkflow(S); }
		});
		if (!result || !valid()) return;
		const { wls, power } = result, inK = sc.probes.findIndex(p => p.role === 'in');
		const T = power.map(port => Float64Array.from(port, (v, i) => v / Math.max(power[inK][i], 1e-30)));
		// Tail RMS² over the last 10%, relative to the largest equal-sized time window, per output port.
		const block = Math.floor(n / 10); let tailRatio = 0;
		for (let j = 0; j < nts; j++) {
			let peak = 0, tail = 0;
			for (let b = 0; b < 10; b++) { let sum = 0; for (let k = b * block; k < (b + 1) * block; k++) sum += ts[k * nts + j] ** 2; peak = Math.max(peak, sum); if (b === 9) tail = sum; }
			tailRatio = Math.max(tailRatio, tail / Math.max(peak, 1e-30));
		}
		S.spec = { wl: wls, T, duration: n * DT, tailRatio };
		S.spec.resonance = resonance(S.spec, sc.probes.findIndex(p => p.name === 'Through'), S.p.wl);
		S.uiAnalyzing = false; engine.linear = false; engine.reset(); S.amp = [];
		$('#specState').textContent = S.spec.resonance ? `Linear single-point spectrum complete. Residual signal ${tailRatio.toExponential(2)}. Click to set λ₀.` : 'Resonance unresolved. Automatic detuning disabled.';
		console.log('SPECTRUM', JSON.stringify({ tailRatio, resonance: S.spec.resonance }));
		drawSpectrum(); updateWorkflow(S);
		if (qs.has('detune') && !(await detuneRed())) { S.running = false; document.title = 'ERR resonance'; return; }
		if (qs.has('sweep') || qs.has('control')) startSweep(); else if (qs.has('spectrum')) { S.running = false; document.title = 'DONE spectrum'; }
	} catch (e) { if (valid()) { abortMeasurements(); showError(e); } }
	finally { if (valid()) { engine.linear = false; S.uiAnalyzing = false; updateWorkflow(S); } }
}

async function detuneRed() {
	const r = S.spec?.resonance;
	if (!r) { $('#specState').textContent = 'Resonance unresolved. Automatic detuning disabled.'; return false; }
	const target = r.wl + 0.9 * r.width, keep = S.spec;
	if (!(await rebuild(S.preset, { ...S.p, wl: target }))) return false;
	S.spec = keep; syncParameterUI(); drawSpectrum();
	$('#specState').textContent = `Resonance λ₀ = ${r.wl.toFixed(3)}, width ≈ ${r.width.toFixed(4)}, Q ≈ ${r.Q.toFixed(0)}. Fourier resolution ≈ ${r.resolution.toFixed(4)}. Laser: ${target.toFixed(3)}.`;
	S.uiDetuned = true; updateWorkflow(S); return true;
}

// ---------- sweep ----------
function startSweep(control = false, chain = qs.has('control')) {
	if (!S.sc || S.building || S.fatal || S.spectrum || S.uiAnalyzing) return;
	let amin, amax, kilo;
	try {
		const max = S.preset.params.find(q => q.k === 'ampA').max;
		amin = number($('#swMin').value, 'A min', 0, max); amax = number($('#swMax').value, 'A max', 0, max);
		kilo = number($('#swDur').value, 'Ramp duration', 0.1, 1000);
		if (!(amin < amax)) throw new Error('Ramp requires A min < A max.');
	} catch (e) { showError(e); return; }
	const startAmp = S.amp[0] ?? S.p.ampA, prepareStart = S.engine.step * DT;
	const prepareEnd = prepareStart + 20 * S.p.wl;
	const settle = Math.max(40 * S.p.wl, 8 * S.tauPeriods * S.p.wl * (S.kerrInstant ? 0 : 1), S.spec?.resonance ? 8 * S.spec.resonance.Q * S.p.wl / (2 * Math.PI) : 4 * Math.max(S.sc.W, S.sc.H) * S.sc.nMax);
	S.sweep = { amin, amax, T: kilo * 1000, t0: prepareEnd + settle, prepareStart, prepareEnd, startAmp, control: !!control, chain };
	S.engine.linear = !!control;
	if (control) S.controlData = []; else { S.sweepData = []; S.controlData = []; }
	updateGain(); S.running = true; $('#run').textContent = 'Pause';
	S.uiSweepDone = false; $('#swState').textContent = 'running: 0 %'; updateWorkflow(S); drawTransfer();
}

// ---------- main loop ----------
function frame() {
	requestAnimationFrame(frame);
	if (!S.engine || !S.sc || S.fatal || S.building || !S.engine.usable) return;
	const e = S.engine;
	if (S.running && !S.inflight && !S.uiAnalyzing) {
		let n = S.spectrum ? Math.min(400, S.spectrum.steps - (e.step - e.tsBase)) : Math.min(S.spf, S.autoSteps ? S.autoSteps - e.step : S.spf);
		if (n > 0) {
			try { e.advance(n, srcRuntime(), { render: S.view }); } catch (error) { showError(error, true); return; }
			S.inflight = true;
			const gen = S.generation;
			e.device.queue.onSubmittedWorkDone().then(() => { if (gen === S.generation) S.inflight = false; }).catch(error => { if (gen === S.generation) showError(error, true); });
		}
		if (S.spectrum && e.step - e.tsBase >= S.spectrum.steps) { finishSpectrum(); }
	} else if (!S.inflight) {
		e.render(S.view);
	}
	if (S.sweep && e.probeVals && e.probeAt !== S.lastProbeAt) {
		S.lastProbeAt = e.probeAt;
		const t = e.probeAt * DT, u = (t - S.sweep.t0) / S.sweep.T;
		const inK = S.sc.probes.findIndex(p => p.role === 'in');
		if (u >= 0 && u <= 2) (S.sweep.control ? S.controlData : S.sweepData).push({ t, a: sweepAmp(t), pin: inK >= 0 ? e.probeVals[inK] : sweepAmp(t) ** 2, v: Array.from(e.probeVals), dir: u <= 1 ? 1 : -1 });
		$('#swState').textContent = `${S.sweep.control ? 'Control χ³ = 0 · ' : ''}${u < 0 ? 'smooth start / settling' : u <= 2 ? `running: ${(50 * u).toFixed(0)} %` : 'complete'}`;
		if (u > 2) {
			const control = S.sweep.control, chain = S.sweep.chain;
			S.uiSweepDone = true; S.sweep = null; e.linear = false;
			if (!control && chain) { e.reset(); S.amp = [0]; S.lastProbeAt = -1; startSweep(true, false); }
			else {
				$('#swState').textContent = control ? 'complete · control χ³ = 0 shown in gray' : 'complete';
				console.log('SWEEP', JSON.stringify({ nonlinearPoints: S.sweepData.length, controlPoints: S.controlData.length }));
				if (qs.has('sweep') || qs.has('control')) { S.running = false; document.title = 'DONE sweep'; }
			}
		}
		drawTransfer(); updateWorkflow(S);
	}
	const now = performance.now();
	if (now - S.lastT > 500) {
		S.rate = (e.step - S.lastStep) / ((now - S.lastT) / 1000); S.lastT = now; S.lastStep = e.step;
		const per = e.step * DT / S.p.wl;
		$('#status').textContent = S.error ? `Error: ${S.error}` : `Step ${e.step} · ${per.toFixed(1)} periods · ${Math.max(0, Math.round(S.rate))} steps/s${S.spectrum ? ` · Spectrum ${(100 * (e.step - e.tsBase) / S.spectrum.steps).toFixed(0)} %` : ''}`;
		probeReadout(); updateWorkflow(S);
		if (qs.has('log')) console.log(JSON.stringify({ step: e.step, v: Array.from(e.probeVals, x => +x.toPrecision(4)) }));
		if (S.autoSteps && e.step >= S.autoSteps) {
			S.running = false; S.autoSteps = 0; updateWorkflow(S); const gen = S.generation;
			e.idle().then(() => { if (gen === S.generation && !S.fatal) document.title = 'DONE steps'; }).catch(error => { if (gen === S.generation) showError(error, true); });
		}
	}
}

function wireControls() {
	$('#exportData').onclick = () => {
		const rows = [['Measurement', 'Time', 'Direction', 'Wavelength', 'Probe', 'E2_Proxy', 'Input_E2_Proxy']];
		for (const [name, data] of [['Ramp', S.sweepData], ['Control_chi3_0', S.controlData]]) for (const row of data)
			row.v.forEach((v, k) => rows.push([name, row.t, row.dir, '', S.sc.probes[k].name, v, row.pin]));
		if (S.spec) S.spec.wl.forEach((wl, i) => S.spec.T.forEach((port, k) => rows.push(['Single_point_spectral_ratio', '', '', wl, S.sc.probes[k].name, port[i], 1])));
		const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(';')).join('\n');
		const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a');
		link.href = url; link.download = `lichtchip-${S.preset.id}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
	};
	$('#run').onclick = () => { S.running = !S.running; $('#run').textContent = S.running ? 'Pause' : 'Resume'; updateWorkflow(S); };
	$('#reset').onclick = resetScene;
	$('#spf').oninput = () => { try { S.spf = number($('#spf').value, 'spf', 1, 400, true); $('#spfV').textContent = S.spf; } catch (e) { showError(e); } };
	$('#viewMode').onchange = () => { try { S.view.mode = number($('#viewMode').value, 'view', 0, 2, true); updateColorKey(S); } catch (e) { showError(e); } };
	$('#gain').oninput = () => { try { S.view.gain = number($('#gain').value, 'Brightness', -1.5, 1.5); updateGain(); } catch (e) { showError(e); } };
	$('#showMat').onchange = () => { S.view.showMat = $('#showMat').checked; };
	$('#kerrModel').onchange = async () => { await rebuild(S.preset, S.p, $('#kerrModel').value === 'instant'); $('#kerrModel').value = S.kerrInstant ? 'instant' : 'debye'; };
	$('#tau').onchange = async () => {
		try { const tau = number($('#tau').value, 'τ in periods', 0.05, 1000); relaxation(S.kerrInstant, tau, S.p.wl); await rebuild(S.preset, S.p, S.kerrInstant, tau); }
		catch (e) { showError(e); } $('#tau').value = S.tauPeriods;
	};
	$('#swStart').onclick = () => startSweep(false, false);
	$('#swControl').onclick = () => { S.engine.reset(); S.amp = [0]; S.lastProbeAt = -1; startSweep(true, false); };
	$('#swStop').onclick = () => { abortMeasurements(); $('#swState').textContent = 'cancelled'; updateWorkflow(S); };
	$('#specStart').onclick = startSpectrum;
	$('#detune').onclick = detuneRed;
	$('#plotS').onclick = async ev => {
		if (!S.spec || !S.spec.ax) return;
		const c = $('#plotS'), r = c.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
		const ax = S.spec.ax; if (x < ax.L || x > ax.right || y < ax.T || y > ax.bottom) return;
		const wl = S.spec.wl; let best = 0;
		wl.forEach((v, i) => { if (Math.abs(S.spec.ax.mx(v) - x) < Math.abs(S.spec.ax.mx(wl[best]) - x)) best = i; });
		const keep = S.spec;
		if (!(await rebuild(S.preset, { ...S.p, wl: +wl[best].toFixed(4) }))) return;
		S.spec = keep; syncParameterUI(); drawSpectrum();
		$('#specState').textContent = `Laser manually set to λ₀ = ${S.p.wl.toFixed(4)}. The measured spectrum is retained as a reference.`; updateWorkflow(S);
	};
	window.addEventListener('resize', () => { if (S.sc) { resizeCanvas(); drawTransfer(); drawSpectrum(); } });
	wirePointer(S);
	document.addEventListener('keydown', ev => {
		if (ev.code !== 'Space' || ev.repeat || ev.altKey || ev.ctrlKey || ev.metaKey) return;
		if (ev.target.closest('input, select, textarea, button, summary, [contenteditable]:not([contenteditable="false"])')) return;
		ev.preventDefault(); $('#run').click();
	});
}

async function main() {
	$('#reload').onclick = () => location.reload();
	if (qs.has('diag')) {
		document.body.classList.add('testmode');
		const out = $('#out'); out.hidden = false;
		const log = s => { out.textContent += s + '\n'; };
		try { await diagColumns(log, number(qs.get('A') ?? 1.1, 'A', 0, 2.5), number(qs.get('chi3') ?? 0.5, 'χ³', 0, 2), number(qs.get('tau') ?? 30, 'τ', 0, 1000), number(qs.get('steps') ?? 30000, 'steps', 1, 2000000, true)); document.title = 'DONE diag'; }
		catch (e) { log('ERROR ' + (e.stack || e)); document.title = 'ERR diag'; }
		return;
	}
	if (qs.has('selftest')) {
		document.body.classList.add('testmode');
		const out = $('#out'); out.hidden = false;
		const log = s => { out.textContent += s + '\n'; console.log(s); };
		try { const r = await selftest(log); document.title = r.ok ? 'PASS selftest' : 'FAIL selftest'; }
		catch (e) { log('ERROR ' + (e.stack || e)); document.title = 'ERR selftest'; }
		return;
	}
	try { S.engine = await Engine.create($('#gpu')); }
	catch (e) { showError(e, true); return; }
	S.engine.onError = e => showError(e, true);
	buildPresetUI(); wireControls(); requestAnimationFrame(frame);
	try {
		const ov = {}; for (const [k, v] of qs) if (k.startsWith('p.')) ov[k.slice(2)] = v;
		for (const flag of ['sweep', 'spectrum', 'detune', 'log', 'control']) if (qs.has(flag)) number(qs.get(flag), flag, 1, 1, true);
		S.view.mode = number(qs.get('view') ?? 0, 'view', 0, 2, true); $('#viewMode').value = S.view.mode;
		S.spf = number(qs.get('spf') ?? 60, 'spf', 1, 400, true); $('#spf').value = S.spf; $('#spfV').textContent = S.spf;
		const steps = qs.has('steps') ? number(qs.get('steps'), 'steps', 1, 2000000, true) : 0;
		if (!(await selectPreset(qs.get('preset') || 'coupler', ov))) return;
		if ((qs.has('spectrum') || qs.has('detune')) && !S.preset.spectrum) throw new Error('Spectrum/detuning requires the ring preset.');
		if ((qs.has('sweep') || qs.has('control')) && !S.preset.sweep) throw new Error('This preset has no ramp.');
		S.autoSteps = steps;
		if (qs.has('spectrum')) startSpectrum(); else if (qs.has('sweep') || qs.has('control')) startSweep();
	} catch (e) { showError(e); return; }
	document.title = 'Lichtchip Lab';
}
main().catch(e => showError(e, true));
