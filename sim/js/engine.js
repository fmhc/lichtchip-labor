// WebGPU engine: leapfrog for the 2D TM wave equation in D-form with Kerr nonlinearity.
//   D^{n+1} = D^n + (D^n - D^{n-1}) * d + DT^2 * (lap9 E^n + J^n)        (d = 1 lossless, < 1 in sponge/absorbers)
//   E^{n+1} from D^{n+1} = eps E + chi3 N E,  N = E^2 (instantaneous, Newton) or dN/dt = (E^2 - N) / tau (Debye)
// lap9 is the isotropic 9-point Laplacian (4*edges + corners - 20*centre) / 6, stable for c*DT <= 0.866.
export const DT = 0.5;
export const MAX_SRC = 8;
import { gridBudget, number } from './validation.js';
const TS_CAP = 1 << 20; // 4 MiB: allows a resolved ringdown with three recorded ports.

const COMMON = /* wgsl */`
struct Params { w: u32, h: u32, nsrc: u32, kerrInstant: u32,
  dt: f32, tauKerr: f32, alphaI: f32, frameStep: u32,
  tsBase: u32, tsCap: u32, nts: u32, linear: u32 };
struct Src { omega: f32, phase: f32, mode: u32, on: f32,
  rampT0: f32, rampT1: f32, a0: f32, a1: f32,
  rise: f32, pulseC: f32, pulseW: f32, pad: f32 };
`;

const STEP_D = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> clock: array<u32>;
@group(0) @binding(2) var<storage, read> srcs: array<Src>;
@group(0) @binding(3) var<storage, read> E: array<f32>;
@group(0) @binding(4) var<storage, read> Dc: array<f32>;
@group(0) @binding(5) var<storage, read_write> Dp: array<f32>;
@group(0) @binding(6) var<storage, read> damp: array<f32>;
@group(0) @binding(7) var<storage, read> srcCell: array<vec2f>;

fn srcVal(k: u32, n: u32) -> f32 {
  let s = srcs[k];
  let t = f32(n) * P.dt;
  var env = s.on;
  if (s.rise > 0.0) { let r = clamp(t / s.rise, 0.0, 1.0); env = env * r * r * (3.0 - 2.0 * r); }
  let a = mix(s.a0, s.a1, clamp((t - s.rampT0) / max(s.rampT1 - s.rampT0, 1e-6), 0.0, 1.0));
  if (s.mode == 1u) { let z = (t - s.pulseC) / s.pulseW; env = env * exp(-z * z); }
  return env * a * sin(s.phase + s.omega * f32(n - P.frameStep) * P.dt);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let w = i32(P.w); let h = i32(P.h);
  let x = i32(g.x); let y = i32(g.y);
  let xm = max(x - 1, 0); let xp = min(x + 1, w - 1);
  let ym = max(y - 1, 0) * w; let yp = min(y + 1, h - 1) * w; let yc = y * w;
  let i = yc + x;
  let c = E[i];
  var rhs = (4.0 * (E[yc + xm] + E[yc + xp] + E[ym + x] + E[yp + x])
           + (E[ym + xm] + E[ym + xp] + E[yp + xm] + E[yp + xp]) - 20.0 * c) * (1.0 / 6.0);
  let s = srcCell[i];
  if (s.y >= 0.0) { rhs = rhs + s.x * srcVal(u32(s.y), clock[0]); }
  let d = Dc[i];
  Dp[i] = d + (d - Dp[i]) * damp[i] + P.dt * P.dt * rhs;
}`;

const STEP_E = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> clock: array<u32>;
@group(0) @binding(2) var<storage, read> Dn: array<f32>;
@group(0) @binding(3) var<storage, read> eps: array<f32>;
@group(0) @binding(4) var<storage, read> chi3: array<f32>;
@group(0) @binding(5) var<storage, read_write> E: array<f32>;
@group(0) @binding(6) var<storage, read_write> Nk: array<f32>;
@group(0) @binding(7) var<storage, read_write> Ib: array<vec2f>;
@group(0) @binding(8) var<storage, read_write> fault: atomic<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let i = g.y * P.w + g.x;
  if (i == 0u) { clock[0] = clock[0] + 1u; }
  let dn = Dn[i]; let e0 = eps[i]; let c3 = select(chi3[i], 0.0, P.linear == 1u);
  let eo = E[i];
  var e = dn / e0;
  if (c3 != 0.0) {
    if (P.kerrInstant == 1u) {
      // Positive chi3: monotone cubic, bracketed Newton with checked residual.
      let magnitude = abs(dn);
      var lo = 0.0; var hi = magnitude / e0;
      var x = clamp(abs(eo), lo, hi);
      for (var k = 0; k < 24; k++) {
        let f = e0 * x + c3 * x * x * x - magnitude;
        if (abs(f) <= 2e-6 * max(magnitude, 1e-6)) { break; }
        if (f > 0.0) { hi = x; } else { lo = x; }
        let fp = e0 + 3.0 * c3 * x * x;
        var next = x - f / fp;
        if (!(next > lo && next < hi)) { next = (lo + hi) * 0.5; }
        x = next;
      }
      e = sign(dn) * x;
      if (!(abs(e0 * e + c3 * e * e * e - dn) <= 1e-5 * max(abs(dn), 1e-6))) { atomicStore(&fault, 1u); }
      Nk[i] = x * x;
    } else {
      let nk = Nk[i] + (eo * eo - Nk[i]) * (P.dt / P.tauKerr);
      Nk[i] = nk;
      let differential = e0 + c3 * nk;
      if (!(differential >= 0.5)) { atomicStore(&fault, 1u); }
      e = dn / differential;
    }
  }
  // eps >= 1, chi3 >= 0 gives CFL margin: DT²*(16/3)/eps <= 4/3 < 4.
  if (!(abs(e) < 1e10) || !(e0 + 3.0 * c3 * e * e >= 0.5)) { atomicStore(&fault, 1u); e = 0.0; }
  E[i] = e;
  let ib = Ib[i];
  let s1 = ib.x + (e * e - ib.x) * P.alphaI;
  Ib[i] = vec2f(s1, ib.y + (s1 - ib.y) * P.alphaI);
}`;

const TS = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> clock: array<u32>;
@group(0) @binding(2) var<storage, read> E: array<f32>;
@group(0) @binding(3) var<storage, read> tsIdx: array<u32>;
@group(0) @binding(4) var<storage, read_write> ts: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let j = g.x;
  if (j >= P.nts) { return; }
  let n = clock[0];
  if (n <= P.tsBase) { return; }
  let k = n - P.tsBase - 1u;
  if (k >= P.tsCap) { return; }
  ts[k * P.nts + j] = E[tsIdx[j]];
}`;

const PROBE = /* wgsl */`
@group(0) @binding(0) var<storage, read> Ib: array<vec2f>;
@group(0) @binding(1) var<storage, read> idx: array<u32>;
@group(0) @binding(2) var<storage, read> off: array<u32>;
@group(0) @binding(3) var<storage, read_write> outv: array<f32>;
var<workgroup> acc: array<f32, 64>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let p = wid.x;
  let a = off[p]; let b = off[p + 1u];
  var s = 0.0;
  for (var j = a + li; j < b; j = j + 64u) { s = s + Ib[idx[j]].y; }
  acc[li] = s;
  workgroupBarrier();
  for (var st = 32u; st > 0u; st = st >> 1u) {
    if (li < st) { acc[li] = acc[li] + acc[li + st]; }
    workgroupBarrier();
  }
  if (li == 0u) { outv[p] = acc[0]; }
}`;

const RENDER = /* wgsl */`
struct View { cw: f32, ch: f32, w: u32, h: u32, mode: u32, showMat: u32, gainF: f32, gainI: f32,
  nBg: f32, nSpan: f32, decades: f32, pad: f32 };
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> E: array<f32>;
@group(0) @binding(2) var<storage, read> Ib: array<vec2f>;
@group(0) @binding(3) var<storage, read> eps: array<f32>;
@group(0) @binding(4) var<storage, read> chi3: array<f32>;
@group(0) @binding(5) var<storage, read> damp: array<f32>;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}
fn ramp(q: f32) -> vec3f {
  let c0 = vec3f(0.0, 0.0, 0.0); let c1 = vec3f(0.30, 0.06, 0.42); let c2 = vec3f(0.78, 0.18, 0.34);
  let c3 = vec3f(0.99, 0.55, 0.12); let c4 = vec3f(1.0, 0.97, 0.78);
  let t = clamp(q, 0.0, 1.0) * 4.0;
  if (t < 1.0) { return mix(c0, c1, t); }
  if (t < 2.0) { return mix(c1, c2, t - 1.0); }
  if (t < 3.0) { return mix(c2, c3, t - 2.0); }
  return mix(c3, c4, t - 3.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let x = min(u32(p.x / V.cw * f32(V.w)), V.w - 1u);
  let y = min(u32(p.y / V.ch * f32(V.h)), V.h - 1u);
  let i = y * V.w + x;
  let n = sqrt(max(eps[i], 1e-6));
  var base = vec3f(0.035, 0.04, 0.055);
  if (V.showMat == 1u) {
    let m = clamp((n - V.nBg) / V.nSpan, 0.0, 1.0);
    base = base + m * vec3f(0.12, 0.13, 0.15);
    if (chi3[i] != 0.0) { base = base + vec3f(0.035, 0.0, 0.05) + m * vec3f(0.06, 0.0, 0.08); }
    if (damp[i] < 0.99999) { base = base * 0.6; }
  }
  var col = base;
  if (V.mode == 0u) {
    let v = clamp(E[i] * V.gainF, -1.0, 1.0);
    col = base * (1.0 - 0.5 * abs(v)) + max(v, 0.0) * vec3f(1.0, 0.62, 0.25) + max(-v, 0.0) * vec3f(0.30, 0.62, 1.0);
  } else {
    let I = Ib[i].y * V.gainI;
    var q = I;
    if (V.mode == 2u) { q = 1.0 + log(max(I, 1e-12)) / (2.302585 * V.decades); }
    col = base + ramp(q);
  }
  return vec4f(min(col, vec3f(1.0)), 1.0);
}`;

// GPUBufferUsage bits as literals, so importing this module never throws in a browser without WebGPU
const SB = 0x80, CD = 0x08, CS = 0x04;

export class Engine {
	static async create(canvas) {
		if (!navigator.gpu) throw new Error('WebGPU unavailable. HTTPS or localhost, a supported browser and compatible GPU drivers are required.');
		const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
		if (!adapter) throw new Error('No WebGPU adapter found.');
		const lim = adapter.limits;
		const device = await adapter.requestDevice({ requiredLimits: {
			maxStorageBufferBindingSize: Math.min(lim.maxStorageBufferBindingSize, 1 << 30),
			maxBufferSize: Math.min(lim.maxBufferSize, 1 << 30),
			maxStorageBuffersPerShaderStage: Math.min(lim.maxStorageBuffersPerShaderStage, 10),
		} });
		device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory');
		let engine;
		try { engine = new Engine(device, adapter, canvas); }
		finally {
			const memory = await device.popErrorScope(), validation = await device.popErrorScope();
			if (memory || validation) { device.destroy(); throw new Error((memory || validation).message); }
		}
		return engine;
	}

	constructor(device, adapter, canvas) {
		this.device = device;
		this.generation = 0; this.usable = true; this.linear = false;
		device.addEventListener('uncapturederror', ev => { ev.preventDefault(); this.fail(ev.error); });
		device.lost.then(info => this.fail(new Error(`GPU device lost: ${info.message}`)));
		this.adapterInfo = adapter.info || {};
		const mk = (code, entry = 'main') => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: entry } });
		this.pD = mk(STEP_D); this.pE = mk(STEP_E); this.pTs = mk(TS); this.pProbe = mk(PROBE);
		this.canvas = canvas;
		if (canvas) {
			this.ctx = canvas.getContext('webgpu');
			this.format = navigator.gpu.getPreferredCanvasFormat();
			this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
			const mod = device.createShaderModule({ code: RENDER });
			this.pRender = device.createRenderPipeline({ layout: 'auto', vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format: this.format }] }, primitive: { topology: 'triangle-list' } });
			this.viewBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | CD });
		}
		this.paramBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | CD });
		this.srcBuf = device.createBuffer({ size: 48 * MAX_SRC, usage: SB | CD });
		this.clockBuf = device.createBuffer({ size: 16, usage: SB | CD | CS });
		this.buffers = [];
		this.probeVals = null;
		this.tauKerr = 64; this.kerrInstant = false; this.alphaI = DT / 64;
	}

	_buf(sizeBytes, usage = SB | CD | CS) { const b = this.device.createBuffer({ size: Math.max(16, Math.ceil(sizeBytes / 4) * 4), usage }); this.buffers.push(b); return b; }
	_upload(arr, usage) { const b = this._buf(arr.byteLength, usage); this.device.queue.writeBuffer(b, 0, arr); return b; }

	/** Loads a built scene (see scene.js buildScene) and resets the state. tsPoints: cell indices to record each step. */
	async load(sc, tsPoints = [], valid = () => true) {
		gridBudget(sc.W, sc.H, this.device.limits);
		if (sc.sources.length > MAX_SRC || sc.probes.length > this.device.limits.maxComputeWorkgroupsPerDimension || tsPoints.length > 256 || tsPoints.some(i => !Number.isSafeInteger(i) || i < 0 || i >= sc.W * sc.H)) throw new Error('Too many sources/probes or invalid probe position.');
		if (TS_CAP * 4 > Math.min(this.device.limits.maxBufferSize, this.device.limits.maxStorageBufferBindingSize)) throw new Error('Time series exceeds the GPU buffer limit.');
		if (!this.usable) throw new Error('GPU device unavailable.');
		// Build on an isolated holder, including clock and uniforms. Old scene remains usable on failure.
		const next = Object.assign(Object.create(Engine.prototype), this, { buffers: [] });
		const dev = this.device;
		dev.pushErrorScope('validation'); dev.pushErrorScope('out-of-memory');
		let failure;
		try { next._load(sc, tsPoints); } catch (e) { failure = e; }
		const memory = await dev.popErrorScope(), validation = await dev.popErrorScope();
		if (failure || memory || validation || !this.usable || !valid()) {
			for (const b of next.buffers) b.destroy();
			throw failure || new Error((memory || validation)?.message || (!valid() ? 'Build cancelled.' : 'GPU device lost.'));
		}
		const previous = [...this.buffers, this.paramBuf, this.srcBuf, this.clockBuf];
		Object.assign(this, next);
		for (const b of previous) b.destroy();
	}

	_load(sc, tsPoints) {
		this.buffers = [];
		this.paramBuf = this._buf(48, GPUBufferUsage.UNIFORM | CD);
		this.srcBuf = this._buf(48 * MAX_SRC); this.clockBuf = this._buf(16);
		this.fault = this._buf(16); this.faultStage = this._buf(16, GPUBufferUsage.MAP_READ | CD); this.faultBusy = false;
		const W = sc.W, H = sc.H, N = W * H, dev = this.device;
		this.sc = sc; this.W = W; this.H = H; this.N = N;
		this.E = this._buf(N * 4); this.Da = this._buf(N * 4); this.Db = this._buf(N * 4);
		this.Nk = this._buf(N * 4); this.Ib = this._buf(N * 8);
		this.eps = this._upload(sc.eps); this.chi3 = this._upload(sc.chi3); this.damp = this._upload(sc.damp);
		const sc2 = new Float32Array(2 * N);
		for (let i = 0; i < N; i++) { sc2[2 * i] = sc.srcW[i]; sc2[2 * i + 1] = sc.srcK[i]; }
		this.srcCell = this._upload(sc2);
		// probes
		const offs = [0], idx = [];
		for (const p of sc.probes) { for (const c of p.cells) idx.push(c); offs.push(idx.length); }
		this.nProbe = sc.probes.length;
		this.probeIdx = this._upload(Uint32Array.from(idx.length ? idx : [0]));
		this.probeOff = this._upload(Uint32Array.from(offs));
		this.probeOut = this._buf(Math.max(1, this.nProbe) * 4);
		this.probeStage = this._buf(Math.max(1, this.nProbe) * 4, GPUBufferUsage.MAP_READ | CD);
		this.probeBusy = false; this.probeVals = new Float32Array(this.nProbe);
		// time series
		this.nts = tsPoints.length;
		this.tsIdx = this._upload(Uint32Array.from(this.nts ? tsPoints : [0]));
		this.tsCap = this.nts ? Math.floor(TS_CAP / this.nts) : 1;
		this.tsBuf = this._buf(this.nts ? TS_CAP * 4 : 16);
		this.tsBase = 0xffffffff;
		const bg = (p, list) => dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: list.map((b, i) => ({ binding: i, resource: { buffer: b } })) });
		this.bgD = [bg(this.pD, [this.paramBuf, this.clockBuf, this.srcBuf, this.E, this.Da, this.Db, this.damp, this.srcCell]),
			bg(this.pD, [this.paramBuf, this.clockBuf, this.srcBuf, this.E, this.Db, this.Da, this.damp, this.srcCell])];
		this.bgE = [bg(this.pE, [this.paramBuf, this.clockBuf, this.Db, this.eps, this.chi3, this.E, this.Nk, this.Ib, this.fault]),
			bg(this.pE, [this.paramBuf, this.clockBuf, this.Da, this.eps, this.chi3, this.E, this.Nk, this.Ib, this.fault])];
		this.bgTs = bg(this.pTs, [this.paramBuf, this.clockBuf, this.E, this.tsIdx, this.tsBuf]);
		this.bgProbe = this.nProbe ? bg(this.pProbe, [this.Ib, this.probeIdx, this.probeOff, this.probeOut]) : null;
		if (this.pRender) this.bgRender = bg(this.pRender, [this.viewBuf, this.E, this.Ib, this.eps, this.chi3, this.damp]);
		this.reset();
	}

	reset() {
		this.generation++; this.probeAt = -1;
		// A pending mapping belongs to the previous generation. Use new staging buffers.
		for (const key of ['probeStage', 'faultStage']) if (this[key]) {
			this[key].destroy(); this.buffers = this.buffers.filter(b => b !== this[key]);
			this[key] = this._buf(key === 'probeStage' ? Math.max(16, this.nProbe * 4) : 16, GPUBufferUsage.MAP_READ | CD);
		}
		this.probeBusy = false; this.faultBusy = false;
		const enc = this.device.createCommandEncoder();
		for (const b of [this.E, this.Da, this.Db, this.Nk, this.Ib, this.clockBuf, this.fault]) enc.clearBuffer(b);
		this.device.queue.submit([enc.finish()]);
		this.step = 0; this.parity = 0; this.tsBase = 0xffffffff;
		this.probeVals = new Float32Array(this.nProbe);
	}

	/** Start recording the time series at the current step; returns the step after which sample 0 is taken. */
	startRecording() { this.tsBase = this.step; return this.step; }
	stopRecording() { this.tsBase = 0xffffffff; }

	/**
	 * Advances nSteps. srcs: array of { omega, phase0, mode, on, a0, a1, rampT0, rampT1, rise, pulseC, pulseW } where
	 * phase0 is the phase at t = 0; the per-frame phase is computed here in double precision.
	 */
	advance(nSteps, srcs, { render = null, readProbes = true } = {}) {
		if (!this.usable) throw new Error('GPU device unavailable.');
		number(nSteps, 'Schritte pro Dispatchblock', 1, 10000, true);
		if (!this.kerrInstant && !(this.tauKerr >= DT)) throw new Error('Debye requires Δt/τ ≤ 1.');
		const dev = this.device, W = this.W, H = this.H;
		const pb = new ArrayBuffer(48), pu = new Uint32Array(pb), pf = new Float32Array(pb);
		pu[0] = W; pu[1] = H; pu[2] = srcs.length; pu[3] = this.kerrInstant ? 1 : 0;
		pf[4] = DT; pf[5] = this.tauKerr; pf[6] = this.alphaI; pu[7] = this.step >>> 0;
		pu[8] = this.tsBase >>> 0; pu[9] = this.tsCap; pu[10] = this.nts; pu[11] = this.linear ? 1 : 0;
		dev.queue.writeBuffer(this.paramBuf, 0, pb);
		const sb = new ArrayBuffer(48 * MAX_SRC), su = new Uint32Array(sb), sf = new Float32Array(sb);
		srcs.slice(0, MAX_SRC).forEach((s, k) => {
			const o = 12 * k, t0 = this.step * DT;
			sf[o] = s.omega; sf[o + 1] = ((s.phase0 || 0) + s.omega * t0) % (2 * Math.PI); su[o + 2] = s.mode || 0; sf[o + 3] = s.on ?? 1;
			sf[o + 4] = s.rampT0 ?? 0; sf[o + 5] = s.rampT1 ?? 1; sf[o + 6] = s.a0 ?? 0; sf[o + 7] = s.a1 ?? s.a0 ?? 0;
			sf[o + 8] = s.rise ?? 0; sf[o + 9] = s.pulseC ?? 0; sf[o + 10] = s.pulseW ?? 1;
		});
		dev.queue.writeBuffer(this.srcBuf, 0, sb);
		const enc = dev.createCommandEncoder();
		const pass = enc.beginComputePass();
		const gx = Math.ceil(W / 16), gy = Math.ceil(H / 16);
		for (let s = 0; s < nSteps; s++) {
			pass.setPipeline(this.pD); pass.setBindGroup(0, this.bgD[this.parity]); pass.dispatchWorkgroups(gx, gy);
			pass.setPipeline(this.pE); pass.setBindGroup(0, this.bgE[this.parity]); pass.dispatchWorkgroups(gx, gy);
			if (this.nts && this.tsBase !== 0xffffffff) { pass.setPipeline(this.pTs); pass.setBindGroup(0, this.bgTs); pass.dispatchWorkgroups(Math.ceil(this.nts / 64)); }
			this.parity ^= 1;
		}
		let doProbe = readProbes && this.nProbe && !this.probeBusy;
		if (doProbe) { pass.setPipeline(this.pProbe); pass.setBindGroup(0, this.bgProbe); pass.dispatchWorkgroups(this.nProbe); }
		pass.end();
		if (doProbe) enc.copyBufferToBuffer(this.probeOut, 0, this.probeStage, 0, this.nProbe * 4);
		const checkFault = !this.faultBusy;
		if (checkFault) enc.copyBufferToBuffer(this.fault, 0, this.faultStage, 0, 16);
		if (render && this.pRender) this._encodeRender(enc, render);
		dev.queue.submit([enc.finish()]);
		this.step += nSteps;
		if (doProbe) {
			this.probeBusy = true;
			const at = this.step, gen = this.generation, stage = this.probeStage, count = this.nProbe;
			this.probePromise = stage.mapAsync(GPUMapMode.READ).then(() => {
				if (gen !== this.generation) return;
				this.probeVals = new Float32Array(stage.getMappedRange().slice(0, count * 4));
				this.probeAt = at;
			}).catch(e => { if (gen === this.generation) this.fail(e); }).finally(() => {
				if (stage.mapState === 'mapped') stage.unmap();
				if (gen === this.generation) this.probeBusy = false;
			});
		}
		if (checkFault) {
			const gen = this.generation, stage = this.faultStage; this.faultBusy = true;
			this.faultPromise = stage.mapAsync(GPUMapMode.READ).then(() => {
				if (gen === this.generation && new Uint32Array(stage.getMappedRange())[0]) this.fail(new Error('Materialsolver: Residuum, Endlichkeit oder CFL-Sicherheitsabstand verletzt.'));
			}).catch(e => { if (gen === this.generation) this.fail(e); }).finally(() => {
				if (stage.mapState === 'mapped') stage.unmap();
				if (gen === this.generation) this.faultBusy = false;
			});
		}
	}

	_encodeRender(enc, v) {
		const b = new ArrayBuffer(48), u = new Uint32Array(b), f = new Float32Array(b);
		f[0] = this.canvas.width; f[1] = this.canvas.height; u[2] = this.W; u[3] = this.H; u[4] = v.mode; u[5] = v.showMat ? 1 : 0;
		f[6] = v.gainF; f[7] = v.gainI; f[8] = this.sc.nBg; f[9] = Math.max(1e-3, this.sc.nMax - this.sc.nBg); f[10] = v.decades || 3;
		this.device.queue.writeBuffer(this.viewBuf, 0, b);
		const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
		pass.setPipeline(this.pRender); pass.setBindGroup(0, this.bgRender); pass.draw(3); pass.end();
	}

	render(v) { const enc = this.device.createCommandEncoder(); this._encodeRender(enc, v); this.device.queue.submit([enc.finish()]); }

	fail(error) { this.usable = false; this.generation++; this.error = error; this.onError?.(error); }
	dispose() {
		this.usable = false; this.generation++;
		for (const b of new Set([...this.buffers, this.paramBuf, this.srcBuf, this.clockBuf, this.viewBuf])) b?.destroy();
		this.ctx?.unconfigure();
	}
	async idle() {
		await this.device.queue.onSubmittedWorkDone(); if (this.probePromise) await this.probePromise;
		if (this.faultPromise) await this.faultPromise;
		if (!this.usable) throw this.error || new Error('GPU unavailable.');
		// Also inspect the latest step when a batch was submitted while a readback was pending.
		const flag = await this.readField('fault');
		if (new Uint32Array(flag.buffer)[0]) { const e = new Error('Material solver: invalid state.'); this.fail(e); throw e; }
	}

	/** Reads the first nSamples recorded samples: Float32Array laid out [sample][point]. */
	async readTs(nSamples) {
		const n = Math.min(nSamples, this.tsCap) * this.nts, bytes = Math.max(16, n * 4);
		const st = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | CD });
		try {
			const enc = this.device.createCommandEncoder(); enc.copyBufferToBuffer(this.tsBuf, 0, st, 0, bytes); this.device.queue.submit([enc.finish()]);
			await st.mapAsync(GPUMapMode.READ);
			return new Float32Array(st.getMappedRange().slice(0, n * 4));
		} finally { if (st.mapState === 'mapped') st.unmap(); st.destroy(); }
	}

	/** Reads a whole field buffer (name: 'E' | 'Ib' | 'Nk'); for diagnostics and tests. */
	async readField(name) {
		const src = this[name], bytes = src.size;
		const st = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | CD });
		try {
			const enc = this.device.createCommandEncoder(); enc.copyBufferToBuffer(src, 0, st, 0, bytes); this.device.queue.submit([enc.finish()]);
			await st.mapAsync(GPUMapMode.READ);
			return new Float32Array(st.getMappedRange().slice(0));
		} finally { if (st.mapState === 'mapped') st.unmap(); st.destroy(); }
	}
}
