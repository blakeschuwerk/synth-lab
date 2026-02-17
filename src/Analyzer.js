import Meyda from 'meyda';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SILENCE_THRESHOLD_DB = -60;
const NORMALIZE_TARGET_DB = -3;

class Analyzer {
  constructor() {
    this.audioContext = null;
    this.results = null;
  }

  async initialize() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  dbToLinear(db) {
    return Math.pow(10, db / 20);
  }

  linearToDb(linear) {
    return 20 * Math.log10(Math.max(linear, 1e-10));
  }

  validateFile(file) {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File too large. Max size is ${MAX_FILE_SIZE / 1024 / 1024}MB`);
    }
    const validTypes = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/webm'];
    if (!validTypes.some(t => file.type.includes(t.split('/')[1]))) {
      console.warn('Unusual file type, attempting to process anyway:', file.type);
    }
    return true;
  }

  normalizeBuffer(audioBuffer, targetDb = NORMALIZE_TARGET_DB) {
    const channels = [];
    let maxAmplitude = 0;

    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const channelData = audioBuffer.getChannelData(c).slice();
      channels.push(channelData);
      for (let i = 0; i < channelData.length; i++) {
        maxAmplitude = Math.max(maxAmplitude, Math.abs(channelData[i]));
      }
    }

    if (maxAmplitude === 0) {
      throw new Error('Audio file appears to be silent');
    }

    const targetLinear = this.dbToLinear(targetDb);
    const gain = targetLinear / maxAmplitude;

    for (const channelData of channels) {
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] *= gain;
      }
    }

    const normalizedBuffer = this.audioContext.createBuffer(
      audioBuffer.numberOfChannels,
      audioBuffer.length,
      audioBuffer.sampleRate
    );

    for (let c = 0; c < channels.length; c++) {
      normalizedBuffer.copyToChannel(channels[c], c);
    }

    return normalizedBuffer;
  }

  checkSilence(audioBuffer) {
    const channelData = audioBuffer.getChannelData(0);
    let rms = 0;
    for (let i = 0; i < channelData.length; i++) {
      rms += channelData[i] * channelData[i];
    }
    rms = Math.sqrt(rms / channelData.length);
    const dbLevel = this.linearToDb(rms);
    
    if (dbLevel < SILENCE_THRESHOLD_DB) {
      throw new Error('Audio file is too quiet (below -60dB)');
    }
    return dbLevel;
  }

  getDualSnapshots(audioBuffer) {
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    
    const pos20 = Math.floor(channelData.length * 0.2);
    const pos80 = Math.floor(channelData.length * 0.8);
    
    const fftSizePitch = 4096;
    const fftSizeTexture = 1024;

    const getSpectrum = (position, fftSize) => {
      const start = Math.max(0, position - Math.floor(fftSize / 2));
      const end = Math.min(channelData.length, start + fftSize);
      const slice = channelData.slice(start, end);
      
      if (slice.length < fftSize) {
        const padded = new Float32Array(fftSize);
        padded.set(slice);
        return this.computeFFT(padded, sampleRate);
      }
      return this.computeFFT(slice, sampleRate);
    };

    return {
      early: {
        pitch: getSpectrum(pos20, fftSizePitch),
        texture: getSpectrum(pos20, fftSizeTexture)
      },
      late: {
        pitch: getSpectrum(pos80, fftSizePitch),
        texture: getSpectrum(pos80, fftSizeTexture)
      }
    };
  }

  computeFFT(samples, sampleRate) {
    const fftSize = samples.length;
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    
    for (let i = 0; i < fftSize; i++) {
      real[i] = samples[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / fftSize));
    }

    this.fft(real, imag);

    const magnitudes = new Float32Array(fftSize / 2);
    const frequencies = new Float32Array(fftSize / 2);
    
    for (let i = 0; i < fftSize / 2; i++) {
      magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
      frequencies[i] = (i * sampleRate) / fftSize;
    }

    return { magnitudes, frequencies, sampleRate, fftSize };
  }

  fft(real, imag) {
    const n = real.length;
    if (n <= 1) return;

    let j = 0;
    for (let i = 0; i < n - 1; i++) {
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
      let k = n >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }

    for (let len = 2; len <= n; len <<= 1) {
      const angle = -2 * Math.PI / len;
      const wReal = Math.cos(angle);
      const wImag = Math.sin(angle);
      
      for (let i = 0; i < n; i += len) {
        let curReal = 1, curImag = 0;
        
        for (let k = 0; k < len / 2; k++) {
          const evenIdx = i + k;
          const oddIdx = i + k + len / 2;
          
          const tReal = curReal * real[oddIdx] - curImag * imag[oddIdx];
          const tImag = curReal * imag[oddIdx] + curImag * real[oddIdx];
          
          real[oddIdx] = real[evenIdx] - tReal;
          imag[oddIdx] = imag[evenIdx] - tImag;
          real[evenIdx] += tReal;
          imag[evenIdx] += tImag;
          
          const newReal = curReal * wReal - curImag * wImag;
          curImag = curReal * wImag + curImag * wReal;
          curReal = newReal;
        }
      }
    }
  }

  detectPitch(spectrum) {
    const { magnitudes, frequencies } = spectrum;
    
    let maxMag = 0;
    let peakIdx = 0;
    
    for (let i = 1; i < magnitudes.length - 1; i++) {
      if (frequencies[i] > 50 && frequencies[i] < 2000) {
        if (magnitudes[i] > maxMag) {
          maxMag = magnitudes[i];
          peakIdx = i;
        }
      }
    }

    if (peakIdx > 0 && peakIdx < magnitudes.length - 1) {
      const y0 = magnitudes[peakIdx - 1];
      const y1 = magnitudes[peakIdx];
      const y2 = magnitudes[peakIdx + 1];
      const delta = (y0 - y2) / (2 * (y0 - 2 * y1 + y2));
      return frequencies[peakIdx] + delta * (frequencies[1] - frequencies[0]);
    }

    return frequencies[peakIdx];
  }

  frequencyToOctave(frequency) {
    if (frequency <= 0) return 2;
    const noteNumber = 12 * Math.log2(frequency / 440) + 69;
    return Math.floor(noteNumber / 12) - 1;
  }

  measureRelease(audioBuffer) {
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    
    let maxAmplitude = 0;
    let maxIdx = 0;
    
    for (let i = 0; i < channelData.length; i++) {
      const abs = Math.abs(channelData[i]);
      if (abs > maxAmplitude) {
        maxAmplitude = abs;
        maxIdx = i;
      }
    }

    const threshold6dB = maxAmplitude * this.dbToLinear(-6);
    const threshold60dB = maxAmplitude * this.dbToLinear(-60);

    let start6dB = -1;
    let end60dB = -1;

    const windowSize = Math.floor(sampleRate * 0.01);
    
    for (let i = maxIdx; i < channelData.length - windowSize; i += windowSize) {
      let windowRms = 0;
      for (let j = 0; j < windowSize; j++) {
        windowRms += channelData[i + j] * channelData[i + j];
      }
      windowRms = Math.sqrt(windowRms / windowSize);
      
      if (start6dB === -1 && windowRms < threshold6dB) {
        start6dB = i;
      }
      if (start6dB !== -1 && windowRms < threshold60dB) {
        end60dB = i;
        break;
      }
    }

    if (start6dB === -1 || end60dB === -1) {
      return 0.5;
    }

    const releaseTime = (end60dB - start6dB) / sampleRate;
    return Math.max(0.01, Math.min(5, releaseTime));
  }

  get90thPercentileAmplitude(audioBuffer) {
    const channelData = audioBuffer.getChannelData(0);
    const amplitudes = [];
    
    const windowSize = 512;
    for (let i = 0; i < channelData.length - windowSize; i += windowSize) {
      let rms = 0;
      for (let j = 0; j < windowSize; j++) {
        rms += channelData[i + j] * channelData[i + j];
      }
      amplitudes.push(Math.sqrt(rms / windowSize));
    }
    
    amplitudes.sort((a, b) => a - b);
    const idx = Math.floor(amplitudes.length * 0.9);
    return amplitudes[idx] || 0.5;
  }

  computeGatekeepers(snapshots) {
    const { early, late } = snapshots;
    
    const countHarmonics = (spectrum, fundamental) => {
      const { magnitudes, frequencies } = spectrum;
      let harmonicCount = 0;
      const threshold = Math.max(...magnitudes) * 0.1;
      
      for (let h = 2; h <= 8; h++) {
        const targetFreq = fundamental * h;
        let found = false;
        
        for (let i = 0; i < frequencies.length; i++) {
          if (Math.abs(frequencies[i] - targetFreq) < 20 && magnitudes[i] > threshold) {
            found = true;
            break;
          }
        }
        if (found) harmonicCount++;
      }
      return harmonicCount;
    };

    const fundamentalFreq = this.detectPitch(early.pitch);
    const harmonics = countHarmonics(early.pitch, fundamentalFreq);
    
    const isFM = harmonics >= 4;

    const spectralFlatness = (spectrum) => {
      const mags = spectrum.magnitudes;
      const logMean = mags.reduce((a, b) => a + Math.log(b + 1e-10), 0) / mags.length;
      const arithmeticMean = mags.reduce((a, b) => a + b, 0) / mags.length;
      return Math.exp(logMean) / (arithmeticMean + 1e-10);
    };

    const flatness = spectralFlatness(early.texture);
    const isOrganic = flatness > 0.1;

    const computeSpread = (spectrum) => {
      const { magnitudes, frequencies } = spectrum;
      const total = magnitudes.reduce((a, b) => a + b, 0);
      if (total === 0) return 0;
      
      let centroid = 0;
      for (let i = 0; i < magnitudes.length; i++) {
        centroid += frequencies[i] * magnitudes[i];
      }
      centroid /= total;
      
      let spread = 0;
      for (let i = 0; i < magnitudes.length; i++) {
        spread += magnitudes[i] * Math.pow(frequencies[i] - centroid, 2);
      }
      return Math.sqrt(spread / total);
    };

    const spread = computeSpread(early.texture);
    const isWide = spread > 500;

    return { isFM, isOrganic, isWide };
  }

  async analyze(file) {
    await this.initialize();
    this.validateFile(file);

    const arrayBuffer = await file.arrayBuffer();
    let audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

    this.checkSilence(audioBuffer);

    audioBuffer = this.normalizeBuffer(audioBuffer);

    const snapshots = this.getDualSnapshots(audioBuffer);

    const pitchHz = this.detectPitch(snapshots.early.pitch);
    const detectedOctave = this.frequencyToOctave(pitchHz);
    const detectedRelease = this.measureRelease(audioBuffer);
    const amplitude = this.get90thPercentileAmplitude(audioBuffer);
    const gatekeepers = this.computeGatekeepers(snapshots);

    this.results = {
      pitchHz,
      detectedOctave,
      detectedRelease,
      amplitude,
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      ...gatekeepers,
      snapshots,
      audioBuffer
    };

    console.log('[Analyzer] Results:', {
      pitchHz: this.results.pitchHz.toFixed(2),
      octave: this.results.detectedOctave,
      release: this.results.detectedRelease.toFixed(3),
      isFM: this.results.isFM,
      isOrganic: this.results.isOrganic,
      isWide: this.results.isWide
    });

    return this.results;
  }

  getResults() {
    return this.results;
  }

  getSpectrum() {
    if (!this.results) return null;
    return this.results.snapshots.early.pitch;
  }
}

export default Analyzer;
