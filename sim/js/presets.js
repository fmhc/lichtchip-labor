// Example scenes. Each preset has parameters (live = changes without rebuilding) and builds a scene spec.
// Default material: silicon-nitride-like core (n = 2.0) in silica-like cladding (n = 1.45), lengths in cells.
import { solveModes, slabColumn, sbend } from './scene.js';

export const SP = 64; // sponge width (strength from scene.js default)

const common = [
	{ k: 'wl', label: 'Vacuum wavelength λ₀', min: 20, max: 48, step: 0.001, v: 32, unit: 'cells' },
	{ k: 'w', label: 'Core width', min: 6, max: 20, step: 0.5, v: 10, unit: 'cells' },
	{ k: 'nCore', label: 'Core refractive index', min: 1.5, max: 3.5, step: 0.01, v: 2.0 },
	{ k: 'nClad', label: 'Cladding refractive index', min: 1.0, max: 2.0, step: 0.01, v: 1.45 },
];

/** Even/odd supermodes of two parallel guides at a given gap: coupling constant kappa = (beta_e - beta_o) / 2. */
export function couplerKappa(p, gap) {
	const d = (p.w + gap) / 2, H = Math.ceil(2 * (p.w + gap) + 140), yc = H / 2;
	const col = slabColumn(H, p.nClad, [{ yc: yc - d, w: p.w, n: p.nCore }, { yc: yc + d, w: p.w, n: p.nCore }]);
	const m = solveModes(col, 2 * Math.PI / p.wl, 2);
	if (m.some(mode => !mode.guided)) throw new Error('Coupler requires two guided supermodes.');
	return { kappa: (m[0].beta - m[1].beta) / 2, modes: m };
}

/** Single-guide mode and the nonlinear overlap Gamma4 = sum_core phi^4 / sum phi^2 (peak-normalised phi). */
export function guideMode(p) {
	const H = Math.ceil(p.w + 120), yc = H / 2;
	const col = slabColumn(H, p.nClad, [{ yc, w: p.w, n: p.nCore }]);
	const m = solveModes(col, 2 * Math.PI / p.wl, 1)[0];
	if (!m.guided) throw new Error('No guided waveguide mode.');
	let s2 = 0, s4 = 0;
	m.profile.forEach((v, j) => { s2 += v * v; if (Math.abs(j + 0.5 - yc) < p.w / 2) s4 += v ** 4; });
	return { ...m, gamma4: s4 / s2 };
}

/** Coupler with cosine S-bends, straight section chosen so the total coupling phase is `target` (pi/2 full, pi/4 3 dB). */
export function designCoupler(p, target) {
	const g = p.gap, w = p.w, Dout = Math.max(w + g + 4, p.sepOut), dy = (Dout - (w + g)) / 2, Lb = p.bendLen;
	const k0 = couplerKappa(p, g).kappa;
	let phiB = 0;
	const ns = 16;
	for (let k = 0; k < ns; k++) {
		const s = (k + 0.5) / ns, gap = g + 2 * dy * (1 + Math.cos(Math.PI * s)) / 2;
		if (gap > 8 * w) continue;
		phiB += couplerKappa(p, gap).kappa * Lb / ns;
	}
	if (!(k0 > 0) || !Number.isFinite(k0)) throw new Error('Coupler: no positive coupling.');
	if (2 * phiB > target) throw new Error('Coupler design unreachable: the S-bends already exceed the target coupling phase. Increase the gap or shorten the bends.');
	const L = (target - 2 * phiB) / k0;
	return { k0, phiB, L, Dout, dy, Lb, Lc: Math.PI / 2 / k0 };
}

function couplerScene(p, target, twoInputs) {
	const d = designCoupler(p, target);
	const xin = SP + 200, x1 = xin + d.Lb, x2 = x1 + d.L, x3 = x2 + d.Lb;
	const W = Math.ceil(x3 + 170 + SP), H = Math.ceil(d.Dout + 2 * 45 + 2 * SP), yc = H / 2;
	const yA = yc - d.Dout / 2, yAi = yc - (p.w + p.gap) / 2, yB = yc + d.Dout / 2, yBi = yc + (p.w + p.gap) / 2;
	const guide = (yo, yi) => [[0, yo], [xin, yo], ...sbend(xin, yo, x1, yi), [x2, yi], ...sbend(x2, yi, x3, yo), [W, yo]];
	const chi3 = p.chi3 ?? 0, hw = Math.min(28, (d.Dout - p.w) / 2 - 2);
	const sources = [{ x: SP + 14, y0: yA - hw, y1: yA + hw, profile: 'mode', ampKey: 'ampA', phaseKey: null, sweep: true, label: 'A' }];
	const probes = [{ name: 'A input', role: 'in', x0: SP + 150, y0: yA - 14, x1: SP + 150, y1: yA + 14 }];
	if (twoInputs) {
		sources.push({ x: SP + 14, y0: yB - hw, y1: yB + hw, profile: 'mode', ampKey: 'ampB', phaseKey: 'phaseB', label: 'B' });
		probes.push({ name: 'B input', role: 'in2', x0: SP + 150, y0: yB - 14, x1: SP + 150, y1: yB + 14 });
	}
	probes.push({ name: 'Upper output', role: 'out', x0: W - SP - 40, y0: yA - 14, x1: W - SP - 40, y1: yA + 14 });
	probes.push({ name: 'Lower output', role: 'out', x0: W - SP - 40, y0: yB - 14, x1: W - SP - 40, y1: yB + 14 });
	const gm = guideMode(p);
	return {
		W, H, nBg: p.nClad, wl: p.wl, sponge: { width: SP },
		parts: [{ type: 'wg', pts: guide(yA, yAi), w: p.w, n: p.nCore, chi3 }, { type: 'wg', pts: guide(yB, yBi), w: p.w, n: p.nCore, chi3 }],
		sources, probes,
		info: { design: d, mode: gm },
	};
}

export const PRESETS = [
	{
		id: 'coupler', title: 'Nonlinear directional coupler (switch)',
		desc: 'Two waveguides run close together. The linear design transfers light to the lower guide. The Kerr effect changes the refractive indices and thus the coupling behavior (Jensen 1982). The amplitude ramp shows a dynamic response. A quantitative switching threshold has not been validated.',
		params: [...common,
			{ k: 'gap', label: 'Gap', min: 3, max: 20, step: 0.5, v: 14, unit: 'cells' },
			{ k: 'sepOut', label: 'Outer separation', min: 40, max: 120, step: 1, v: 70, unit: 'cells' },
			{ k: 'bendLen', label: 'S-bend length', min: 80, max: 400, step: 5, v: 200, unit: 'cells' },
			{ k: 'chi3', label: 'Kerr χ³ (exaggerated)', min: 0, max: 2, step: 0.01, v: 0.5 },
			{ k: 'ampA', label: 'Amplitude A', min: 0, max: 2.5, step: 0.01, v: 0.2, live: true },
		],
		sweep: { amin: 0.05, amax: 1.3, kilo: 80 },
		build: p => couplerScene(p, Math.PI / 2, false),
		hint(p, sc, ctx) {
			const d = sc.spec.info.design, gm = sc.spec.info.mode, omega = 2 * Math.PI / p.wl, c = ctx.instant ? 0.75 : 0.5 + 1 / (4 * (1 + (4 * Math.PI * ctx.tauPeriods) ** 2));
			const dnEffNeeded = 4 * d.k0 / omega; // Jensen: nonlinear mismatch 4 kappa at the critical power; dn = c chi3 A^2 / (2 n)
			const aCrit = p.chi3 > 0 ? Math.sqrt(dnEffNeeded * 2 * p.nCore / (c * p.chi3 * gm.gamma4)) : NaN;
			return `Coupling length L<sub>c</sub> = ${d.Lc.toFixed(0)} cells (${(d.Lc / p.wl).toFixed(1)} λ₀), straight section ${d.L.toFixed(0)}, n<sub>eff</sub> = ${gm.neff.toFixed(4)}.<br>Estimated switching amplitude A<sub>crit</sub> ≈ ${isFinite(aCrit) ? aCrit.toFixed(2) : '–'} (${ctx.instant ? 'instantaneous' : 'Debye'}, rough estimate).`;
		},
	},
	{
		id: 'ring', title: 'Kerr ring resonator (dynamic response)',
		desc: 'A ring stores light over multiple round trips. Positive χ³ can shift the resonance to a longer wavelength. Measure the linear spectrum first, then detune to red if the resonance is resolved and ramp the amplitude up and down. A dynamic ramp loop does not establish a bistable memory bit. Compare with χ³ = 0 and slower ramps.',
		params: [...common,
			{ k: 'R', label: 'Ring radius', min: 60, max: 260, step: 1, v: 130, unit: 'cells' },
			{ k: 'gap', label: 'Bus–ring gap', min: 2, max: 20, step: 0.5, v: 6, unit: 'cells' },
			{ k: 'drop', label: 'Drop bus (0/1)', min: 0, max: 1, step: 1, v: 1 },
			{ k: 'chi3', label: 'Kerr χ³ (exaggerated)', min: 0, max: 2, step: 0.01, v: 0.1 },
			{ k: 'ampA', label: 'Amplitude', min: 0, max: 1.5, step: 0.005, v: 0.1, live: true },
		],
		sweep: { amin: 0.02, amax: 0.5, kilo: 200 },
		spectrum: { bw: 0.04, kilo: 80 },
		build(p) {
			const R = p.R, w = p.w, cc = R + w + p.gap, drop = p.drop >= 0.5;
			const W = Math.ceil(2 * SP + 2 * R + 2 * w + 260), H = Math.ceil(2 * SP + 80 + (drop ? 2 * cc : cc + R + w));
			const yT = H - SP - 40, cy = yT - cc, cx = W / 2, yD = cy - cc, chi3 = p.chi3;
			const parts = [{ type: 'wg', pts: [[0, yT], [W, yT]], w, n: p.nCore, chi3 }, { type: 'ring', cx, cy, r: R, w, n: p.nCore, chi3 }];
			const probes = [{ name: 'Input', role: 'in', x0: SP + 50, y0: yT - 14, x1: SP + 50, y1: yT + 14 },
				{ name: 'Through', role: 'out', x0: W - SP - 40, y0: yT - 14, x1: W - SP - 40, y1: yT + 14 }];
			if (drop) {
				parts.push({ type: 'wg', pts: [[0, yD], [W, yD]], w, n: p.nCore, chi3 });
				probes.push({ name: 'Drop', role: 'out', x0: SP + 50, y0: yD - 14, x1: SP + 50, y1: yD + 14 });
			}
			return {
				W, H, nBg: p.nClad, wl: p.wl, sponge: { width: SP }, parts, probes,
				sources: [{ x: SP + 14, y0: yT - 28, y1: yT + 28, profile: 'mode', ampKey: 'ampA', sweep: true, label: 'Laser' }],
				info: { mode: guideMode(p) },
			};
		},
		hint(p, sc) {
			const gm = sc.spec.info.mode, L = 2 * Math.PI * p.R;
			return `Circumference ${L.toFixed(0)} cells ≈ ${(L * gm.neff / p.wl).toFixed(1)} wavelengths (straight-guide n<sub>eff</sub> = ${gm.neff.toFixed(3)}, slightly different in bends). Free spectral range ≈ ${(p.wl * p.wl / (L * gm.neff * 1.1)).toFixed(3)} cells in λ₀.`;
		},
	},
	{
		id: 'soliton', title: 'Self-focusing (spatial soliton)',
		desc: 'A light beam in a Kerr material. A weak beam spreads by diffraction. Stronger light raises the refractive index at its center and focuses itself. The soliton estimate is paraxial; constant beam width has not been validated here. Negative χ³ values are disabled.',
		params: [
			{ k: 'wl', label: 'Vacuum wavelength λ₀', min: 16, max: 48, step: 0.001, v: 24, unit: 'cells' },
			{ k: 'n', label: 'Refractive index', min: 1, max: 3.5, step: 0.01, v: 2.0 },
			{ k: 'w0', label: 'Beam waist w₀', min: 4, max: 40, step: 0.5, v: 16, unit: 'cells' },
			{ k: 'L', label: 'Length', min: 600, max: 3000, step: 50, v: 1500, unit: 'cells' },
			{ k: 'chi3', label: 'Kerr χ³ (exaggerated)', min: 0, max: 2, step: 0.01, v: 0.5 },
			{ k: 'ampA', label: 'Amplitude', min: 0, max: 2, step: 0.01, v: 0.1, live: true },
		],
		sweep: { amin: 0.02, amax: 1.0, kilo: 60 },
		build(p) {
			const W = Math.ceil(p.L + 2 * SP + 40), H = Math.ceil(Math.max(320, 16 * p.w0) + 2 * SP), yc = H / 2;
			return {
				W, H, nBg: p.n, chi3Bg: p.chi3, wl: p.wl, sponge: { width: SP }, parts: [],
				sources: [{ x: SP + 10, y0: 0, y1: H - 1, profile: 'gauss', yc, sigma: p.w0, ampKey: 'ampA', sweep: true, label: 'Beam' }],
				probes: [{ name: 'Total', role: 'in', x0: W - SP - 30, y0: SP, x1: W - SP - 30, y1: H - SP },
					{ name: 'Center ±w₀', role: 'out', x0: W - SP - 30, y0: yc - p.w0, x1: W - SP - 30, y1: yc + p.w0 }],
				info: {},
			};
		},
		hint(p, sc, ctx) {
			// field exp(-y^2/w0^2): Rayleigh range k w0^2 / 2. Paraxial NLS with d_eps = chi3 |A|^2 / 2 (Debye) has the
			// soliton A0 sech(y/a) with A0 = 2 / (k0 a sqrt(chi3)); equal intensity FWHM gives a = 0.668 w0.
			// in general d_eps = c chi3 |A|^2 (c = 1/2 Debye, 3/4 instantaneous): A0 = sqrt(2 / (c chi3)) / (k0 a)
			const k0 = 2 * Math.PI / p.wl, zR = k0 * p.n * p.w0 * p.w0 / 2, a = 0.668 * p.w0, c = ctx.instant ? 0.75 : 0.5 + 1 / (4 * (1 + (4 * Math.PI * ctx.tauPeriods) ** 2));
			const aSol = p.chi3 > 0 ? Math.sqrt(2 / (c * p.chi3)) / (k0 * a) : NaN;
			return `Rayleigh range ≈ ${zR.toFixed(0)} cells over ${p.L} cells of propagation. Rough soliton amplitude (sech approximation, ${ctx.instant ? 'instantaneous' : 'Debye'}) ≈ ${isFinite(aSol) ? aSol.toFixed(2) : '–'}.`;
		},
	},
	{
		id: 'xor', title: 'Linear XOR as in WaveDude (interference)',
		desc: 'Two inputs feed a 3-dB coupler. At phase B = +90°, the waves cancel at the lower output when both inputs are on, sending all light to the upper output: the lower output is the WaveDude “XOR” (at −90°, the outputs swap). Adjust the phase or amplitude of B: the result depends on both, and the output is not a clean 0/1. This is a limitation of linear gates.',
		params: [...common,
			{ k: 'gap', label: 'Gap', min: 3, max: 20, step: 0.5, v: 9, unit: 'cells' },
			{ k: 'sepOut', label: 'Outer separation', min: 40, max: 120, step: 1, v: 70, unit: 'cells' },
			{ k: 'bendLen', label: 'S-bend length', min: 80, max: 400, step: 5, v: 200, unit: 'cells' },
			{ k: 'chi3', label: 'Kerr χ³', min: 0, max: 2, step: 0.01, v: 0 },
			{ k: 'ampA', label: 'Amplitude A', min: 0, max: 2, step: 0.01, v: 0.3, live: true },
			{ k: 'ampB', label: 'Amplitude B', min: 0, max: 2, step: 0.01, v: 0.3, live: true },
			{ k: 'phaseB', label: 'Phase B', min: -180, max: 180, step: 1, v: 90, unit: '°', live: true },
		],
		build: p => couplerScene(p, Math.PI / 4, true),
		hint(p, sc) { const d = sc.spec.info.design; return `3-dB coupler: straight section ${d.L.toFixed(0)} cells, full coupling length would be ${d.Lc.toFixed(0)}.`; },
	},
];
