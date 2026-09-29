// Aria at her desk: a 90s-cartoon character rig in a painted office.
//
// Style: the character is cel-shaded (flat base colours, hard-edged shadow
// shapes, bold ink outlines, crisp hair highlights); the office behind her is
// painted softly with no outlines, as in 90s TV animation. She sits turned
// 45° toward her monitor (screen right) and can look back at the viewer.
//
// The rig is procedural and driven continuously:
// - head yaw/pitch/roll around the three-quarter pose, with depth parallax
// - eyes with saccades, gaze between viewer / monitor / window, blinks, winks
// - a viseme timeline built from the spoken text, resynced on word boundaries
// - moods blended through critically damped springs, with small gestures
// - typing while she thinks, a hand gesture on emphasis while she talks
// - idle behaviours: glances at the screen or window, smiles, tilts
// - an animated room: real-time wall clock, steam, twinkling city, CRT glow
//
// Public API: setState("idle"|"listening"|"thinking"|"speaking"), setMood(name),
// setMouth(0..1), speakStart(text, rate), speakSync(charIndex), speakEnd(),
// mood (read-only).

const W = 640, H = 480;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

const HEAD = { x: 300, y: 156, s: 0.9 };   // head centre and scale (local units → px)
const NECK_PIVOT = 70;                        // local y the head rolls around
const DESK_Y = 352;                           // back edge of the desk top
const BODY_DY = 14;                           // torso sits a little lower than the art was drawn

const INK = "#1a1522";
const PAL = {
  skin: "#f1b896", skinShade: "#c98067", blush: "#e0707a",
  hair: "#262239", hairShade: "#15121f", hairHi: "#5d78c2", hairGlint: "#d7e4ff",
  blazer: "#1f7c80", blazerShade: "#135559", blazerHi: "#3aa3a2",
  blouse: "#f4e8d2", blouseShade: "#cdb896",
  lip: "#b3434f", lipShade: "#7a2733", mouth: "#4a1620", teeth: "#fbf6ec", tongue: "#c9606c",
  sclera: "#fdf8f0", iris: "#2f9c8f", irisDark: "#1b5f58", gold: "#e3b04b", goldShade: "#a8792a",
};

const MOODS = {
  neutral:   { browL: 0,   browR: 0,   tilt: 0,  furrow: 0,   smileL: 0.2,  smileR: 0.2,  droop: 0.14, squint: 0.05, blush: 0.2,  pupil: 1.0,  roll: 0,  pitch: 0,     open: 0,    wide: 0.1 },
  happy:     { browL: 2.5, browR: 2.5, tilt: 0,  furrow: 0,   smileL: 1.0,  smileR: 1.0,  droop: 0.16, squint: 0.55, blush: 0.7,  pupil: 1.12, roll: 2,  pitch: -0.05, open: 0.12, wide: 0.5 },
  thinking:  { browL: 3,   browR: 0.5, tilt: -1, furrow: 0.5, smileL: 0.0,  smileR: 0.25, droop: 0.24, squint: 0.1,  blush: 0.15, pupil: 0.92, roll: -3, pitch: 0.02,  open: 0,    wide: -0.1 },
  surprised: { browL: 6,   browR: 6,   tilt: 0,  furrow: 0,   smileL: 0.1,  smileR: 0.1,  droop: 0,    squint: 0,    blush: 0.35, pupil: 0.8,  roll: 0,  pitch: -0.18, open: 0.35, wide: -0.5 },
  concerned: { browL: 2,   browR: 2,   tilt: 3.5,furrow: 0.3, smileL: -0.35,smileR: -0.35,droop: 0.22, squint: 0.05, blush: 0.1,  pupil: 1.1,  roll: 3,  pitch: 0.06,  open: 0,    wide: -0.1 },
  playful:   { browL: 0.5, browR: 4,   tilt: -1, furrow: 0,   smileL: 0.35, smileR: 1.0,  droop: 0.18, squint: 0.35, blush: 0.6,  pupil: 1.12, roll: -5, pitch: 0,     open: 0.05, wide: 0.4 },
};

// Mouth shapes: o = open, w = wide(+)/round(-), p = lips pressed, b = lip bite.
const VISEMES = {
  rest: { o: 0, w: 0.1 }, A: { o: 0.8, w: 0.15 }, E: { o: 0.45, w: 0.55 }, I: { o: 0.3, w: 0.75 },
  O: { o: 0.6, w: -0.55 }, U: { o: 0.28, w: -0.9 }, M: { o: 0, w: 0, p: 1 }, F: { o: 0.1, w: 0.2, b: 1 },
  S: { o: 0.18, w: 0.45 }, L: { o: 0.35, w: 0.2 }, R: { o: 0.3, w: -0.3 },
};
const LETTER_VISEME = {
  a: "A", e: "E", i: "I", y: "I", o: "O", u: "U", w: "U", q: "U", m: "M", b: "M", p: "M", f: "F", v: "F",
  l: "L", r: "R", s: "S", z: "S", c: "S", x: "S", t: "S", d: "S", n: "S", k: "S", g: "S", j: "S", h: "S",
};

// Where she can look: gaze x (-1 = at the viewer, +1 = at her monitor), gaze y.
const LOOK = { viewer: [-0.75, 0], monitor: [0.9, 0.15], window: [-1, -0.55], down: [0.3, 0.8] };

// Critically damped spring step.
function spring(cur, vel, target, freq, dt) {
  const w = 2 * Math.PI * freq;
  const x = cur - target;
  const e = Math.exp(-w * dt);
  return [target + (x + (vel + w * x) * dt) * e, (vel - w * (vel + w * x) * dt) * e];
}

// Path through points; a point with a third element "c" is a sharp corner,
// everything else is smoothed (Catmull-Rom → cubic Béziers).
function trace(ctx, pts, closed = true) {
  const n = pts.length;
  const get = (i) => (closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)]);
  ctx.moveTo(pts[0][0], pts[0][1]);
  const end = closed ? n : n - 1;
  for (let i = 0; i < end; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const c1 = p1[2] === "c" ? p1 : [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = p2[2] === "c" ? p2 : [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]);
  }
  if (closed) ctx.closePath();
}

function buildTimeline(text, rate = 1) {
  const tl = [];
  let t = 0, word = 0, inWord = false;
  const r = Math.max(0.5, rate);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i].toLowerCase();
    let vis = LETTER_VISEME[ch], dur;
    if (vis) dur = "aeiouy".includes(ch) ? 0.085 : 0.058;
    else if (/[0-9]/.test(ch)) { vis = "A"; dur = 0.12; }
    else if (/[,;:]/.test(ch)) { vis = "rest"; dur = 0.2; }
    else if (/[.!?]/.test(ch)) { vis = "rest"; dur = 0.32; }
    else { vis = "rest"; dur = 0.035; }
    const isLetter = vis !== "rest";
    const wordStart = isLetter && !inWord;
    inWord = isLetter;
    if (wordStart) word++;
    const prev = tl[tl.length - 1];
    dur /= r;
    if (prev && prev.vis === vis && !wordStart) prev.dur += dur;
    else tl.push({ ci: i, t, dur, vis, amp: rand(0.85, 1.1), word: wordStart ? word : 0, end: /[.!?]/.test(ch) });
    t += dur;
  }
  return { tl, total: t };
}

// Deterministic pseudo-random for the painted background, so it's the same every load.
function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export class Avatar {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "avatar-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Aria at her desk in a cozy evening office");
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this.state = "idle";
    this.mood = "neutral";
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const m = MOODS.neutral;
    this.p = {
      yaw: 0, pitch: 0, roll: 0, lean: 0, gazeX: LOOK.viewer[0], gazeY: 0, ...m,
      open: 0, wide: 0.1, press: 0, bite: 0, arm: 0, glow: 0.6, typing: 0,
    };
    this.v = Object.fromEntries(Object.keys(this.p).map((k) => [k, 0]));
    this.tgt = { ...this.p };

    this.look = "viewer";
    this.gaze = { x: LOOK.viewer[0], y: 0 };
    this.nextSaccade = 0;
    this.pointer = null;
    this.blink = { start: 0, eyes: "both", dur: 230, next: performance.now() + 1500 };
    this.behaviour = null;
    this.nextBehaviour = performance.now() + 4000;
    this.nextNod = 0;
    this.browFlash = 0;
    this.surpriseUntil = 0;
    this.gestureUntil = 0;
    this.mouthManual = 0;
    this.utt = null;
    this.stars = [];
    this.shake = 0;
    this.last = performance.now();
    this.t0 = this.last;
    this.hairLag = { x: 0, y: 0, vx: 0, vy: 0 };
    this.earring = { ang: 0, vel: 0, prevX: null, prevV: 0 };
    this.steam = [0, 1, 2].map((i) => ({ phase: i / 3 }));
    this.cityLights = [];

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    window.addEventListener("pointermove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width) return;
      const lx = (e.clientX - r.left - this.ox) / this.S;
      const ly = (e.clientY - r.top - this.oy) / this.S;
      this.pointer = { x: lx, y: ly, t: performance.now() };
    });
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------ public API
  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.canvas.dataset.state = state;
    if (state === "thinking") this.setMood("thinking");
    if (state === "listening") {
      if (this.mood === "thinking") this.setMood("neutral");
      this.v.pitch += 1.2;
    }
  }

  setMood(mood) {
    if (!MOODS[mood] || mood === this.mood) return;
    this.mood = mood;
    const now = performance.now();
    if (mood === "happy") { this.v.pitch += 1.8; this.burst(4); }
    if (mood === "surprised") { this.v.pitch -= 2.2; this.v.browL += 50; this.v.browR += 50; this.surpriseUntil = now + 1100; }
    if (mood === "playful") { this.wink(); this.v.roll -= 20; this.burst(3); }
    if (mood === "concerned") this.shake = now;
  }

  setMouth(v) { this.mouthManual = clamp(v, 0, 1); }

  speakStart(text, rate = 1) {
    this.utt = { ...buildTimeline(text, rate), start: performance.now(), lastWord: 0, lastEnd: -1 };
  }

  speakSync(charIndex) {
    const u = this.utt;
    if (!u) return;
    const seg = u.tl.find((s) => s.ci >= charIndex);
    if (seg) u.start = performance.now() - seg.t * 1000;
  }

  speakEnd() { this.utt = null; }

  // ------------------------------------------------------------ setup
  resize() {
    const r = this.container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    // Cover the container; the scene is composed with slack at every edge.
    this.S = Math.max(r.width / W, r.height / H) || 1;
    this.ox = (r.width - W * this.S) / 2;
    this.oy = (r.height - H * this.S) / 2;
    this.layers = null; // rebuilt lazily at the new resolution
  }

  layer(draw) {
    const c = document.createElement("canvas");
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext("2d");
    const k = this.dpr * this.S;
    g.setTransform(k, 0, 0, k, this.dpr * this.ox, this.dpr * this.oy);
    draw.call(this, g);
    return c;
  }

  wink() {
    this.blink.start = performance.now();
    this.blink.eyes = "near";
    this.blink.dur = 420;
  }

  burst(n) {
    if (this.reduced) return;
    for (let i = 0; i < n; i++) {
      this.stars.push({ x: rand(230, 380), y: rand(50, 120), vy: rand(-26, -14), life: 0, max: rand(0.8, 1.3), size: rand(4, 7), rot: rand(0, 1) });
    }
  }

  startBlink(now) {
    this.blink.start = now;
    this.blink.eyes = "both";
    this.blink.dur = rand(190, 250);
    this.blink.next = now + (Math.random() < 0.12 ? 320 : rand(2400, 5800));
  }

  // ------------------------------------------------------------ simulation
  frame(now) {
    const dt = clamp((now - this.last) / 1000, 0.001, 0.05);
    this.last = now;
    const t = (now - this.t0) / 1000;
    this.update(now, t, dt);
    this.draw(now, t);
    requestAnimationFrame((n) => this.frame(n));
  }

  update(now, t, dt) {
    const P = this.p, T = this.tgt, V = this.v;
    const mood = MOODS[this.mood];
    const calm = this.reduced ? 0.3 : 1;
    const st = this.state;

    Object.assign(T, {
      browL: mood.browL, browR: mood.browR, tilt: mood.tilt, furrow: mood.furrow,
      smileL: mood.smileL, smileR: mood.smileR, droop: mood.droop, squint: mood.squint,
      blush: mood.blush, pupil: mood.pupil,
    });
    if (st === "listening") { T.browL += 1.5; T.browR += 1.5; T.pupil += 0.08; }
    this.browFlash *= Math.exp(-dt * 5);
    T.browL += this.browFlash; T.browR += this.browFlash;

    // --- behaviours between turns
    if (!this.behaviour && now > this.nextBehaviour && (st === "idle" || st === "speaking")) {
      const kinds = st === "speaking" ? ["glance"] : ["monitor", "monitor", "type", "window", "smile", "tilt"];
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      this.behaviour = { kind, until: now + (kind === "type" ? rand(1800, 3200) : rand(900, 2400)), dir: Math.random() < 0.5 ? -1 : 1 };
      this.nextBehaviour = now + rand(st === "speaking" ? 4000 : 3000, st === "speaking" ? 8000 : 7500);
    }
    if (this.behaviour && now > this.behaviour.until) this.behaviour = null;
    const B = this.behaviour;

    // --- where she looks
    let look = "viewer";
    if (st === "thinking") look = "monitor";
    else if (B?.kind === "monitor" || B?.kind === "type") look = "monitor";
    else if (B?.kind === "window") look = "window";
    else if (B?.kind === "glance") look = "down";
    let [gx, gy] = LOOK[look];
    if (look === "viewer" && this.pointer && now - this.pointer.t < 4000 && st !== "speaking") {
      gx = clamp(-0.75 + (this.pointer.x - HEAD.x) / 320, -1, 0.6);
      gy = clamp((this.pointer.y - HEAD.y) / 260, -0.8, 0.8);
    }
    if (look !== this.look && Math.random() < 0.6) this.startBlink(now);
    this.look = look;
    if (now > this.nextSaccade) {
      const j = st === "thinking" ? 0.18 : 0.05;
      this.gaze.x = gx + rand(-j, j);
      this.gaze.y = gy + rand(-j, j) * 0.6;
      this.nextSaccade = now + (st === "thinking" ? rand(300, 800) : rand(450, 1200));
    }
    T.gazeX = this.gaze.x; T.gazeY = this.gaze.y;

    // --- head pose around the three-quarter view
    const drift = (a, b) => (Math.sin(t * a) + Math.sin(t * b * 1.7 + 1.3)) * 0.5;
    const lively = st === "speaking" ? 1.6 : 1;
    T.yaw = this.gaze.x * 0.3 + drift(0.31, 0.23) * 0.05 * calm * lively;
    T.pitch = this.gaze.y * 0.3 + mood.pitch + drift(0.27, 0.19) * 0.03 * calm * lively;
    T.roll = mood.roll + drift(0.21, 0.13) * 1.2 * calm + (st === "listening" ? 4 : 0) + (B?.kind === "tilt" ? 5 * B.dir : 0);
    if (this.shake && now - this.shake < 700) T.yaw += Math.sin((now - this.shake) / 70) * 0.1 * (1 - (now - this.shake) / 700);
    T.lean = st === "listening" ? 1 : 0;
    if (st === "listening" && now > this.nextNod) { V.pitch += 1.6; this.nextNod = now + rand(2200, 4200); }
    if (B?.kind === "smile") { T.smileL += 0.4; T.smileR += 0.4; T.squint += 0.2; }

    // --- hands
    T.typing = st === "thinking" || B?.kind === "type" ? 1 : 0;
    T.arm = now < this.gestureUntil ? 1 : 0;
    T.glow = st === "thinking" ? 1 : 0.6;

    // --- mouth
    let open = mood.open, wide = mood.wide, press = 0, bite = 0;
    if (this.mood === "surprised" && now > this.surpriseUntil) { open = 0.08; wide = -0.2; }
    if (this.mood === "thinking") press = 0.35;
    const u = this.utt;
    if (u) {
      const el = (now - u.start) / 1000;
      const seg = u.tl.find((s) => el >= s.t && el < s.t + s.dur);
      if (seg) {
        const vz = VISEMES[seg.vis];
        open = vz.o * seg.amp; wide = vz.w + (P.smileL + P.smileR) * 0.15; press = vz.p || 0; bite = vz.b || 0;
        if (seg.word && seg.word !== u.lastWord) {
          u.lastWord = seg.word;
          if (Math.random() < 0.22) { this.browFlash = Math.max(this.browFlash, rand(1.5, 3)); V.pitch += rand(0.5, 1.2); }
          if (Math.random() < 0.08 && now > this.gestureUntil + 1500) this.gestureUntil = now + rand(1000, 1800);
        }
        if (seg.end && seg.ci !== u.lastEnd) { u.lastEnd = seg.ci; V.pitch += 0.8; if (Math.random() < 0.5) this.startBlink(now); }
      }
    } else if (this.mouthManual > 0.02) {
      open = this.mouthManual;
    }
    T.open = open; T.wide = wide; T.press = press; T.bite = bite;

    // --- springs
    const F = { yaw: 2, pitch: 2.2, roll: 1.5, lean: 1.2, gazeX: 13, gazeY: 13, open: 14, wide: 9, press: 12, bite: 12, pupil: 1.5, arm: 2.2, glow: 1.5, typing: 3 };
    for (const k of Object.keys(P)) [P[k], V[k]] = spring(P[k], V[k], T[k], F[k] || 4.5, dt);

    // --- blinks
    if (now > this.blink.next) this.startBlink(now);
    const b = this.blink, e = (now - b.start) / b.dur;
    let bv = 0;
    if (e >= 0 && e < 1) bv = e < 0.38 ? e / 0.38 : 1 - (e - 0.38) / 0.62;
    bv = bv * bv * (3 - 2 * bv);
    this.blinkNear = bv;
    this.blinkFar = b.eyes === "near" ? 0 : bv;

    // --- body
    this.breath = Math.sin(t * (2 * Math.PI / 4.4)) * calm;
    this.bodyY = -this.breath * 1.4;
    this.headDX = P.lean * 5;
    this.headDY = this.breath * 0.9 + P.lean * 3;

    // hair and earring lag behind the head
    const hx = P.yaw * 10 + P.roll * 0.8, hy = P.pitch * 10;
    [this.hairLag.x, this.hairLag.vx] = spring(this.hairLag.x, this.hairLag.vx, hx, 1.4, dt);
    [this.hairLag.y, this.hairLag.vy] = spring(this.hairLag.y, this.hairLag.vy, hy, 1.4, dt);
    const er = this.earring;
    const ax = hx + this.headDX;
    if (er.prevX !== null) {
      const vx = (ax - er.prevX) / dt, acc = (vx - er.prevV) / dt;
      er.prevV = vx;
      er.vel += (-(700 / 12) * Math.sin(er.ang) - acc * 0.012 - er.vel * 2.4) * dt;
      er.ang = clamp(er.ang + er.vel * dt, -0.9, 0.9);
    }
    er.prevX = ax;

    for (const s of this.stars) { s.life += dt; s.y += s.vy * dt; }
    this.stars = this.stars.filter((s) => s.life < s.max);
  }

  // ------------------------------------------------------------ drawing: frame
  draw(now, t) {
    const ctx = this.ctx;
    if (!this.layers) {
      this.layers = {
        back: this.layer(this.paintRoom),
        desk: this.layer(this.paintDeskTop),
        front: this.layer(this.paintDeskFront),
      };
      this.buildCity();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layers.back, 0, 0);
    const k = this.dpr * this.S;
    ctx.setTransform(k, 0, 0, k, this.dpr * this.ox, this.dpr * this.oy);

    this.drawCityLights(t);
    this.drawClockHands();
    this.drawChair();
    this.drawBackHair();
    this.drawNeck();
    this.drawFarUpperArm();
    this.drawTorso();
    this.drawHead(t);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layers.desk, 0, 0);
    ctx.setTransform(k, 0, 0, k, this.dpr * this.ox, this.dpr * this.oy);

    this.drawMonitorGlow(t);
    this.drawArms(t);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layers.front, 0, 0);
    ctx.setTransform(k, 0, 0, k, this.dpr * this.ox, this.dpr * this.oy);

    this.drawSteam(t);
    this.drawThoughts(t);
    this.drawStars();
  }

  // ------------------------------------------------------------ painted room (static)
  paintRoom(g) {
    const rnd = seeded(7);
    // wall
    const wall = g.createLinearGradient(0, 0, 0, H);
    wall.addColorStop(0, "#3a3350");
    wall.addColorStop(0.55, "#54435c");
    wall.addColorStop(1, "#6a4d58");
    g.fillStyle = wall;
    g.fillRect(-40, -40, W + 80, H + 80);
    // wallpaper stripes
    g.globalAlpha = 0.05;
    g.fillStyle = "#fff";
    for (let x = -40; x < W + 40; x += 22) g.fillRect(x, -40, 8, H + 80);
    g.globalAlpha = 1;
    // picture rail
    g.fillStyle = "#2c2438";
    g.fillRect(-40, 22, W + 80, 5);

    // window with the city at dusk
    const wx = 26, wy = 46, ww = 176, wh = 206;
    const sky = g.createLinearGradient(0, wy, 0, wy + wh);
    sky.addColorStop(0, "#1d2150");
    sky.addColorStop(0.45, "#583d7a");
    sky.addColorStop(0.8, "#c9637a");
    sky.addColorStop(1, "#f0a05f");
    g.fillStyle = sky;
    g.fillRect(wx, wy, ww, wh);
    g.fillStyle = "#fff4d8";
    for (let i = 0; i < 14; i++) {
      g.globalAlpha = rand(0.3, 0.8);
      g.fillRect(wx + rnd() * ww, wy + rnd() * wh * 0.4, 1.3, 1.3);
    }
    g.globalAlpha = 1;
    // moon
    g.fillStyle = "#fbecc4";
    g.beginPath(); g.arc(wx + 134, wy + 34, 13, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#2a2658";
    g.beginPath(); g.arc(wx + 140, wy + 30, 11, 0, Math.PI * 2); g.fill();
    // far skyline then near skyline
    this.buildings = [];
    for (const [shade, base, hmin, hmax, wmin, wmax] of [["#3c2f5e", wy + wh, 60, 120, 14, 26], ["#1f1a36", wy + wh, 40, 150, 18, 34]]) {
      let x = wx - 6;
      while (x < wx + ww) {
        const bw = lerp(wmin, wmax, rnd()), bh = lerp(hmin, hmax, rnd());
        g.fillStyle = shade;
        g.fillRect(x, base - bh, bw, bh);
        if (rnd() < 0.3) g.fillRect(x + bw / 2 - 1, base - bh - 10, 2, 10); // antenna
        if (shade === "#1f1a36") this.buildings.push({ x, y: base - bh, w: bw, h: bh });
        x += bw + (rnd() < 0.3 ? 2 : 0);
      }
    }
    // frame, mullions, sill
    g.strokeStyle = "#2b2233";
    g.lineWidth = 9;
    g.strokeRect(wx, wy, ww, wh);
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(wx + ww / 2, wy); g.lineTo(wx + ww / 2, wy + wh); g.moveTo(wx, wy + wh * 0.46); g.lineTo(wx + ww, wy + wh * 0.46); g.stroke();
    g.fillStyle = "#3a2d3f";
    g.fillRect(wx - 12, wy + wh + 3, ww + 24, 9);
    // glass sheen
    g.globalAlpha = 0.08;
    g.fillStyle = "#fff";
    g.beginPath(); g.moveTo(wx + 10, wy + wh); g.lineTo(wx + 60, wy); g.lineTo(wx + 80, wy); g.lineTo(wx + 30, wy + wh); g.fill();
    g.globalAlpha = 1;
    // curtains
    for (const [x0, dir] of [[wx - 22, 1], [wx + ww + 22, -1]]) {
      g.fillStyle = "#8c4a3c";
      g.beginPath();
      g.moveTo(x0, wy - 18);
      g.lineTo(x0 + dir * 34, wy - 18);
      g.bezierCurveTo(x0 + dir * 26, wy + 90, x0 + dir * 40, wy + 170, x0 + dir * 30, wy + wh + 40);
      g.lineTo(x0 - dir * 4, wy + wh + 40);
      g.closePath();
      g.fill();
      g.strokeStyle = "#6b3329";
      g.lineWidth = 3;
      for (const f of [10, 20]) {
        g.beginPath(); g.moveTo(x0 + dir * f, wy - 10); g.bezierCurveTo(x0 + dir * (f - 3), wy + 80, x0 + dir * (f + 4), wy + 160, x0 + dir * (f - 2), wy + wh + 36); g.stroke();
      }
    }
    g.fillStyle = "#b8894c";
    g.fillRect(wx - 30, wy - 24, ww + 60, 6);
    // small plant on the sill
    this.paintPot(g, wx + 30, wy + wh + 2, 0.8);

    // framed art above her
    g.fillStyle = "#b58a4b";
    g.fillRect(236, 30, 72, 46);
    g.fillStyle = "#e8dcc2";
    g.fillRect(241, 35, 62, 36);
    g.fillStyle = "#3f7f7a"; g.beginPath(); g.arc(260, 58, 10, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#d9804f"; g.fillRect(272, 42, 20, 22);
    g.fillStyle = "#2f3e6b"; g.beginPath(); g.moveTo(245, 70); g.lineTo(276, 50); g.lineTo(300, 70); g.fill();

    // wall clock face (hands are drawn live)
    g.fillStyle = "#2b2233";
    g.beginPath(); g.arc(398, 70, 27, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#f3e9d2";
    g.beginPath(); g.arc(398, 70, 22, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#2b2233";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r1 = i % 3 === 0 ? 15 : 17.5;
      g.save(); g.translate(398 + Math.sin(a) * r1, 70 - Math.cos(a) * r1); g.rotate(a);
      g.fillRect(-0.9, 0, 1.8, i % 3 === 0 ? 4 : 2.5); g.restore();
    }

    // bookshelf on the right
    const sx = 452, sy = 14, sw = 200, sh = 346;
    g.fillStyle = "#4a2f24";
    g.fillRect(sx, sy, sw, sh);
    g.fillStyle = "#3a241b";
    g.fillRect(sx + 10, sy + 10, sw - 10, sh - 10);
    const colors = ["#b5523b", "#d9a441", "#3f7f7a", "#6b4f8f", "#e3d5b8", "#2f4b6e", "#8c3b3b", "#5d7a3e"];
    for (const shelfY of [104, 194, 284]) {
      g.fillStyle = "#6b4431";
      g.fillRect(sx, shelfY, sw, 8);
      let x = sx + 14;
      while (x < sx + sw - 8) {
        const bw = lerp(8, 15, rnd()), bh = lerp(52, 74, rnd());
        if (rnd() < 0.12) { // a leaning book
          g.save(); g.translate(x, shelfY); g.rotate(-0.25); g.fillStyle = colors[Math.floor(rnd() * colors.length)];
          g.fillRect(0, -bh, bw, bh); g.restore(); x += bw + 12; continue;
        }
        if (rnd() < 0.1) { // a small object instead of a book
          g.fillStyle = "#c9a15a"; g.beginPath(); g.arc(x + 10, shelfY - 10, 10, 0, Math.PI * 2); g.fill();
          g.fillStyle = "#6b4431"; g.fillRect(x + 6, shelfY - 2, 8, 2); x += 26; continue;
        }
        g.fillStyle = colors[Math.floor(rnd() * colors.length)];
        g.fillRect(x, shelfY - bh, bw, bh);
        g.fillStyle = "rgba(255,255,255,0.18)";
        g.fillRect(x + 2, shelfY - bh + 8, bw - 4, 2);
        g.fillRect(x + 2, shelfY - 14, bw - 4, 2);
        x += bw + 1;
      }
    }
    g.fillStyle = "#6b4431";
    g.fillRect(sx, sy, sw, 8);
    // trailing plant on top of the shelf
    this.paintPot(g, sx + 36, sy + 2, 0.9);
    g.strokeStyle = "#2f6a45";
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(sx + 30, sy + 2); g.bezierCurveTo(sx + 10, sy + 40, sx + 16, sy + 80, sx - 2, sy + 130); g.stroke();
    for (let i = 0; i < 9; i++) {
      const tt = i / 8, px = lerp(sx + 26, sx - 2, tt) + Math.sin(i * 1.7) * 6, py = lerp(sy + 8, sy + 130, tt);
      this.leaf(g, px, py, 7, i % 2 ? 0.9 : -0.6, i % 2 ? "#3f8a58" : "#2f6a45");
    }

    // warm lamp light on the wall and a cool glow from the monitor
    const lamp = g.createRadialGradient(92, 300, 10, 92, 300, 300);
    lamp.addColorStop(0, "rgba(255,190,110,0.45)");
    lamp.addColorStop(1, "rgba(255,190,110,0)");
    g.fillStyle = lamp;
    g.fillRect(-40, -40, W + 80, H + 80);
  }

  paintPot(g, x, y, s) {
    g.save(); g.translate(x, y); g.scale(s, s);
    for (let i = 0; i < 7; i++) this.leaf(g, (i - 3) * 5, -14 - Math.abs(i - 3) * -2, 11, (i - 3) * 0.35, i % 2 ? "#3f8a58" : "#2f6a45");
    g.fillStyle = "#b8643f";
    g.beginPath(); g.moveTo(-14, -12); g.lineTo(14, -12); g.lineTo(10, 6); g.lineTo(-10, 6); g.closePath(); g.fill();
    g.fillStyle = "#94502f"; g.fillRect(-15, -14, 30, 5);
    g.restore();
  }

  leaf(g, x, y, len, ang, color) {
    g.save(); g.translate(x, y); g.rotate(ang);
    g.fillStyle = color;
    g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(len * 0.5, -len * 0.45, 0, -len); g.quadraticCurveTo(-len * 0.5, -len * 0.45, 0, 0); g.fill();
    g.restore();
  }

  buildCity() {
    const rnd = seeded(11);
    this.cityLights = [];
    for (const b of this.buildings || []) {
      for (let yy = b.y + 6; yy < b.y + b.h - 4; yy += 8) {
        for (let xx = b.x + 3; xx < b.x + b.w - 3; xx += 6) {
          if (rnd() < 0.35 && xx > 26 && xx < 200) this.cityLights.push({ x: xx, y: yy, on: rnd() < 0.8, next: rnd() * 8000 });
        }
      }
    }
  }

  drawCityLights(t) {
    const ctx = this.ctx, now = t * 1000;
    ctx.fillStyle = "#ffd27a";
    for (const l of this.cityLights) {
      if (!this.reduced && now > l.next) { l.on = Math.random() < 0.8; l.next = now + rand(3000, 14000); }
      if (!l.on) continue;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(l.x, l.y, 2.4, 3);
    }
    ctx.globalAlpha = 1;
  }

  drawClockHands() {
    const ctx = this.ctx, d = new Date();
    const h = (d.getHours() % 12) + d.getMinutes() / 60, m = d.getMinutes() + d.getSeconds() / 60, s = d.getSeconds();
    const hand = (a, len, w, c) => {
      ctx.save(); ctx.translate(398, 70); ctx.rotate(a);
      ctx.fillStyle = c; ctx.fillRect(-w / 2, -len, w, len + 3); ctx.restore();
    };
    hand((h / 12) * Math.PI * 2, 10, 2.6, "#2b2233");
    hand((m / 60) * Math.PI * 2, 15, 1.8, "#2b2233");
    hand((s / 60) * Math.PI * 2, 17, 0.8, "#b5523b");
    ctx.fillStyle = "#2b2233";
    ctx.beginPath(); ctx.arc(398, 70, 1.8, 0, Math.PI * 2); ctx.fill();
  }

  // ------------------------------------------------------------ desk (static layers)
  paintDeskTop(g) {
    // desk surface in perspective
    const top = g.createLinearGradient(0, DESK_Y, 0, 404);
    top.addColorStop(0, "#7b4a31");
    top.addColorStop(1, "#935a38");
    g.fillStyle = top;
    g.beginPath(); g.moveTo(-40, DESK_Y + 2); g.lineTo(W + 40, DESK_Y - 4); g.lineTo(W + 40, 404); g.lineTo(-40, 404); g.closePath(); g.fill();
    g.strokeStyle = "rgba(60,30,18,0.25)";
    g.lineWidth = 1.2;
    for (let i = 0; i < 7; i++) {
      const y = DESK_Y + 6 + i * 7;
      g.beginPath(); g.moveTo(-40, y); g.bezierCurveTo(160, y - 3, 420, y + 4, W + 40, y - 2); g.stroke();
    }
    // warm light pool under the lamp
    const pool = g.createRadialGradient(96, 380, 5, 96, 380, 200);
    pool.addColorStop(0, "rgba(255,200,120,0.5)");
    pool.addColorStop(1, "rgba(255,200,120,0)");
    g.fillStyle = pool;
    g.fillRect(-40, DESK_Y - 10, W + 80, 70);

    // stack of books, far left
    for (const [y, w, c] of [[388, 70, "#2f4b6e"], [378, 64, "#b5523b"], [369, 58, "#d9a441"]]) {
      g.fillStyle = c; g.fillRect(-6, y - 10, w, 10);
      g.fillStyle = "#efe4cc"; g.fillRect(-6 + w - 4, y - 8, 3, 6);
    }

    // banker's lamp
    g.fillStyle = "#b8893a";
    g.beginPath(); g.ellipse(96, 374, 26, 7, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#d9ab55"; g.fillRect(93, 318, 6, 56);
    g.beginPath(); g.ellipse(96, 370, 20, 4, 0, 0, Math.PI * 2); g.fill();
    const glass = g.createLinearGradient(0, 290, 0, 322);
    glass.addColorStop(0, "#2f8a5a");
    glass.addColorStop(1, "#1d5c3c");
    g.fillStyle = glass;
    g.beginPath(); g.moveTo(56, 318); g.quadraticCurveTo(58, 292, 96, 290); g.quadraticCurveTo(134, 292, 136, 318); g.closePath(); g.fill();
    g.fillStyle = "rgba(255,255,255,0.25)";
    g.beginPath(); g.moveTo(70, 312); g.quadraticCurveTo(74, 298, 94, 296); g.lineTo(94, 300); g.quadraticCurveTo(78, 302, 76, 314); g.fill();
    g.fillStyle = "#ffe3a3";
    g.beginPath(); g.ellipse(96, 319, 38, 4, 0, 0, Math.PI * 2); g.fill();

    // beige 90s CRT monitor, turned toward her
    g.fillStyle = "#8f8470"; // stand
    g.beginPath(); g.ellipse(522, 372, 44, 9, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#7d7361"; g.fillRect(508, 342, 30, 26);
    g.fillStyle = "#a89a7e"; // case side
    g.beginPath(); g.moveTo(486, 214); g.lineTo(606, 232); g.lineTo(600, 338); g.lineTo(488, 348); g.closePath(); g.fill();
    g.fillStyle = "#958a70";
    g.beginPath(); g.moveTo(486, 214); g.lineTo(606, 232); g.lineTo(612, 222); g.lineTo(500, 204); g.closePath(); g.fill();
    g.strokeStyle = "rgba(90,80,64,0.35)"; g.lineWidth = 2;
    for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(540 + i * 10, 250 + i * 1.5); g.lineTo(540 + i * 10, 300); g.stroke(); } // vents
    const caseShade = g.createLinearGradient(488, 0, 606, 0);
    caseShade.addColorStop(0, "rgba(20,14,30,0)");
    caseShade.addColorStop(1, "rgba(20,14,30,0.45)");
    g.fillStyle = caseShade;
    g.beginPath(); g.moveTo(486, 214); g.lineTo(606, 232); g.lineTo(600, 338); g.lineTo(488, 348); g.closePath(); g.fill();
    g.fillStyle = "#c2b597"; // front bezel, seen edge-on
    g.beginPath(); g.moveTo(462, 206); g.lineTo(488, 212); g.lineTo(490, 350); g.lineTo(464, 356); g.closePath(); g.fill();
    g.fillStyle = "#16202b"; // screen sliver
    g.beginPath(); g.moveTo(467, 218); g.lineTo(484, 222); g.lineTo(485, 338); g.lineTo(468, 342); g.closePath(); g.fill();

    // keyboard (beige, of course) and mouse
    g.fillStyle = "#9d927d";
    g.beginPath(); g.moveTo(304, 374); g.lineTo(432, 368); g.lineTo(442, 390); g.lineTo(308, 398); g.closePath(); g.fill();
    g.fillStyle = "#cfc3a8";
    g.beginPath(); g.moveTo(304, 371); g.lineTo(432, 365); g.lineTo(440, 385); g.lineTo(308, 393); g.closePath(); g.fill();
    g.strokeStyle = "rgba(90,80,64,0.45)"; g.lineWidth = 0.9;
    for (let r = 1; r < 4; r++) {
      const a = r / 4;
      g.beginPath(); g.moveTo(lerp(304, 308, a), lerp(371, 393, a)); g.lineTo(lerp(432, 440, a), lerp(365, 385, a)); g.stroke();
    }
    for (let c = 1; c < 14; c++) {
      const a = c / 14;
      g.beginPath(); g.moveTo(lerp(304, 432, a), lerp(371, 365, a)); g.lineTo(lerp(308, 440, a), lerp(393, 385, a)); g.stroke();
    }
    g.fillStyle = "#ddd3bf";
    g.beginPath(); g.ellipse(462, 384, 9, 6, -0.2, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#8a806c"; g.lineWidth = 1; g.beginPath(); g.moveTo(462, 378); g.quadraticCurveTo(470, 360, 490, 350); g.stroke();

    // legal pad and pen
    g.save(); g.translate(214, 384); g.rotate(-0.08);
    g.fillStyle = "#f3dc7a"; g.fillRect(-26, -9, 52, 20);
    g.fillStyle = "#a7372f"; g.fillRect(-26, -9, 52, 4);
    g.strokeStyle = "rgba(80,110,160,0.5)"; g.lineWidth = 0.8;
    for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(-22, -1 + i * 4); g.lineTo(22, -1 + i * 4); g.stroke(); }
    g.fillStyle = "#1f1b2b"; g.rotate(0.5); g.fillRect(-4, -12, 3, 26);
    g.restore();
  }

  paintDeskFront(g) {
    // front edge and panel
    g.fillStyle = "#b37848";
    g.fillRect(-40, 402, W + 80, 5);
    const front = g.createLinearGradient(0, 407, 0, H + 40);
    front.addColorStop(0, "#5f3624");
    front.addColorStop(1, "#3a2016");
    g.fillStyle = front;
    g.fillRect(-40, 407, W + 80, H);
    g.strokeStyle = "rgba(0,0,0,0.25)";
    g.lineWidth = 2;
    g.strokeRect(40, 424, 200, 70);
    g.strokeRect(400, 424, 200, 70);
    g.fillStyle = "#c79a52";
    g.fillRect(126, 446, 28, 5);
    g.fillRect(486, 446, 28, 5);

    // mug in front of the lamp light
    const mx = 176, my = 392;
    g.fillStyle = "#1f7c80";
    g.beginPath(); g.moveTo(mx - 13, my - 24); g.lineTo(mx + 13, my - 24); g.lineTo(mx + 12, my + 4); g.quadraticCurveTo(mx, my + 9, mx - 12, my + 4); g.closePath(); g.fill();
    g.strokeStyle = "#1f7c80"; g.lineWidth = 4;
    g.beginPath(); g.arc(mx + 15, my - 11, 7, -1.2, 1.2); g.stroke();
    g.fillStyle = "#135559";
    g.beginPath(); g.ellipse(mx, my - 24, 13, 3.5, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#4a2a1a";
    g.beginPath(); g.ellipse(mx, my - 23, 11, 2.6, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(255,255,255,0.25)"; g.fillRect(mx - 9, my - 18, 3, 16);

    // brass nameplate
    g.fillStyle = "#3a2016";
    g.beginPath(); g.moveTo(538, 404); g.lineTo(612, 404); g.lineTo(606, 386); g.lineTo(544, 386); g.closePath(); g.fill();
    const brass = g.createLinearGradient(0, 380, 0, 398);
    brass.addColorStop(0, "#f0cf7a"); brass.addColorStop(1, "#b88a37");
    g.fillStyle = brass;
    g.beginPath(); g.moveTo(544, 398); g.lineTo(606, 398); g.lineTo(602, 380); g.lineTo(548, 380); g.closePath(); g.fill();
    g.fillStyle = "#3a2410";
    g.font = "bold 11px 'Bebas Neue', 'Oswald', 'Arial Narrow', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("A R I A", 575, 390);

    // succulent at the right edge
    this.paintPot(g, 626, 402, 1.1);

    // vignette over everything
    const v = g.createRadialGradient(W / 2, H / 2, 180, W / 2, H / 2, 480);
    v.addColorStop(0, "rgba(12,8,24,0)");
    v.addColorStop(1, "rgba(12,8,24,0.5)");
    g.fillStyle = v;
    g.fillRect(-40, -40, W + 80, H + 80);
  }

  drawMonitorGlow(t) {
    const ctx = this.ctx, P = this.p;
    const flicker = this.reduced ? 0 : Math.sin(t * 13) * 0.03 + Math.sin(t * 2.1) * 0.04;
    const a = clamp(0.35 + P.glow * 0.35 + flicker, 0, 1);
    const g = ctx.createRadialGradient(466, 280, 6, 466, 280, 150);
    g.addColorStop(0, `rgba(120,210,255,${0.22 * a})`);
    g.addColorStop(1, "rgba(120,210,255,0)");
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = g;
    ctx.fillRect(320, 150, 146, 240);
    ctx.restore();
    ctx.fillStyle = `rgba(150,225,255,${0.65 * a})`;
    ctx.beginPath(); ctx.moveTo(467, 218); ctx.lineTo(484, 222); ctx.lineTo(485, 338); ctx.lineTo(468, 342); ctx.closePath(); ctx.fill();
  }

  drawSteam(t) {
    if (this.reduced) return;
    const ctx = this.ctx;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (const s of this.steam) {
      const ph = (t * 0.35 + s.phase) % 1;
      ctx.globalAlpha = Math.sin(ph * Math.PI) * 0.35;
      const x = 176 + (s.phase - 0.5) * 12, y = 364 - ph * 34;
      ctx.beginPath();
      ctx.moveTo(x, y + 14);
      ctx.bezierCurveTo(x - 5, y + 8, x + 5, y + 4, x, y - 4);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------ character helpers
  // Filled shape with an ink outline.
  ink(pts, fill, lw = 2.4, closed = true, stroke = INK) {
    const ctx = this.ctx;
    ctx.beginPath();
    trace(ctx, pts, closed);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (lw) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke(); }
  }

  // Hard-edged cel shadow clipped to the shape just traced as `clip`.
  cel(clipPts, shadePts, color) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath(); trace(ctx, clipPts, true); ctx.clip();
    ctx.beginPath(); trace(ctx, shadePts, true);
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }

  // Shift a head-local point by depth parallax (yaw turns, pitch nods).
  hp(x, y, z) {
    return [x + this.p.yaw * 9 * z, y + this.p.pitch * 7 * z];
  }

  drawChair() {
    const ctx = this.ctx, y = this.bodyY * 0.3;
    ctx.save(); ctx.translate(0, y);
    this.ink([[218, 380, "c"], [214, 170], [236, 118], [296, 104], [356, 116], [380, 170], [378, 380, "c"]], "#5b2b30", 2.4);
    this.cel([[218, 380], [214, 170], [236, 118], [296, 104], [356, 116], [380, 170], [378, 380]],
      [[214, 170], [236, 118], [270, 108], [248, 140], [238, 380], [210, 380]], "#3f1c21");
    ctx.strokeStyle = "#7d4145"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(262, 120); ctx.quadraticCurveTo(298, 112, 340, 120); ctx.stroke();
    ctx.fillStyle = "#2c1215";
    for (const [bx, by] of [[270, 150], [322, 150], [270, 200], [322, 200]]) { ctx.beginPath(); ctx.arc(bx, by, 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  // Everything attached to the head is drawn in head-local space.
  enterHead() {
    const ctx = this.ctx, P = this.p;
    ctx.save();
    ctx.translate(HEAD.x + this.headDX, HEAD.y + this.headDY);
    ctx.scale(HEAD.s, HEAD.s);
    ctx.translate(0, NECK_PIVOT);
    ctx.rotate(P.roll * DEG);
    ctx.translate(0, -NECK_PIVOT);
  }

  drawBackHair() {
    const ctx = this.ctx, L = this.hairLag;
    this.enterHead();
    const lx = -L.x * 0.8, ly = -L.y * 0.5;
    const pts = [[-20, -92], [-62, -74], [-82, -34], [-86, 18], [-80 + lx, 66 + ly], [-92 + lx, 104 + ly, "c"], [-66 + lx, 98 + ly], [-50 + lx * 0.7, 112 + ly, "c"], [-38, 94 + ly * 0.5], [-20, 102 + ly * 0.4, "c"], [-8, 60], [8, -50]];
    this.ink(pts, PAL.hair, 2.8);
    this.cel(pts, [[-80, 0], [-86, 18], [-80 + lx, 66 + ly], [-92 + lx, 104 + ly], [-66 + lx, 98 + ly], [-50 + lx * 0.7, 112 + ly], [-38, 94], [-20, 102], [-8, 60], [-34, 10]], PAL.hairShade);
    // a sweep of highlight down the back of the hair
    this.cel(pts, [[-72, -54], [-80, -20], [-80, 22], [-77, 44], [-74, 20], [-73, -16], [-66, -48]], PAL.hairHi);
    ctx.restore();
  }

  drawNeck() {
    this.enterHead();
    const neck = [[-18, 44, "c"], [16, 58, "c"], [20, 112, "c"], [-24, 114, "c"]];
    this.ink(neck, PAL.skin, 2.4);
    this.cel(neck, [[-18, 44], [18, 58], [18, 84], [-4, 88], [-24, 80]], PAL.skinShade);
    this.ctx.restore();
  }

  drawTorso() {
    const ctx = this.ctx, y = this.bodyY, P = this.p;
    ctx.save();
    ctx.translate(this.headDX * 0.3, y + BODY_DY);
    // blazer
    const body = [[282, 218, "c"], [244, 228], [214, 246], [205, 300], [208, 390, "c"], [364, 390, "c"], [368, 300], [360, 244], [334, 226], [312, 214, "c"]];
    this.ink(body, PAL.blazer, 2.6);
    this.cel(body, [[214, 246], [205, 300], [208, 390], [248, 390], [240, 300], [252, 250], [270, 232], [282, 218], [244, 228]], PAL.blazerShade);
    // blouse
    const blouse = [[283, 219, "c"], [311, 214, "c"], [302, 276, "c"]];
    this.ink(blouse, PAL.blouse, 2);
    this.cel(blouse, [[283, 219], [296, 216], [300, 276]], PAL.blouseShade);
    // necklace
    ctx.strokeStyle = PAL.gold; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(286, 222); ctx.quadraticCurveTo(296, 240, 308, 218); ctx.stroke();
    ctx.fillStyle = PAL.gold; ctx.beginPath(); ctx.arc(297, 234, 2.4, 0, Math.PI * 2); ctx.fill();
    // lapels
    this.ink([[283, 219, "c"], [300, 282, "c"], [284, 300, "c"], [262, 252, "c"], [272, 246, "c"], [266, 232, "c"]], PAL.blazer, 2.2);
    this.cel([[283, 219], [300, 282], [284, 300], [262, 252], [272, 246], [266, 232]], [[266, 232], [272, 246], [262, 252], [284, 300], [290, 290], [276, 250]], PAL.blazerShade);
    this.ink([[311, 214, "c"], [302, 280, "c"], [314, 294, "c"], [330, 250, "c"], [322, 244, "c"], [328, 228, "c"]], PAL.blazer, 2.2);
    // lapel highlight and a button
    ctx.strokeStyle = PAL.blazerHi; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(314, 232); ctx.lineTo(306, 272); ctx.stroke();
    this.ink([[296, 318], [301, 322], [296, 326], [291, 322]], "#0e3b3e", 1.4);
    ctx.restore();
  }

  drawFarUpperArm() {
    const ctx = this.ctx, y = this.bodyY;
    ctx.save(); ctx.translate(this.headDX * 0.3, y + BODY_DY);
    this.tube([[352, 250], [366, 344]], 30, PAL.blazerShade);
    ctx.restore();
  }

  // Thick outlined limb along a polyline.
  tube(pts, w, color) {
    const ctx = this.ctx;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = INK; ctx.lineWidth = w + 5; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
  }

  drawArms(t) {
    const ctx = this.ctx, P = this.p, y = this.bodyY;
    const typing = clamp(P.typing, 0, 1);
    const tap = (ph) => (this.reduced ? 0 : Math.max(0, Math.sin(t * 17 + ph)) * 2.2 * typing);
    ctx.save(); ctx.translate(this.headDX * 0.3, y * 0.5);

    // far forearm and hand on the keyboard
    const fe = [366, 358], fw = [398, 372 - tap(1.7)];
    this.tube([[358, 330], fe], 28, PAL.blazerShade);
    this.tube([fe, fw], 22, PAL.blazerShade);
    this.hand(fw[0], fw[1], 0.1, PAL.skinShade, false);

    // near arm: shoulder → elbow on the desk → wrist; lifts to gesture
    const lift = clamp(P.arm, 0, 1);
    const sh = [214, 252 + BODY_DY], el = [224 + lift * 8, 366 - lift * 6];
    const rest = Math.atan2(376 - 366, 322 - 224); // pointing at the keyboard
    const ang = lerp(rest, -1.15, lift);
    const len = 96 - lift * 16;
    const wr = [el[0] + Math.cos(ang) * len, el[1] + Math.sin(ang) * len - tap(0)];
    this.tube([sh, el], 32, PAL.blazer);
    // shadow side of the upper arm
    ctx.save();
    ctx.beginPath(); ctx.moveTo(sh[0] - 16, sh[1]); ctx.lineTo(el[0] - 16, el[1]); ctx.lineTo(el[0] - 4, el[1]); ctx.lineTo(sh[0] - 4, sh[1]); ctx.closePath();
    ctx.fillStyle = PAL.blazerShade; ctx.fill();
    ctx.restore();
    this.tube([el, wr], 26, PAL.blazer);
    // cuff
    const cx = wr[0] - Math.cos(ang) * 5, cy = wr[1] - Math.sin(ang) * 5;
    this.tube([[cx, cy], [wr[0] - Math.cos(ang) * 1, wr[1] - Math.sin(ang) * 1]], 16, PAL.blouse);
    this.hand(wr[0], wr[1], ang, PAL.skin, lift > 0.5);
    ctx.restore();
  }

  hand(x, y, ang, color, open) {
    const ctx = this.ctx;
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    if (open) {
      // open palm, fingers up, facing the viewer
      ctx.rotate(-ang - 0.25);
      this.ink([[-8, 4], [-10, -8], [-8, -22, "c"], [-4, -22], [-3, -12], [-1, -26, "c"], [3, -26], [4, -13], [6, -24, "c"], [10, -23], [9, -10], [13, -18, "c"], [16, -16], [12, -2], [14, 6, "c"], [20, 2], [22, 6], [12, 16], [0, 16]], color, 2.2);
    } else {
      this.ink([[0, -9], [14, -11], [28, -8], [34, -2], [32, 6], [20, 9], [4, 9], [-2, 2]], color, 2.2);
      ctx.strokeStyle = INK; ctx.lineWidth = 1.3;
      for (const yy of [-4, 0, 4]) { ctx.beginPath(); ctx.moveTo(22, yy); ctx.lineTo(31, yy + 0.5); ctx.stroke(); }
      ctx.fillStyle = PAL.skinShade;
      ctx.beginPath(); ctx.moveTo(4, 9); ctx.lineTo(20, 9); ctx.lineTo(18, 5); ctx.lineTo(4, 5); ctx.fill();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ the head
  drawHead(t) {
    const ctx = this.ctx, P = this.p;
    this.enterHead();

    // ear (near side) and earring
    this.drawEar();

    // face
    const chinDrop = clamp(P.open, 0, 1) * 4;
    const face = [
      this.hp(20, -54, 0.4), this.hp(38, -32, 0.7), this.hp(45, -8, 0.9), this.hp(41, 2, 0.9), this.hp(46, 14, 0.9),
      this.hp(43, 34, 0.9), this.hp(37, 52 + chinDrop * 0.5, 0.9), this.hp(31, 66 + chinDrop, 0.9), [18, 73 + chinDrop],
      [-4, 63 + chinDrop * 0.6], [-26, 40], [-32, 16], [-34, -10], [-26, -40], [-2, -56],
    ];
    this.faceShape = face;
    this.ink(face, PAL.skin, 0);
    // cel shadow on the side away from the monitor light
    this.cel(face, [[-40, -20], [-14, -14], [-6, 6], [-14, 28], [2, 52], [0, 70], [-30, 60], [-40, 20]], PAL.skinShade);
    // cast shadow under the fringe
    this.cel(face, [[-40, -60], [60, -60], [60, -30], [30, -28], [10, -22], [-10, -26], [-40, -20]], PAL.skinShade);

    // monitor rim light on the far contour
    ctx.save();
    ctx.beginPath(); trace(ctx, face, true); ctx.clip();
    ctx.strokeStyle = `rgba(160,230,255,${0.35 + P.glow * 0.4})`;
    ctx.lineWidth = 5;
    ctx.beginPath(); trace(ctx, face.slice(1, 8), false); ctx.stroke();
    ctx.restore();

    // blush: hatched strokes, the 90s way
    if (P.blush > 0.05) {
      ctx.strokeStyle = PAL.blush;
      ctx.globalAlpha = clamp(P.blush, 0, 1) * 0.8;
      ctx.lineWidth = 1.6;
      for (const [bx, by, n] of [[this.hp(-2, 26, 0.6), 0, 3], [this.hp(34, 22, 0.9), 0, 2]].map(([p, _, n]) => [p[0], p[1], n])) {
        for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.moveTo(bx + i * 5 - 4, by + 4); ctx.lineTo(bx + i * 5, by - 3); ctx.stroke(); }
      }
      ctx.globalAlpha = 1;
    }

    this.drawNose();
    this.drawMouth();
    this.drawEyes();
    this.drawBrows();

    // face outline on top so every feature sits inside the ink
    ctx.beginPath(); trace(ctx, face.slice(0, 11), false);
    ctx.strokeStyle = INK; ctx.lineWidth = 2.8; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();

    this.drawFrontHair();
    ctx.restore();
  }

  drawEar() {
    const ctx = this.ctx;
    const [ex, ey] = this.hp(-32, 6, -0.6);
    this.ink([[ex + 2, ey - 16], [ex - 8, ey - 12], [ex - 10, ey + 2], [ex - 6, ey + 14], [ex + 2, ey + 16]], PAL.skin, 2.2);
    ctx.strokeStyle = INK; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(ex - 1, ey - 9); ctx.quadraticCurveTo(ex - 6, ey, ex - 2, ey + 8); ctx.stroke();
    // gold hoop, swinging
    const a = this.earring.ang;
    const hx = ex - 2 + Math.sin(a) * 8, hy = ey + 18 + Math.cos(a) * 8;
    ctx.strokeStyle = INK; ctx.lineWidth = 4.5;
    ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = PAL.gold; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.stroke();
  }

  drawNose() {
    const ctx = this.ctx;
    const tip = this.hp(51, 26, 1.2), base = this.hp(44, 31, 1.1), bridge = this.hp(40, 4, 1);
    // skin wedge where the nose breaks the far contour
    this.ink([bridge, [tip[0] - 1, tip[1] - 4], tip, base, this.hp(38, 28, 1)], PAL.skin, 0);
    ctx.strokeStyle = INK; ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(bridge[0], bridge[1]);
    ctx.quadraticCurveTo(tip[0] - 2, tip[1] - 8, tip[0], tip[1]);
    ctx.quadraticCurveTo(tip[0] + 1, tip[1] + 4, base[0], base[1]);
    ctx.stroke();
    const n = this.hp(40, 28, 1);
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(n[0], n[1]); ctx.quadraticCurveTo(n[0] + 1, n[1] + 3, n[0] + 4, n[1] + 3); ctx.stroke();
    // shadow under the nose
    const s = this.hp(42, 33, 1);
    ctx.fillStyle = PAL.skinShade;
    ctx.beginPath(); ctx.moveTo(s[0] - 5, s[1]); ctx.lineTo(s[0] + 4, s[1] - 1); ctx.lineTo(s[0], s[1] + 3); ctx.closePath(); ctx.fill();
  }

  drawEyes() {
    const P = this.p;
    this.eye(this.hp(6, 4, 0.7), 1.12, this.blinkNear, P.gazeX);
    this.eye(this.hp(37, 2, 0.9), 0.5, this.blinkFar, P.gazeX);
  }

  // One eye in local space: sx is horizontal foreshortening (far eye ≈ 0.5).
  eye([x, y], sx, blink, gaze) {
    const ctx = this.ctx, P = this.p;
    const squint = clamp(P.squint, 0, 1);
    const droop = clamp(P.droop + Math.max(0, P.gazeY) * 0.3 - Math.max(0, -P.gazeY) * 0.1, 0, 1);
    const c = clamp(droop + (1 - droop) * blink, 0, 1);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sx, sx > 1 ? sx : 1);
    // eyeshadow between lash line and crease
    ctx.fillStyle = "rgba(122, 86, 150, 0.45)";
    ctx.beginPath(); ctx.moveTo(-16, -2); ctx.quadraticCurveTo(-6, -17, 12, -8); ctx.quadraticCurveTo(0, -9 - (1 - c) * 2, -16, -2); ctx.fill();
    // almond: outer corner at -14 (screen left), inner corner at +13
    const shape = [[-14, -1, "c"], [-6, -8], [5, -8], [13, 1, "c"], [4, 6], [-6, 5]];
    ctx.beginPath(); trace(ctx, shape, true);
    ctx.fillStyle = PAL.sclera; ctx.fill();
    ctx.save(); ctx.clip();
    // iris toward where she's looking (-1 viewer … +1 monitor)
    const ix = gaze * 5.5 / Math.max(sx, 0.6), iy = P.gazeY * 2.5;
    ctx.fillStyle = PAL.iris;
    ctx.beginPath(); ctx.ellipse(ix, iy, 5, 5.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PAL.irisDark;
    ctx.beginPath(); ctx.ellipse(ix, iy - 1.5, 5, 3, 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.ellipse(ix, iy, 2.3 * P.pupil, 2.6 * P.pupil, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.ellipse(ix - 1.6, iy - 2.2, 1.5, 1.2, 0, 0, Math.PI * 2); ctx.fill();
    // lids
    const edge = lerp(-10, 5, c);
    ctx.fillStyle = PAL.skin;
    ctx.beginPath(); ctx.moveTo(-20, -20); ctx.lineTo(20, -20); ctx.lineTo(20, edge + 3);
    ctx.quadraticCurveTo(0, edge - 5 * (1 - c) - squint * 4 * c, -20, edge + 2); ctx.closePath(); ctx.fill();
    const lo = lerp(8, 1, squint * (1 - c * 0.5));
    ctx.beginPath(); ctx.moveTo(-20, 20); ctx.lineTo(20, 20); ctx.lineTo(20, lo); ctx.quadraticCurveTo(0, lo + 3 * (1 - squint), -20, lo); ctx.closePath(); ctx.fill();
    ctx.restore();

    // upper lash line: heavy ink with a sharp outer flick
    const ly = (u) => { const q = (u + 14) / 27; const top = lerp(-8, -1, c); return (1 - q) * (1 - q) * (lerp(-1, 1, c)) + 2 * q * (1 - q) * (top - 2 - squint * 3 * c) + q * q * lerp(1, 2, c); };
    ctx.beginPath();
    ctx.moveTo(-19, ly(-14) - 5);
    for (let u = -14; u <= 13; u += 3) ctx.lineTo(u, ly(u) - 1.2);
    ctx.lineTo(13, ly(13) + 1);
    for (let u = 13; u >= -14; u -= 3) ctx.lineTo(u, ly(u) + 1.4);
    ctx.closePath();
    ctx.fillStyle = INK; ctx.fill();
    // lower lid line on the outer half
    ctx.strokeStyle = INK; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(-13, lo - 3); ctx.quadraticCurveTo(-6, lo + 2, 2, lo + 1); ctx.stroke();
    // crease
    if (c < 0.8) {
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-10, -11 - (1 - c) * 1); ctx.quadraticCurveTo(0, -14, 10, -9); ctx.stroke();
    }
    ctx.restore();
  }

  drawBrows() {
    const P = this.p, ctx = this.ctx;
    const brow = ([x, y], sx, raise) => {
      ctx.save(); ctx.translate(x, y); ctx.scale(sx, 1);
      const inY = -raise - P.tilt + P.furrow * 2.5, outY = -raise + 2 + P.tilt * 0.4, mid = -raise - 5 + P.furrow;
      const inX = 13 - P.furrow * 1.5;
      ctx.beginPath();
      ctx.moveTo(inX, inY + 2);
      ctx.quadraticCurveTo(0, mid - 3, -17, outY);
      ctx.quadraticCurveTo(-2, mid + 1, inX, inY - 1.5);
      ctx.closePath();
      ctx.fillStyle = INK; ctx.fill();
      ctx.restore();
    };
    brow(this.hp(4, -12, 0.75), 1, P.browL);
    brow(this.hp(38, -12, 0.9), 0.45, P.browR);
  }

  drawMouth() {
    const ctx = this.ctx, P = this.p;
    const [mx, my] = this.hp(30, 47, 1);
    const open = clamp(P.open, 0, 1), wide = clamp(P.wide, -1, 1);
    const press = clamp(P.press, 0, 1), bite = clamp(P.bite, 0, 1);
    const round = Math.max(0, -wide);
    const nearX = -11 - wide * 3 + round * 2, farX = 10 + wide * 1.5 - round * 2;
    const nearY = -P.smileL * 4, farY = -P.smileR * 3.5;
    const top = -1 - open * (2 + round * 2);
    const bot = 1 + open * (11 + round * 2);
    ctx.save(); ctx.translate(mx, my);
    if (open > 0.05) {
      const inner = [[nearX, nearY, "c"], [0, top - round], [farX, farY, "c"], [1, bot]];
      ctx.beginPath(); trace(ctx, inner, true);
      ctx.fillStyle = PAL.mouth; ctx.fill();
      ctx.save(); ctx.clip();
      ctx.fillStyle = PAL.teeth; ctx.fillRect(-14, top - 3, 28, clamp(open * 6, 1.5, 4.5) + 2);
      if (open > 0.35) { ctx.fillStyle = PAL.tongue; ctx.beginPath(); ctx.ellipse(1, bot, 8, open * 6, 0, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
      ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.lineJoin = "round";
      ctx.beginPath(); trace(ctx, inner, true); ctx.stroke();
    } else {
      // closed: one confident ink line, pressed lips go thinner
      ctx.strokeStyle = INK; ctx.lineWidth = 2.2 - press * 0.6; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(nearX, nearY);
      ctx.quadraticCurveTo(0, 1.5 + (P.smileL + P.smileR) * 1.8 - press, farX, farY);
      ctx.stroke();
    }
    // lips: colour on both lips on the upper lip and a lower-lip shadow stroke
    ctx.fillStyle = PAL.lip;
    ctx.beginPath(); ctx.moveTo(nearX + 1, nearY - 0.5); ctx.quadraticCurveTo(-4, top - 5, 0, top - 3); ctx.quadraticCurveTo(3, top - 5.5, farX - 1, farY - 0.5); ctx.quadraticCurveTo(0, top - 0.5, nearX + 1, nearY - 0.5); ctx.fill();
    const lb = open > 0.05 ? bot : 1.5 + (P.smileL + P.smileR) * 1.8;
    ctx.beginPath(); ctx.moveTo(nearX + 3, nearY + 0.5); ctx.quadraticCurveTo(0, lb + 6 - bite * 3, farX - 2, farY + 0.5); ctx.quadraticCurveTo(0, lb + 1, nearX + 3, nearY + 0.5); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.beginPath(); ctx.ellipse(1, lb + 3.2 - bite * 2, 3, 0.9, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = PAL.lipShade; ctx.lineWidth = 1.8 - bite;
    ctx.beginPath(); ctx.moveTo(-5, bot + 5 - bite * 3); ctx.quadraticCurveTo(0, bot + 6.5 - bite * 3, 5, bot + 4.5 - bite * 3); ctx.stroke();
    // smile lines at the corners
    if (P.smileL > 0.5) {
      ctx.strokeStyle = INK; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(nearX - 2, nearY - 3); ctx.quadraticCurveTo(nearX - 4, nearY, nearX - 2, nearY + 3); ctx.stroke();
    }
    ctx.restore();
    // chin shadow
    const [cx, cy] = this.hp(26, 60 + open * 4, 0.9);
    ctx.fillStyle = PAL.skinShade;
    ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.quadraticCurveTo(cx, cy + 4, cx + 7, cy - 1); ctx.quadraticCurveTo(cx, cy + 1.5, cx - 8, cy); ctx.fill();
  }

  drawFrontHair() {
    const ctx = this.ctx, L = this.hairLag;
    const bx = -L.x * 0.5, by = -L.y * 0.4;
    const crown = [
      [-26, -12, "c"], [-44, -38], [-62, -64], [-42, -94], [0, -104], [42, -90], [60, -62], [62, -36],
      [58 + bx, -12 + by, "c"], [48, -26], [40 + bx, -10 + by, "c"], [30, -28], [16 + bx, -18 + by, "c"],
      [4, -34], [-10, -26, "c"], [-18, -26], [-22, -16, "c"],
    ].map(([x, y, c]) => { const [px, py] = this.hp(x, y, x > 0 ? 0.5 : 0.1); return c ? [px, py, c] : [px, py]; });
    this.ink(crown, PAL.hair, 2.8);
    // shadow under the crown and at the back
    this.cel(crown, [[-70, -44], [-44, -34], [-22, -12], [-12, -30], [4, -38], [30, -32], [70, -40], [70, 0], [-70, 0]], PAL.hairShade);
    // the classic 90s highlight: a jagged band of blue with white glints
    ctx.save();
    ctx.beginPath(); trace(ctx, crown, true); ctx.clip();
    const band = [[-52, -56, "c"], [-32, -82], [6, -90], [44, -72, "c"], [34, -68], [40, -60, "c"], [18, -74], [6, -70, "c"], [-8, -76], [-20, -66, "c"], [-30, -70], [-46, -48, "c"]];
    ctx.beginPath(); trace(ctx, band.map(([x, y, c]) => { const [px, py] = this.hp(x, y, 0.3); return c ? [px, py, c] : [px, py]; }), true);
    ctx.fillStyle = PAL.hairHi; ctx.fill();
    ctx.fillStyle = PAL.hairGlint;
    for (const [gx, gy, r] of [[-24, -80, 3], [10, -86, 2], [26, -78, 1.4]]) {
      const [px, py] = this.hp(gx, gy, 0.3);
      ctx.beginPath(); ctx.moveTo(px - r * 2, py); ctx.lineTo(px, py - r); ctx.lineTo(px + r * 2, py); ctx.lineTo(px, py + r); ctx.closePath(); ctx.fill();
    }
    // strand lines
    ctx.strokeStyle = INK; ctx.lineWidth = 1.4;
    for (const [a, b, c] of [[[-36, -50], [-12, -62], [12, -48]], [[14, -60], [36, -60], [52, -40]], [[-46, -24], [-40, -44], [-26, -56]], [[20, -40], [34, -40], [44, -22]]]) {
      const [p, q, r] = [a, b, c].map(([x, y]) => this.hp(x, y, 0.3));
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.quadraticCurveTo(q[0], q[1], r[0], r[1]); ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ overlays
  drawThoughts(t) {
    if (this.state !== "thinking") return;
    const ctx = this.ctx;
    for (let i = 0; i < 3; i++) {
      const bob = this.reduced ? 0 : Math.sin(t * 4 - i * 0.8) * 3;
      ctx.beginPath();
      ctx.ellipse(232 - i * 18, 96 - i * 16 + bob, 4 + i * 2.5, 3.4 + i * 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#f6ecd9"; ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  drawStars() {
    const ctx = this.ctx;
    for (const s of this.stars) {
      const a = Math.sin((s.life / s.max) * Math.PI);
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot + s.life * 2); ctx.globalAlpha = a;
      const r = s.size;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const rr = i % 2 ? r * 0.35 : r, an = (i / 8) * Math.PI * 2;
        ctx.lineTo(Math.cos(an) * rr, Math.sin(an) * rr);
      }
      ctx.closePath();
      ctx.fillStyle = "#ffd76a"; ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}
