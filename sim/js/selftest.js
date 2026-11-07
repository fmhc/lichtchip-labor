// Self-test against closed-form results of the discretised equations (run with ?selftest).
// T1 linear plane wave: wavenumber from the exact discrete dispersion sin(k/2) = sqrt(eps) sin(w DT/2) / DT, amplitude = A.
// T2/T3 Kerr plane wave: eps_eff = eps + chi3 A^2 / 2 (Debye, slow) or eps + 3/4 chi3 A^2 (instantaneous, fundamental).
// T4 waveguide: FDTD wavenumber against the 9-point-consistent mode solver.
// T5 coupler: linear full transfer to the cross port. T6 is diagnostic only, not a switching validation.
import { Engine, DT } from './engine.js';
import { buildScene, kappaOf, solveModes } from './scene.js';
import { PRESETS } from './presets.js';

/** Complex amplitude at omega of a sampled signal (samples taken at times t0 + k DT), least-squares over whole periods. */
function lockin(sig, t0, omega) {
	let re = 0, im = 0;
	for (let k = 0; k < sig.length; k++) { const t = t0 + k * DT; re += sig[k] * Math.cos(omega * t); im -= sig[k] * Math.sin(omega * t); }
	return { re: 2 * re / sig.length, im: 2 * im / sig.length, amp: 2 * Math.hypot(re, im) / sig.length, ph: Math.atan2(im, re) };
}

async function runPlane(engine, { eps, chi3 = 0, instant = false, A, wl = 32, steps, tauPeriods = 5 }) {
	// default sponge (left/right only), so T1 also measures how much the standard absorbing layer reflects
	const W = 1100, H = 32, xs = [400, 404, 440, 700], xr = Array.from({ length: 16 }, (_, j) => 600 + j);
	const sc = buildScene({ W, H, nBg: Math.sqrt(eps), chi3Bg: chi3, wl, sponge: { sides: 'lr' }, parts: [],
		sources: [{ x: 140, y0: 0, y1: H - 1, profile: 'flat' }], probes: [] });
	const all = [...xs, ...xr], pts = all.map(x => 16 * W + x), np = pts.length;
	engine.kerrInstant = instant; engine.tauKerr = tauPeriods * wl;
	await engine.load(sc, pts);
	const omega = 2 * Math.PI / wl, src = [{ omega, phase0: 0, a0: A, a1: A, rise: 20 * wl }];
	const per = Math.round(wl / DT), rec = 40 * per;
	let left = steps - rec;
	while (left > 0) { const n = Math.min(500, left); engine.advance(n, src, { readProbes: false }); left -= n; }
	const t0 = (engine.startRecording() + 1) * DT;
	left = rec;
	while (left > 0) { const n = Math.min(500, left); engine.advance(n, src, { readProbes: false }); left -= n; }
	await engine.idle();
	const ts = await engine.readTs(rec);
	const z = all.map((_, j) => lockin(Float64Array.from({ length: rec }, (_, k) => ts[k * np + j]), t0, omega));
	// hierarchical unwrapping over 4, 40 and 300 cells
	const wrap = a => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
	let k = wrap(z[0].ph - z[1].ph) / (xs[1] - xs[0]);
	for (const j of [2, 3]) { const L = xs[j] - xs[0], d = z[0].ph - z[j].ph; k = (d + 2 * Math.PI * Math.round((k * L - d) / (2 * Math.PI))) / L; }
	const ar = z.slice(xs.length).map(q => q.amp), refl = (Math.max(...ar) - Math.min(...ar)) / (Math.max(...ar) + Math.min(...ar));
	const nan = z.some(q => !isFinite(q.amp));
	return { kMeas: k, amps: z.slice(0, xs.length).map(q => q.amp), refl, nan, omega };
}

const kPlane = (eps, omega) => 2 * Math.asin(Math.sqrt(eps * kappaOf(omega)) / 2);

export async function selftest(log) {
	const res = [];
	const add = (name, pass, detail) => { res.push({ name, pass, ...detail }); log(`${pass === null ? 'INFO' : pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`); };
	const engine = await Engine.create(null);
	log(`Adapter: ${JSON.stringify(engine.adapterInfo.vendor)} ${engine.adapterInfo.architecture || ''} ${engine.adapterInfo.description || ''}`);

	// T1 linear plane wave in eps = 4
	{
		const r = await runPlane(engine, { eps: 4, A: 0.5, steps: 8000 });
		const kTh = kPlane(4, r.omega), relK = (r.kMeas - kTh) / kTh;
		const relA = (r.amps[0] / 0.5) - 1;
		add('T1 linear plane wave: wavenumber', Math.abs(relK) < 2e-3, { kMeas: +r.kMeas.toFixed(6), kTheory: +kTh.toFixed(6), relError: +relK.toExponential(2) });
		add('T1 linear plane wave: amplitude = A', Math.abs(relA) < 0.03, { relError: +relA.toFixed(4) });
		add('T1 absorbing layer: reflection (amplitude)', r.refl < 0.01, { reflection: +r.refl.toExponential(2) });
	}
	// T2 Kerr Debye, T3 Kerr instantaneous
	for (const instant of [false, true]) {
		const chi3 = 0.2, A = 0.5;
		const r = await runPlane(engine, { eps: 4, chi3, instant, A, steps: 14000 });
		const Am = (r.amps[0] + r.amps[2]) / 2;
		const epsEff = 4 + (instant ? 0.75 : 0.5) * chi3 * Am * Am;
		const kLin = kPlane(4, r.omega), kTh = kPlane(epsEff, r.omega);
		const rel = (r.kMeas - kLin) / (kTh - kLin) - 1;
		add(`T${instant ? 3 : 2} Kerr ${instant ? 'instantaneous' : 'Debye'}: nonlinear wavenumber shift`, !r.nan && Math.abs(rel) < 0.03,
			{ dkMeasured: +(r.kMeas - kLin).toExponential(4), dkTheory: +(kTh - kLin).toExponential(4), relDeviation: +rel.toFixed(4), amplitude: +Am.toFixed(4), ampsAlong: r.amps.map(a => +a.toFixed(4)) });
	}
	// T2b slow Debye at high power in a structure-free medium: must stay a clean forward wave (no self-written grating without a seed)
	{
		const r = await runPlane(engine, { eps: 4, chi3: 0.5, A: 1.1, steps: 60000, tauPeriods: 30 });
		const epsEff = 4 + 0.5 * 0.5 * ((r.amps[0] + r.amps[3]) / 2) ** 2; // Debye CW: eps + chi3 A^2 / 2
		const kLin = kPlane(4, r.omega), kTh = kPlane(epsEff, r.omega), rel = (r.kMeas - kLin) / (kTh - kLin) - 1;
		add('T2b slow Debye, high power, plane wave', !r.nan && r.refl < 0.01 && Math.abs(rel) < 0.03, { reflection: +r.refl.toExponential(2), relDeviation: +rel.toFixed(4), ampsAlong: r.amps.map(a => +a.toFixed(4)) });
	}
	// T4 waveguide mode: FDTD wavenumber vs mode solver
	{
		const W = 1200, H = 160, wl = 32, yc = 80;
		const sc = buildScene({ W, H, nBg: 1.45, wl, sponge: { width: 48 }, parts: [{ type: 'wg', pts: [[0, yc], [W, yc]], w: 10, n: 2.0 }],
			sources: [{ x: 70, y0: yc - 40, y1: yc + 40, profile: 'mode' }], probes: [] });
		const col = []; for (let y = 0; y < H; y++) col.push(sc.eps[y * W + 600]);
		const mode = solveModes(col, 2 * Math.PI / wl, 1)[0];
		const ys = Array.from({ length: 25 }, (_, i) => yc - 24 + 2 * i);
		const pts = [...[400, 404, 700].map(x => yc * W + x), ...ys.map(y => y * W + 400)];
		engine.kerrInstant = false; await engine.load(sc, pts);
		const omega = 2 * Math.PI / wl, src = [{ omega, phase0: 0, a0: 0.3, a1: 0.3, rise: 20 * wl }];
		const per = Math.round(wl / DT), rec = 40 * per;
		engine.advance(6000 - rec, src, { readProbes: false });
		const t0 = (engine.startRecording() + 1) * DT;
		engine.advance(rec, src, { readProbes: false });
		await engine.idle();
		const ts = await engine.readTs(rec);
		const z = pts.map((_, j) => lockin(Float64Array.from({ length: rec }, (_, k) => ts[k * pts.length + j]), t0, omega));
		const wrap = a => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
		const kC = wrap(z[0].ph - z[1].ph) / 4, d = z[0].ph - z[2].ph, m = Math.round((kC * 300 - d) / (2 * Math.PI)), kM = (d + 2 * Math.PI * m) / 300;
		const rel = (kM - mode.beta) / mode.beta;
		add('T4 waveguide: FDTD versus mode solver', Math.abs(rel) < 1e-3, { kMeasured: +kM.toFixed(6), betaSolver: +mode.beta.toFixed(6), neff: +mode.neff.toFixed(5), relError: +rel.toExponential(2), amplitude: +z[0].amp.toFixed(4), ampTarget: 0.3 });
		// Fit the complex transverse fundamental. 1% amplitude and 1% residual-energy tolerances
		// allow finite source tails, sponge reflection and finite settling/recording time.
		let norm = 0, re = 0, im = 0, energy = 0;
		ys.forEach((y, i) => { const phi = mode.profile[y], q = z[i + 3]; norm += phi * phi; re += phi * q.re; im += phi * q.im; energy += q.re ** 2 + q.im ** 2; });
		re /= norm; im /= norm;
		let residual = 0;
		ys.forEach((y, i) => { const q = z[i + 3]; residual += (q.re - re * mode.profile[y]) ** 2 + (q.im - im * mode.profile[y]) ** 2; });
		const amp = Math.hypot(re, im), impurity = residual / energy;
		add('T4 launched mode: amplitude and purity', Math.abs(amp / 0.3 - 1) < 0.01 && impurity < 0.01,
			{ amplitude: +amp.toFixed(6), target: 0.3, relAmplitude: +(amp / 0.3 - 1).toExponential(3), residualEnergy: +impurity.toExponential(3), amplitudeTolerance: 0.01, residualEnergyTolerance: 0.01 });
	}
	// T5/T6 coupler: linear full transfer, then Kerr
	const preset = PRESETS.find(p => p.id === 'coupler');
	const pv = Object.fromEntries(preset.params.map(q => [q.k, q.v]));
	for (const [label, chi3, A] of [['T5 linear coupler: full cross-port transfer', 0, 0.2], ['T6 coupler with Kerr (instantaneous), A = 1.1', 0.5, 1.1]]) {
		const spec = preset.build({ ...pv, chi3 });
		const sc = buildScene(spec);
		if (chi3 > 0) log('INFO Coupler calibration: ' + preset.hint({ ...pv, chi3 }, sc, { instant: true, tauPeriods: 30 }).replace(/<[^>]*>/g, ' '));
		engine.kerrInstant = chi3 > 0; engine.tauKerr = 30 * pv.wl; await engine.load(sc, []);
		const omega = 2 * Math.PI / pv.wl, src = [{ omega, phase0: 0, a0: A, a1: A, rise: 20 * pv.wl }];
		const t0 = performance.now();
		const total = 24000;
		for (let s = 0; s < total; s += 500) engine.advance(500, src, { readProbes: s + 500 >= total });
		await engine.idle();
		const dtMs = performance.now() - t0;
		const v = engine.probeVals, names = sc.probes.map(p => p.name);
		const up = v[names.indexOf('Upper output')], lo = v[names.indexOf('Lower output')], inp = v[names.indexOf('A input')];
		const cross = lo / (up + lo);
		if (chi3 === 0) add(label, cross > 0.9, { lowerFraction: +cross.toFixed(4), outputSum_to_input: +((up + lo) / inp).toFixed(4), Lc: +spec.info.design.Lc.toFixed(1), grid: `${sc.W}x${sc.H}`, stepsPerSecond: Math.round(total / dtMs * 1000) });
		else add(label, null, { upperFraction: +(up / (up + lo)).toFixed(4), outputSum_to_input: +((up + lo) / inp).toFixed(4) });
		const E = await engine.readField('E');
		if (E.some(x => !isFinite(x))) add(label + ': NaN in field', false, {});
	}
	const ok = res.every(r => r.pass !== false);
	const soliton = PRESETS.find(p => p.id === 'soliton');
	const solitonParams = Object.fromEntries(soliton.params.map(q => [q.k, q.v]));
	log('INFO Soliton calibration: ' + soliton.hint(solitonParams, null, { instant: true, tauPeriods: 30 }).replace(/<[^>]*>/g, ' '));
	engine.dispose();
	return { ok, res };
}

/** Diagnostic (?diag&p.ampA=..): power proxy sum_y <E^2> per column along the coupler, to locate losses. */
export async function diagColumns(log, A, chi3, tauPeriods = 30, steps = 30000) {
	const engine = await Engine.create(null);
	const preset = PRESETS.find(p => p.id === 'coupler');
	const pv = Object.fromEntries(preset.params.map(q => [q.k, q.v]));
	const sc = buildScene(preset.build({ ...pv, chi3 }));
	engine.kerrInstant = tauPeriods === 0; engine.tauKerr = tauPeriods === 0 ? pv.wl : tauPeriods * pv.wl;
	if (engine.tauKerr < DT) throw new Error('Debye requires Δt/τ ≤ 1.');
	engine.alphaI = DT / (2 * pv.wl); await engine.load(sc, []);
	const src = [{ omega: 2 * Math.PI / pv.wl, phase0: 0, a0: A, a1: A, rise: 20 * pv.wl }];
	for (let s = 0; s < steps; s += 500) engine.advance(Math.min(500, steps - s), src, { readProbes: false });
	await engine.idle();
	const Ib = await engine.readField('Ib'), W = sc.W, H = sc.H;
	const yMid = H / 2, row = [];
	for (let x = 70; x < W - 60; x += Math.round((W - 130) / 40)) {
		let top = 0, bot = 0;
		for (let y = 64; y < H - 64; y++) { const v = Ib[2 * (y * W + x) + 1]; if (y < yMid) top += v; else bot += v; }
		row.push({ x, top: +top.toFixed(3), bottom: +bot.toFixed(3), sum: +(top + bot).toFixed(3) });
	}
	log(`A=${A} chi3=${chi3} tau=${tauPeriods} periods (0 = instantaneous)  Grid ${W}x${H}`);
	for (const r of row) log(JSON.stringify(r));
	engine.dispose();
}
