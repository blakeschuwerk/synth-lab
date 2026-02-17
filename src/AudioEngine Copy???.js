import * as Tone from 'tone';

class AudioEngine {
  constructor() {
    this.synth = null;
    this.filter = null;
    this.distortion = null;
    this.chorus = null;
    this.lfo = null;
    this.master = null;
    this.analyzer = null;
    this.isInitialized = false;
    this.lockedFrequency = null;
    this.currentParams = {
      oscillatorType: 'sawtooth',
      filterFreq: 2000,
      filterQ: 1,
      distortionAmount: 0,
      chorusWet: 0,
      attack: 0.01,
      decay: 0.2,
      sustain: 0.5,
      release: 0.5,
      vibeDepth: 0
    };
  }

  async initialize() {
    if (this.isInitialized) return;

    await Tone.start();

    this.master = new Tone.Gain(0.8).toDestination();
    
    this.analyzer = new Tone.Analyser('fft', 256);
    this.master.connect(this.analyzer);

    this.chorus = new Tone.Chorus({
      frequency: 1.5,
      delayTime: 3.5,
      depth: 0.7,
      wet: 0
    }).connect(this.master);

    this.distortion = new Tone.Distortion({
      distortion: 0,
      wet: 0
    }).connect(this.chorus);

    this.filter = new Tone.Filter({
      frequency: 2000,
      type: 'lowpass',
      rolloff: -12,
      Q: 1
    }).connect(this.distortion);

    this.synth = new Tone.PolySynth(Tone.Synth, {
      maxPolyphony: 4,
      voice: Tone.Synth,
      options: {
        oscillator: {
          type: 'sawtooth'
        },
        envelope: {
          attack: 0.01,
          decay: 0.2,
          sustain: 0.5,
          release: 0.5
        }
      }
    }).connect(this.filter);

    this.lfo = new Tone.LFO({
      frequency: 5,
      min: -50,
      max: 50,
      amplitude: 0
    }).start();

    this.isInitialized = true;
    console.log('[AudioEngine] Initialized');
  }

  configure(analysisResults) {
    if (!this.isInitialized) {
      console.warn('[AudioEngine] Not initialized yet');
      return;
    }

    const { detectedRelease, isWide, pitchHz } = analysisResults;

    this.currentParams.release = detectedRelease;
    this.synth.set({
      envelope: {
        release: detectedRelease
      }
    });

    if (isWide) {
      this.currentParams.chorusWet = 0.5;
      this.chorus.wet.value = 0.5;
    }

    this.lockedFrequency = pitchHz;

    console.log('[AudioEngine] Configured:', {
      release: detectedRelease.toFixed(3),
      chorusWet: this.currentParams.chorusWet,
      lockedFreq: pitchHz?.toFixed(2)
    });
  }

  runSimulatedAnnealing(targetSpectrum, steps = 50, onProgress = null) {
    if (!this.isInitialized) return null;

    const paramRanges = {
      filterFreq: { min: 200, max: 8000 },
      filterQ: { min: 0.5, max: 10 },
      distortionAmount: { min: 0, max: 0.8 },
      attack: { min: 0.001, max: 0.5 },
      decay: { min: 0.01, max: 1 },
      sustain: { min: 0.1, max: 1 }
    };

    let currentParams = { ...this.currentParams };
    let bestParams = { ...currentParams };
    let currentEnergy = this.calculateEnergy(currentParams, targetSpectrum);
    let bestEnergy = currentEnergy;

    const startTemp = 1.0;
    const endTemp = 0.01;

    for (let step = 0; step < steps; step++) {
      const temp = startTemp * Math.pow(endTemp / startTemp, step / steps);

      const newParams = { ...currentParams };
      const paramKeys = Object.keys(paramRanges);
      const keyToMutate = paramKeys[Math.floor(Math.random() * paramKeys.length)];
      const range = paramRanges[keyToMutate];
      const mutation = (Math.random() - 0.5) * (range.max - range.min) * 0.2 * temp;
      newParams[keyToMutate] = Math.max(range.min, Math.min(range.max, 
        currentParams[keyToMutate] + mutation
      ));

      const newEnergy = this.calculateEnergy(newParams, targetSpectrum);
      const delta = newEnergy - currentEnergy;

      if (delta < 0 || Math.random() < Math.exp(-delta / temp)) {
        currentParams = newParams;
        currentEnergy = newEnergy;

        if (currentEnergy < bestEnergy) {
          bestParams = { ...currentParams };
          bestEnergy = currentEnergy;
        }
      }

      if (onProgress) {
        onProgress({
          step,
          totalSteps: steps,
          energy: bestEnergy,
          params: bestParams
        });
      }
    }

    this.applyParams(bestParams);
    console.log('[AudioEngine] Annealing complete:', {
      energy: bestEnergy.toFixed(4),
      filterFreq: bestParams.filterFreq.toFixed(0),
      filterQ: bestParams.filterQ.toFixed(2),
      distortion: bestParams.distortionAmount.toFixed(3)
    });

    return bestParams;
  }

  calculateEnergy(params, targetSpectrum) {
    if (!targetSpectrum) return 1;

    const synthResponse = this.estimateSynthSpectrum(params);
    const targetMags = targetSpectrum.magnitudes;

    let energy = 0;
    const compareLength = Math.min(synthResponse.length, targetMags.length, 64);

    for (let i = 0; i < compareLength; i++) {
      const diff = Math.log(synthResponse[i] + 1) - Math.log(targetMags[i] + 1);
      energy += diff * diff;
    }

    return energy / compareLength;
  }

  estimateSynthSpectrum(params) {
    const spectrum = new Float32Array(128);
    const fundamental = this.lockedFrequency || 440;

    for (let i = 1; i <= 16; i++) {
      const freq = fundamental * i;
      const bin = Math.floor(freq / 172);
      
      if (bin < spectrum.length) {
        let amplitude;
        
        switch (params.oscillatorType) {
          case 'sawtooth':
            amplitude = 1 / i;
            break;
          case 'square':
            amplitude = i % 2 === 1 ? 1 / i : 0;
            break;
          case 'triangle':
            amplitude = i % 2 === 1 ? 1 / (i * i) : 0;
            break;
          default:
            amplitude = i === 1 ? 1 : 0;
        }

        const filterRolloff = freq > params.filterFreq 
          ? Math.pow(params.filterFreq / freq, 2) 
          : 1;

        if (freq > params.filterFreq * 0.9 && freq < params.filterFreq * 1.1) {
          amplitude *= (1 + params.filterQ * 0.5);
        }

        spectrum[bin] += amplitude * filterRolloff;
      }
    }

    if (params.distortionAmount > 0) {
      for (let i = 0; i < spectrum.length; i++) {
        spectrum[i] += spectrum[i] * params.distortionAmount * 0.3;
      }
    }

    return spectrum;
  }

  applyParams(params) {
    this.currentParams = { ...this.currentParams, ...params };

    if (params.oscillatorType) {
      this.synth.set({
        oscillator: { type: params.oscillatorType }
      });
    }

    if (params.filterFreq !== undefined) {
      this.filter.frequency.value = params.filterFreq;
    }
    if (params.filterQ !== undefined) {
      this.filter.Q.value = params.filterQ;
    }

    if (params.distortionAmount !== undefined) {
      this.distortion.distortion = params.distortionAmount;
      this.distortion.wet.value = params.distortionAmount > 0 ? 1 : 0;
    }

    if (params.chorusWet !== undefined) {
      this.chorus.wet.value = params.chorusWet;
    }

    this.synth.set({
      envelope: {
        attack: params.attack ?? this.currentParams.attack,
        decay: params.decay ?? this.currentParams.decay,
        sustain: params.sustain ?? this.currentParams.sustain,
        release: params.release ?? this.currentParams.release
      }
    });
  }

  setVibe(vibeType) {
    switch (vibeType) {
      case 'modern':
        this.lfo.amplitude.value = 0.3;
        this.lfo.frequency.value = 6;
        this.distortion.distortion = Math.min(0.3, this.currentParams.distortionAmount + 0.1);
        break;
      case 'vintage':
        this.lfo.amplitude.value = 0.5;
        this.lfo.frequency.value = 4;
        this.chorus.wet.value = Math.min(0.7, this.currentParams.chorusWet + 0.2);
        break;
      case 'off':
      default:
        this.lfo.amplitude.value = 0;
        this.distortion.distortion = this.currentParams.distortionAmount;
        this.chorus.wet.value = this.currentParams.chorusWet;
        break;
    }
    console.log('[AudioEngine] Vibe set:', vibeType);
  }

  triggerAttack(note) {
    if (!this.isInitialized) return;
    this.synth.triggerAttack(note, Tone.now());
  }

  triggerRelease(note) {
    if (!this.isInitialized) return;
    this.synth.triggerRelease(note, Tone.now());
  }

  releaseAll() {
    if (!this.isInitialized) return;
    this.synth.releaseAll();
  }

  getAnalyzerData() {
    if (!this.analyzer) return new Float32Array(256);
    return this.analyzer.getValue();
  }

  async recordToWav(durationMs = 3000) {
    if (!this.isInitialized) return null;

    const recorder = new Tone.Recorder();
    this.master.connect(recorder);
    
    recorder.start();

    this.triggerAttack('C4');
    await new Promise(r => setTimeout(r, durationMs * 0.7));
    this.triggerRelease('C4');
    await new Promise(r => setTimeout(r, durationMs * 0.3));

    const blob = await recorder.stop();
    this.master.disconnect(recorder);
    recorder.dispose();

    return blob;
  }

  dispose() {
    if (this.synth) this.synth.dispose();
    if (this.filter) this.filter.dispose();
    if (this.distortion) this.distortion.dispose();
    if (this.chorus) this.chorus.dispose();
    if (this.lfo) this.lfo.dispose();
    if (this.master) this.master.dispose();
    if (this.analyzer) this.analyzer.dispose();
    this.isInitialized = false;
  }
}

export default AudioEngine;
