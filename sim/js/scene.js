// Scene building: rasterise parts into per-cell maps, solve waveguide modes, place sources and probes.
// Grid units: one cell = 1 length unit, vacuum light speed = 1, time step DT (see engine.js).
// Model: 2D TM (E_z only) Maxwell, i.e. eps * E_tt = lap E exactly in 2D; Kerr via D = eps E + chi3 * N * E.
import { DT } from './engine.js';
import { gridBudget, number } from './validation.js';

/** Squared discrete vacuum wavenumber seen by the leapfrog time step for angular frequency omega. */
export function kappaOf(omega) {
	const s = 2 * Math.sin(omega * DT / 2) / DT;
	return s * s;
}

/**
 * Guided modes of a 1D cross-section, exactly consistent with the isotropic 9-point stencil used by the engine.
 * For a field phi(y) * exp(i beta x) the 9-point Laplacian plus eps*kappa = 0 gives the symmetric generalised
 * eigenproblem (20 - 4S - 6 kappa eps) phi = c (2S + 8) phi with S phi_j = phi_{j-1} + phi_{j+1}, c = cos(beta).
 * The fundamental mode has the smallest c; inverse iteration with a shift just below the plane-wave bound finds it,
 * further modes by B-orthogonal deflation. Dirichlet ends: the window must contain the evanescent tails.
 */
export function solveModes(epsCol, omega, nModes = 1) {
	number(omega, 'Modenfrequenz', 1e-6, 1);
	const n = epsCol.length;
	const kap = kappaOf(omega);
	let emax = -Infinity, emin = Infinity, imax = 0;
	for (let j = 0; j < n; j++) {
		if (epsCol[j] > emax) { emax = epsCol[j]; imax = j; }
		if (epsCol[j] < emin) emin = epsCol[j];
	}
	const cMin = 1 - kap * emax / 2; // plane wave in the densest material
	const cClad = 1 - kap * emin / 2; // plane wave in the cladding: guided modes lie below this
	const sigma = cMin - 1e-5;
	const aD = new Float64Array(n), mD = new Float64Array(n);
	for (let j = 0; j < n; j++) { aD[j] = 20 - 6 * kap * epsCol[j]; mD[j] = aD[j] - 8 * sigma; }
	const aO = -4, bD = 8, bO = 2, mO = aO - sigma * bO;
	const mulB = (v, out) => { for (let j = 0; j < n; j++) out[j] = bD * v[j] + bO * ((j > 0 ? v[j - 1] : 0) + (j < n - 1 ? v[j + 1] : 0)); return out; };
	const mulA = (v, out) => { for (let j = 0; j < n; j++) out[j] = aD[j] * v[j] + aO * ((j > 0 ? v[j - 1] : 0) + (j < n - 1 ? v[j + 1] : 0)); return out; };
	const dot = (a, b) => { let s = 0; for (let j = 0; j < n; j++) s += a[j] * b[j]; return s; };
	// Thomas solve of the constant-off-diagonal tridiagonal system (mD, mO) y = r
	const cp = new Float64Array(n), dp = new Float64Array(n);
	const solve = (r, y) => {
		cp[0] = mO / mD[0]; dp[0] = r[0] / mD[0];
		for (let j = 1; j < n; j++) { const den = mD[j] - mO * cp[j - 1]; cp[j] = mO / den; dp[j] = (r[j] - mO * dp[j - 1]) / den; }
		y[n - 1] = dp[n - 1];
		for (let j = n - 2; j >= 0; j--) y[j] = dp[j] - cp[j] * y[j + 1];
		return y;
	};
	const modes = [];
	const symmetric = epsCol.every((e, j) => Math.abs(e - epsCol[n - 1 - j]) < 1e-10);
	const Bv = new Float64Array(n), tmp = new Float64Array(n);
	for (let m = 0; m < nModes; m++) {
		let v = new Float64Array(n);
		for (let j = 0; j < n; j++) {
			const z = (j - (symmetric ? (n - 1) / 2 : imax)) / (n / 6);
			v[j] = Math.exp(-z * z) * (m % 2 ? z : 1) + (symmetric ? 0 : 1e-3 * Math.sin(j * (m + 1.3)));
		}
		let c = 0, cOld = 2;
		for (let it = 0; it < 400; it++) {
			for (const p of modes) { const a = dot(p.Bphi, v); for (let j = 0; j < n; j++) v[j] -= a * p.phi[j]; }
			mulB(v, Bv);
			const y = solve(Bv, new Float64Array(n));
			// Near-degenerate separated guides converge slowly if parity mixes. Preserve exact
			// even/odd symmetry for symmetric cross-sections, without changing the eigenproblem.
			if (symmetric && m < 2) for (let j = 0; j < n / 2; j++) {
				const other = n - 1 - j, sign = m % 2 ? -1 : 1, value = (y[j] + sign * y[other]) / 2;
				y[j] = value; y[other] = sign * value;
			}
			for (const p of modes) { const a = dot(p.Bphi, y); for (let j = 0; j < n; j++) y[j] -= a * p.phi[j]; }
			const nb = Math.sqrt(dot(y, mulB(y, tmp)));
			for (let j = 0; j < n; j++) v[j] = y[j] / nb;
			c = dot(v, mulA(v, tmp)) / dot(v, mulB(v, Bv));
			if (Math.abs(c - cOld) < 1e-14) break;
			cOld = c;
		}
		const phi = Float64Array.from(v), Bphi = mulB(phi, new Float64Array(n));
		let pk = 0; for (let j = 0; j < n; j++) if (Math.abs(phi[j]) > Math.abs(pk)) pk = phi[j];
		const profile = Array.from(phi, x => x / pk);
		mulA(phi, tmp);
		let residual = 0, norm = 0;
		for (let j = 0; j < n; j++) { residual += (tmp[j] - c * Bphi[j]) ** 2; norm += tmp[j] ** 2 + (c * Bphi[j]) ** 2; }
		residual = Math.sqrt(residual / Math.max(norm, 1e-30));
		if (!Number.isFinite(c) || c <= -1 || c >= 1 || !(residual < 1e-6)) throw new Error(`Mode solver: non-propagating or unresolved mode (c=${c}, residual=${residual}).`);
		const beta = Math.acos(c);
		modes.push({ c, beta, neff: beta / omega, guided: c < cClad, residual, phi, Bphi, profile });
	}
	return modes;
}

// ---------- geometry ----------
const sdBox = (x, y, p) => { const dx = Math.max(p.x0 - x, x - p.x1), dy = Math.max(p.y0 - y, y - p.y1); return dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy); };
function sdPolyline(x, y, pts, segs) {
	let best = Infinity;
	for (const s of segs) {
		if (x < s.bx0 || x > s.bx1 || y < s.by0 || y > s.by1) continue;
		const ax = pts[s.i][0], ay = pts[s.i][1];
		let t = ((x - ax) * s.dx + (y - ay) * s.dy) * s.il2;
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		const d = Math.hypot(x - ax - t * s.dx, y - ay - t * s.dy);
		if (d < best) best = d;
	}
	return best;
}

function partSdf(p) {
	switch (p.type) {
		case 'rect': return { bbox: [p.x0, p.y0, p.x1, p.y1], sd: (x, y) => sdBox(x, y, p) };
		case 'disk': return { bbox: [p.cx - p.r, p.cy - p.r, p.cx + p.r, p.cy + p.r], sd: (x, y) => Math.hypot(x - p.cx, y - p.cy) - p.r };
		case 'ring': {
			const ro = p.r + p.w / 2;
			return { bbox: [p.cx - ro, p.cy - ro, p.cx + ro, p.cy + ro], sd: (x, y) => Math.abs(Math.hypot(x - p.cx, y - p.cy) - p.r) - p.w / 2 };
		}
		case 'wg': {
			const h = p.w / 2 + 2, pts = p.pts, segs = [];
			let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
			for (let i = 0; i + 1 < pts.length; i++) {
				const [ax, ay] = pts[i], [cx, cy] = pts[i + 1], dx = cx - ax, dy = cy - ay;
				const s = { i, dx, dy, il2: 1 / Math.max(dx * dx + dy * dy, 1e-12), bx0: Math.min(ax, cx) - h, bx1: Math.max(ax, cx) + h, by0: Math.min(ay, cy) - h, by1: Math.max(ay, cy) + h };
				segs.push(s);
				bx0 = Math.min(bx0, s.bx0); by0 = Math.min(by0, s.by0); bx1 = Math.max(bx1, s.bx1); by1 = Math.max(by1, s.by1);
			}
			return { bbox: [bx0, by0, bx1, by1], sd: (x, y) => sdPolyline(x, y, pts, segs) - p.w / 2 };
		}
		default: throw new Error('unknown part type ' + p.type);
	}
}

/** Cosine S-bend from (x0,y0) to (x1,y1) as polyline points (without the first point). */
export function sbend(x0, y0, x1, y1, n = 48) {
	const out = [];
	for (let k = 1; k <= n; k++) { const s = k / n; out.push([x0 + (x1 - x0) * s, y0 + (y1 - y0) * (1 - Math.cos(Math.PI * s)) / 2]); }
	return out;
}

/**
 * Builds the per-cell maps from a scene spec:
 *   { W, H, nBg, sponge: { width, sides: 'lrtb', strength }, kerr: { instant, tauPeriods }, wl,
 *     parts: [{ type, ..., n, chi3, loss }], sources: [...], probes: [...] }
 * Returns typed arrays plus resolved sources (mode profiles, weights) and probe cell lists.
 */
export function buildScene(spec, limits) {
	gridBudget(spec.W, spec.H, limits);
	number(spec.nBg, 'Background refractive index', 1, 3.5);
	number(spec.chi3Bg ?? 0, 'Background χ³', 0, 2);
	number(spec.wl, 'Wavelength', 16, 48);
	for (const p of spec.parts || []) { number(p.n ?? spec.nBg, 'Refractive index', 1, 3.5); number(p.chi3 ?? 0, 'χ³', 0, 2); }
	const W = spec.W, H = spec.H, N = W * H;
	const eps = new Float32Array(N).fill(spec.nBg * spec.nBg);
	const chi3 = new Float32Array(N).fill(spec.chi3Bg || 0);
	const damp = new Float32Array(N).fill(1);
	const SS = 4;
	for (const p of spec.parts || []) {
		const { bbox, sd } = partSdf(p);
		const x0 = Math.max(0, Math.floor(bbox[0]) - 1), y0 = Math.max(0, Math.floor(bbox[1]) - 1);
		const x1 = Math.min(W - 1, Math.ceil(bbox[2]) + 1), y1 = Math.min(H - 1, Math.ceil(bbox[3]) + 1);
		const e2 = (p.n ?? spec.nBg) ** 2, c3 = p.chi3 || 0, keepChi = p.chi3 === undefined;
		const dP = 1 - (p.loss || 0);
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			const cx = x + 0.5, cy = y + 0.5, d = sd(cx, cy);
			let f;
			if (d <= -0.75) f = 1; else if (d >= 0.75) f = 0;
			else { let k = 0; for (let a = 0; a < SS; a++) for (let b = 0; b < SS; b++) if (sd(x + (a + 0.5) / SS, y + (b + 0.5) / SS) < 0) k++; f = k / (SS * SS); }
			if (f <= 0) continue;
			const i = y * W + x;
			if (p.n !== undefined) eps[i] = eps[i] * (1 - f) + e2 * f; // volume-averaged eps: exact effective medium for E parallel to the interface (TM_z)
			if (!keepChi) chi3[i] = chi3[i] * (1 - f) + c3 * f;
			if (p.loss) damp[i] = Math.min(damp[i], 1 - f * (1 - dP));
		}
	}
	// absorbing sponge: velocity damping with a quadratic ramp; the outer edge itself is zero-gradient
	const sp = spec.sponge || {}, sw = sp.width ?? 64, sides = sp.sides ?? 'lrtb', smax = sp.strength ?? 0.15;
	if (sw > 0) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		let r = Infinity;
		if (sides.includes('l')) r = Math.min(r, x);
		if (sides.includes('r')) r = Math.min(r, W - 1 - x);
		if (sides.includes('t')) r = Math.min(r, y);
		if (sides.includes('b')) r = Math.min(r, H - 1 - y);
		if (r < sw) { const q = (sw - r) / sw; const i = y * W + x; damp[i] = Math.min(damp[i], 1 - smax * q * q); }
	}
	// Mode sheets: J = 2 A sin(beta) C phi, C = (4 I + S_y)/6 for the 9-point stencil.
	const srcW = new Float32Array(N), srcK = new Float32Array(N).fill(-1);
	const sources = [];
	(spec.sources || []).forEach((s, k) => {
		const wl = s.wl ?? spec.wl, omega = 2 * Math.PI / wl;
		const y0 = Math.max(0, Math.round(s.y0)), y1 = Math.min(H - 1, Math.round(s.y1)), x = Math.round(s.x);
		const col = []; for (let y = y0; y <= y1; y++) col.push(eps[y * W + x]);
		let profile, beta, info = {};
		if (s.profile === 'mode') {
			const m = solveModes(col, omega, 1)[0];
			if (!m.guided) throw new Error('Source: no guided mode in the source window.');
			profile = m.profile; beta = m.beta; info = { neff: m.neff, guided: m.guided };
		} else {
			const yc = s.yc ?? (y0 + y1) / 2, sg = s.sigma ?? 1e9;
			profile = col.map((_, j) => { const z = (y0 + j + 0.5 - yc) / sg; return s.profile === 'gauss' ? Math.exp(-z * z) : 1; });
			const e = eps[Math.round(yc) * W + x];
			beta = Math.acos(Math.max(-1, 1 - kappaOf(omega) * e / 2));
			info = { neff: beta / omega };
		}
		const wgt = 2 * Math.sin(beta);
		for (let j = 0; j < profile.length; j++) {
			const i = (y0 + j) * W + x;
			// Dirichlet tails for a mode window; homogeneous flat sources keep Neumann edges.
			const left = profile[j - 1] ?? (s.profile === 'flat' ? profile[j] : 0);
			const right = profile[j + 1] ?? (s.profile === 'flat' ? profile[j] : 0);
			srcW[i] = wgt * (4 * profile[j] + left + right) / 6; srcK[i] = k;
		}
		// C phi has one nonzero cell beyond each truncated Dirichlet window.
		if (s.profile === 'mode') for (const [y, value] of [[y0 - 1, profile[0]], [y1 + 1, profile[profile.length - 1]]]) {
			if (y >= 0 && y < H) { srcW[y * W + x] = wgt * value / 6; srcK[y * W + x] = k; }
		}
		sources.push({ ...s, wl, omega, beta, x, y0, y1, info });
	});
	// probes: straight lines, cells sampled at unit steps
	const probes = (spec.probes || []).map(p => {
		const len = Math.max(Math.abs(p.x1 - p.x0), Math.abs(p.y1 - p.y0)), set = new Set();
		for (let s = 0; s <= len; s++) {
			const x = Math.round(p.x0 + (p.x1 - p.x0) * s / Math.max(len, 1)), y = Math.round(p.y0 + (p.y1 - p.y0) * s / Math.max(len, 1));
			if (x >= 0 && x < W && y >= 0 && y < H) set.add(y * W + x);
		}
		const cx = Math.round((p.x0 + p.x1) / 2), cy = Math.round((p.y0 + p.y1) / 2);
		return { ...p, cells: Uint32Array.from(set), center: cy * W + cx };
	});
	let nMax = spec.nBg; for (const p of spec.parts || []) if (p.n !== undefined) nMax = Math.max(nMax, p.n);
	return { spec, W, H, eps, chi3, damp, srcW, srcK, sources, probes, nBg: spec.nBg, nMax };
}

/** eps column across y at x (whole height) for a list of horizontal guides, used to design couplers before rasterising. */
export function slabColumn(H, nBg, guides) {
	const col = new Array(H).fill(nBg * nBg);
	for (const g of guides) for (let y = 0; y < H; y++) {
		const lo = Math.max(y, g.yc - g.w / 2), hi = Math.min(y + 1, g.yc + g.w / 2), f = Math.max(0, hi - lo);
		col[y] = col[y] * (1 - f) + g.n * g.n * f;
	}
	return col;
}
