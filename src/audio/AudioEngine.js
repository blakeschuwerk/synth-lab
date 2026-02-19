import * as Elementary from '@elemaudio/core';
import WebAudioRenderer from '@elemaudio/web-renderer';

const core = new WebAudioRenderer();

let mixerNode;
let isPolyphonic = false;
let globalSustainMode = false;
let currentCutoffNorm = 1.0; // 0–1, maps to 20Hz–20kHz
const activeVoices = new Map(); // frequency -> SynthVoice

// Sequencer FX Bus
let seqFxInput;
let seqFxOutput;
let seqLimiter;
let activeSeqFxNodes = [];
let currentSeqSlots = [];

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
    // Ensure sequencer FX bus is initialized even if context already exists
    const ctx = window.globalAudioContext;
    if (!seqFxInput || !seqFxOutput) {
      seqFxInput = ctx.createGain();
      seqFxOutput = ctx.createGain();
      seqFxInput.connect(seqFxOutput); // Default bypass until updateSeqEffectsChain runs
      
      // Add Master Limiter to prevent clipping
      seqLimiter = ctx.createDynamicsCompressor();
      seqLimiter.threshold.value = -3.0;
      seqLimiter.ratio.value = 20.0; // Hard limit
      seqLimiter.attack.value = 0.005;
      seqLimiter.release.value = 0.050;
      
      seqFxOutput.connect(seqLimiter);
      // Connect to mixerNode if it exists, otherwise to destination
      if (mixerNode) {
        seqLimiter.connect(mixerNode);
      } else {
        seqLimiter.connect(ctx.destination);
      }
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

  // Initialize Sequencer FX Bus
  seqFxInput = ctx.createGain();
  seqFxOutput = ctx.createGain();
  seqFxInput.connect(seqFxOutput); // Default bypass until updateSeqEffectsChain runs
  
  // Add Master Limiter to prevent clipping
  seqLimiter = ctx.createDynamicsCompressor();
  seqLimiter.threshold.value = -3.0;
  seqLimiter.ratio.value = 20.0; // Hard limit
  seqLimiter.attack.value = 0.005;
  seqLimiter.release.value = 0.050;
  
  seqFxOutput.connect(seqLimiter);
  seqLimiter.connect(mixerNode); // Route sequencer FX output through limiter to main mixer

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

/**
 * Trigger a sequencer step with ADSR envelope and Legato support.
 * @param {string} noteName - Note name like 'C4', 'C#3', 'D5', etc.
 * @param {number} time - Audio context time to start (audioContext.currentTime)
 * @param {object} params - Parameters: { wave, cutoff, res, attack, decay, sustain, release }
 * @param {boolean} isTiedFromPrev - If true, skip attack/decay (legato continue)
 * @param {boolean} isTiedToNext - If true, hold gate open (legato hold)
 * @param {number} stepDuration - Duration of one step in seconds (for BPM scaling)
 */
export function triggerSequencerStep(noteName, time, params = {}, isTiedFromPrev = false, isTiedToNext = false, stepDuration = 0.25) {
  const ctx = window.globalAudioContext;
  if (!ctx || !mixerNode) return;

  // Helper: Convert note string (e.g., 'C4', 'C#3') to frequency in Hz
  const noteToFrequency = (noteStr) => {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = parseInt(noteStr.slice(-1), 10);
    const noteName = noteStr.slice(0, -1);
    const noteIndex = noteNames.indexOf(noteName);
    if (isNaN(octave) || noteIndex === -1) return 440; // fallback to A4
    const midiNote = (octave + 1) * 12 + noteIndex;
    return 440 * Math.pow(2, (midiNote - 69) / 12);
  };

  const frequency = noteToFrequency(noteName);
  const {
    wave = 'sawtooth',
    cutoff = 1.0, // normalized 0-1
    res = 0.0, // Q value
    attack = 1, // UI value 0-100 (will be scaled to seconds)
    decay = 30, // UI value 0-100 (will be scaled to seconds)
    sustain = 70, // UI value 0-100 (will be scaled to 0.0-1.0)
    release = 20, // UI value 0-100 (will be scaled to seconds)
  } = params;

  // Shared Source of Truth: proportional ADSR math
  const MIN_TIME = 0.005;
  const gateLength = isTiedToNext ? stepDuration : stepDuration * 0.8; // Standard 80% gate

  // Attack takes a percentage of the total gate
  const attackRatio = attack / 100;
  const aTime = Math.max(MIN_TIME, attackRatio * gateLength);

  // Decay takes a percentage of the REMAINING gate time
  const remainingGate = gateLength - aTime;
  const decayRatio = decay / 100;
  const dTime = Math.max(MIN_TIME, decayRatio * remainingGate);

  const sLevel = sustain / 100;
  const rTime = Math.max(MIN_TIME, (release / 100) * stepDuration);

  // Create nodes: osc -> filter -> env -> destination
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const env = ctx.createGain();

  // Configure oscillator
  osc.type = wave === 'saw' ? 'sawtooth' : wave === 'square' ? 'square' : wave;
  osc.frequency.value = frequency;

  // Configure filter
  filter.type = 'lowpass';
  filter.frequency.value = cutoffToHz(cutoff);
  filter.Q.value = res;

  // Connect: osc -> filter -> env -> seqFxInput (sequencer FX bus)
  osc.connect(filter);
  filter.connect(env);
  env.connect(seqFxInput || mixerNode); // Fallback to mixerNode if bus not initialized

  // 3. Attack / Legato Continue Phase
  if (isTiedFromPrev) {
    // Legato: Skip Attack/Decay. Start instantly at Sustain level.
    env.gain.setValueAtTime(1.0 * sLevel, time);
  } else {
    // Standard Envelope Scheduling
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(1.0, time + aTime);
    env.gain.linearRampToValueAtTime(1.0 * sLevel, time + aTime + dTime);
  }

  // 4. Release / Legato Hold Phase
  if (isTiedToNext) {
    // Legato: Do not release. Hold volume at sustain level to connect to the next note.
    env.gain.setValueAtTime(1.0 * sLevel, time + gateLength);
    osc.start(time);
    osc.stop(time + stepDuration + 0.01);
  } else {
    // Hold sustain until gate closes, then release
    env.gain.setValueAtTime(1.0 * sLevel, time + gateLength);
    env.gain.linearRampToValueAtTime(0, time + gateLength + rTime);
    osc.start(time);
    osc.stop(time + gateLength + rTime + 0.1);
  }

  // Cleanup after note ends
  osc.onended = () => {
    try {
      osc.disconnect();
      filter.disconnect();
      env.disconnect();
    } catch (_) {}
  };
}

/**
 * Update the sequencer effects chain dynamically based on slots and values.
 * @param {Array<string|null>} slots - Array of effect names (e.g., ['Cutoff', null, null, null])
 * @param {Array<number>} values - Array of knob values (0-1) corresponding to each slot
 */
export function updateSeqEffectsChain(slots, values) {
  const ctx = window.globalAudioContext;
  if (!ctx || !seqFxInput || !seqFxOutput) return;

  // Check if the slots changed (need to rebuild chain)
  const slotsChanged = JSON.stringify(slots) !== JSON.stringify(currentSeqSlots);

  // IF slots changed: rebuild the entire chain
  if (slotsChanged) {
    // Disconnect input from current chain
    seqFxInput.disconnect();

    // Cleanup old FX nodes
    activeSeqFxNodes.forEach(node => {
      try {
        node.disconnect();
      } catch (_) {}
    });
    activeSeqFxNodes = [];

    // Build the FX chain
    let currentNode = seqFxInput;

    // Loop through slots (0 to 3)
    for (let i = 0; i < slots.length; i++) {
      const effectName = slots[i];

      if (effectName === 'Cutoff') {
        // Create a lowpass filter
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        
        // Set Q/resonance (optional, could be controlled by another effect)
        filter.Q.value = 1.0;

        // Connect current node to this filter
        currentNode.connect(filter);
        
        // Add to cleanup array
        activeSeqFxNodes.push(filter);
        
        // Move down the chain
        currentNode = filter;
      }
      // Future effects can be added here:
      // else if (effectName === 'Resonance') { ... }
      // else if (effectName === 'Delay') { ... }
    }

    // Connect the final node in the chain to the output
    currentNode.connect(seqFxOutput);

    // Update state tracking
    currentSeqSlots = [...slots];
  }

  // Smooth Value Updating (No Disconnecting) - runs EVERY time
  let nodeIndex = 0;
  for (let i = 0; i < slots.length; i++) {
    const effectName = slots[i];
    const knobValue = values[i] !== undefined ? values[i] : 0.5; // Default to 0.5 if undefined

    if (effectName === 'Cutoff') {
      const filter = activeSeqFxNodes[nodeIndex];
      if (filter) {
        // Map knob value (0-1) to frequency (20Hz to 20000Hz) using exponential mapping
        const freq = cutoffToHz(knobValue);
        // Use setTargetAtTime for smoothing (removes clicks)
        filter.frequency.setTargetAtTime(freq, ctx.currentTime, 0.05);
      }
      nodeIndex++;
    }
    // Future effects can be added here:
    // else if (effectName === 'Resonance') { ... }
  }
}
