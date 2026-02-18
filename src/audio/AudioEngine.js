import * as Elementary from '@elemaudio/core';
import WebAudioRenderer from '@elemaudio/web-renderer';

const core = new WebAudioRenderer();

let mixerNode;
let isPolyphonic = false;
let globalSustainMode = false;
let currentCutoffNorm = 1.0; // 0–1, maps to 20Hz–20kHz
const activeVoices = new Map(); // frequency -> SynthVoice

function cutoffToHz(norm) {
  return 20 * Math.pow(1000, norm);
}

/** One voice: Oscillator -> Gain -> BiquadFilter -> destination (mixer). */
class SynthVoice {
  constructor(ctx, frequency, destination, waveform = 'saw', velocity = 0.5) {
    this.ctx = ctx;
    this.frequency = frequency;
    this.osc = ctx.createOscillator();
    this.gainNode = ctx.createGain();
    this.filterNode = ctx.createBiquadFilter();
    this.filterNode.type = 'lowpass';
    this.filterNode.frequency.value = cutoffToHz(currentCutoffNorm);

    const type = waveform === 'saw' ? 'sawtooth' : waveform;
    this.osc.type = type;
    this.osc.frequency.value = frequency;
    this.gainNode.gain.value = velocity * 0.5;

    this.osc.connect(this.gainNode);
    this.gainNode.connect(this.filterNode);
    this.filterNode.connect(destination);
  }

  start() {
    this.osc.start(0);
  }

  stop() {
    try {
      this.osc.stop(this.ctx.currentTime);
    } catch (_) {}
    this.osc.disconnect();
    this.gainNode.disconnect();
    this.filterNode.disconnect();
  }

  setCutoffHz(hz) {
    this.filterNode.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01);
  }
}

export function stopAll() {
  activeVoices.forEach((v) => v.stop());
  activeVoices.clear();
}

export function setPolyphony(poly) {
  isPolyphonic = !!poly;
  stopAll();
}

export function setSustainMode(sustain) {
  globalSustainMode = !!sustain;
}

export async function initAudio() {
  if (window.globalAudioContext) {
    if (window.globalAudioContext.state === 'suspended') {
      await window.globalAudioContext.resume();
    }
    return { core, analyser: window.globalAnalyser };
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  window.globalAudioContext = ctx;
  await core.initialize(ctx, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });

  mixerNode = ctx.createGain();

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  mixerNode.connect(analyser);
  analyser.connect(ctx.destination);

  window.globalAnalyser = analyser;
  return { core, analyser };
}

/** Call from UI when keys are pressed but visualizer is stuck (e.g. after refresh). */
export function resumeAudioContext() {
  const ctx = window.globalAudioContext;
  if (ctx?.state === 'suspended') ctx.resume();
}

export function playTone(freq = 440, waveform = 'sine', velocity = 0.8) {
  const ctx = window.globalAudioContext;
  if (!ctx || !mixerNode) return;
  if (ctx.state === 'suspended') ctx.resume();

  if (!isPolyphonic) stopAll();
  // Safety: never duplicate a voice for the same frequency — kill existing first
  if (activeVoices.has(freq)) {
    const existing = activeVoices.get(freq);
    existing.stop();
    activeVoices.delete(freq);
  }

  const voice = new SynthVoice(ctx, freq, mixerNode, waveform, velocity);
  voice.start();
  activeVoices.set(freq, voice);
}

/** Latch: only when globalSustainMode is true do we keep the note. If Sustain is OFF, note must die. */
export function stopTone(frequency) {
  if (!globalSustainMode) {
    const voice = frequency !== undefined ? activeVoices.get(frequency) : undefined;
    if (voice) {
      voice.stop();
      activeVoices.delete(frequency);
    }
  }
}

export function updateSynthParams(params) {
  if (params.cutoff !== undefined) {
    currentCutoffNorm = params.cutoff;
    const hz = cutoffToHz(currentCutoffNorm);
    activeVoices.forEach((v) => v.setCutoffHz(hz));
  }
}

export const setFilterCutoff = (value) => {
  currentCutoffNorm = value;
  const hz = cutoffToHz(value);
  if (window.globalAudioContext) {
    activeVoices.forEach((v) => v.setCutoffHz(hz));
  }
};

/** For UI: which frequencies are currently sounding (so keys can 'breathe'). */
export function getVisualState() {
  const active = Array.from(activeVoices.keys());
  return { active, held: active };
}

/** Diagnostic: filter status (first voice or summary). */
export function getFilterDiagnostics() {
  const first = activeVoices.values().next().value;
  if (first && first.filterNode) {
    const freq = Math.round(first.filterNode.frequency.value);
    return `FILTER: lowpass | ${freq}Hz (${activeVoices.size} voices)`;
  }
  return activeVoices.size ? 'FILTER: (voices)' : 'FILTER: NOT CREATED';
}
