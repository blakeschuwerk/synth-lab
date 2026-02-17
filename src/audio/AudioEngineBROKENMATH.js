import * as Elementary from '@elemaudio/core';
import WebAudioRenderer from '@elemaudio/web-renderer';

console.log('📄 AudioEngine Module Loaded');

const el = Elementary.el || Elementary.default?.el || Elementary;
const core = new WebAudioRenderer();
const MASTER_OUT = 'master-out';

/** Wrap a number as an Elementary constant node */
const val = (v) => el.const({ value: v });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** 0–1 where applicable; specific ranges below */
const defaultParams = {
  Attack: 0.2,
  Decay: 0.3,
  Sustain: 0.7,
  Release: 0.4,
  Cutoff: 0.5,
  Res: 0.3,
  Drive: 0,
  Detune: 0.1,
  Blend: 0.5,
  Glide: 0,
  Sub: 0,
  Noise: 0,
  'Delay Time': 0.3,
  'Delay Mix': 0,
  'Reverb Size': 0.5,
  'Reverb Mix': 0,
};

let currentParams = { ...defaultParams };

/** Current voice: gate (0|1), freq (Hz), waveform, velocity (0–1) */
let voice = { gate: 0, freq: 440, waveform: 'saw', velocity: 0.8 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map 0–1 to 20–20000 Hz (log scale) */
function mapFreq(norm) {
  const min = 20;
  const max = 20000;
  return min * Math.pow(max / min, Math.max(0, Math.min(1, norm)));
}

/** Map 0–1 to 0.01–2.0 seconds */
function mapTime(norm) {
  return 0.01 + Math.max(0, Math.min(1, norm)) * (2.0 - 0.01);
}

/** Map 0–1 to Q 0.7–20 */
function mapRes(norm) {
  return 0.7 + Math.max(0, Math.min(1, norm)) * (20 - 0.7);
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/**
 * Build the synth graph: oscillators → unison → sub/noise → filter → envelope → drive → delay → reverb → stereo out.
 * Uses currentParams and voice (freq, gate, waveform, velocity).
 * 
 * SANITY CHECK MODE: Simplified to raw sine wave output for debugging.
 */
function buildGraph() {
  const freq = voice.freq;
  const gate = voice.gate;
  const waveform = voice.waveform;
  const velocity = voice.velocity;
  const p = currentParams;
  
  console.log('🎛️ buildGraph called', { freq, gate, waveform, velocity });

  // ===== SANITY CHECK: Raw Sine Wave =====
  // Initialize mix channels to zero
  let mixLeft = val(0);
  let mixRight = val(0);
  
  // Create raw sine wave oscillator at voice.freq, low volume (0.1)
  const osc = el.mul(el.cycle(val(freq)), val(0.1));
  
  // Gate the oscillator: multiply by gate (0 or 1) so it only plays when gate is on
  const gatedOsc = el.mul(osc, val(gate));
  
  // Add to mix channels
  mixLeft = el.add(mixLeft, gatedOsc);
  mixRight = el.add(mixRight, gatedOsc);
  
  // Return left channel (render function duplicates to right channel)
  console.log('🎛️ buildGraph returning node:', typeof mixLeft, mixLeft);
  return mixLeft;

  // ===== COMMENTED OUT: Complex DSP Logic =====
  /*
  const freqNode = val(freq);
  const gateNode = val(gate);

  // ----- Oscillators (main + unison) -----
  const getOsc = (f) => {
    switch (waveform) {
      case 'sine':
        return el.cycle(f);
      case 'square':
        return el.blepsquare(f);
      case 'triangle':
        return el.bleptriangle(f);
      case 'saw':
      default:
        return el.blepsaw(f);
    }
  };

  const mainOsc = getOsc(freqNode);
  const detuneCents = p.Detune * 100; // e.g. 0.1 -> 10 cents
  const detuneRatio = Math.pow(2, detuneCents / 1200);
  const unisonOsc = getOsc(val(freq * detuneRatio));
  const blendedOsc = el.add(
    el.mul(val(1 - p.Blend), mainOsc),
    el.mul(val(p.Blend), unisonOsc)
  );

  // ----- Sub + Noise -----
  const subOsc = el.mul(val(p.Sub), el.cycle(val(freq / 2)));
  const noiseSig = el.mul(val(p.Noise), el.noise());
  let raw = el.add(blendedOsc, el.add(subOsc, noiseSig));

  // ----- Envelope (for amplitude and filter modulation) -----
  const attackSec = mapTime(p.Attack);
  const decaySec = mapTime(p.Decay);
  const sustainLevel = Math.max(0, Math.min(1, p.Sustain));
  const releaseSec = mapTime(p.Release);
  const env = el.adsr(
    val(attackSec),
    val(decaySec),
    val(sustainLevel),
    val(releaseSec),
    gateNode
  );

  // ----- Filter: lowpass with envelope modulation on cutoff -----
  const cutoffBase = mapFreq(p.Cutoff);
  const envModAmount = 0.6 * cutoffBase;
  const cutoffNode = el.min(
    val(20000),
    el.add(val(cutoffBase), el.mul(val(envModAmount), env))
  );
  const qNode = val(mapRes(p.Res));
  raw = el.lowpass(cutoffNode, qNode, raw);

  // ----- Amplitude (envelope * velocity) -----
  let out = el.mul(env, el.mul(val(velocity * 0.5), raw));

  // ----- FX: Drive -----
  const driveAmount = 1 + p.Drive * 15;
  out = el.tanh(el.mul(val(driveAmount), out));

  // ----- FX: Delay -----
  const delayTimeSec = mapTime(p['Delay Time']);
  const delayTimeMs = delayTimeSec * 1000;
  const delayFeedback = 0.4;
  const delayWet = Math.max(0, Math.min(1, p['Delay Mix']));
  const delayed = el.delay(
    { size: 44100 * 2 },
    el.ms2samps(val(delayTimeMs)),
    val(delayFeedback),
    out
  );
  out = el.add(el.mul(val(1 - delayWet), out), el.mul(val(delayWet), delayed));

  // ----- FX: Reverb (simple feedback delay + lowpass as reverb tail) -----
  const reverbSize = p['Reverb Size'];
  const reverbTimeSec = 0.03 + reverbSize * 0.5;
  const reverbFb = 0.7 + reverbSize * 0.25;
  const reverbWet = Math.max(0, Math.min(1, p['Reverb Mix']));
  const reverbDel = el.delay(
    { size: 44100 * 2 },
    el.ms2samps(val(reverbTimeSec * 1000)),
    val(reverbFb),
    out
  );
  const reverbFiltered = el.lowpass(val(4000), val(0.7), reverbDel);
  out = el.add(el.mul(val(1 - reverbWet), out), el.mul(val(reverbWet), reverbFiltered));

  return out;
  */
}

/** Render current graph to master out (stereo). */
function render() {
  console.log('🎛️ Render Cycle started');
  const ctx = window.globalAudioContext;
  if (!ctx) {
    console.error('🎛️ Render Cycle: No AudioContext!');
    return;
  }
  console.log('🎛️ Render Cycle: AudioContext state:', ctx.state);
  const out = buildGraph();
  console.log('🎛️ Render Cycle: Graph built, node type:', typeof out, 'has key:', out?.key);
  try {
    console.log('🎛️ Render Cycle: Calling core.render with key:', MASTER_OUT);
    const result = core.render(MASTER_OUT, out, out);
    console.log('🎛️ Render Cycle: core.render returned:', typeof result, result);
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.error('🔥 Engine: Render Failed (Promise rejection)', err));
    }
  } catch (err) {
    console.error('🔥 Engine: Render Failed (Exception)', err);
  }
  console.log('🎛️ Render Cycle completed');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function initAudio() {
  console.log('🔊 Engine: initAudio started');
  console.log('🔌 Init called. Context:', window.globalAudioContext?.state || 'Not Created');
  if (window.globalAudioContext) {
    console.log('🔌 Init: Reusing existing context, state:', window.globalAudioContext.state);
    if (window.globalAudioContext.state === 'suspended') {
      console.log('🔌 Init: Resuming suspended context');
      await window.globalAudioContext.resume();
      console.log('🔌 Init: Context resumed, new state:', window.globalAudioContext.state);
    }
    console.log('🔌 Init: Returning existing core instance');
    return core;
  }
  console.log('🔌 Init: Creating new AudioContext');
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  console.log('🔊 Engine: AudioContext State:', ctx.state);
  console.log('🔌 Init called. Context:', ctx.state);
  window.globalAudioContext = ctx;
  console.log('🔌 Init: Initializing Elementary renderer');
  const node = await core.initialize(ctx, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  console.log('🔌 Init: Renderer initialized, connecting to destination');
  node.connect(ctx.destination);
  console.log('🔌 Init: Connected to destination, context state:', ctx.state);
  return core;
}

/** Map camelCase (UI) keys to engine internal keys (only keys present in defaultParams are used) */
const CAMEL_TO_ENGINE = {
  attack: 'Attack',
  decay: 'Decay',
  sustain: 'Sustain',
  release: 'Release',
  cutoff: 'Cutoff',
  res: 'Res',
  drive: 'Drive',
  detune: 'Detune',
  blend: 'Blend',
  glide: 'Glide',
  sub: 'Sub',
  noise: 'Noise',
  delayTime: 'Delay Time',
  delayMix: 'Delay Mix',
  reverbSize: 'Reverb Size',
  reverbMix: 'Reverb Mix',
};

/**
 * Update synth parameters (0–1 where applicable), merge with current, then re-render.
 * Accepts camelCase keys from UI (e.g. delayTime, reverbSize).
 * @param {Partial<Record<string, number>>} params
 */
export function updateSynthParams(params) {
  console.log('🎚️ updateSynthParams called with:', params);
  if (!params || typeof params !== 'object') {
    console.warn('🎚️ updateSynthParams: Invalid params, skipping');
    return;
  }
  const normalized = {};
  for (const [k, v] of Object.entries(params)) {
    const engineKey = CAMEL_TO_ENGINE[k] ?? k;
    if (Object.prototype.hasOwnProperty.call(defaultParams, engineKey)) {
      normalized[engineKey] = v;
    }
  }
  console.log('🎚️ updateSynthParams: Normalized params:', normalized);
  Object.assign(currentParams, normalized);
  console.log('🎚️ updateSynthParams: Current params updated, calling render');
  render();
}

/**
 * Trigger a voice: set freq, waveform, velocity, gate=1 and re-render.
 * @param {number} freq - Frequency in Hz
 * @param {string} waveform - 'sine' | 'saw' | 'square' | 'triangle'
 * @param {number} velocity - 0–1
 */
export function playTone(freq = 440, waveform = 'saw', velocity = 0.8) {
  console.log('🔊 Engine: playTone received', { freq });
  console.log('🎹 Note Triggered:', freq, 'waveform:', waveform, 'velocity:', velocity);
  const ctx = window.globalAudioContext;
  if (!ctx) {
    console.error('🎹 Note Triggered: No AudioContext available!');
    return;
  }
  console.log('🎹 Note Triggered: AudioContext state:', ctx.state);
  if (ctx.state === 'suspended') {
    console.log('🎹 Note Triggered: Resuming suspended context');
    ctx.resume();
  }

  voice = { gate: 1, freq, waveform, velocity };
  console.log('🎹 Note Triggered: Voice set, calling render. Voice:', voice);
  render();
}

/**
 * Stop the current voice: set gate=0 and re-render (silence).
 * @param {number} [freq] - Optional; ignored in single-voice implementation.
 */
export function stopTone(freq) {
  console.log('🎹 Note Stopped:', freq || 'all');
  const ctx = window.globalAudioContext;
  if (!ctx) {
    console.error('🎹 Note Stopped: No AudioContext available!');
    return;
  }
  voice = { ...voice, gate: 0 };
  console.log('🎹 Note Stopped: Voice updated, calling render. Voice:', voice);
  render();
}
