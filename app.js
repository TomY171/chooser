/* Chooser — finger chooser with secret spots.
 *
 * Everyone holds a finger on the screen; after the set of fingers has been
 * stable for a second a ring sweeps around every finger and one is picked.
 *
 * Secret spots (set in the hidden settings, opened by tapping the top-right
 * corner 5 times quickly):
 *   - a finger on the WIN spot when the pick happens is always picked;
 *   - a finger on the LOSE spot is never picked.
 * Spots are stored relative to the physical screen (device portrait), so they
 * stay on the same place of the glass even if the app rotates.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Debug / test hooks — only with ?debug in the URL.
  // ---------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const DEBUG = params.has('debug');
  const SPEED = DEBUG ? Math.min(50, Math.max(0.1, Number(params.get('speed')) || 1)) : 1;
  const MUTED = DEBUG && !params.has('sound'); // automated test runs stay silent
  const clock = () => (performance.now() / 1000) * SPEED; // game time, seconds
  const realNow = () => performance.now() / 1000;          // wall time, seconds

  // ---------------------------------------------------------------------------
  // Look & timing (measured from the reference recording; sizes in CSS px).
  // ---------------------------------------------------------------------------
  const TAU = Math.PI * 2;
  const BG = '#000000'; // true black: OLED pixels off
  // The seven finger colours of the reference app (fill / base ring / progress ring), sampled
  // from the recordings. Each new finger gets a random colour that is not already on screen.
  const PALETTE = [
    { fill: '#e1e1e1', ring: '#a8a8a8', prog: '#fefefe' }, // white
    { fill: '#fb7100', ring: '#b46b24', prog: '#fcae64' }, // orange
    { fill: '#f7dc4a', ring: '#e8bf01', prog: '#f9e695' }, // yellow
    { fill: '#80ba31', ring: '#57811a', prog: '#8afd01' }, // green
    { fill: '#0884a8', ring: '#1e6678', prog: '#56b8d0' }, // teal
    { fill: '#e9323a', ring: '#c90036', prog: '#e15a5a' }, // red
    { fill: '#e232a2', ring: '#c80080', prog: '#e05bb2' }, // pink
  ];
  const WHITE = 0;
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const PAL_RGB = PALETTE.map((p) => ({ fill: hexRgb(p.fill), ring: hexRgb(p.ring), prog: hexRgb(p.prog) }));
  const mixRgb = (a, b, k) => 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',') + ')';
  const MAX_COUNT = 4;       // up to 4 winners or 4 groups (an iPhone tracks at most 5 fingers)
  const T_GROUP_TINT = 0.25; // groups: white -> team colour
  const T_POP_HOLD = 0.52;   // pop on lift only once the ring is 2/3 drawn (0.08 s delay + eased 0.72 s draw)
  const T_AUTO_RETURN = 3.0; // after the chosen fingers lift, the result stays this long, then black
  const T_MIN_RESULT = 1.0;  // a new tap can end the result only this long after the pick
  const R_MEAN = 36.3;       // fill radius pulses 34.0 .. 38.7
  const R_AMP = 2.35;
  const PULSE_PERIOD = 1.0;  // s; odd colours pulse in anti-phase
  const RING_IN = 1.245;     // ring inner edge, multiple of fill radius
  const RING_OUT = 1.515;    // ring outer edge
  const HOLE_R = 102;        // dark circle left around the winner
  const PROG_ROT = 1.75;     // rad the progress arc drifts back while filling
  const T = {
    pop: 0.13,          // circle grows in
    drawDelay: 0.08,    // ring starts drawing
    draw: 0.72,         // ring draw-in
    stable: 1.0,        // fingers unchanged this long -> countdown
    sweep: 1.2,         // progress ring sweep
    pickDelay: 0.2,     // pause after sweep before the pick
    loserShrink: 0.32,  // losers shrink away
    floodDelay: 0.75,   // pick -> winner colour floods in
    flood: 0.22,
    liftShrink: 0.25,   // round ended -> the winner's dot shrinks
    expand: 0.25,       // dark circle grows back over the screen
    removeShrink: 0.25, // a finger lifted before the pick
    unsweep: 0.2,       // progress ring retracts when the countdown is cancelled
  };

  // ---------------------------------------------------------------------------
  // Settings (stored on this device only).
  // ---------------------------------------------------------------------------
  const STORE_KEY = 'chooser.settings.v1';
  const DEFAULTS = {
    mode: 'winners',              // 'winners' | 'groups'
    winners: 1,                   // how many fingers win (1..4)
    groups: 2,                    // how many teams (2..4)
    cheat: true,
    mirror: true,                 // lose spot = mirror image of the win spot
    // Left side: always picked. This is where the left finger was in the reference video, on the
    // owner's 402x874 screen (that video was cropped at the bottom).
    win: { u: 0.196, v: 0.623 },
    lose: { u: 0.804, v: 0.623 }, // right side: never picked (used when mirror is off)
    radius: 45,                   // spot radius in CSS px
    hint: false,                  // faint dot at the win spot
    showSpots: false,             // draw both spots while playing (testing)
    sound: true,
    silentPlay: false,            // true = also play on silent, but that pauses music apps
    minFingers: 2,
    dock: 'top',
  };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const clamp01 = (x) => clamp(x, 0, 1);
  const lerp = (a, b, k) => a + (b - a) * k;
  const num = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d);
  const point = (p, d) => (p && typeof p === 'object' ? { u: clamp01(num(p.u, d.u)), v: clamp01(num(p.v, d.v)) } : { ...d });

  function sanitize(s) {
    s = s && typeof s === 'object' ? s : {};
    return {
      mode: s.mode === 'groups' ? 'groups' : 'winners',
      winners: clamp(Math.round(num(s.winners, DEFAULTS.winners)), 1, MAX_COUNT),
      groups: clamp(Math.round(num(s.groups, DEFAULTS.groups)), 2, MAX_COUNT),
      cheat: typeof s.cheat === 'boolean' ? s.cheat : DEFAULTS.cheat,
      mirror: typeof s.mirror === 'boolean' ? s.mirror : DEFAULTS.mirror,
      win: point(s.win, DEFAULTS.win),
      lose: point(s.lose, DEFAULTS.lose),
      radius: clamp(Math.round(num(s.radius, DEFAULTS.radius)), 20, 90),
      hint: typeof s.hint === 'boolean' ? s.hint : DEFAULTS.hint,
      showSpots: typeof s.showSpots === 'boolean' ? s.showSpots : DEFAULTS.showSpots,
      sound: typeof s.sound === 'boolean' ? s.sound : DEFAULTS.sound,
      silentPlay: s.v === 2 && typeof s.silentPlay === 'boolean' ? s.silentPlay : DEFAULTS.silentPlay,
      v: 2,
      minFingers: s.minFingers === 1 ? 1 : 2,
      dock: s.dock === 'bottom' ? 'bottom' : 'top',
    };
  }
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return sanitize(JSON.parse(raw));
    } catch (_) { /* private mode / blocked storage */ }
    return sanitize({});
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) { /* ignore */ }
  }
  let settings = loadSettings();

  // ---------------------------------------------------------------------------
  // Canvas.
  // ---------------------------------------------------------------------------
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: false });
  let W = 1, H = 1, DPR = 1;

  function resize() {
    // Measure the real visible area (100vh / innerHeight can be wrong in home-screen apps).
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width || window.innerWidth);
    H = Math.max(1, r.height || window.innerHeight);
    DPR = Math.min(window.devicePixelRatio || 1, 3);
    if (W * H * DPR * DPR > 16e6) DPR = Math.sqrt(16e6 / (W * H)); // Safari canvas size cap
    const bw = Math.round(W * DPR), bh = Math.round(H * DPR);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    kick();
  }

  // ---------------------------------------------------------------------------
  // Physical-screen coordinates for the secret spots.
  // (u, v) are fractions of the device in portrait: u left->right, v top->bottom.
  // ---------------------------------------------------------------------------
  function orientationAngle() {
    if (typeof window.orientation === 'number') return ((window.orientation % 360) + 360) % 360; // iOS: 0, 90, -90, 180
    const so = window.screen && window.screen.orientation;
    if (so && typeof so.angle === 'number') return ((so.angle % 360) + 360) % 360;
    return 0;
  }
  function toDevice(x, y) {
    const a = orientationAngle();
    if (a === 90) return { u: 1 - y / H, v: x / W };   // device turned counter-clockwise
    if (a === 270) return { u: y / H, v: 1 - x / W };  // device turned clockwise
    if (a === 180) return { u: 1 - x / W, v: 1 - y / H };
    return { u: x / W, v: y / H };
  }
  function fromDevice(p) {
    const a = orientationAngle();
    if (a === 90) return { x: p.v * W, y: (1 - p.u) * H };
    if (a === 270) return { x: (1 - p.v) * W, y: p.u * H };
    if (a === 180) return { x: (1 - p.u) * W, y: (1 - p.v) * H };
    return { x: p.u * W, y: p.v * H };
  }
  const loseSpot = () => (settings.mirror ? { u: 1 - settings.win.u, v: settings.win.v } : settings.lose);
  const spotPx = (which) => fromDevice(which === 'win' ? settings.win : loseSpot());

  // ---------------------------------------------------------------------------
  // Easing.
  // ---------------------------------------------------------------------------
  const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
  const easeInOutSine = (p) => 0.5 - 0.5 * Math.cos(Math.PI * p);
  const easeOutQuad = (p) => 1 - (1 - p) * (1 - p);

  // ---------------------------------------------------------------------------
  // Sound — synthesized with the Web Audio API (no audio files).
  // ---------------------------------------------------------------------------
  /* SFX-BEGIN — measured from the reference recording: finger tones A3/D4/E4 (rising per
     finger), a 440 Hz crescendo during the ring sweep, and a metallic swell at the pick. */
  const SFX = (function () {
    var store = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    function cache(ctx) {
      if (!store) return (ctx.__sfx = ctx.__sfx || {});
      var c = store.get(ctx);
      if (!c) { c = {}; store.set(ctx, c); }
      return c;
    }
    function T(ctx, when) { return Math.max(ctx.currentTime, when == null ? 0 : when); }
    function dbToAmp(d) { return Math.pow(10, d / 20); }
    // PeriodicWave from cosine amplitudes; returns {wave, comp}. comp undoes the browser's peak
    // normalization (cosine partials all peak at phase 0, so the normalized peak is sum(a)).
    function wave(ctx, key, amps) {
      var c = cache(ctx);
      if (!c[key]) {
        var re = new Float32Array(amps.length), im = new Float32Array(amps.length), s = 0;
        for (var k = 0; k < amps.length; k++) { re[k] = amps[k]; s += Math.abs(amps[k]); }
        c[key] = { wave: ctx.createPeriodicWave(re, im), comp: s };
      }
      return c[key];
    }
    function cleanup(src, nodes) {
      src.onended = function () {
        for (var i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (e) {} }
      };
    }
    // piecewise-linear interpolation of y over log2(f)
    function interpLog(f, pts) {
      var x = Math.log2(f);
      if (x <= Math.log2(pts[0][0])) return pts[0][1];
      for (var i = 1; i < pts.length; i++) {
        var x1 = Math.log2(pts[i][0]);
        if (x <= x1) {
          var x0 = Math.log2(pts[i - 1][0]);
          return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (x - x0) / (x1 - x0);
        }
      }
      var n = pts.length, xa = Math.log2(pts[n - 2][0]), xb = Math.log2(pts[n - 1][0]);
      return pts[n - 1][1] + (pts[n - 1][1] - pts[n - 2][1]) * (x - xb) / (xb - xa);
    }

    /* ---------------- finger down: soft "boop" (sine + weak odd harmonics) ---------------- */
    // Measured: finger1 A3 220.0 Hz, finger2 D4 293.7 Hz, finger3 E4 329.6 Hz (Asus4: A-D-E).
    // Continuation: the same A-D-E cycle one octave up per 3 fingers: A4 D5 E5 A5 D6 E6 A6 ...
    function fingerFreq(i) {
      return 220 * Math.pow(2, ([0, 5, 7][i % 3] + 12 * Math.floor(i / 3)) / 12);
    }
    function fingerWave(ctx, i) {
      var f = fingerFreq(i);
      // 3rd / 5th harmonic level (dB re fundamental), measured at A3, D4, E4; extrapolated above
      var h3 = interpLog(f, [[220, -28.5], [293.66, -39.5], [329.63, -42.5], [659.26, -60.5]]);
      var h5 = interpLog(f, [[220, -29.0], [293.66, -48.5], [329.63, -58.0], [659.26, -98]]);
      return wave(ctx, 'f' + i, [0, 1, 0, dbToAmp(h3), 0, dbToAmp(Math.max(h5, -120))]);
    }
    function sfxFingerDown(ctx, out, fingerIndex, when) {
      var t0 = T(ctx, when);
      var i = Math.max(0, Math.floor(fingerIndex || 0));
      var f = fingerFreq(i);
      var w = fingerWave(ctx, i);
      var P = 0.37 * w.comp;                      // fundamental peak = 0.37
      // decay rate (dB/s) after the first 83 ms of decay: 92 @A3, ~106 @D4, ~113 @E4
      var r2 = Math.min(160, 92 * Math.sqrt(f / 220));
      var a1 = 0.348, t1 = 0.0208, ta = 0.0257, tp = 0.1256, r1 = 113.3, d1 = 0.083;
      var tEnd = 0.495, tf = 0.005;

      var osc = ctx.createOscillator(), g = ctx.createGain(), G = g.gain;
      osc.setPeriodicWave(w.wave);
      // short downward pitch blip at the onset (measured +5.6..+8 st, tau 2-5 ms)
      var tau = Math.max(0.0006, 0.00264 * Math.pow(293.66 / f, 2.2));
      osc.frequency.setValueAtTime(f * (1 + 0.6 * Math.exp(-0.0022 / tau)), t0);
      osc.frequency.setTargetAtTime(f, t0, tau);
      // amplitude: linear rise, exponential approach to peak at 126 ms, two-rate exp. decay, cut at 0.495 s
      G.setValueAtTime(0, t0);
      G.linearRampToValueAtTime(P * a1, t0 + t1);
      for (var t = t1 + 0.008; t < tp - 0.004; t += 0.008)
        G.linearRampToValueAtTime(P * (1 - (1 - a1) * Math.exp(-(t - t1) / ta)), t0 + t);
      var vp = P * (1 - (1 - a1) * Math.exp(-(tp - t1) / ta));
      G.linearRampToValueAtTime(vp, t0 + tp);
      var v1 = vp * Math.pow(10, -r1 * d1 / 20);
      G.exponentialRampToValueAtTime(v1, t0 + tp + d1);
      var v2 = v1 * Math.pow(10, -r2 * (tEnd - tf - tp - d1) / 20);
      G.exponentialRampToValueAtTime(v2, t0 + tEnd - tf);
      G.linearRampToValueAtTime(0, t0 + tEnd);

      osc.connect(g); g.connect(out);
      osc.start(t0); osc.stop(t0 + tEnd + 0.02);
      cleanup(osc, [osc, g]);
    }

    /* ---------------- countdown: A4 crescendo that gets brighter ---------------- */
    // Two layers: 440 Hz sine (level L1) and partials 2,3,4 (level L2 for the 2nd partial).
    // L1/L2 are quadratic in time (dBFS, already scaled), fitted to the recording.
    function sfxCountdown(ctx, out, durationSec, when) {
      var t0 = T(ctx, when);
      var D = durationSec > 0.25 ? durationSec : 0.846;
      var fade = 0.08, Tc = D - fade, k = 0.766 / Tc, ta = 0.012;
      function L1(t) { var u = t * k - 0.4; return -17.21 + 31.4 * u - 25.3 * u * u; }
      function L2(t) { var u = t * k - 0.4; return -31.51 + 46.7 * u - 10.2 * u * u; }
      var w2 = wave(ctx, 'cd', [0, 0, 1, dbToAmp(-28.5), dbToAmp(-29.2)]);
      var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
      var g1 = ctx.createGain(), g2 = ctx.createGain();
      o1.type = 'sine';
      o2.setPeriodicWave(w2.wave);
      var oscs = [o1, o2], gains = [g1, g2], Ls = [L1, L2], comps = [1, w2.comp];
      for (var n = 0; n < 2; n++) {
        var o = oscs[n], G = gains[n].gain, L = Ls[n], c = comps[n];
        o.frequency.setValueAtTime(440 * 1.08, t0);          // tiny onset blip (measured x1.08, 3 ms)
        o.frequency.setTargetAtTime(440, t0, 0.003);
        G.setValueAtTime(0, t0);
        G.linearRampToValueAtTime(c * dbToAmp(L(ta)), t0 + ta);
        for (var s = 1; s <= 8; s++) {
          var t = ta + (Tc - ta) * s / 8;
          G.exponentialRampToValueAtTime(c * dbToAmp(L(t)), t0 + t);
        }
        G.linearRampToValueAtTime(0, t0 + D);
        o.connect(gains[n]); gains[n].connect(out);
        o.start(t0); o.stop(t0 + D + 0.02);
      }
      cleanup(o1, [o1, o2, g1, g2]);
    }

    /* ---------------- pick: metallic noise swell (reverse-cymbal-like) ---------------- */
    // Measured: 0.378 s, rises ~(t/0.268)^1.3, falls in ~110 ms; ~75% of the energy sits in
    // narrow stationary lines (3.6-8.1 kHz and 9-12.8 kHz, many as 10-25 Hz doublets),
    // on a broadband floor (-13 dB below 600 Hz, dip near 3 kHz, flat 4-13 kHz, cut ~14.5 kHz).
    var LINES = [ // [Hz, dB re strongest]
      [809.4, -14.3], [969.2, -11.8], [1279.1, -15.8], [1612.8, -14.7], [1753.9, -15.3], [2904.7, -15.0],
      [3612.5, -5.6], [4255.8, -15.0], [4272.7, -10.5], [4568.5, -12.3], [4579.3, -7.6], [4742.4, -7.7],
      [4842.3, -11.3], [4854.3, -15.3], [5068.2, -8.7], [5080.6, -12.9], [5355.4, -15.3], [5397.0, -13.3],
      [5547.2, -8.3], [5663.2, -12.4], [5797.2, -11.4], [5812.5, 0.0], [5887.5, -14.4], [5916.6, -14.7],
      [6455.5, -8.8], [6472.9, -4.5], [6529.6, -16.0], [6768.5, -6.9], [6779.2, -2.0], [6942.4, -2.5],
      [7268.1, -2.0], [7281.5, -8.2], [7508.3, -12.4], [7532.7, -13.9], [7597.3, -8.9], [7747.3, -2.9],
      [8071.4, -14.4], [8088.9, -6.8], [10654.1, -12.2], [11316.6, -15.2], [11326.4, -15.4], [11474.9, -12.2],
      [11610.4, -14.7], [11630.5, -11.2], [12270.0, -11.6], [12284.8, -12.5], [12592.8, -12.5], [12754.0, -14.3]
    ];
    // Levels: +5 dB versus the first fit, so the swell matches the recording's loudness
    // (checked with an offline render: RMS -21.5 dB vs -21.0 dB in the recording).
    var PICK_LINE_AMP = 0.0490 * 1.78;   // amplitude of the strongest line
    var PICK_NOISE_AMP = 0.123 * 1.78;   // white-noise level before the floor-shaping filters
    var PICK_ENV_T = [0, 0.005, 0.02, 0.04, 0.07, 0.10, 0.14, 0.18, 0.22, 0.25, 0.268, 0.29, 0.31, 0.33, 0.35, 0.365, 0.378];
    var PICK_ENV_V = [0, 0.0057, 0.0343, 0.0844, 0.174, 0.277, 0.430, 0.597, 0.774, 0.914, 1.0, 0.80, 0.64, 0.43, 0.20, 0.06, 0];

    function noiseBuffer(ctx) {
      var c = cache(ctx);
      if (!c.noise) {
        var n = Math.round(ctx.sampleRate * 1.0), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
        for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        c.noise = b;
      }
      return c.noise;
    }
    function metalBuffer(ctx) {
      var c = cache(ctx);
      if (!c.metal) {
        var sr = ctx.sampleRate, n = Math.round(sr * 0.4), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
        for (var j = 0; j < LINES.length; j++) {
          var f = LINES[j][0];
          if (f >= sr * 0.45) continue;
          var a = PICK_LINE_AMP * dbToAmp(LINES[j][1]);
          var ph = 2 * Math.PI * ((j * 0.618034) % 1);       // fixed pseudo-random phases
          var w = 2 * Math.PI * f / sr, cw = 2 * Math.cos(w);
          var s1 = a * Math.sin(ph - w), s2 = a * Math.sin(ph - 2 * w);  // sine recursion
          for (var i = 0; i < n; i++) { var s0 = cw * s1 - s2; d[i] += s0; s2 = s1; s1 = s0; }
        }
        c.metal = b;
      }
      return c.metal;
    }
    function sfxPick(ctx, out, when) {
      var t0 = T(ctx, when);
      var nz = ctx.createBufferSource(), mt = ctx.createBufferSource();
      nz.buffer = noiseBuffer(ctx); mt.buffer = metalBuffer(ctx);
      var ls = ctx.createBiquadFilter(), pk = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter();
      ls.type = 'lowshelf'; ls.frequency.value = 650; ls.gain.value = -10;
      pk.type = 'peaking'; pk.frequency.value = 3100; pk.Q.value = 1.4; pk.gain.value = -7;
      lp.type = 'lowpass'; lp.frequency.value = 14000; lp.Q.value = -3.01;   // Q in dB for LP/HP
      var ng = ctx.createGain(), env = ctx.createGain(), E = env.gain;
      ng.gain.value = PICK_NOISE_AMP;
      E.setValueAtTime(0, t0);
      for (var i = 1; i < PICK_ENV_T.length; i++) E.linearRampToValueAtTime(PICK_ENV_V[i], t0 + PICK_ENV_T[i]);
      nz.connect(ls); ls.connect(pk); pk.connect(lp); lp.connect(ng); ng.connect(env);
      mt.connect(env); env.connect(out);
      var dur = PICK_ENV_T[PICK_ENV_T.length - 1];
      nz.start(t0, Math.random() * 0.5); nz.stop(t0 + dur + 0.02);
      mt.start(t0); mt.stop(t0 + dur + 0.02);
      cleanup(nz, [nz, mt, ls, pk, lp, ng, env]);
    }

    // Build the cached waves/buffers up front so the first pick does not stutter.
    function warm(ctx) {
      for (var i = 0; i < 6; i++) fingerWave(ctx, i);
      wave(ctx, 'cd', [0, 0, 1, dbToAmp(-28.5), dbToAmp(-29.2)]);
      noiseBuffer(ctx); metalBuffer(ctx);
    }

    /* ---------------- pop: a finger lifts before the pick ---------------- */
    // Measured from the reference app: a pure tone that glides 525 -> 1146 Hz while it swells to its
    // peak at 18.5 ms and fades out by 44 ms (identical every time). [ms, Hz] and [ms, level].
    var POP_F = [[0, 525], [5.9, 524], [7.8, 595], [9.5, 671], [11, 714], [12.4, 763], [13.7, 803], [15, 838],
      [16.2, 878], [18.4, 926], [20.5, 972], [22.6, 995], [24.6, 1021], [26.5, 1040], [28.4, 1054], [30.3, 1071],
      [32.2, 1084], [34, 1096], [36.8, 1105], [38.6, 1113], [42, 1146]];
    var POP_A = [[0, 0], [1, 0.12], [4, 0.13], [9.5, 0.32], [13.7, 0.667], [16.2, 0.907], [18.5, 1], [22.6, 0.907],
      [27.5, 0.707], [31.3, 0.52], [35, 0.347], [38.6, 0.173], [40.4, 0.107], [42, 0.053], [44.5, 0]];
    var POP_PEAK = 0.75; // same peak as the recording (played on its own bus, no compressor)
    function sfxPop(ctx, out, when) {
      var t0 = T(ctx, when);
      var o = ctx.createOscillator(), g = ctx.createGain(), F = o.frequency, G = g.gain, i;
      o.type = 'sine';
      F.setValueAtTime(POP_F[0][1], t0);
      for (i = 1; i < POP_F.length; i++) F.linearRampToValueAtTime(POP_F[i][1], t0 + POP_F[i][0] / 1000);
      G.setValueAtTime(0, t0);
      for (i = 1; i < POP_A.length; i++) G.linearRampToValueAtTime(POP_PEAK * POP_A[i][1], t0 + POP_A[i][0] / 1000);
      o.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + 0.05);
      cleanup(o, [o, g]);
    }

    return { sfxFingerDown: sfxFingerDown, sfxCountdown: sfxCountdown, sfxPick: sfxPick, sfxPop: sfxPop, fingerFreq: fingerFreq, warm: warm };
  })();
  /* SFX-END */

  const COUNTDOWN_DELAY = 0.22; // the countdown tone starts ~0.22 s into the ring sweep
  const COUNTDOWN_LEN = 0.846;  // and lasts 0.846 s (both measured)

  const audio = (() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    let ac = null, master = null, direct = null, recovering = false, warmed = null, everRan = false;

    function applySession() {
      // 'playback' = also plays when the phone is on silent (pauses music apps); 'ambient' = obeys the switch.
      try { if ('audioSession' in navigator) navigator.audioSession.type = settings.silentPlay ? 'playback' : 'ambient'; } catch (_) { /* ignore */ }
    }
    function warm() {
      if (ac && warmed !== ac && ac.state === 'running') { warmed = ac; try { SFX.warm(ac); } catch (_) { /* ignore */ } }
    }
    function make() {
      ac = null;
      if (!AC) return null;
      applySession();
      try { ac = new AC({ latencyHint: 'interactive' }); } catch (_) {
        try { ac = new AC(); } catch (__) { return null; }
      }
      // Clipping guard only: several finger tones at once must not distort. A high threshold keeps
      // the compressor's automatic make-up gain small (~2.3 dB), which the master gain cancels, so
      // single sounds keep the recording's levels and five simultaneous tones stay below 0 dBFS.
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -4; comp.knee.value = 0; comp.ratio.value = 20;
      comp.attack.value = 0.002; comp.release.value = 0.1;
      master = ac.createGain();
      master.gain.value = 0.77;
      master.connect(comp);
      comp.connect(ac.destination);
      direct = ac.createGain(); // short sounds that never stack (the pop) skip the compressor
      direct.gain.value = 1;
      direct.connect(ac.destination);
      ac.onstatechange = () => {
        if (ac && ac.state === 'running') everRan = true;
        warm();
        kick(); // hide the speaker glyph
      };
      return ac;
    }
    // Call synchronously inside activation events (a quick tap's touchend, click). Safe to call often.
    function unlock() {
      if (MUTED || !settings.sound) return; // sound off: never start a session that pauses music
      if (!ac || ac.state === 'closed') make();
      if (!ac || ac.state === 'running') return;
      try { ac.resume().catch(() => {}); } catch (_) { /* ignore */ }
      try {
        const s = ac.createBufferSource();
        s.buffer = ac.createBuffer(1, 1, ac.sampleRate);
        s.connect(ac.destination); s.start(0);
      } catch (_) { /* ignore */ }
      // iOS 26.0/26.1 home-screen apps sometimes got a context that never starts: recreate it
      // while this tap's activation is still valid.
      const real = navigator.userActivation ? navigator.userActivation.isActive : true;
      if (real && !recovering) {
        recovering = true;
        const old = ac, t0 = ac.currentTime;
        setTimeout(() => {
          recovering = false;
          if (ac !== old || (old.state === 'running' && old.currentTime > t0)) return;
          try { old.close(); } catch (_) { /* ignore */ }
          if (make()) { try { ac.resume().catch(() => {}); } catch (_) { /* ignore */ } }
        }, 700);
      }
    }
    const sfxLog = []; // debug: which sounds were requested
    const note = (name) => { if (DEBUG) { sfxLog.push(name); if (sfxLog.length > 500) sfxLog.shift(); } };
    const ready = () => !MUTED && settings.sound && ac && ac.state === 'running';
    const at = (d) => ac.currentTime + 0.005 + (d || 0);
    return {
      unlock,
      applySession,
      sfxLog,
      suspend() { if (ac && ac.state === 'running') ac.suspend().catch(() => {}); },
      resume() { if (settings.sound && ac && ac.state !== 'closed' && ac.state !== 'running') ac.resume().catch(() => {}); },
      running: () => !!ac && ac.state === 'running',
      everRan: () => everRan,
      // Pitch rises with each additional finger: A3, D4, E4, A4, D5, ...
      fingerDown(i) { note('tone' + i); if (ready()) try { SFX.sfxFingerDown(ac, master, i, at()); } catch (_) { /* ignore */ } },
      pop() { note('pop'); if (ready()) try { SFX.sfxPop(ac, direct, at()); } catch (_) { /* ignore */ } },
      countdown() {
        note('countdown');
        if (!ready()) return null;
        try {
          const bus = ac.createGain();
          bus.connect(master);
          SFX.sfxCountdown(ac, bus, COUNTDOWN_LEN, at(COUNTDOWN_DELAY));
          return {
            stop() {
              try {
                const t = ac.currentTime;
                bus.gain.cancelScheduledValues(t);
                bus.gain.setValueAtTime(bus.gain.value, t);
                bus.gain.linearRampToValueAtTime(0, t + 0.06);
                setTimeout(() => { try { bus.disconnect(); } catch (_) { /* ignore */ } }, 1500);
              } catch (_) { /* ignore */ }
            },
          };
        } catch (_) { return null; }
      },
      pick() { note('pick'); if (ready()) try { SFX.sfxPick(ac, master, at()); } catch (_) { /* ignore */ } },
    };
  })();

  // ---------------------------------------------------------------------------
  // Game state.
  // ---------------------------------------------------------------------------
  const fingers = new Map(); // touch id -> finger (includes ones shrinking away)
  const ignored = new Set(); // touch ids ignored until they lift
  const onGlass = new Map(); // every touch on the screen right now: id -> { x, y }
  const lateTouches = new Set(); // touches that started while a result was showing
  let phase = 'gather';      // gather | sweep | picked | ending
  let lastChange = 0, sweepStart = 0, pickTime = 0, floodAt = Infinity;
  let endStart = 0, endFlooded = false, endHole = HOLE_R;
  let winner = null;         // single winner: the screen floods with its colour
  let roundKind = 'flood';   // result shown: 'flood' (1 winner) | 'multi' (several winners) | 'groups'
  let countdownSfx = null;
  const history = [];        // debug: recent picks

  const active = () => { const a = []; for (const f of fingers.values()) if (!f.gone) a.push(f); return a; };

  function randInt(n) {
    if (n <= 1) return 0;
    try {
      const buf = new Uint32Array(1), lim = Math.floor(0x100000000 / n) * n;
      let x;
      do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= lim);
      return x % n;
    } catch (_) { return Math.floor(Math.random() * n); }
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); const tmp = a[i]; a[i] = a[j]; a[j] = tmp; }
    return a;
  }

  const modeCount = () => (settings.mode === 'groups' ? settings.groups : settings.winners);
  // Fingers needed before the countdown starts: one more than the winners/teams, like the
  // reference app. The secret "1 finger" option drops the extra one (for testing alone).
  const neededFingers = () => Math.max(1, modeCount() + (settings.minFingers === 1 ? 0 : 1));

  function addFinger(id, x, y, t) {
    const act = active();
    // A random colour that is not on screen yet. In groups mode everyone is white until the pick.
    let color = WHITE;
    if (settings.mode !== 'groups') {
      const used = new Set(act.map((f) => f.color));
      const free = [];
      for (let i = 0; i < PALETTE.length; i++) if (!used.has(i)) free.push(i);
      color = free.length ? free[randInt(free.length)] : randInt(PALETTE.length);
    }
    if (phase === 'sweep') cancelSweep(t); // before adding, so the new finger gets no progress arc
    fingers.set(id, {
      id, x, y, color, order: act.length, t0: t,
      gone: false, goneAt: 0, goneDur: 0,
      drawAngle: Math.random() * TAU,
      progAngle: Math.random() * TAU,
      unsweepFrom: 0, unsweepAt: -1,
      team: -1, teamColor: -1, teamAt: 0,
      lifted: false, liftedAt: 0, // after the pick: finger up, dot stays
    });
    lastChange = t;
    return fingers.get(id);
  }

  function markGone(f, t, dur) {
    if (f.gone) return;
    f.gone = true; f.goneAt = t; f.goneDur = dur;
  }

  function liftFinger(id, t) {
    const f = fingers.get(id);
    if (!f || f.gone) return false;
    if (phase === 'picked') {
      // The result stays on screen after the finger lifts, so everyone can see who was picked.
      // While a chosen finger stays down its dot keeps following it. A new tap ends the round.
      if (!f.lifted) { f.lifted = true; f.liftedAt = t; }
      return false;
    }
    if (phase === 'ending') { markGone(f, t, T.removeShrink); return false; }
    markGone(f, t, T.removeShrink);
    lastChange = t;
    if (phase === 'sweep') cancelSweep(t);
    return t - f.t0 >= T_POP_HOLD;
  }

  // "Tap to play again": a new tap clears the result. One winner: its dot shrinks and the dark
  // circle grows back over the screen. Several winners / groups: all dots shrink away.
  function endRound(t) {
    if (roundKind === 'flood') startEnding(t);
    else for (const f of active()) markGone(f, t, T.removeShrink);
  }

  function sweepProgress(t) { return clamp01((t - sweepStart) / T.sweep); }

  function startSweep(t) {
    phase = 'sweep';
    sweepStart = t;
    for (const f of fingers.values()) { f.progAngle = Math.random() * TAU; f.unsweepAt = -1; f.unsweepFrom = 0; }
    countdownSfx = audio.countdown();
  }

  function cancelSweep(t) {
    const p = sweepProgress(t);
    phase = 'gather';
    for (const f of fingers.values()) { f.unsweepFrom = p; f.unsweepAt = t; }
    if (countdownSfx) { countdownSfx.stop(); countdownSfx = null; }
  }

  function dist(f, p) { return Math.hypot(f.x - p.x, f.y - p.y); }

  // Picks k winners. Cheat: the finger closest to the win spot (within the radius) is always one
  // of them; fingers in the lose spot are only used if there is nobody else, and the one closest
  // to the lose spot's centre is never picked unless it is literally the only option left.
  function chooseWinners(list, k) {
    k = Math.min(k, list.length);
    const chosen = [];
    let why = 'random';
    if (settings.cheat) {
      const R = settings.radius, win = spotPx('win'), lose = spotPx('lose');
      let best = null, bestD = Infinity;
      for (const f of list) {
        const d = dist(f, win);
        if (d <= R && d < bestD) { best = f; bestD = d; }
      }
      if (best) { chosen.push(best); why = 'win'; }
      const rest = list.filter((f) => f !== best);
      const inLose = rest.filter((f) => dist(f, lose) <= R).sort((a, b) => dist(a, lose) - dist(b, lose));
      if (inLose.length && !best) why = 'lose';
      const safe = shuffle(rest.filter((f) => !inLose.includes(f)));
      while (chosen.length < k && safe.length) chosen.push(safe.pop());
      const others = shuffle(inLose.slice(1));
      while (chosen.length < k && others.length) chosen.push(others.pop());
      if (chosen.length < k && inLose.length) chosen.push(inLose[0]);
    } else {
      const order = shuffle(list.slice());
      while (chosen.length < k) chosen.push(order.pop());
    }
    return { chosen, why };
  }

  // Splits everyone into g balanced teams, each with its own random colour (not white).
  function assignGroups(list, g, t) {
    const order = shuffle(list.slice());
    const colors = [];
    for (let i = 0; i < PALETTE.length; i++) if (i !== WHITE) colors.push(i);
    shuffle(colors);
    order.forEach((f, i) => { f.team = i % g; f.teamColor = colors[f.team % colors.length]; f.teamAt = t; });
  }

  function pick(t) {
    const list = active();
    countdownSfx = null; // the sweep sound ends on its own
    if (!list.length) { phase = 'gather'; return; }
    phase = 'picked';
    pickTime = t;
    floodAt = Infinity;
    winner = null;
    let rec;
    if (settings.mode === 'groups') {
      roundKind = 'groups';
      assignGroups(list, Math.max(1, Math.min(settings.groups, list.length)), t);
      rec = { mode: 'groups', n: list.length, teams: list.map((f) => [f.id, f.team]) };
    } else {
      const res = chooseWinners(list, Math.max(1, Math.min(settings.winners, list.length)));
      const won = new Set(res.chosen);
      for (const f of list) if (!won.has(f)) markGone(f, t, T.loserShrink);
      if (res.chosen.length === 1) {
        roundKind = 'flood';
        winner = res.chosen[0];
        floodAt = t + T.floodDelay;
      } else {
        roundKind = 'multi';
      }
      rec = { mode: 'winners', n: list.length, winnerId: res.chosen[0].id, winnerIds: res.chosen.map((f) => f.id), why: res.why };
    }
    audio.pick();
    if (DEBUG) {
      history.push(rec);
      if (history.length > 1000) history.shift();
    }
  }

  function holeRadius(t) {
    // Radius of the dark circle around the winner while the screen is flooded, or null.
    if (!winner) return null;
    if (phase === 'picked') {
      if (t < floodAt) return null;
      const p = clamp01((t - floodAt) / T.flood);
      return lerp(farCorner(winner.x, winner.y), HOLE_R, p * (0.75 + 0.25 * p));
    }
    if (phase === 'ending' && endFlooded) {
      const p = clamp01((t - endStart - T.liftShrink) / T.expand);
      return lerp(endHole, farCorner(winner.x, winner.y), p * (1.25 - 0.25 * p));
    }
    return null;
  }

  function startEnding(t) {
    endFlooded = t >= floodAt;
    if (endFlooded) endHole = holeRadius(t);
    phase = 'ending';
    endStart = t;
    markGone(winner, t, T.liftShrink);
  }

  function resetRound(t) {
    fingers.clear();
    lateTouches.clear();
    winner = null;
    roundKind = 'flood';
    phase = 'gather';
    floodAt = Infinity;
    lastChange = t;
    if (countdownSfx) { countdownSfx.stop(); countdownSfx = null; }
  }

  // Something changed under the players (rotation, app hidden): drop the round. Fingers that are
  // still on the glass are ignored until they lift and touch again.
  function abortRound(t) {
    for (const id of fingers.keys()) ignored.add(id);
    for (const id of onGlass.keys()) ignored.add(id);
    resetRound(t);
  }

  // When a round ends, everyone still touching the screen plays in the next round, so a finger
  // that stays on the win spot (or a tap-to-play-again finger that stays down) is not left out.
  function joinHeldTouches(t) {
    let first = null;
    for (const [id, pos] of onGlass) {
      if (ignored.has(id) || fingers.has(id)) continue;
      const f = addFinger(id, pos.x, pos.y, t);
      if (!first) first = f;
    }
    if (first) audio.fingerDown(first.order);
  }

  function farCorner(x, y) {
    return Math.max(Math.hypot(x, y), Math.hypot(W - x, y), Math.hypot(x, H - y), Math.hypot(W - x, H - y)) + 4;
  }

  function update(t) {
    for (const [id, f] of fingers) if (f.gone && t - f.goneAt >= f.goneDur) fingers.delete(id);
    if (phase === 'gather') {
      const n = active().length;
      if (n > 0 && n >= neededFingers() && t - lastChange >= T.stable) startSweep(t);
    } else if (phase === 'sweep') {
      if (t - sweepStart >= T.sweep + T.pickDelay) pick(t);
    } else if (phase === 'picked') {
      if (roundKind !== 'flood' && fingers.size === 0) { resetRound(t); joinHeldTouches(t); } // dots cleared
      else {
        // Everyone chosen has lifted: keep the result on screen for a moment, then back to black.
        const shown = active();
        if (shown.length && shown.every((f) => f.lifted)) {
          let since = roundKind === 'flood' ? floodAt + T.flood : pickTime;
          for (const f of shown) since = Math.max(since, f.liftedAt);
          if (t - since >= T_AUTO_RETURN) endRound(t);
        }
        // A finger put down during the first second of the result and still held ends it too.
        if (phase === 'picked' && t - pickTime >= T_MIN_RESULT) {
          for (const id of lateTouches) if (onGlass.has(id)) { endRound(t); break; }
        }
      }
    } else if (phase === 'ending') {
      if (t - endStart >= T.liftShrink + (endFlooded ? T.expand : 0)) { resetRound(t); joinHeldTouches(t); }
    }
  }

  // ---------------------------------------------------------------------------
  // Drawing.
  // ---------------------------------------------------------------------------
  function arcSym(x, y, r, center, half, color) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    if (half >= Math.PI - 1e-3) ctx.arc(x, y, r, 0, TAU);
    else ctx.arc(x, y, r, center - half, center + half);
    ctx.stroke();
  }

  function progressOf(f, t) {
    if (phase === 'sweep') return sweepProgress(t);
    if (phase === 'picked' || phase === 'ending') return 1;
    if (f.unsweepAt >= 0) return f.unsweepFrom * (1 - clamp01((t - f.unsweepAt) / T.unsweep));
    return 0;
  }

  // Groups: a finger fades from white to its team colour right after the pick.
  function colorsOf(f, t) {
    if (f.teamColor < 0) return PALETTE[f.color];
    const k = clamp01((t - f.teamAt) / T_GROUP_TINT);
    if (k >= 1) return PALETTE[f.teamColor];
    const a = PAL_RGB[f.color], b = PAL_RGB[f.teamColor];
    return { fill: mixRgb(a.fill, b.fill, k), ring: mixRgb(a.ring, b.ring, k), prog: mixRgb(a.prog, b.prog, k) };
  }

  function radiusOf(f, t) {
    let s = easeOutCubic(clamp01((t - f.t0) / T.pop));
    if (f.gone) s *= 1 - clamp01((t - f.goneAt) / f.goneDur);
    return (R_MEAN + R_AMP * Math.cos(TAU * t / PULSE_PERIOD + (f.order % 2) * Math.PI)) * s;
  }

  function drawFinger(f, t) {
    const r = radiusOf(f, t);
    if (r <= 0.08) return;
    const pal = colorsOf(f, t);
    const ringR = r * (RING_IN + RING_OUT) / 2;
    ctx.lineWidth = r * (RING_OUT - RING_IN);
    ctx.lineCap = 'round';
    const dp = easeInOutSine(clamp01((t - f.t0 - T.drawDelay) / T.draw));
    if (dp > 0) arcSym(f.x, f.y, ringR, f.drawAngle, Math.PI * dp, pal.ring);
    const pp = progressOf(f, t);
    if (pp > 0) arcSym(f.x, f.y, ringR, f.progAngle - PROG_ROT * easeOutQuad(pp), Math.PI * easeInOutSine(pp), pal.prog);
    ctx.fillStyle = pal.fill;
    ctx.beginPath();
    ctx.arc(f.x, f.y, r, 0, TAU);
    ctx.fill();
  }

  function drawSpots() {
    const R = settings.radius;
    const spots = [['win', '#30d158', '✓'], ['lose', '#ff453a', '✗']];
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.font = '600 16px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [key, col, label] of spots) {
      if (!settings.cheat && !settingsOpen) continue;
      const p = spotPx(key);
      ctx.globalAlpha = settingsOpen ? 0.22 : 0.12;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, TAU); ctx.fill();
      ctx.globalAlpha = settingsOpen ? 1 : 0.5;
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, TAU); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - 7, p.y); ctx.lineTo(p.x + 7, p.y);
      ctx.moveTo(p.x, p.y - 7); ctx.lineTo(p.x, p.y + 7);
      ctx.stroke();
      if (settingsOpen) { ctx.fillStyle = col; ctx.fillText(label, p.x, p.y - R - 12); }
    }
    ctx.restore();
  }

  function drawHintDot() {
    const p = spotPx('win');
    ctx.fillStyle = '#121212';
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, TAU); ctx.fill();
  }

  function draw(t) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    const hole = holeRadius(t);
    if (hole !== null) {
      ctx.fillStyle = PALETTE[winner.color].fill;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = BG;
      ctx.beginPath(); ctx.arc(winner.x, winner.y, hole, 0, TAU); ctx.fill();
    } else if (settingsOpen || settings.showSpots) {
      drawSpots();
    } else if (settings.hint && settings.cheat && phase !== 'picked' && phase !== 'ending') {
      drawHintDot();
    }
    if (settingsOpen && dragTouch) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(dragTouch.x - 30, dragTouch.y); ctx.lineTo(dragTouch.x + 30, dragTouch.y);
      ctx.moveTo(dragTouch.x, dragTouch.y - 30); ctx.lineTo(dragTouch.x, dragTouch.y + 30);
      ctx.stroke();
      ctx.restore();
    }
    for (const f of fingers.values()) drawFinger(f, t);
  }

  let rafId = 0;
  let wasIdle = null;
  function kick() { if (!rafId) rafId = requestAnimationFrame(frame); }
  function frame() {
    rafId = 0;
    const t = clock();
    update(t);
    draw(t);
    const idle = isIdle();
    if (idle !== wasIdle) { wasIdle = idle; document.body.classList.toggle('playing', !idle); } // hides the mode button
    if (reloadWhenIdle && idle && onGlass.size === 0 && !audio.everRan()) { location.reload(); return; }
    if (fingers.size > 0 || phase !== 'gather') kick();
  }

  // ---------------------------------------------------------------------------
  // Secret gesture: 5 quick taps in the top-right corner open the settings.
  // The zone is generous because on some iOS versions a system bar covers the top ~60 px.
  // ---------------------------------------------------------------------------
  let lastPopLift = -1;
  const tapStarts = new Map();
  const cornerTaps = [];
  let openRequested = false;
  const inCorner = (x, y) => x > W - 100 && y < 200;

  function cornerTapStart(tc) {
    if (inCorner(tc.clientX, tc.clientY)) tapStarts.set(tc.identifier, { t: realNow(), x: tc.clientX, y: tc.clientY });
  }
  function cornerTapEnd(tc) {
    const s = tapStarts.get(tc.identifier);
    if (!s) return;
    tapStarts.delete(tc.identifier);
    const now = realNow();
    if (now - s.t > 0.45 || Math.hypot(tc.clientX - s.x, tc.clientY - s.y) > 25) return;
    cornerTaps.push(now);
    while (cornerTaps.length && now - cornerTaps[0] > 3) cornerTaps.shift();
    if (cornerTaps.length >= 5) { cornerTaps.length = 0; openRequested = true; }
  }

  // ---------------------------------------------------------------------------
  // Touch input.
  // ---------------------------------------------------------------------------
  function trackGlass(list) {
    onGlass.clear();
    for (let i = 0; i < list.length; i++) onGlass.set(list[i].identifier, { x: list[i].clientX, y: list[i].clientY });
  }

  function syncWithTouchList(list, t) {
    // iOS does not always send touchend/touchcancel; anything we track that is no longer on the
    // glass is lifted, so a "ghost" finger can never win.
    trackGlass(list);
    const live = onGlass;
    for (const f of [...fingers.values()]) if (!f.gone && !f.lifted && !live.has(f.id)) liftFinger(f.id, t);
    for (const id of [...lateTouches]) if (!live.has(id)) lateTouches.delete(id);
    for (const id of [...ignored]) if (!live.has(id)) ignored.delete(id);
    for (const id of [...tapStarts.keys()]) if (!live.has(id)) tapStarts.delete(id);
  }

  function onTouchStart(e) {
    e.preventDefault();
    if (settingsOpen) { trackGlass(e.touches); settingsTouch(e, 'start'); return; }
    const t = clock();
    syncWithTouchList(e.touches, t);
    let toned = false;
    for (const tc of e.changedTouches) {
      cornerTapStart(tc);
      const id = tc.identifier;
      if (ignored.has(id)) continue;
      if (phase === 'picked' || phase === 'ending') {
        // "Tap to play again": a new touch ends the result; if it stays down it plays next round.
        lateTouches.add(id);
        if (phase === 'picked' && t - pickTime >= T_MIN_RESULT) endRound(t);
        continue;
      }
      if (fingers.has(id)) fingers.delete(id); // stale entry with a reused id
      const f = addFinger(id, tc.clientX, tc.clientY, t);
      if (f && !toned) { toned = true; audio.fingerDown(f.order); } // one tone per touch, like the original
    }
    kick();
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (settingsOpen) { trackGlass(e.touches); settingsTouch(e, 'move'); return; }
    for (const tc of e.changedTouches) {
      const f = fingers.get(tc.identifier);
      if (f && !f.gone && !f.lifted) { f.x = tc.clientX; f.y = tc.clientY; }
    }
    syncWithTouchList(e.touches, clock());
    kick();
  }

  function onTouchEnd(e) {
    e.preventDefault();
    if (e.type === 'touchend') { audio.unlock(); requestWakeLock(); } // a quick tap unlocks sound
    if (settingsOpen) { trackGlass(e.touches); settingsTouch(e, 'end'); return; }
    const t = clock();
    let popped = false;
    for (const tc of e.changedTouches) {
      if (e.type === 'touchend') cornerTapEnd(tc); else tapStarts.delete(tc.identifier);
      ignored.delete(tc.identifier);
      lateTouches.delete(tc.identifier);
      if (liftFinger(tc.identifier, t)) popped = true;
    }
    if (popped) {
      // Fingers lifted together arrive a few ms apart: one pop for the whole group (any lift less
      // than 0.25 s after the previous one stays silent).
      const now = realNow();
      if (now - lastPopLift > 0.25) audio.pop();
      lastPopLift = now;
    }
    syncWithTouchList(e.touches, t);
    if (openRequested) { openRequested = false; openSettings(); }
    kick();
  }

  const opts = { passive: false };
  canvas.addEventListener('touchstart', onTouchStart, opts);
  canvas.addEventListener('touchmove', onTouchMove, opts);
  canvas.addEventListener('touchend', onTouchEnd, opts);
  canvas.addEventListener('touchcancel', onTouchEnd, opts);

  // Block browser gestures (pinch zoom, double-tap zoom, rubber-banding, callouts, selection).
  const inSheet = (e) => e.target && e.target.closest && e.target.closest('#settings');
  document.addEventListener('touchmove', (e) => { if (!inSheet(e)) e.preventDefault(); }, opts);
  for (const n of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(n, (e) => e.preventDefault(), opts);
  for (const n of ['dblclick', 'contextmenu', 'selectstart']) document.addEventListener(n, (e) => { if (!inSheet(e)) e.preventDefault(); }, opts);
  document.addEventListener('click', () => audio.unlock(), true);
  document.addEventListener('pointerup', () => audio.unlock(), true);

  // Mouse acts as one finger (for testing on a computer).
  let mouseDown = false;
  const fakeTouch = (e) => ({ identifier: -1, clientX: e.clientX, clientY: e.clientY });
  const fakeEvent = (e, down) => ({
    type: down ? 'touchstart' : 'touchend',
    preventDefault() {},
    changedTouches: [fakeTouch(e)],
    touches: down ? [fakeTouch(e)] : [],
  });
  canvas.addEventListener('mousedown', (e) => { if (e.button !== 0) return; mouseDown = true; onTouchStart(fakeEvent(e, true)); });
  window.addEventListener('mousemove', (e) => { if (mouseDown) onTouchMove(fakeEvent(e, true)); });
  window.addEventListener('mouseup', (e) => { if (!mouseDown) return; mouseDown = false; onTouchEnd(fakeEvent(e, false)); });

  // ---------------------------------------------------------------------------
  // Settings sheet.
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    root: $('settings'), sheet: document.querySelector('#settings .sheet'), dock: $('s-dock'), cheat: $('s-cheat'), mirror: $('s-mirror'),
    radius: $('s-radius'), radiusOut: $('s-radius-out'),
    hint: $('s-hint'), show: $('s-show'), sound: $('s-sound'), silent: $('s-silent'), test: $('s-test'),
    solo: $('s-solo'), reset: $('s-reset'), close: $('s-close'),
  };
  let settingsOpen = false;
  let settingsOpenedAt = 0;
  let dragTouch = null; // { id, which, x, y }
  let dockFlip = false;  // the ⇅ button swaps the automatic dock side

  function syncSettingsUI() {
    const sp = spotPx('win');
    const top = (sp.y > H / 2) !== dockFlip;
    el.root.className = top ? 'top' : 'bottom';
    el.sheet.style.maxHeight = Math.round(Math.max(170, (top ? sp.y : H - sp.y) - settings.radius - 70)) + 'px';
    el.root.hidden = !settingsOpen;
    el.cheat.checked = settings.cheat;
    el.mirror.checked = settings.mirror;
    el.radius.value = String(settings.radius);
    el.radiusOut.textContent = String(settings.radius);
    el.hint.checked = settings.hint;
    el.show.checked = settings.showSpots;
    el.sound.checked = settings.sound;
    el.silent.checked = settings.silentPlay;
    el.solo.checked = settings.minFingers === 1;
  }

  function changed() { saveSettings(); syncSettingsUI(); kick(); }

  function openSettings() {
    setMenu(false);
    setHelp(false);
    resetRound(clock());
    ignored.clear();
    settingsOpen = true;
    settingsOpenedAt = realNow();
    dockFlip = false;
    dragTouch = null;
    syncSettingsUI();
    kick();
  }
  function closeSettings() {
    settingsOpen = false;
    dragTouch = null;
    saveSettings();
    syncSettingsUI();
    resetRound(clock());
    for (const id of onGlass.keys()) ignored.add(id);
    kick();
  }

  function placeSpot(which, x, y) {
    const p = toDevice(clamp(x, 0, W), clamp(y, 0, H));
    if (which === 'win') settings.win = p;
    else if (settings.mirror) settings.win = { u: 1 - p.u, v: p.v };
    else settings.lose = p;
  }

  function settingsTouch(e, kind) {
    if (kind === 'start') {
      // Only a touch that starts on a spot moves it, so extra taps (like a 6th tap on the corner)
      // or stray touches never move a spot.
      if (dragTouch && !onGlass.has(dragTouch.id)) dragTouch = null; // its touch was taken by the system
      if (dragTouch || realNow() - settingsOpenedAt < 0.6) return;
      const tc = e.changedTouches[0];
      const x = tc.clientX, y = tc.clientY, R = Math.max(settings.radius, 30) + 30;
      const w = spotPx('win'), l = spotPx('lose');
      const dw = Math.hypot(x - w.x, y - w.y), dl = Math.hypot(x - l.x, y - l.y);
      let which = null;
      if (dw <= R && dw <= dl) which = 'win';
      else if (dl <= R) which = 'lose';
      if (!which) return;
      dragTouch = { id: tc.identifier, which, x, y };
      placeSpot(which, x, y);
    } else if (dragTouch) {
      for (const tc of e.changedTouches) {
        if (tc.identifier !== dragTouch.id) continue;
        if (kind !== 'end' || e.type === 'touchend') {
          dragTouch.x = tc.clientX; dragTouch.y = tc.clientY;
          placeSpot(dragTouch.which, tc.clientX, tc.clientY);
        }
        if (kind === 'end') { dragTouch = null; saveSettings(); syncSettingsUI(); }
      }
    }
    kick();
  }

  el.dock.addEventListener('click', () => { dockFlip = !dockFlip; syncSettingsUI(); kick(); });
  el.cheat.addEventListener('change', () => { settings.cheat = el.cheat.checked; changed(); });
  el.mirror.addEventListener('change', () => {
    settings.mirror = el.mirror.checked;
    if (!settings.mirror) settings.lose = { u: 1 - settings.win.u, v: settings.win.v };
    changed();
  });
  el.radius.addEventListener('input', () => { settings.radius = clamp(Number(el.radius.value) || 45, 20, 90); changed(); });
  el.hint.addEventListener('change', () => { settings.hint = el.hint.checked; changed(); });
  el.show.addEventListener('change', () => { settings.showSpots = el.show.checked; changed(); });
  el.sound.addEventListener('change', () => {
    settings.sound = el.sound.checked;
    changed();
    if (settings.sound) audio.unlock(); else audio.suspend();
  });
  el.silent.addEventListener('change', () => { settings.silentPlay = el.silent.checked; audio.applySession(); changed(); });
  el.test.addEventListener('click', () => {
    audio.unlock();
    setTimeout(() => audio.fingerDown(0), 150); // the context may need a moment to start
  });
  el.solo.addEventListener('change', () => { settings.minFingers = el.solo.checked ? 1 : 2; changed(); });
  el.reset.addEventListener('click', () => {
    const keep = { dock: settings.dock, mode: settings.mode, winners: settings.winners, groups: settings.groups };
    settings = sanitize(keep);
    audio.applySession();
    changed();
  });
  el.close.addEventListener('click', closeSettings);

  // ---------------------------------------------------------------------------
  // Mode menu (visible, top-left): winners 1..4 or groups 2..4.
  // ---------------------------------------------------------------------------
  const mm = {
    btn: $('mode-btn'), num: $('mode-num'), letter: $('mode-letter'), menu: $('mode-menu'),
    minus: $('m-minus'), plus: $('m-plus'), count: $('m-count'), groups: $('m-groups'), winners: $('m-winners'),
  };
  let menuOpen = false;

  function syncModeUI() {
    const g = settings.mode === 'groups';
    const n = g ? settings.groups : settings.winners;
    document.documentElement.dataset.mode = settings.mode; // theme colour: green winners / orange groups
    mm.num.textContent = String(n);
    mm.letter.textContent = g ? 'ק' : 'ז';
    mm.count.textContent = String(n);
    mm.minus.disabled = n <= (g ? 2 : 1);
    mm.plus.disabled = n >= MAX_COUNT;
    mm.groups.classList.toggle('on', g);
    mm.winners.classList.toggle('on', !g);
    mm.winners.textContent = !g && n === 1 ? 'זוכה' : 'זוכים';
  }
  function setMenu(open) {
    menuOpen = open && isIdle();
    mm.menu.classList.toggle('open', menuOpen);
    mm.menu.setAttribute('aria-hidden', String(!menuOpen));
  }
  function stepCount(d) {
    if (settings.mode === 'groups') settings.groups = clamp(settings.groups + d, 2, MAX_COUNT);
    else settings.winners = clamp(settings.winners + d, 1, MAX_COUNT);
    saveSettings();
    syncModeUI();
  }
  function setMode(m) { settings.mode = m; saveSettings(); syncModeUI(); }

  mm.btn.addEventListener('click', () => { setHelp(false); setMenu(!menuOpen); });
  mm.menu.addEventListener('click', (e) => { if (e.target === mm.menu) setMenu(false); }); // tap outside the card
  mm.minus.addEventListener('click', () => stepCount(-1));
  mm.plus.addEventListener('click', () => stepCount(1));
  mm.groups.addEventListener('click', () => setMode('groups'));
  mm.winners.addEventListener('click', () => setMode('winners'));

  // ---------------------------------------------------------------------------
  // Help (top-right "?"): a small how-to-play card. Holding "?" for 1.5 s opens the secret settings.
  // ---------------------------------------------------------------------------
  const hp = { btn: $('help-btn'), menu: $('help-menu'), close: $('help-close') };
  let helpOpen = false, helpHoldTimer = 0, helpHeld = false;
  function setHelp(open) {
    helpOpen = open && isIdle();
    hp.menu.classList.toggle('open', helpOpen);
    hp.menu.setAttribute('aria-hidden', String(!helpOpen));
  }
  hp.btn.addEventListener('pointerdown', () => {
    helpHeld = false;
    clearTimeout(helpHoldTimer);
    helpHoldTimer = setTimeout(() => { helpHeld = true; setHelp(false); setMenu(false); openSettings(); }, 1500);
  });
  for (const n of ['pointerup', 'pointercancel', 'pointerleave']) hp.btn.addEventListener(n, () => clearTimeout(helpHoldTimer));
  hp.btn.addEventListener('click', () => { if (helpHeld) { helpHeld = false; return; } setMenu(false); setHelp(!helpOpen); });
  hp.close.addEventListener('click', () => setHelp(false));
  hp.menu.addEventListener('click', (e) => { if (e.target === hp.menu) setHelp(false); });

  // ---------------------------------------------------------------------------
  // Lifecycle.
  // ---------------------------------------------------------------------------
  let wakeLock = null;
  function requestWakeLock() {
    try {
      if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then((lock) => {
        wakeLock = lock;
        lock.addEventListener('release', () => { wakeLock = null; });
      }).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  const isIdle = () => !settingsOpen && phase === 'gather' && fingers.size === 0;
  let swReg = null;
  let reloadWhenIdle = false;
  function checkForUpdate() {
    if (swReg && navigator.onLine !== false) { try { swReg.update().catch(() => {}); } catch (_) { /* ignore */ } }
  }

  document.addEventListener('visibilitychange', () => {
    tapStarts.clear();
    dragTouch = null;
    if (document.hidden) {
      // Touches can be lost while hidden: drop the round and release the audio session.
      if (!settingsOpen) abortRound(clock());
      audio.suspend();
    } else {
      audio.resume();
      requestWakeLock();
      checkForUpdate();
      resize();
    }
    kick();
  });
  window.addEventListener('pagehide', () => { dragTouch = null; if (!settingsOpen) abortRound(clock()); });
  window.addEventListener('blur', () => { dragTouch = null; if (!settingsOpen && !isIdle()) { abortRound(clock()); kick(); } });

  function onRotate() {
    // Positions jump when the screen rotates: drop the round, then re-measure (iOS can report
    // stale sizes during the rotation).
    if (!settingsOpen) abortRound(clock());
    resize();
    requestAnimationFrame(resize);
    setTimeout(resize, 300);
  }
  window.addEventListener('resize', resize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
  window.addEventListener('orientationchange', onRotate);
  if (window.screen && screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', onRotate);

  if ('serviceWorker' in navigator) {
    if (DEBUG) {
      // Testing: always run the files on disk, never a cached copy.
      navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    } else if (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      const hadController = !!navigator.serviceWorker.controller;
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => { swReg = r; }).catch(() => {});
      });
      // A new version took over. Reload only before any sound has played and with nobody touching
      // (a reload loses the unlocked sound); otherwise the new version starts on the next launch.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || audio.everRan()) return;
        if (isIdle() && onGlass.size === 0) location.reload(); else { reloadWhenIdle = true; kick(); }
      });
    }
  }

  if (DEBUG) {
    window.__chooser = {
      get phase() { return phase; },
      get winner() { return winner && { id: winner.id, x: winner.x, y: winner.y, color: winner.color }; },
      get fingers() { return [...fingers.values()].map((f) => ({ id: f.id, x: f.x, y: f.y, color: f.color, gone: f.gone, lifted: f.lifted, unsweepFrom: f.unsweepFrom })); },
      get ignored() { return [...ignored]; },
      get settings() { return JSON.parse(JSON.stringify(settings)); },
      set settings(s) { settings = sanitize(s); saveSettings(); syncModeUI(); kick(); },
      setMenu, get menuOpen() { return menuOpen; }, setHelp, get helpOpen() { return helpOpen; },
      spotPx, toDevice, fromDevice, history, openSettings, closeSettings,
      get settingsOpen() { return settingsOpen; },
      get settingsOpenedAt() { return settingsOpenedAt; },
      tick() { update(clock()); },
      SFX, SPEED, sfxLog: audio.sfxLog,
    };
  }

  // Opening screen (every fresh launch): hold ~2.2 s, then the dark circle grows over the screen.
  (function splash() {
    const el = document.getElementById('splash');
    if (!el) return;
    if (DEBUG) { el.remove(); return; }
    const disc = el.querySelector('.disc');
    setTimeout(() => {
      const d = disc.getBoundingClientRect().width || 1;
      disc.style.transform = 'scale(' + (Math.hypot(window.innerWidth, window.innerHeight) / d * 1.05).toFixed(2) + ')';
      el.classList.add('go');
      setTimeout(() => el.remove(), 550);
    }, 2200);
  })();

  resize();
  syncSettingsUI();
  syncModeUI();
})();
