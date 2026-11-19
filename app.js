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
  const BG = '#0f0f0f';
  const PALETTE = [
    { fill: '#e1e1e1', ring: '#a8a8a8', prog: '#fefefe' }, // white
    { fill: '#fb7100', ring: '#b46b24', prog: '#fcae64' }, // orange
    { fill: '#f7dc4a', ring: '#e8bf01', prog: '#f9e695' }, // yellow
    { fill: '#33c75a', ring: '#1f8a3c', prog: '#93e6a8' }, // green
    { fill: '#3d8bff', ring: '#2a5fb3', prog: '#a3c8ff' }, // blue
    { fill: '#ff3b7f', ring: '#b32a5a', prog: '#ff9fc0' }, // pink
    { fill: '#a259ff', ring: '#703db3', prog: '#d2adff' }, // purple
    { fill: '#22cfe6', ring: '#178fa1', prog: '#93e8f4' }, // cyan
    { fill: '#ff4d3d', ring: '#b3362b', prog: '#ffa69e' }, // red
    { fill: '#b8e04a', ring: '#7f9c33', prog: '#dcf0a4' }, // lime
  ];
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
    liftShrink: 0.25,   // winner lifted -> shrinks
    expand: 0.25,       // dark circle grows back over the screen
    removeShrink: 0.25, // a finger lifted before the pick
    unsweep: 0.2,       // progress ring retracts when the countdown is cancelled
  };

  // ---------------------------------------------------------------------------
  // Settings (stored on this device only).
  // ---------------------------------------------------------------------------
  const STORE_KEY = 'chooser.settings.v1';
  const DEFAULTS = {
    cheat: true,
    mirror: true,                 // lose spot = mirror image of the win spot
    win: { u: 0.196, v: 0.674 },  // left side: always picked
    lose: { u: 0.804, v: 0.674 }, // right side: never picked (used when mirror is off)
    radius: 45,                   // spot radius in CSS px
    hint: false,                  // faint dot at the win spot
    showSpots: false,             // draw both spots while playing (testing)
    sound: true,
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
      cheat: typeof s.cheat === 'boolean' ? s.cheat : DEFAULTS.cheat,
      mirror: typeof s.mirror === 'boolean' ? s.mirror : DEFAULTS.mirror,
      win: point(s.win, DEFAULTS.win),
      lose: point(s.lose, DEFAULTS.lose),
      radius: clamp(Math.round(num(s.radius, DEFAULTS.radius)), 20, 90),
      hint: typeof s.hint === 'boolean' ? s.hint : DEFAULTS.hint,
      showSpots: typeof s.showSpots === 'boolean' ? s.showSpots : DEFAULTS.showSpots,
      sound: typeof s.sound === 'boolean' ? s.sound : DEFAULTS.sound,
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
    W = Math.max(1, window.innerWidth);
    H = Math.max(1, window.innerHeight);
    DPR = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
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
  /* SFX-BEGIN */
  // Placeholder synthesis; replaced by the measured version below.
  const NOTE = [220, 293.66, 329.63, 440, 587.33, 659.25, 880, 1174.66, 1318.51, 1760];
  function env(ctx, g, when, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  }
  function sfxFingerDown(ctx, out, i, when) {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = NOTE[i % NOTE.length];
    f.type = 'lowpass'; f.frequency.value = 1800;
    env(ctx, g, when, 0.25, 0.006, 0.42);
    o.connect(f); f.connect(g); g.connect(out);
    o.start(when); o.stop(when + 0.5);
    o.onended = () => { o.disconnect(); f.disconnect(); g.disconnect(); };
  }
  function sfxCountdown(ctx, out, dur, when) {
    dur = dur || 1.2;
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = 440;
    f.type = 'lowpass'; f.frequency.value = 2800;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.18, when + dur * 0.5);
    g.gain.setValueAtTime(0.18, when + dur - 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(f); f.connect(g); g.connect(out);
    o.start(when); o.stop(when + dur + 0.02);
    o.onended = () => { o.disconnect(); f.disconnect(); g.disconnect(); };
  }
  function sfxPick(ctx, out, when) {
    const len = Math.floor(ctx.sampleRate * 0.4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let k = 0; k < len; k++) d[k] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf;
    env(ctx, g, when, 0.5, 0.004, 0.36);
    s.connect(g); g.connect(out);
    s.start(when); s.stop(when + 0.4);
    s.onended = () => { s.disconnect(); g.disconnect(); };
  }
  /* SFX-END */

  const audio = (() => {
    let ac = null, master = null, primed = false;
    function ensure() {
      if (ac) return ac;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ac = new AC({ latencyHint: 'interactive' }); } catch (_) {
        try { ac = new AC(); } catch (__) { return null; }
      }
      master = ac.createGain();
      master.gain.value = 1;
      master.connect(ac.destination);
      return ac;
    }
    // Call from user-activation events (touchend / click). Safe to call often.
    function unlock() {
      const c = ensure();
      if (!c) return;
      if (c.state !== 'running') { try { c.resume().catch(() => {}); } catch (_) { /* ignore */ } }
      if (!primed) {
        try {
          const b = c.createBuffer(1, 1, 22050), s = c.createBufferSource();
          s.buffer = b; s.connect(c.destination); s.start(0);
          primed = true;
        } catch (_) { /* ignore */ }
      }
    }
    const ready = () => !MUTED && settings.sound && ac && ac.state === 'running';
    const at = () => ac.currentTime + 0.005;
    return {
      unlock,
      fingerDown(i) { if (ready()) try { sfxFingerDown(ac, master, i, at()); } catch (_) { /* ignore */ } },
      countdown(dur) {
        if (!ready()) return null;
        try {
          const bus = ac.createGain();
          bus.connect(master);
          sfxCountdown(ac, bus, dur, at());
          return {
            stop() {
              try {
                const t = ac.currentTime;
                bus.gain.cancelScheduledValues(t);
                bus.gain.setValueAtTime(bus.gain.value, t);
                bus.gain.linearRampToValueAtTime(0, t + 0.06);
                setTimeout(() => { try { bus.disconnect(); } catch (_) { /* ignore */ } }, 200);
              } catch (_) { /* ignore */ }
            },
          };
        } catch (_) { return null; }
      },
      pick() { if (ready()) try { sfxPick(ac, master, at()); } catch (_) { /* ignore */ } },
    };
  })();

  // ---------------------------------------------------------------------------
  // Game state.
  // ---------------------------------------------------------------------------
  const fingers = new Map(); // touch id -> finger (includes ones shrinking away)
  const ignored = new Set(); // touch ids ignored until they lift
  let phase = 'gather';      // gather | sweep | picked | ending
  let lastChange = 0, sweepStart = 0, pickTime = 0, floodAt = Infinity;
  let endStart = 0, endFlooded = false, endHole = HOLE_R;
  let winner = null;
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

  function addFinger(id, x, y, t) {
    const used = new Set(active().map((f) => f.color));
    let color = 0;
    while (used.has(color)) color++;
    if (color >= PALETTE.length) { ignored.add(id); return; }
    fingers.set(id, {
      id, x, y, color, t0: t,
      gone: false, goneAt: 0, goneDur: 0,
      drawAngle: Math.random() * TAU,
      progAngle: Math.random() * TAU,
      unsweepFrom: 0, unsweepAt: -1,
    });
    lastChange = t;
    if (phase === 'sweep') cancelSweep(t);
    audio.fingerDown(color);
  }

  function markGone(f, t, dur) {
    if (f.gone) return;
    f.gone = true; f.goneAt = t; f.goneDur = dur;
  }

  function liftFinger(id, t) {
    const f = fingers.get(id);
    if (!f || f.gone) return;
    if (phase === 'picked') {
      if (f === winner) startEnding(t);
      else markGone(f, t, T.removeShrink);
      return;
    }
    if (phase === 'ending') { markGone(f, t, T.removeShrink); return; }
    markGone(f, t, T.removeShrink);
    lastChange = t;
    if (phase === 'sweep') cancelSweep(t);
  }

  function sweepProgress(t) { return clamp01((t - sweepStart) / T.sweep); }

  function startSweep(t) {
    phase = 'sweep';
    sweepStart = t;
    for (const f of fingers.values()) { f.progAngle = Math.random() * TAU; f.unsweepAt = -1; f.unsweepFrom = 0; }
    countdownSfx = audio.countdown(T.sweep);
  }

  function cancelSweep(t) {
    const p = sweepProgress(t);
    phase = 'gather';
    for (const f of fingers.values()) { f.unsweepFrom = p; f.unsweepAt = t; }
    if (countdownSfx) { countdownSfx.stop(); countdownSfx = null; }
  }

  function dist(f, p) { return Math.hypot(f.x - p.x, f.y - p.y); }

  function chooseWinner(list) {
    if (settings.cheat) {
      const R = settings.radius, win = spotPx('win'), lose = spotPx('lose');
      let best = null, bestD = Infinity;
      for (const f of list) {
        const d = dist(f, win);
        if (d <= R && d < bestD) { best = f; bestD = d; }
      }
      if (best) return { f: best, why: 'win' };
      const inLose = list.filter((f) => dist(f, lose) <= R);
      let pool = list.filter((f) => !inLose.includes(f));
      if (!pool.length && list.length > 1) {
        // Everyone is inside the lose spot: still never pick the finger closest to its centre.
        const closest = inLose.reduce((a, b) => (dist(a, lose) <= dist(b, lose) ? a : b));
        pool = list.filter((f) => f !== closest);
      }
      if (pool.length) return { f: pool[randInt(pool.length)], why: inLose.length ? 'lose' : 'random' };
    }
    return { f: list[randInt(list.length)], why: 'random' };
  }

  function pick(t) {
    const list = active();
    countdownSfx = null; // the sweep sound ends on its own
    if (!list.length) { phase = 'gather'; return; }
    const res = chooseWinner(list);
    winner = res.f;
    phase = 'picked';
    pickTime = t;
    floodAt = t + T.floodDelay;
    for (const f of list) if (f !== winner) markGone(f, t, T.loserShrink);
    audio.pick();
    if (DEBUG) {
      history.push({ n: list.length, winnerId: winner.id, why: res.why });
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
    winner = null;
    phase = 'gather';
    floodAt = Infinity;
    lastChange = t;
    if (countdownSfx) { countdownSfx.stop(); countdownSfx = null; }
  }

  function farCorner(x, y) {
    return Math.max(Math.hypot(x, y), Math.hypot(W - x, y), Math.hypot(x, H - y), Math.hypot(W - x, H - y)) + 4;
  }

  function update(t) {
    for (const [id, f] of fingers) if (f.gone && t - f.goneAt >= f.goneDur) fingers.delete(id);
    if (phase === 'gather') {
      const n = active().length;
      if (n > 0 && n >= settings.minFingers && t - lastChange >= T.stable) startSweep(t);
    } else if (phase === 'sweep') {
      if (t - sweepStart >= T.sweep + T.pickDelay) pick(t);
    } else if (phase === 'ending') {
      if (t - endStart >= T.liftShrink + (endFlooded ? T.expand : 0)) resetRound(t);
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

  function drawFinger(f, t) {
    const pal = PALETTE[f.color];
    let s = easeOutCubic(clamp01((t - f.t0) / T.pop));
    if (f.gone) s *= 1 - clamp01((t - f.goneAt) / f.goneDur);
    if (s <= 0.002) return;
    const r = (R_MEAN + R_AMP * Math.cos(TAU * t / PULSE_PERIOD + (f.color % 2) * Math.PI)) * s;
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
    ctx.fillStyle = '#1b1b1b';
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
  function kick() { if (!rafId) rafId = requestAnimationFrame(frame); }
  function frame() {
    rafId = 0;
    const t = clock();
    update(t);
    draw(t);
    if (fingers.size > 0 || phase !== 'gather') kick();
  }

  // ---------------------------------------------------------------------------
  // Secret gesture: 5 quick taps in the top-right corner open the settings.
  // ---------------------------------------------------------------------------
  const tapStarts = new Map();
  const cornerTaps = [];
  let openRequested = false;
  const inCorner = (x, y) => x > W - 90 && y < 130;

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
  function syncWithTouchList(list, t) {
    // iOS occasionally drops touchend; anything we track that is no longer down is lifted.
    const live = new Set();
    for (let i = 0; i < list.length; i++) live.add(list[i].identifier);
    for (const f of [...fingers.values()]) if (!f.gone && !live.has(f.id)) liftFinger(f.id, t);
    for (const id of [...ignored]) if (!live.has(id)) ignored.delete(id);
    for (const id of [...tapStarts.keys()]) if (!live.has(id)) tapStarts.delete(id);
  }

  function onTouchStart(e) {
    e.preventDefault();
    if (settingsOpen) { settingsTouch(e, 'start'); return; }
    const t = clock();
    for (const tc of e.changedTouches) {
      cornerTapStart(tc);
      const id = tc.identifier;
      if (phase === 'picked' || phase === 'ending' || ignored.has(id)) { ignored.add(id); continue; }
      if (fingers.has(id)) fingers.delete(id); // stale entry with a reused id
      addFinger(id, tc.clientX, tc.clientY, t);
    }
    syncWithTouchList(e.touches, t);
    kick();
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (settingsOpen) { settingsTouch(e, 'move'); return; }
    for (const tc of e.changedTouches) {
      const f = fingers.get(tc.identifier);
      if (f && !f.gone) { f.x = tc.clientX; f.y = tc.clientY; }
    }
    kick();
  }

  function onTouchEnd(e) {
    e.preventDefault();
    audio.unlock();
    requestWakeLock();
    if (settingsOpen) { settingsTouch(e, 'end'); return; }
    const t = clock();
    for (const tc of e.changedTouches) {
      cornerTapEnd(tc);
      ignored.delete(tc.identifier);
      liftFinger(tc.identifier, t);
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

  // Block browser gestures (pinch zoom, double-tap zoom, rubber-banding, callouts).
  const inSheet = (e) => e.target && e.target.closest && e.target.closest('#settings');
  document.addEventListener('touchmove', (e) => { if (!inSheet(e)) e.preventDefault(); }, opts);
  for (const n of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(n, (e) => e.preventDefault(), opts);
  document.addEventListener('dblclick', (e) => e.preventDefault(), opts);
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('click', () => audio.unlock(), true);

  // Mouse acts as one finger (for testing on a computer).
  let mouseDown = false;
  const fakeTouch = (e) => ({ identifier: -1, clientX: e.clientX, clientY: e.clientY });
  const fakeEvent = (e, down) => ({
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
    root: $('settings'), dock: $('s-dock'), cheat: $('s-cheat'), mirror: $('s-mirror'),
    selWin: $('s-sel-win'), selLose: $('s-sel-lose'), radius: $('s-radius'), radiusOut: $('s-radius-out'),
    hint: $('s-hint'), show: $('s-show'), sound: $('s-sound'), min1: $('s-min1'), min2: $('s-min2'),
    reset: $('s-reset'), close: $('s-close'),
  };
  let settingsOpen = false;
  let selected = 'win';
  let dragTouch = null; // { id, which, x, y }

  function syncSettingsUI() {
    el.root.className = settings.dock;
    el.root.hidden = !settingsOpen;
    el.cheat.checked = settings.cheat;
    el.mirror.checked = settings.mirror;
    el.selWin.classList.toggle('on', selected === 'win');
    el.selLose.classList.toggle('on', selected === 'lose');
    el.radius.value = String(settings.radius);
    el.radiusOut.textContent = String(settings.radius);
    el.hint.checked = settings.hint;
    el.show.checked = settings.showSpots;
    el.sound.checked = settings.sound;
    el.min1.classList.toggle('on', settings.minFingers === 1);
    el.min2.classList.toggle('on', settings.minFingers === 2);
  }

  function changed() { saveSettings(); syncSettingsUI(); kick(); }

  function openSettings() {
    resetRound(clock());
    ignored.clear();
    settingsOpen = true;
    syncSettingsUI();
    kick();
  }
  function closeSettings() {
    settingsOpen = false;
    dragTouch = null;
    saveSettings();
    syncSettingsUI();
    resetRound(clock());
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
      if (dragTouch) return;
      const tc = e.changedTouches[0];
      const x = tc.clientX, y = tc.clientY, R = settings.radius + 24;
      const w = spotPx('win'), l = spotPx('lose');
      const dw = Math.hypot(x - w.x, y - w.y), dl = Math.hypot(x - l.x, y - l.y);
      let which = selected;
      if (dw <= R && dw <= dl) which = 'win';
      else if (dl <= R) which = 'lose';
      selected = which;
      dragTouch = { id: tc.identifier, which, x, y };
      placeSpot(which, x, y);
      syncSettingsUI();
    } else if (dragTouch) {
      for (const tc of e.changedTouches) {
        if (tc.identifier !== dragTouch.id) continue;
        dragTouch.x = tc.clientX; dragTouch.y = tc.clientY;
        placeSpot(dragTouch.which, tc.clientX, tc.clientY);
        if (kind === 'end') { dragTouch = null; saveSettings(); }
      }
    }
    kick();
  }

  el.dock.addEventListener('click', () => { settings.dock = settings.dock === 'top' ? 'bottom' : 'top'; changed(); });
  el.cheat.addEventListener('change', () => { settings.cheat = el.cheat.checked; changed(); });
  el.mirror.addEventListener('change', () => {
    settings.mirror = el.mirror.checked;
    if (!settings.mirror) settings.lose = { u: 1 - settings.win.u, v: settings.win.v };
    changed();
  });
  el.selWin.addEventListener('click', () => { selected = 'win'; changed(); });
  el.selLose.addEventListener('click', () => { selected = 'lose'; changed(); });
  el.radius.addEventListener('input', () => { settings.radius = clamp(Number(el.radius.value) || 45, 20, 90); changed(); });
  el.hint.addEventListener('change', () => { settings.hint = el.hint.checked; changed(); });
  el.show.addEventListener('change', () => { settings.showSpots = el.show.checked; changed(); });
  el.sound.addEventListener('change', () => { settings.sound = el.sound.checked; changed(); if (settings.sound) { audio.unlock(); audio.fingerDown(0); } });
  el.min1.addEventListener('click', () => { settings.minFingers = 1; changed(); });
  el.min2.addEventListener('click', () => { settings.minFingers = 2; changed(); });
  el.reset.addEventListener('click', () => { const dock = settings.dock; settings = sanitize({ dock }); selected = 'win'; changed(); });
  el.close.addEventListener('click', closeSettings);

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

  document.addEventListener('visibilitychange', () => {
    // Touches can be lost while hidden; start clean when we come back.
    tapStarts.clear();
    ignored.clear();
    if (!settingsOpen) resetRound(clock());
    kick();
  });
  window.addEventListener('pagehide', () => { if (!settingsOpen) resetRound(clock()); });
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 60));

  if ('serviceWorker' in navigator) {
    if (DEBUG) {
      // Testing: always run the files on disk, never a cached copy.
      navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    } else if (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
    }
  }

  if (DEBUG) {
    window.__chooser = {
      get phase() { return phase; },
      get winner() { return winner && { id: winner.id, x: winner.x, y: winner.y, color: winner.color }; },
      get fingers() { return [...fingers.values()].map((f) => ({ id: f.id, x: f.x, y: f.y, color: f.color, gone: f.gone })); },
      get settings() { return JSON.parse(JSON.stringify(settings)); },
      set settings(s) { settings = sanitize(s); saveSettings(); kick(); },
      spotPx, toDevice, fromDevice, history, openSettings, closeSettings,
      get settingsOpen() { return settingsOpen; },
      tick() { update(clock()); },
      SPEED,
    };
  }

  resize();
  syncSettingsUI();
})();
