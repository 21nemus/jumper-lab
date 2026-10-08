// The music player: src/audio/score.ts synthesized live with the Web Audio API (oscillators and noise; no
// samples, no files). Built to be kind to ears: it never starts by itself, fades in over three seconds to 75 %
// of a deliberately quiet master level, and runs through a limiter so nothing can spike. The ♪ button mutes it,
// remembered on this device. It also keeps the song's beat clock, which the crab rave dances to.

import { BPM, DEFAULT_VOLUME, FADE_IN, hitsAt, STEP_SEC, STEPS_PER_BAR, type Hit, type Section } from './score.ts';

/** Master gain at volume 1, before the limiter (set from a loudness measurement of the busiest section). */
export const LEVEL = 0.6;
const LOOKAHEAD = 0.15; // seconds of audio scheduled ahead of the playhead
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** A plan: [beats after the start bar, what happens there]. */
export type Cue = [number, Section | 'stop'];

interface Graph {
  c: BaseAudioContext;
  bus: GainNode; // everything mixes here
  duck: GainNode; // the sidechain: melodic parts dip under each kick
  verb: GainNode; // reverb send
  echo: GainNode; // delay send
  muffle: BiquadFilterNode;
  master: GainNode;
  noise: AudioBuffer;
}

function buildGraph(c: BaseAudioContext): Graph {
  const master = c.createGain();
  master.gain.value = 0;
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 4;
  limiter.ratio.value = 16;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.2;
  const muffle = c.createBiquadFilter();
  muffle.type = 'lowpass';
  muffle.frequency.value = 18000;
  muffle.Q.value = 0.7;
  const bus = c.createGain();
  const duck = c.createGain();
  duck.connect(bus);
  // a little air on top and less mud below, so it reads on laptop and phone speakers too
  const air = c.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 4500;
  air.gain.value = 5;
  const lows = c.createBiquadFilter();
  lows.type = 'lowshelf';
  lows.frequency.value = 110;
  lows.gain.value = -3;
  const presence = c.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 2800;
  presence.Q.value = 0.9;
  presence.gain.value = 3;
  bus.connect(lows).connect(presence).connect(air).connect(muffle).connect(master).connect(limiter).connect(c.destination);

  // a small room: stereo noise with an exponential tail
  const len = Math.floor(c.sampleRate * 1.6);
  const ir = c.createBuffer(2, len, c.sampleRate);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = rand() * Math.pow(1 - i / len, 3);
  }
  const convolver = c.createConvolver();
  convolver.buffer = ir;
  const verb = c.createGain();
  verb.gain.value = 0.8;
  verb.connect(convolver).connect(bus);

  // a dotted-eighth echo, darkened on every repeat
  const delay = c.createDelay(1);
  delay.delayTime.value = STEP_SEC * 3;
  const fb = c.createGain();
  fb.gain.value = 0.3;
  const tone = c.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 2600;
  const echo = c.createGain();
  echo.connect(delay).connect(tone).connect(fb).connect(delay);
  tone.connect(bus);

  const noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = rand();
  return { c, bus, duck, verb, echo, muffle, master, noise };
}

// ── voices ──────────────────────────────────────────────────────────────────────────────────────────
function env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
  peak = Math.max(peak, 0.0002); // exponential ramps can't reach zero
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}
function noiseSource(G: Graph, t: number, dur: number): AudioBufferSourceNode {
  const s = G.c.createBufferSource();
  s.buffer = G.noise;
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur);
  return s;
}

function play(G: Graph, h: Hit, t: number): void {
  const c = G.c;
  switch (h.v) {
    case 'kick': {
      const o = c.createOscillator();
      const g = c.createGain();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
      env(g, t, 0.75 * h.vel, 0.004, 0.36);
      o.connect(g).connect(G.bus);
      o.start(t);
      o.stop(t + 0.45);
      // everything melodic ducks under the kick and swells back: the pump
      G.duck.gain.cancelScheduledValues(t);
      G.duck.gain.setValueAtTime(0.45, t);
      G.duck.gain.linearRampToValueAtTime(1, t + 0.22);
      break;
    }
    case 'clap': {
      const s = noiseSource(G, t, 0.25);
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1400;
      f.Q.value = 0.8;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      for (const k of [0, 0.011, 0.022]) {
        g.gain.setValueAtTime(0.32 * h.vel, t + k);
        g.gain.exponentialRampToValueAtTime(0.02, t + k + 0.009);
      }
      g.gain.setValueAtTime(0.25 * h.vel, t + 0.031);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      s.connect(f).connect(g);
      const crisp = c.createBiquadFilter();
      crisp.type = 'highpass';
      crisp.frequency.value = 3200;
      const cg = c.createGain();
      cg.gain.value = 0.55;
      s.connect(crisp).connect(cg).connect(g);
      g.connect(G.bus);
      g.connect(G.verb);
      break;
    }
    case 'hat': {
      const dur = h.open ? 0.15 : 0.035;
      const s = noiseSource(G, t, dur + 0.02);
      const f = c.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7200;
      const g = c.createGain();
      env(g, t, (h.open ? 0.13 : 0.2) * h.vel, 0.002, dur);
      s.connect(f).connect(g).connect(G.bus);
      break;
    }
    case 'bass': {
      const len = h.steps * STEP_SEC * 0.9;
      const g = c.createGain();
      env(g, t, 0.21, 0.005, len);
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 3;
      f.frequency.setValueAtTime(950, t);
      f.frequency.exponentialRampToValueAtTime(280, t + 0.12);
      for (const [type, gain] of [['sawtooth', 1], ['sine', 0.5]] as [OscillatorType, number][]) {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = hz(h.note);
        const og = c.createGain();
        og.gain.value = gain;
        o.connect(og).connect(f);
        o.start(t);
        o.stop(t + len + 0.05);
      }
      f.connect(g).connect(G.duck);
      break;
    }
    case 'lead': {
      const len = Math.max(0.12, h.steps * STEP_SEC);
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 2;
      f.frequency.setValueAtTime(6500, t);
      f.frequency.exponentialRampToValueAtTime(2400, t + 0.18);
      const g = c.createGain();
      env(g, t, 0.11, 0.004, len + 0.12);
      for (const [type, detune] of [['square', -6], ['sawtooth', 9]] as [OscillatorType, number][]) {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = hz(h.note);
        o.detune.value = detune;
        o.connect(f);
        o.start(t);
        o.stop(t + len + 0.2);
      }
      f.connect(g);
      g.connect(G.duck);
      g.connect(G.echo);
      g.connect(G.verb);
      break;
    }
    case 'stab': {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(4200, t);
      f.frequency.exponentialRampToValueAtTime(1600, t + 0.12);
      const g = c.createGain();
      env(g, t, 0.05, 0.003, 0.17);
      for (const n of h.notes) {
        for (const detune of [-10, 10]) {
          const o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = hz(n);
          o.detune.value = detune;
          o.connect(f);
          o.start(t);
          o.stop(t + 0.25);
        }
      }
      f.connect(g);
      g.connect(G.duck);
      g.connect(G.verb);
      break;
    }
    case 'pad': {
      const len = h.steps * STEP_SEC;
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 950;
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.03, t + 0.6);
      g.gain.setValueAtTime(0.03, t + len - 0.1);
      g.gain.linearRampToValueAtTime(0, t + len + 0.7);
      for (const n of h.notes) {
        for (const detune of [-12, 12]) {
          const o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = hz(n);
          o.detune.value = detune;
          o.connect(f);
          o.start(t);
          o.stop(t + len + 0.8);
        }
      }
      f.connect(g);
      g.connect(G.duck);
      g.connect(G.verb);
      break;
    }
    case 'arp': {
      if (h.vel <= 0.01) break;
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = hz(h.note);
      const g = c.createGain();
      env(g, t, 0.06 * h.vel, 0.003, 0.2);
      o.connect(g);
      g.connect(G.duck);
      g.connect(G.echo);
      o.start(t);
      o.stop(t + 0.25);
      break;
    }
    case 'riser': {
      const dur = h.steps * STEP_SEC;
      const s = noiseSource(G, t, dur);
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 2;
      f.frequency.setValueAtTime(300, t);
      f.frequency.exponentialRampToValueAtTime(6000, t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.07, t + dur);
      s.connect(f).connect(g);
      g.connect(G.bus);
      g.connect(G.verb);
      break;
    }
  }
}

/** The song state machine, shared by live playback and offline rendering: which section plays at a step. */
class Song {
  section: Section;
  sectionStart = 0; // step the section began on
  cues: [number, Section | 'stop'][] = []; // [absolute step, change], sorted
  stopped = false;
  constructor(first: Section) {
    this.section = first;
  }
  /** Apply any change due at `step` (only on bar lines), then list what sounds there. */
  at(step: number): Hit[] {
    while (this.cues.length && this.cues[0][0] <= step) {
      const [, what] = this.cues.shift()!;
      if (what === 'stop') this.stopped = true;
      else {
        this.section = what;
        this.sectionStart = step;
      }
    }
    if (this.stopped) return [];
    const rel = step - this.sectionStart;
    return hitsAt(this.section, Math.floor(rel / STEPS_PER_BAR), rel % STEPS_PER_BAR);
  }
  add(startStep: number, plan: Cue[]): void {
    for (const [beats, what] of plan) this.cues.push([startStep + Math.round(beats * 4), what]);
    this.cues.sort((a, b) => a[0] - b[0]);
  }
}

export class Music {
  volume = DEFAULT_VOLUME;
  muted = false;
  private ctx: AudioContext | null = null;
  private G: Graph | null = null;
  private song: Song | null = null;
  private timer = 0;
  private t0 = 0; // audio time of step 0
  private clock0 = 0; // performance.now() of step 0, when audio can't run (blocked, unsupported)
  private silent = false;
  private next = 0; // next step to schedule
  private muffled = false;
  private stopping = false;
  /** Fires when a song ends (a 'stop' cue played out, or stop() finished). */
  onEnd: () => void = () => {};
  /** The wall clock the silent fallback keeps time with (dev tools step it frame by frame). */
  now: () => number = () => performance.now();
  /** Dev and tests: keep time without making any sound at all. */
  silentOnly = false;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx || !this.song || this.silent) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  get playing(): boolean {
    return !!this.song;
  }

  /** Song position in beats (what is audible now), or null when nothing plays. */
  beat(): number | null {
    if (!this.song) return null;
    if (this.silent || !this.ctx) return ((this.now() - this.clock0) / 1000) / (60 / BPM);
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return Math.max(0, (this.ctx.currentTime - lat - this.t0) / (60 / BPM));
  }

  /**
   * Start a plan, or splice it into the playing song at the next bar line. Call it from a click or key press
   * (browsers only allow sound after one). Returns the song beat at which the plan's beat 0 falls.
   */
  play(plan: Cue[]): number {
    if (this.stopping) this.end(); // a song fading out is finished; start over
    if (!this.song) {
      this.start(plan[0][1] === 'stop' ? 'intro' : plan[0][1]);
      this.song!.add(0, plan.slice(1));
      return 0;
    }
    this.tick(); // catch up first (timers may have been throttled), so the bar line chosen is still ahead
    const bar = Math.ceil(this.next / STEPS_PER_BAR) * STEPS_PER_BAR;
    this.song.cues = this.song.cues.filter(([s]) => s < bar); // the new plan replaces what was queued after it
    this.song.add(bar, plan);
    return bar / 4;
  }

  /** Fade out over `fade` seconds and stop. */
  stop(fade = 2): void {
    if (!this.song || this.stopping) return;
    this.stopping = true;
    const song = this.song;
    if (this.G && this.ctx && !this.silent) {
      const g = this.G.master.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + fade);
    }
    window.setTimeout(() => {
      if (this.song !== song) return; // a new song started meanwhile
      this.end();
    }, fade * 1000 + 50);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.level(0.2);
  }
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.level(0.1);
  }
  /** Muffled (as if behind a door) while the game is frozen; open again on resume. */
  muffle(on: boolean): void {
    if (on === this.muffled) return;
    this.muffled = on;
    if (!this.G || !this.ctx) return;
    const f = this.G.muffle.frequency;
    const now = this.ctx.currentTime;
    f.cancelScheduledValues(now);
    f.setValueAtTime(f.value, now);
    f.exponentialRampToValueAtTime(on ? 650 : 18000, now + (on ? 0.25 : 0.4));
    this.level(0.25);
  }

  private target(): number {
    return this.muted ? 0 : LEVEL * this.volume * (this.muffled ? 0.65 : 1);
  }
  private level(ramp: number): void {
    if (!this.G || !this.ctx || !this.song || this.silent) return;
    const g = this.G.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(this.target(), now + ramp);
  }

  private start(first: Section): void {
    this.song = new Song(first);
    this.stopping = false;
    this.next = 0;
    this.clock0 = this.now();
    if (!this.silentOnly) {
      try {
        this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
        if (this.ctx.state !== 'running') void this.ctx.resume();
        this.G ??= buildGraph(this.ctx);
      } catch {
        this.ctx = null;
      }
    }
    // without a running audio clock (blocked before any click, or no Web Audio), keep time silently
    this.silent = this.silentOnly || !this.ctx || this.ctx.state !== 'running';
    if (!this.silent) {
      const now = this.ctx!.currentTime;
      this.t0 = now + 0.06;
      const g = this.G!.master.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, now);
      g.linearRampToValueAtTime(this.target(), now + FADE_IN); // never starts loud
      this.G!.muffle.frequency.setValueAtTime(this.muffled ? 650 : 18000, now);
    }
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 25);
    this.tick();
  }

  private tick(): void {
    const song = this.song;
    if (!song) return;
    if (this.silent || !this.ctx || !this.G) {
      // keep the plan moving on the wall clock (no sound)
      const step = Math.floor(((this.now() - this.clock0) / 1000) / STEP_SEC);
      while (this.next <= step) song.at(this.next++);
    } else {
      if (this.ctx.state !== 'running') return; // suspended (tab hidden): the clock waits too
      const until = this.ctx.currentTime + LOOKAHEAD;
      while (this.t0 + this.next * STEP_SEC < until) {
        const t = this.t0 + this.next * STEP_SEC;
        const hits = song.at(this.next);
        if (!this.muted) for (const h of hits) play(this.G, h, t);
        this.next++;
        if (song.stopped) break;
      }
    }
    if (song.stopped) this.stop(1.5);
  }

  private end(): void {
    window.clearInterval(this.timer);
    this.song = null;
    this.stopping = false;
    this.onEnd();
  }
}

/** Render a plan offline (for measuring loudness in a browser): returns the mixed stereo buffer. */
export async function renderOffline(plan: Cue[], seconds: number, volume = DEFAULT_VOLUME): Promise<AudioBuffer> {
  const rate = 44100;
  const c = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  const G = buildGraph(c);
  G.master.gain.value = LEVEL * volume;
  const song = new Song(plan[0][1] as Section);
  song.add(0, plan.slice(1));
  for (let step = 0; step * STEP_SEC < seconds - 0.5; step++) for (const h of song.at(step)) play(G, h, 0.05 + step * STEP_SEC);
  return c.startRendering();
}
