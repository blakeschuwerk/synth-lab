import React, { useState, useEffect, useRef } from 'react';
import { initAudio, playTone, stopTone, updateSynthParams, getFilterDiagnostics, setPolyphony, setSustainMode, getVisualState, resumeAudioContext, triggerSequencerStep, updateSeqEffectsChain } from './audio/AudioEngine';

/** 'Delay Time' -> 'delayTime', 'Env Amt' -> 'envAmt' */
function toCamelCase(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .trim()
    .split(/\s+/)
    .map((word, i) => (i === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join('');
}

// Calculate frequency from absolute key index (0-17 for C to High F, ~1.5 octaves)
// octave: the current octave state (defaults to 4)
function getFrequencyFromIndex(absoluteIndex, octave = 4) {
  // Base is C3 = MIDI note 48
  // When octave=4, we want C4 (MIDI 60), so add (octave - 3) * 12 semitones
  const semitoneOffset = (octave - 3) * 12;
  const midiNote = 48 + absoluteIndex + semitoneOffset;
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

// Calculate frequency from note name and octave (legacy support)
function getFrequency(noteName, octave) {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteIndex = noteNames.indexOf(noteName);
  const midiNote = (octave + 1) * 12 + noteIndex;
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

// Piano key layout: 18 keys (C to High F) - Home Row Extended
// White keys: A, S, D, F, G, H, J, K, L, ;, ' (11 keys)
// Black keys: W, E, T, Y, U, O, P, [ (8 keys)
const PIANO_KEYS = [
  // First octave (C3 to B3)
  { note: 'C', key: 'a', isBlack: false, whiteKeyIndex: 0, absoluteIndex: 0 },
  { note: 'C#', key: 'w', isBlack: true, whiteKeyIndex: 0, absoluteIndex: 1 },
  { note: 'D', key: 's', isBlack: false, whiteKeyIndex: 1, absoluteIndex: 2 },
  { note: 'D#', key: 'e', isBlack: true, whiteKeyIndex: 1, absoluteIndex: 3 },
  { note: 'E', key: 'd', isBlack: false, whiteKeyIndex: 2, absoluteIndex: 4 },
  { note: 'F', key: 'f', isBlack: false, whiteKeyIndex: 3, absoluteIndex: 5 },
  { note: 'F#', key: 't', isBlack: true, whiteKeyIndex: 3, absoluteIndex: 6 },
  { note: 'G', key: 'g', isBlack: false, whiteKeyIndex: 4, absoluteIndex: 7 },
  { note: 'G#', key: 'y', isBlack: true, whiteKeyIndex: 4, absoluteIndex: 8 },
  { note: 'A', key: 'h', isBlack: false, whiteKeyIndex: 5, absoluteIndex: 9 },
  { note: 'A#', key: 'u', isBlack: true, whiteKeyIndex: 5, absoluteIndex: 10 },
  { note: 'B', key: 'j', isBlack: false, whiteKeyIndex: 6, absoluteIndex: 11 },
  // Second octave (C4 to F4)
  { note: 'C', key: 'k', isBlack: false, whiteKeyIndex: 7, absoluteIndex: 12 },
  { note: 'C#', key: 'o', isBlack: true, whiteKeyIndex: 7, absoluteIndex: 13 },
  { note: 'D', key: 'l', isBlack: false, whiteKeyIndex: 8, absoluteIndex: 14 },
  { note: 'D#', key: 'p', isBlack: true, whiteKeyIndex: 8, absoluteIndex: 15 },
  { note: 'E', key: ';', isBlack: false, whiteKeyIndex: 9, absoluteIndex: 16 },
  { note: 'F', key: "'", isBlack: false, whiteKeyIndex: 10, absoluteIndex: 17 },
];

const KEY_TO_NOTE = {};
PIANO_KEYS.forEach(keyInfo => {
  KEY_TO_NOTE[keyInfo.key] = keyInfo.note;
});

const WAVEFORMS = ['sine', 'triangle', 'square', 'saw'];

const DiagnosticProbe = ({ audioPlaying, analyzer, width, height }) => (
  <div style={{
    position: 'absolute',
    top: '2px',
    left: '2px',
    maxWidth: '90%',
    maxHeight: '90%',
    fontFamily: 'monospace',
    fontSize: '9px',
    lineHeight: '1.1',
    padding: '4px',
    backgroundColor: 'rgba(215, 44, 44, 0.8)',
    border: '1px solid rgba(255, 255, 255, 0.4)',
    borderRadius: '8px',
    boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
    color: 'white',
    zIndex: 9999,
    pointerEvents: 'none',
  }}>
    <strong style={{ margin: 0 }}>TOP WINDOW</strong><br />
    Audio: {audioPlaying ? '✓ RUNNING' : 'x STOPPED'}<br />
    Analyzer: {analyzer ? '✓ READY' : 'x MISSING'}<br />
    Size: ✓ {width}x{height}
  </div>
);

// Top-view spectrum analyzer: simplified bars only (no labels), fits small OSC A window.
// Reads from same analyserRef as SpectrumLab; stays active as long as isAudioPlaying (including release).
function SpectrumAnalyzer({ analyzer }) {
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);

  useEffect(() => {
    if (!analyzer || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const width = 100;
    const height = 50;
    const barCount = 48;
    const dataArray = new Uint8Array(analyzer.frequencyBinCount);

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);
      analyzer.getByteFrequencyData(dataArray);

      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, width, height);

      const padding = 2;
      const barWidth = (width - padding * 2) / barCount;
      for (let i = 0; i < barCount; i++) {
        const logIndex = Math.pow(i / barCount, 2) * (dataArray.length - 1);
        const binIndex = Math.floor(logIndex);
        const value = dataArray[binIndex] / 255;
        const x = padding + i * barWidth;
        const barHeight = value * (height - padding * 2);
        const y = height - padding - barHeight;
        ctx.fillStyle = '#007aff';
        ctx.fillRect(x, y, barWidth - 1, barHeight);
      }
    };

    draw();
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [analyzer]);

  return (
    <canvas
      ref={canvasRef}
      width={100}
      height={50}
      style={{ display: 'block', width: '100px', height: '50px' }}
    />
  );
}

// Spectrum Lab Footer Component (high-resolution version)
function SpectrumLab({ analyzer }) {
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!analyzer || !canvasRef.current || !containerRef.current) return;

    const updateCanvasSize = () => {
      if (canvasRef.current && containerRef.current) {
        const containerWidth = containerRef.current.offsetWidth - 20;
        canvasRef.current.width = containerWidth;
        canvasRef.current.height = 160;
      }
    };

    updateCanvasSize();
    window.addEventListener('resize', updateCanvasSize);

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const barCount = 128; // High resolution
    const dataArray = new Uint8Array(analyzer.frequencyBinCount);

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);

      const width = canvas.width;
      const height = canvas.height;

      analyzer.getByteFrequencyData(dataArray);

      // Clear canvas
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);

      // Draw background grid
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      
      // Horizontal grid lines
      for (let i = 0; i <= 4; i++) {
        const y = (height / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Frequency labels
      ctx.fillStyle = '#666';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('100Hz', 10, height - 5);
      ctx.fillText('1kHz', width / 2 - 20, height - 5);
      ctx.fillText('10kHz', width - 50, height - 5);

      // Draw bars with logarithmic frequency mapping
      const padding = 30;
      const barWidth = (width - padding * 2) / barCount;
      
      for (let i = 0; i < barCount; i++) {
        // Map bar index logarithmically to frequency bin
        const logIndex = Math.pow(i / barCount, 2) * (dataArray.length - 1);
        const binIndex = Math.floor(logIndex);
        const value = dataArray[binIndex] / 255; // Normalize to 0-1
        
        const x = padding + i * barWidth;
        const barHeight = value * (height - padding - 20);
        const y = height - padding - barHeight;

        // Draw bar in electric blue with gradient
        const gradient = ctx.createLinearGradient(x, y, x, height - padding);
        gradient.addColorStop(0, '#007aff');
        gradient.addColorStop(1, '#0051d5');
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, barWidth - 1, barHeight);
      }
    };

    draw();

    return () => {
      window.removeEventListener('resize', updateCanvasSize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [analyzer]);

  return (
    <div 
      ref={containerRef}
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: '200px',
        background: '#000',
        borderTop: '1px solid #333',
        zIndex: 1000,
        padding: '10px',
      }}
    >
      <div style={{ color: '#007aff', fontSize: '12px', marginBottom: '5px', fontFamily: 'monospace' }}>
        SPECTRUM LAB
      </div>
      <canvas
        ref={canvasRef}
        height={160}
        style={{ display: 'block', width: '100%', height: '160px' }}
      />
    </div>
  );
}

export default function TestSynth() {
  const [waveform, setWaveform] = useState('sine');
  const [octave, setOctave] = useState(4);
  const [velocity, setVelocity] = useState(64);
  const [sustain, setSustain] = useState(false);
  const [pitchBend, setPitchBend] = useState(0); // -1 to 1
  const [modulation, setModulation] = useState(0); // 0 to 127
  const [pressedKeys, setPressedKeys] = useState(new Set());
  const [activeNotes, setActiveNotes] = useState(new Map());
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [hoveredChip, setHoveredChip] = useState(null);
  const [assignedSlots, setAssignedSlots] = useState(Array(8).fill(null)); // 8 slots: 4 left + 4 right
  const [slotValues, setSlotValues] = useState(Array(8).fill(0.5)); // Values for each knob (0-1)
  const [dragOverSlot, setDragOverSlot] = useState(null);
  const [dragOverSeqSlot, setDragOverSeqSlot] = useState(null);
  const [draggingKnob, setDraggingKnob] = useState(null); // Track which knob is being dragged
  const [draggingSeqFx, setDraggingSeqFx] = useState(null); // Track which sequencer FX slot is being dragged
  const [editingSeqFx, setEditingSeqFx] = useState(null); // Track which sequencer FX knob is being edited
  const [editingKnob, setEditingKnob] = useState(null); // Track which knob is being edited
  const [logs, setLogs] = useState([{ message: 'Waiting for input...', type: 'log' }]);
  const [showDebug, setShowDebug] = useState(false);
  const [filterDiagnostic, setFilterDiagnostic] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [analyserReady, setAnalyserReady] = useState(false);
  const [isPoly, setIsPoly] = useState(false);
  const [selectedOscillator, setSelectedOscillator] = useState(1);
  const [visualState, setVisualState] = useState({ active: [], held: [] });
  const [padPressed, setPadPressed] = useState({ osc1: false, osc2: false, mode: false });
  const [visorSize, setVisorSize] = useState({ width: 0, height: 0 });
  const [selectedScale, setSelectedScale] = useState('');
  // Transport and Sequencer state
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(120);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [editLayer, setEditLayer] = useState('synth'); // 'synth' | 'seq'
  const [sequencerSteps, setSequencerSteps] = useState(() =>
    Array.from({ length: 16 }, () => ({ active: false, tied: false, note: null }))
  ); // 16 steps: { active, tied, note }
  const [currentStep, setCurrentStep] = useState(-1); // -1 = stopped, 0-15 = current step
  const [isRecording, setIsRecording] = useState(false);
  const [recordingIndex, setRecordingIndex] = useState(0);
  const [clearButtonHover, setClearButtonHover] = useState(false);
  // Sequencer Voice parameters
  const [seqWave, setSeqWave] = useState('saw'); // 'saw' | 'square'
  const [seqCutoff, setSeqCutoff] = useState(0.5); // 0-1
  const [seqRes, setSeqRes] = useState(0.0); // 0-1
  const [seqAttack, setSeqAttack] = useState(0.1); // 0-1
  const [seqDecay, setSeqDecay] = useState(0.3); // 0-1
  const [seqSustain, setSeqSustain] = useState(0.7); // 0-1
  const [seqRelease, setSeqRelease] = useState(0.2); // 0-1
  const [seqFxSlots, setSeqFxSlots] = useState(Array(4).fill(null)); // 4 effect slots
  const [seqFxValues, setSeqFxValues] = useState(Array(4).fill(0.5)); // Values for sequencer FX slots (0-1)
  const audioInitialized = useRef(false);
  const analyserRef = useRef(null);
  const visorDisplayRef = useRef(null);
  const sustainRef = useRef(false);
  const knobDragStartY = useRef(0);
  const knobDragStartValue = useRef(0);
  const isDropSuccessful = useRef(false);
  const isSeqFxDropSuccessful = useRef(false);
  const addLogRef = useRef(null);
  const seqParamsRef = useRef({ seqAttack, seqDecay, seqSustain, seqRelease });

  const addLog = (msg, type = 'log') => {
    setLogs((prev) => [{ message: String(msg), type }, ...prev].slice(0, 100));
  };

  // Keep addLog ref up to date
  useEffect(() => {
    addLogRef.current = addLog;
  });

  // Update filter diagnostic in real-time when Debug Panel is open (for Cutoff knob verification)
  useEffect(() => {
    if (!showDebug) return;
    setFilterDiagnostic(getFilterDiagnostics());
    const id = setInterval(() => setFilterDiagnostic(getFilterDiagnostics()), 100);
    return () => clearInterval(id);
  }, [showDebug]);

  const cycleWaveform = (direction) => {
    const currentIndex = WAVEFORMS.indexOf(waveform);
    if (direction === 'next') {
      setWaveform(WAVEFORMS[(currentIndex + 1) % WAVEFORMS.length]);
    } else {
      setWaveform(WAVEFORMS[(currentIndex - 1 + WAVEFORMS.length) % WAVEFORMS.length]);
    }
  };

  // Sync sustain ref and engine latch mode
  useEffect(() => {
    sustainRef.current = sustain;
    setSustainMode(sustain);
  }, [sustain]);

  // Poll visual state in requestAnimationFrame so breathing starts instantly when releasing sustained notes
  useEffect(() => {
    let rafId;
    const tick = () => {
      setVisualState(getVisualState());
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Measure top visor size for diagnostic box
  useEffect(() => {
    const el = visorDisplayRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0]?.contentRect ?? { width: 0, height: 0 };
      setVisorSize({ width: Math.round(width), height: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [analyserReady]);

  // Auto-fix: if keys are pressed but audio is reported stopped (e.g. after refresh), resume context
  useEffect(() => {
    const keysPressed = pressedKeys.size > 0 || activeNotes.size > 0;
    if (!isAudioPlaying && keysPressed) {
      resumeAudioContext();
    }
  }, [isAudioPlaying, pressedKeys.size, activeNotes.size]);

  // Console intercept: Capture all console.log/warn/error and display in overlay
  useEffect(() => {
    // Store original console functions
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    // Helper to format console arguments
    const formatArgs = (args) => {
      return args.map(arg => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      }).join(' ');
    };

    // Override console.log
    console.log = (...args) => {
      const message = formatArgs(args);
      if (addLogRef.current) {
        addLogRef.current(message, 'log');
      }
      originalLog.apply(console, args);
    };

    // Override console.warn
    console.warn = (...args) => {
      const message = formatArgs(args);
      if (addLogRef.current) {
        addLogRef.current(message, 'warn');
      }
      originalWarn.apply(console, args);
    };

    // Override console.error
    console.error = (...args) => {
      const message = formatArgs(args);
      if (addLogRef.current) {
        addLogRef.current(message, 'error');
      }
      originalError.apply(console, args);
    };

    // Cleanup: Restore original console functions on unmount
    return () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    };
  }, []); // Empty deps - only run once on mount

  // Bridge: map UI state (assignedSlots, slotValues) to AudioEngine
  const syncToAudioEngine = () => {
    console.log('🎚️ UI: Syncing Params', assignedSlots);
    const params = {};
    assignedSlots.forEach((label, i) => {
      if (label != null) {
        params[toCamelCase(label)] = slotValues[i];
      }
    });
    const allLibraryParams = [
      'Attack', 'Decay', 'Sustain', 'Release',
      'Cutoff', 'Res', 'Drive', 'Env Amt',
      'Detune', 'Blend', 'Glide', 'Sub', 'Noise',
      'Bitcrush', 'Chorus', 'Delay Mix', 'Delay Time', 'Reverb Size', 'Reverb Mix', 'Pan',
    ];
    allLibraryParams.forEach((name) => {
      const key = toCamelCase(name);
      if (!(key in params)) params[key] = (key === 'cutoff') ? 1.0 : 0.5;
    });
    updateSynthParams(params);
  };

  useEffect(() => {
    syncToAudioEngine();
  }, [slotValues, assignedSlots]);

  // Initialize audio
  useEffect(() => {
    addLog('App Mounted', 'log');
    console.log('🖱️ UI: initAudio called');
    const initialize = async () => {
      if (!audioInitialized.current) {
        try {
          const { analyser } = await initAudio();
          analyserRef.current = analyser;
          audioInitialized.current = true;
          setAnalyserReady(true);
          addLog('Init Audio Called', 'log');
        } catch (e) {
          console.error('Audio initialization error:', e);
        }
      }
    };
    initialize();
  }, []);

  // Indestructible volume loop: starts on mount, ALWAYS schedules next frame outside the analyser check.
  // After refresh the loop never stopped, so isAudioPlaying flips to TRUE as soon as a note is played and the Red Diagnostic Box shows RUNNING.
  useEffect(() => {
    const dataArray = new Uint8Array(2048); // Safe size for typical analyser frequencyBinCount (e.g. 1024)
    let animationFrameId;

    const check = () => {
      if (analyserRef.current) {
        try {
          analyserRef.current.getByteFrequencyData(dataArray);
          const sum = dataArray.reduce((a, b) => a + b, 0);
          setIsAudioPlaying(sum > 0);
        } catch (_) {
          // e.g. context suspended — loop keeps running and will see data once resumed
        }
      }
      // ALWAYS request the next frame, even if analyzer is null (indestructible on refresh)
      animationFrameId = requestAnimationFrame(check);
    };

    check();

    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, []);

  // Global drag end handler to reset drag state
  useEffect(() => {
    const handleDragEnd = () => {
      setDragOverSlot(null);
      setDraggingKnob(null);
      isDropSuccessful.current = false;
    };
    
    document.addEventListener('dragend', handleDragEnd);
    return () => {
      document.removeEventListener('dragend', handleDragEnd);
    };
  }, []);

  // Keyboard event handlers
  useEffect(() => {
    const handleKeyDown = async (e) => {
      const key = e.key.toLowerCase();
      
      // Control keys
      if (key === 'z') {
        e.preventDefault();
        setOctave(prev => Math.max(0, prev - 1));
        return;
      }
      if (key === 'x') {
        e.preventDefault();
        setOctave(prev => Math.min(8, prev + 1));
        return;
      }
      if (key === 'c') {
        e.preventDefault();
        setVelocity(prev => Math.max(0, prev - 1));
        return;
      }
      if (key === 'v') {
        e.preventDefault();
        setVelocity(prev => Math.min(127, prev + 1));
        return;
      }
      if (key === 'tab') {
        e.preventDefault();
        setSustain(prev => !prev);
        return;
      }
      if (key === '1') {
        e.preventDefault();
        setPitchBend(-1);
        return;
      }
      if (key === '2') {
        e.preventDefault();
        setPitchBend(1);
        return;
      }
      if (['3', '4', '5', '6', '7', '8'].includes(key)) {
        e.preventDefault();
        const modValue = (parseInt(key) - 3) * 25.4; // 0, 25.4, 50.8, 76.2, 101.6, 127
        setModulation(Math.min(127, modValue));
        return;
      }

      // Piano keys
      if (KEY_TO_NOTE[key] && !pressedKeys.has(key)) {
        e.preventDefault();
        
        const keyInfo = PIANO_KEYS.find(k => k.key === key);
        const noteName = KEY_TO_NOTE[key];
        const noteDisplay = getNoteDisplay(noteName); // e.g. 'C4', 'C#3'
        let frequency = keyInfo ? getFrequencyFromIndex(keyInfo.absoluteIndex, octave) : getFrequency(noteName, octave);
        
        // Apply pitch bend
        if (pitchBend !== 0) {
          frequency = frequency * Math.pow(2, pitchBend / 12);
        }
        
        // Smart Step Recording: if recording, write note to current step and advance
        if (isRecording) {
          setSequencerSteps(prev => {
            const next = prev.map((step, i) =>
              i === recordingIndex ? { active: true, tied: false, note: noteDisplay } : step
            );
            return next;
          });
          setRecordingIndex(prev => (prev + 1) % 16);
        }
        
        setPressedKeys(prev => new Set([...prev, key]));
        setActiveNotes(prev => new Map([...prev, [key, { note: noteName, frequency }]]));
        
        if (!audioInitialized.current) {
          try {
            const { analyser } = await initAudio();
            analyserRef.current = analyser;
            audioInitialized.current = true;
            setAnalyserReady(true);
          } catch (err) {
            return;
          }
        }
        
        // Convert velocity 0-127 to 0.0-1.0
        const velocityNormalized = velocity / 127;
        addLog('Playing: ' + frequency + 'Hz', 'log');
        console.log('🎹 UI: Note Down', { frequency, velocity: velocityNormalized });
        playTone(frequency, waveform, velocityNormalized);
      }
    };

    const handleKeyUp = (e) => {
      const key = e.key.toLowerCase();
      
      if (['z', 'x', 'c', 'v', 'tab', '1', '2', '3', '4', '5', '6', '7', '8'].includes(key)) {
        if (['1', '2'].includes(key)) {
          e.preventDefault();
          setPitchBend(0);
        }
        return;
      }

      if (KEY_TO_NOTE[key] && pressedKeys.has(key)) {
        e.preventDefault();
        const noteData = activeNotes.get(key);
        
        setPressedKeys(prev => {
          const newSet = new Set(prev);
          newSet.delete(key);
          return newSet;
        });
        
        setActiveNotes(prev => {
          const newMap = new Map(prev);
          newMap.delete(key);
          return newMap;
        });
        
        if (!sustainRef.current && noteData) {
          addLog('Stopping: ' + noteData.frequency + 'Hz', 'log');
          stopTone(noteData.frequency);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [pressedKeys, octave, waveform, velocity, activeNotes, pitchBend, isRecording, recordingIndex]);

  // Update sound when waveform/velocity changes
  useEffect(() => {
    if (activeNotes.size > 0 && audioInitialized.current) {
      activeNotes.forEach(({ frequency }) => {
        const velocityNormalized = velocity / 127;
        addLog('Playing: ' + frequency + 'Hz', 'log');
        console.log('🎹 UI: Note Down', { frequency, velocity: velocityNormalized });
        playTone(frequency, waveform, velocityNormalized);
      });
    }
  }, [waveform, velocity, activeNotes]);

  // Lookahead Scheduler: Master Clock for Sequencer Playback
  useEffect(() => {
    if (!isPlaying || !audioInitialized.current || !window.globalAudioContext) {
      setCurrentStep(-1);
      return;
    }

    const ctx = window.globalAudioContext;
    let timerID;
    let nextNoteTime = ctx.currentTime + 0.1; // 100ms lookahead
    let currentStepIndex = 0;

    // Calculate step duration (16th notes: 4 steps per beat)
    const secondsPerBeat = 60.0 / bpm;
    const stepDuration = secondsPerBeat / 4;

    // Scheduler function with lookahead
    const schedule = () => {
      while (nextNoteTime < ctx.currentTime + 0.1) {
        // Recalculate loop length dynamically (in case steps changed during playback)
        const loopLength = calculateLoopLength(sequencerStepsRef.current);
        
        // A. Play the Note
        const step = sequencerStepsRef.current[currentStepIndex];
        if (step && step.active && step.note) {
          // Calculate tie states for Legato
          const isTiedFromPrev = step.tied;
          let isTiedToNext = false;
          const nextStepIndex = (currentStepIndex + 1) % loopLength;
          const nextStep = sequencerStepsRef.current[nextStepIndex];
          if (nextStep && nextStep.active && nextStep.tied) {
            isTiedToNext = true;
          }
          
          const p = seqParamsRef.current;
          triggerSequencerStep(step.note, nextNoteTime, {
            wave: seqWave,
            cutoff: seqCutoff,
            res: seqRes,
            attack: p.seqAttack * 100, // Convert 0-1 to 0-100 for ADSR formula
            decay: p.seqDecay * 100,
            sustain: p.seqSustain * 100,
            release: p.seqRelease * 100,
          }, isTiedFromPrev, isTiedToNext, stepDuration);
        }

        // B. Update UI (throttle updates to avoid React choking)
        const stepIndexToShow = currentStepIndex;
        requestAnimationFrame(() => {
          setCurrentStep(stepIndexToShow);
        });

        // C. Advance Time & Index
        nextNoteTime += stepDuration;
        currentStepIndex = (currentStepIndex + 1) % loopLength;
      }

      timerID = setTimeout(schedule, 25.0);
    };

    // Start scheduling
    schedule();

    // Cleanup
    return () => {
      if (timerID) clearTimeout(timerID);
      setCurrentStep(-1);
    };
  }, [isPlaying, bpm, sequencerSteps, seqWave, seqCutoff, seqRes]);

  const getNoteDisplay = (noteName) => `${noteName}${octave}`;

  // Smart Loop: find last active step index, return length as nearest upper multiple of 4 (4, 8, 12, or 16)
  const calculateLoopLength = (steps = sequencerSteps) => {
    let lastActiveIndex = -1;
    steps.forEach((step, i) => {
      if (step && step.active) lastActiveIndex = i;
    });
    if (lastActiveIndex < 0) return 16;
    return Math.min(16, Math.ceil((lastActiveIndex + 1) / 4) * 4);
  };

  const sequencerStepsRef = useRef(sequencerSteps);
  useEffect(() => {
    sequencerStepsRef.current = sequencerSteps;
  }, [sequencerSteps]);

  useEffect(() => {
    seqParamsRef.current = { seqAttack, seqDecay, seqSustain, seqRelease };
  }, [seqAttack, seqDecay, seqSustain, seqRelease]);

  // Update sequencer FX chain when slots or values change
  useEffect(() => {
    updateSeqEffectsChain(seqFxSlots, seqFxValues);
  }, [seqFxSlots, seqFxValues]);

  // Parse stored note string "C4" / "C#4" to frequency
  const noteStringToFrequency = (noteStr) => {
    if (!noteStr || typeof noteStr !== 'string') return null;
    const octave = parseInt(noteStr.slice(-1), 10);
    const noteName = noteStr.slice(0, -1);
    if (isNaN(octave) || !noteName) return null;
    return getFrequency(noteName, octave);
  };

  // Scale intervals
  const SCALE_INTERVALS = {
    Major: [0, 2, 4, 5, 7, 9, 11],
    Minor: [0, 2, 3, 5, 7, 8, 10],
  };

  // Helper function to check if a note is in the scale
  const getScaleNoteStatus = (noteName) => {
    if (!selectedScale) return null;
    
    // Parse the selected scale string (e.g., 'C Major' or 'F# Minor')
    const parts = selectedScale.split(' ');
    if (parts.length !== 2) return null;
    
    const scaleRoot = parts[0];
    const scaleType = parts[1];
    
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const rootIndex = noteNames.indexOf(scaleRoot);
    if (rootIndex === -1) return null;
    
    const noteIndex = noteNames.indexOf(noteName);
    if (noteIndex === -1) return null;
    
    // Calculate semitone distance from root (handling octave wrap)
    const semitoneDistance = (noteIndex - rootIndex + 12) % 12;
    
    // Check if it's the root
    if (semitoneDistance === 0) return 'root';
    
    // Check if it's in the scale
    const intervals = SCALE_INTERVALS[scaleType] || SCALE_INTERVALS.Major;
    if (intervals.includes(semitoneDistance)) return 'scale';
    
    return null;
  };

  // Calculate used effects for single-instance rule
  const usedEffects = assignedSlots.filter(slot => slot !== null);
  // Check if effect is used in main synth or sequencer
  const isEffectInMainSynth = (effectName) => assignedSlots.includes(effectName);
  const isEffectInSequencer = (effectName) => seqFxSlots.includes(effectName);

  // Helper: angle in degrees (0 = 3 o'clock) to SVG x,y
  const polarToCartesian = (cx, cy, radius, angleDeg) => {
    const rad = (angleDeg * Math.PI) / 180;
    return {
      x: cx + radius * Math.cos(rad),
      y: cy + radius * Math.sin(rad),
    };
  };

  // SVG Arc Knob — 270° arc from 135° (7 o'clock) to 405° (5 o'clock)
  const KnobSVG = ({ value, isDragging, label }) => {
    const size = 80;
    const center = size / 2;
    const radius = 30;
    const startAngleDeg = 135;
    const endAngleDeg = 405;
    const totalAngleDeg = 270;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const v = clamp(value);
    const currentAngleDeg = startAngleDeg + v * totalAngleDeg;
    const sweepDeg = v * totalAngleDeg;
    const largeArcFlag = sweepDeg >= 180 ? 1 : 0;

    const start = polarToCartesian(center, center, radius, startAngleDeg);
    const end = polarToCartesian(center, center, radius, currentAngleDeg);
    const trackEnd = polarToCartesian(center, center, radius, endAngleDeg);

    const trackD = `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${trackEnd.x} ${trackEnd.y}`;
    const valueD = `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;

    return (
      <svg width={size} height={size} style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="none">
        <path d={trackD} fill="none" stroke="#333" strokeWidth={6} strokeLinecap="round" />
        <path d={valueD} fill="none" stroke="#00f0ff" strokeWidth={6} strokeLinecap="round" />
        {isDragging && (
          <text x={center} y={center + 4} textAnchor="middle" fontSize="10" fill="#00f0ff" fontWeight="600">
            {Math.round(v * 100)}
          </text>
        )}
      </svg>
    );
  };

  // Sequencer FX Knob Component (40px) - matches main synth knob but smaller
  const SequencerFxKnobSVG = ({ value, isDragging }) => {
    const size = 40;
    const center = size / 2;
    const radius = 15;
    const startAngleDeg = 135;
    const endAngleDeg = 405;
    const totalAngleDeg = 270;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const v = clamp(value);
    const currentAngleDeg = startAngleDeg + v * totalAngleDeg;
    const sweepDeg = v * totalAngleDeg;
    const largeArcFlag = sweepDeg >= 180 ? 1 : 0;

    const start = polarToCartesian(center, center, radius, startAngleDeg);
    const end = polarToCartesian(center, center, radius, currentAngleDeg);
    const trackEnd = polarToCartesian(center, center, radius, endAngleDeg);

    const trackD = `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${trackEnd.x} ${trackEnd.y}`;
    const valueD = `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;

    return (
      <svg width={size} height={size} style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="none">
        <path d={trackD} fill="none" stroke="#333" strokeWidth={4} strokeLinecap="round" />
        <path d={valueD} fill="none" stroke="#00f0ff" strokeWidth={4} strokeLinecap="round" />
        {isDragging && (
          <text x={center} y={center + 3} textAnchor="middle" fontSize="8" fill="#00f0ff" fontWeight="600">
            {Math.round(v * 100)}
          </text>
        )}
      </svg>
    );
  };

  // Small Knob Component (30px) for Sequencer ADSR
  const SmallKnob = ({ value, onChange, label }) => {
    const size = 30;
    const center = size / 2;
    const radius = 10;
    const startAngleDeg = 135;
    const endAngleDeg = 405;
    const totalAngleDeg = 270;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const v = clamp(value);
    const currentAngleDeg = startAngleDeg + v * totalAngleDeg;
    const sweepDeg = v * totalAngleDeg;
    const largeArcFlag = sweepDeg >= 180 ? 1 : 0;

    const start = polarToCartesian(center, center, radius, startAngleDeg);
    const end = polarToCartesian(center, center, radius, currentAngleDeg);
    const trackEnd = polarToCartesian(center, center, radius, endAngleDeg);

    const trackD = `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${trackEnd.x} ${trackEnd.y}`;
    const valueD = `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;

    return (
      <div style={styles.sequencerSmallKnob}>
        <div style={styles.sequencerSmallKnobLabel}>{label}</div>
        <div
          style={{
            width: size,
            height: size,
            position: 'relative',
            cursor: 'pointer',
          }}
          onMouseDown={(e) => {
            const startY = e.clientY;
            const startValue = value;
            const handleMove = (moveEvent) => {
              const delta = (startY - moveEvent.clientY) / 150;
              onChange(Math.max(0, Math.min(1, startValue + delta)));
            };
            const handleUp = () => {
              document.removeEventListener('mousemove', handleMove);
              document.removeEventListener('mouseup', handleUp);
            };
            document.addEventListener('mousemove', handleMove);
            document.addEventListener('mouseup', handleUp);
          }}
        >
          <svg width={size} height={size} style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="none">
            <path d={trackD} fill="none" stroke="#333" strokeWidth={3} strokeLinecap="round" />
            <path d={valueD} fill="none" stroke="#007aff" strokeWidth={3} strokeLinecap="round" />
          </svg>
        </div>
        <div style={styles.sequencerSmallKnobValue}>{Math.round(v * 100)}</div>
      </div>
    );
  };

  // Waveform SVG generator - Fixed for 100x50 viewbox
  // Serum-Style ADSR Visualizer — Shared Source of Truth proportional math (matches AudioEngine)
  const ADSRVisualizer = ({ attack, decay, sustain, release }) => {
    // Convert 0-1 to 0-100 for calculations
    const seqAttack = attack * 100;
    const seqDecay = decay * 100;
    const seqSustain = sustain * 100;
    const seqRelease = release * 100;
    
    // X-axis: 80 represents the 80% gate drop (same as audio engine)
    const attackRatio = seqAttack / 100;
    const aX = attackRatio * 80;

    const decayRatio = seqDecay / 100;
    const remainingX = 80 - aX;
    const dX = aX + (decayRatio * remainingX);

    const sY = 100 - seqSustain;
    const rX = 80 + ((seqRelease / 100) * 20); // Release tail past the gate

    // Connect the points (viewBox 0 0 100 100)
    const points = `0,100 ${aX},0 ${dX},${sY} 80,${sY} ${rX},100`;
    
    return (
      <svg
        width={200}
        height={80}
        viewBox="0 0 100 100"
        style={{
          background: '#111',
          borderRadius: '4px',
          border: '1px solid #333',
        }}
      >
        <line x1="0" y1="50" x2="100" y2="50" stroke="#222" strokeWidth="0.5" strokeDasharray="2,2" />
        <line x1="80" y1="0" x2="80" y2="100" stroke="#222" strokeWidth="0.5" strokeDasharray="2,2" />
        <polyline
          points={points}
          fill="none"
          stroke="#00FFFF"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  };

  const getWaveformSVG = (type) => {
    const width = 100;
    const height = 50;
    const centerY = height / 2;
    const padding = 5;
    const waveWidth = width - padding * 2;
    const waveHeight = height - padding * 2;
    const topY = padding;
    const bottomY = height - padding;
    
    let path = '';
    switch(type) {
      case 'sine': {
        // Smooth sine wave curve
        const points = [];
        for (let i = 0; i <= 60; i++) {
          const x = padding + (i / 60) * waveWidth;
          const y = centerY + Math.sin(i * Math.PI * 4 / 60) * (waveHeight / 2 - 2);
          points.push(`${x},${y}`);
        }
        path = `M ${points.join(' L ')}`;
        break;
      }
      case 'triangle': {
        // Sharp linear rise and fall (pyramid shape)
        const midX = width / 2;
        path = `M ${padding} ${bottomY} L ${midX} ${topY} L ${width - padding} ${bottomY}`;
        break;
      }
      case 'square': {
        // Strict stepping line: horizontal, vertical drop, horizontal, vertical rise
        const midX = width / 2;
        path = `M ${padding} ${topY} L ${midX} ${topY} L ${midX} ${bottomY} L ${width - padding} ${bottomY} L ${width - padding} ${topY}`;
        break;
      }
      case 'saw': {
        // Diagonal ramp with straight vertical drop
        const midX = width / 2;
        path = `M ${padding} ${bottomY} L ${midX} ${topY} L ${midX} ${bottomY} L ${width - padding} ${bottomY}`;
        break;
      }
      default:
        path = `M ${padding} ${centerY} L ${width - padding} ${centerY}`;
    }
    
    return (
      <svg width={100} height={50} viewBox="0 0 100 50" style={{ display: 'block' }}>
        <path
          d={path}
          fill="none"
          stroke="#007aff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  };

  // Parameter Library Data
  const parameterLibrary = {
    Envelope: ['Attack', 'Decay', 'Sustain', 'Release'],
    Filter: ['Cutoff', 'Res', 'Drive', 'Env Amt'],
    Oscillator: ['Detune', 'Blend', 'Glide', 'Sub', 'Noise'],
    Effects: ['Bitcrush', 'Chorus', 'Delay Mix', 'Delay Time', 'Reverb Size', 'Reverb Mix', 'Pan'],
  };

  // Styles object
  const styles = {
    studioLayout: {
      display: 'flex',
      justifyContent: 'center',
      gap: '20px',
      alignItems: 'flex-start',
      width: '100%',
      maxWidth: '1200px',
      margin: '0 auto',
      padding: '20px',
    },
    container: {
      width: '100%',
      maxWidth: '720px',
      margin: '0',
      background: '#2b2b2b',
      borderRadius: '8px',
      paddingTop: '0',
      paddingRight: '0',
      paddingBottom: '0',
      paddingLeft: '0',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '12px',
      color: '#fff',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
    },
    dragHandle: {
      height: '20px',
      background: '#2b2b2b',
      borderRadius: '8px 8px 0 0',
      cursor: 'move',
      borderBottom: '1px solid #1a1a1a',
      display: 'flex',
      alignItems: 'center',
      padding: '0 8px',
      justifyContent: 'space-between',
    },
    libraryButton: {
      background: 'transparent',
      border: 'none',
      color: '#aaa',
      cursor: 'pointer',
      padding: '4px 8px',
      borderRadius: '4px',
      fontSize: '14px',
      display: 'flex',
      alignItems: 'center',
      transition: 'all 0.2s',
    },
    libraryButtonHover: {
      background: '#333',
      color: '#fff',
    },
    drawer: {
      position: 'fixed',
      left: libraryOpen ? '0' : '-250px',
      top: '0',
      width: '250px',
      height: '100vh',
      background: '#1e1e1e',
      borderRight: '1px solid #333',
      zIndex: 1000,
      transition: 'left 0.3s ease',
      overflowY: 'auto',
      paddingTop: '20px',
      boxShadow: libraryOpen ? '2px 0 8px rgba(0, 0, 0, 0.3)' : 'none',
    },
    drawerOverlay: {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      background: 'rgba(0, 0, 0, 0.3)',
      zIndex: 999,
      opacity: libraryOpen ? 1 : 0,
      pointerEvents: libraryOpen ? 'auto' : 'none',
      transition: 'opacity 0.3s ease',
    },
    drawerHeader: {
      padding: '12px 16px',
      borderBottom: '1px solid #333',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    drawerTitle: {
      fontSize: '14px',
      fontWeight: '600',
      color: '#fff',
    },
    drawerClose: {
      background: 'transparent',
      border: 'none',
      color: '#aaa',
      cursor: 'pointer',
      fontSize: '18px',
      padding: '0',
      width: '24px',
      height: '24px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    drawerCategory: {
      padding: '12px 16px',
      borderBottom: '1px solid #2a2a2a',
    },
    drawerCategoryTitle: {
      fontSize: '11px',
      fontWeight: '600',
      color: '#888',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      marginBottom: '8px',
    },
    drawerChips: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '6px',
    },
    parameterChip: {
      padding: '4px 10px',
      background: '#2a2a2a',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: '#444',
      borderRadius: '12px',
      fontSize: '10px',
      color: '#ccc',
      cursor: 'grab',
      userSelect: 'none',
      transition: 'all 0.2s',
    },
    parameterChipHover: {
      background: '#333',
      borderColor: '#007aff',
      color: '#fff',
      cursor: 'grabbing',
    },
    oscillatorVisor: {
      background: '#111',
      borderRadius: '6px',
      padding: '8px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      border: '1px solid #333',
      minWidth: '180px',
      justifyContent: 'center',
      position: 'relative',
    },
    visorLabel: {
      position: 'absolute',
      top: '4px',
      left: '8px',
      fontSize: '8px',
      color: '#666',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
    },
    visorDisplay: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 1,
      marginTop: '8px',
      position: 'relative',
      minHeight: '50px',
    },
    visorArrow: {
      background: 'transparent',
      border: 'none',
      color: '#666',
      cursor: 'pointer',
      padding: '4px',
      fontSize: '12px',
      display: 'flex',
      alignItems: 'center',
      transition: 'all 0.2s',
    },
    visorArrowHover: {
      color: '#007aff',
    },
    topControls: {
      display: 'flex',
      justifyContent: 'space-between',
      paddingTop: '8px',
      paddingRight: '12px',
      paddingBottom: '8px',
      paddingLeft: '12px',
      background: '#2b2b2b',
      borderBottom: '1px solid #1a1a1a',
    },
    controlGroup: {
      display: 'flex',
      gap: '4px',
    },
    button: {
      padding: '4px 8px',
      borderRadius: '4px',
      border: 'none',
      cursor: 'pointer',
      fontSize: '11px',
      fontWeight: '500',
      minWidth: '32px',
      transition: 'all 0.1s',
    },
    buttonBlue: {
      background: '#007aff',
      color: '#fff',
    },
    buttonBlueActive: {
      background: '#0051d5',
      boxShadow: '0 0 8px rgba(0, 122, 255, 0.6)',
    },
    buttonPurple: {
      background: '#af52de',
      color: '#fff',
    },
    buttonPurpleActive: {
      background: '#8e3fc1',
      boxShadow: '0 0 8px rgba(175, 82, 222, 0.6)',
    },
    oscillatorPad: {
      padding: '12px 20px',
      borderRadius: '12px',
      border: 'none',
      cursor: 'pointer',
      fontSize: '16px',
      fontWeight: '700',
      minWidth: '48px',
      minHeight: '44px',
      transition: 'all 0.1s',
      background: '#007aff',
      color: '#fff',
      boxShadow: '0 4px 0 rgba(0,0,0,0.2)',
    },
    oscillatorPadActive: {
      background: '#0051d5',
      boxShadow: '0 4px 0 rgba(0,0,0,0.25)',
    },
    oscillatorPadPressed: {
      transform: 'translateY(2px)',
      boxShadow: '0 2px 0 rgba(0,0,0,0.2)',
    },
    modePad: {
      padding: '12px 20px',
      borderRadius: '12px',
      border: 'none',
      cursor: 'pointer',
      fontSize: '14px',
      fontWeight: '700',
      minWidth: '56px',
      minHeight: '44px',
      transition: 'all 0.1s',
      boxShadow: '0 4px 0 rgba(0,0,0,0.2)',
    },
    modePadMono: {
      background: '#f0f0f0',
      color: '#333',
    },
    modePadPoly: {
      background: '#bd00ff',
      color: '#fff',
    },
    modePadPressed: {
      transform: 'translateY(2px)',
      boxShadow: '0 2px 0 rgba(0,0,0,0.2)',
    },
    buttonGreen: {
      background: '#28cd41',
      color: '#fff',
    },
    buttonGreenActive: {
      background: '#1fa832',
      boxShadow: '0 0 8px rgba(40, 205, 65, 0.6)',
    },
    buttonOrange: {
      background: '#ff9500',
      color: '#fff',
    },
    buttonOrangeActive: {
      background: '#cc7700',
      boxShadow: '0 0 8px rgba(255, 149, 0, 0.6)',
    },
    keyboardSection: {
      display: 'flex',
      alignItems: 'flex-end',
      paddingTop: '12px',
      paddingRight: '12px',
      paddingBottom: '12px',
      paddingLeft: '12px',
      background: '#2b2b2b',
      position: 'relative',
      minHeight: '140px',
    },
    sustainButton: {
      width: '60px',
      height: '120px',
      background: sustain ? '#1fa832' : '#28cd41',
      color: '#fff',
      border: 'none',
      borderRadius: '4px',
      marginRight: '8px',
      cursor: 'pointer',
      fontSize: '11px',
      fontWeight: '600',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      transition: 'all 0.1s',
      boxShadow: sustain ? '0 0 8px rgba(40, 205, 65, 0.6)' : 'none',
    },
    pianoContainer: {
      display: 'flex',
      position: 'relative',
      flex: 1,
    },
    whiteKey: {
      flex: 1,
      minWidth: 0,
      height: '120px',
      background: '#fff',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: '#ccc',
      borderRightWidth: '1px',
      borderRadius: '0 0 4px 4px',
      position: 'relative',
      cursor: 'pointer',
      transition: 'all 0.1s',
    },
    whiteKeyActive: {
      background: '#007aff',
      borderColor: '#007aff',
      boxShadow: '0 0 12px rgba(0, 122, 255, 0.8)',
      zIndex: 5,
    },
    whiteKeyHeld: {
      position: 'relative',
      background: '#007aff',
      borderColor: '#0051d5',
      boxShadow: '0 0 12px rgba(0, 122, 255, 0.8)',
      zIndex: 5,
      opacity: 1,
      transform: 'translateY(2px)',
    },
    whiteKeyLatched: {
      position: 'relative',
      background: '#00e5ff',
      borderColor: 'rgba(0, 229, 255, 0.8)',
      boxShadow: '0 0 8px rgba(0, 229, 255, 0.5)',
      zIndex: 5,
      animation: 'breathe 1.5s ease-in-out infinite',
    },
    whiteKeyLabel: {
      position: 'absolute',
      bottom: '4px',
      left: '4px',
      fontSize: '10px',
      fontWeight: '600',
      color: '#333',
    },
    whiteKeyLabelActive: {
      color: '#fff',
    },
    blackKey: {
      position: 'absolute',
      width: '20px',
      height: '70px',
      background: '#000',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: '#333',
      borderRadius: '0 0 3px 3px',
      cursor: 'pointer',
      transition: 'all 0.1s',
      zIndex: 10,
    },
    blackKeyActive: {
      background: '#007aff',
      borderColor: '#0051d5',
      boxShadow: '0 0 12px rgba(0, 122, 255, 0.8)',
    },
    blackKeyHeld: {
      position: 'absolute',
      background: '#007aff',
      borderColor: '#0051d5',
      boxShadow: '0 0 12px rgba(0, 122, 255, 0.8)',
      opacity: 1,
      transform: 'translateY(2px)',
    },
    blackKeyLatched: {
      position: 'absolute',
      background: '#00e5ff',
      borderColor: 'rgba(0, 229, 255, 0.8)',
      boxShadow: '0 0 8px rgba(0, 229, 255, 0.5)',
      animation: 'breathe 1.5s ease-in-out infinite',
    },
    blackKeyLabel: {
      position: 'absolute',
      bottom: '4px',
      left: '50%',
      transform: 'translateX(-50%)',
      fontSize: '9px',
      fontWeight: '600',
      color: '#aaa',
    },
    blackKeyLabelActive: {
      color: '#fff',
    },
    bottomControls: {
      display: 'flex',
      justifyContent: 'space-between',
      padding: '8px 12px',
      background: '#2b2b2b',
      borderTop: '1px solid #1a1a1a',
      borderRadius: '0 0 8px 8px',
    },
    sequencerSidecar: {
      width: '380px',
      background: '#2b2b2b',
      borderRadius: '8px',
      padding: '16px',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    },
    sequencerMasterLCD: {
      background: 'radial-gradient(circle, #1a1a1a 0%, #000000 100%)',
      border: '1px solid #333',
      borderRadius: '4px',
      padding: '10px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '15px',
    },
    sequencerLCDPlayStatus: {
      cursor: 'pointer',
      fontFamily: 'monospace',
      fontSize: '12px',
      fontWeight: '700',
      background: 'none',
      border: 'none',
      padding: 0,
      minWidth: '36px',
    },
    sequencerLCDBPM: {
      width: '48px',
      fontFamily: 'monospace',
      fontSize: '14px',
      fontWeight: '600',
      color: '#0f0',
      background: 'transparent',
      border: 'none',
      textAlign: 'center',
      outline: 'none',
      textShadow: '0 0 5px rgba(0, 255, 0, 0.6)',
    },
    sequencerLCDWaveform: {
      width: '80px',
      height: '30px',
      background: 'transparent',
      cursor: 'pointer',
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    sequencerModuleBay: {
      background: 'rgba(0,0,0,0.3)',
      borderRadius: '8px',
      boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.6)',
      padding: '10px',
    },
    sequencerADSRStrip: {
      display: 'flex',
      gap: '8px',
      justifyContent: 'space-around',
      padding: '8px',
    },
    sequencerSmallKnob: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '4px',
    },
    sequencerSmallKnobLabel: {
      fontSize: '10px',
      color: '#888',
      textTransform: 'uppercase',
      fontWeight: '600',
    },
    sequencerSmallKnobValue: {
      fontSize: '9px',
      color: '#fff',
      fontFamily: 'monospace',
    },
    sequencerFxRack: {
      padding: '12px',
    },
    sequencerFxLabel: {
      fontSize: '11px',
      fontWeight: '600',
      color: '#aaa',
      marginBottom: '12px',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
    },
    sequencerFxSlotsGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: '8px',
      justifyContent: 'center',
    },
    sequencerEmptySlot: {
      width: '60px',
      height: '60px',
      position: 'relative',
      opacity: 0.4,
      border: '1px dashed #666',
      borderRadius: '50%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      margin: '0 auto',
    },
    sequencerEmptySlotIndicator: {
      position: 'absolute',
      width: '2px',
      height: '15px',
      background: '#666',
      borderRadius: '2px',
      top: '6px',
      left: '50%',
      transform: 'translateX(-50%)',
      opacity: 0.4,
    },
    sequencerEmptySlotPlus: {
      fontSize: '24px',
      fontWeight: '100',
      color: '#666',
      lineHeight: '1',
      marginBottom: '2px',
      position: 'relative',
      zIndex: 2,
    },
    sequencerEmptySlotLabel: {
      fontSize: '7px',
      color: '#666',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      position: 'relative',
      zIndex: 2,
    },
    sequencerVoiceSection: {
      padding: '12px',
      background: '#1a1a1a',
      borderRadius: '6px',
      border: '1px solid #333',
    },
    sequencerVoiceLabel: {
      fontSize: '11px',
      fontWeight: '600',
      color: '#aaa',
      marginBottom: '12px',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
    },
    sequencerKnobsRow: {
      display: 'flex',
      gap: '12px',
      justifyContent: 'space-around',
    },
    sequencerKnob: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '6px',
    },
    sequencerKnobLabel: {
      fontSize: '9px',
      color: '#888',
      textTransform: 'uppercase',
    },
    sequencerKnobValue: {
      fontSize: '10px',
      color: '#fff',
      fontFamily: 'monospace',
    },
    sequencerStepRail: {
      background: 'rgba(0,0,0,0.3)',
      borderRadius: '8px',
      boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.6)',
      padding: '10px',
    },
    sequencerStepsGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(8, 1fr)',
      gridTemplateRows: 'repeat(2, 1fr)',
      gap: '6px',
    },
    sequencerStepButton: {
      width: '40px',
      height: '40px',
      borderRadius: '4px',
      border: '1px solid #333',
      borderBottom: '2px solid rgba(0,0,0,0.5)',
      background: 'linear-gradient(180deg, #333 0%, #222 100%)',
      cursor: 'pointer',
      position: 'relative',
      transition: 'all 0.1s',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '10px',
      color: '#666',
    },
    sequencerStepButtonDownbeat: {
      background: 'linear-gradient(180deg, #444 0%, #333 100%)',
    },
    sequencerStepButtonActive: {
      background: '#ff9500',
      borderColor: '#ff9500',
      borderBottomColor: '#cc7700',
      boxShadow: '0 0 8px #ff9900',
      color: '#fff',
    },
    sequencerStepButtonTied: {
      background: '#ffeb3b',
      borderColor: '#ffeb3b',
      borderBottomColor: '#ccbb00',
      boxShadow: '0 0 8px #ffeb3b',
      color: '#000',
    },
    sequencerStepButtonCurrent: {
      borderColor: '#fff',
      borderWidth: '2px',
      boxShadow: '0 0 12px rgba(255, 255, 255, 0.8)',
    },
    sequencerStepButtonRecordingCursor: {
      borderColor: '#f00',
      borderWidth: '2px',
      boxShadow: '0 0 8px rgba(255, 0, 0, 0.8)',
    },
    sequencerRecButton: {
      padding: '4px 8px',
      height: '28px',
      borderRadius: '4px',
      border: '1px solid #555',
      background: '#333',
      color: '#888',
      cursor: 'pointer',
      fontSize: '9px',
      fontWeight: '700',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: '50px',
    },
    sequencerRecButtonActive: {
      background: '#f00',
      color: '#fff',
      borderColor: '#f00',
    },
    sequencerRestButton: {
      padding: '4px 8px',
      borderRadius: '4px',
      border: '1px solid #555',
      background: '#333',
      color: '#fff',
      cursor: 'pointer',
      fontSize: '9px',
      fontWeight: '600',
    },
    sequencerClearButton: {
      padding: '4px 8px',
      borderRadius: '4px',
      border: '1px solid #555',
      background: '#333',
      color: '#888',
      cursor: 'pointer',
      fontSize: '9px',
      fontWeight: '600',
    },
    controlLabel: {
      fontSize: '10px',
      color: '#aaa',
      marginBottom: '4px',
    },
    controlValue: {
      fontSize: '14px',
      fontWeight: '600',
      color: '#fff',
    },
    controlRack: {
      padding: '16px 12px',
      background: '#2b2b2b',
      borderTop: '1px solid #1a1a1a',
      borderBottom: '1px solid #1a1a1a',
    },
    controlRackGrid: {
      display: 'grid',
      gridTemplateColumns: '1fr 2fr 1fr',
      gap: '16px',
      alignItems: 'start',
    },
    knobGrid: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '12px',
    },
    ghostKnob: {
      width: '80px',
      height: '80px',
      position: 'relative',
      opacity: 0.4,
      border: '1px dashed #666',
      borderRadius: '50%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'radial-gradient(circle at center, rgba(255,255,255,0.05) 0%, transparent 70%)',
      cursor: 'pointer',
      boxShadow: 'inset 0 2px 4px rgba(0, 0, 0, 0.3)',
    },
    ghostKnobIndicator: {
      position: 'absolute',
      width: '3px',
      height: '20px',
      background: '#666',
      borderRadius: '2px',
      top: '8px',
      left: '50%',
      transform: 'translateX(-50%)',
      opacity: 0.4,
    },
    ghostKnobPlus: {
      fontSize: '32px',
      fontWeight: '100',
      color: '#666',
      lineHeight: '1',
      marginBottom: '4px',
      position: 'relative',
      zIndex: 2,
    },
    ghostKnobLabel: {
      fontSize: '9px',
      color: '#666',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      position: 'relative',
      zIndex: 2,
    },
    ghostKnobDragOver: {
      background: '#444',
      borderColor: '#fff',
      boxShadow: '0 0 8px rgba(255, 255, 255, 0.5)',
      opacity: 1,
    },
    activeKnobContainer: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      width: '80px',
      userSelect: 'none',
      transition: 'opacity 0.2s, filter 0.2s',
    },
    activeKnobContainerDragging: {
      opacity: 0.4,
      filter: 'grayscale(100%) brightness(0.7)',
    },
    activeKnob: {
      width: '80px',
      height: '80px',
      position: 'relative',
      opacity: 1,
      border: '1px solid #555',
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'radial-gradient(circle at center, rgba(255,255,255,0.1) 0%, rgba(0,0,0,0.3) 70%)',
      cursor: 'ns-resize',
      boxShadow: 'inset 0 2px 4px rgba(0, 0, 0, 0.3), 0 2px 8px rgba(0, 0, 0, 0.2)',
    },
    activeKnobLabel: {
      fontSize: '11px',
      color: '#888',
      textTransform: 'uppercase',
      letterSpacing: '1px',
      marginTop: '8px',
      cursor: 'grab',
      textAlign: 'center',
      transition: 'color 0.2s',
    },
    activeKnobLabelHover: {
      color: '#fff',
    },
    parameterChipDisabled: {
      opacity: 0.3,
      color: '#666',
      borderColor: '#333',
      cursor: 'not-allowed',
    },
    morphPadContainer: {
      display: 'flex',
      gap: '12px',
      justifyContent: 'center',
    },
    morphPad: {
      width: '140px',
      height: '140px',
      background: '#111',
      borderRadius: '8px',
      position: 'relative',
      border: '1px solid #333',
      boxShadow: 'inset 0 2px 4px rgba(0, 0, 0, 0.5)',
      cursor: 'crosshair',
    },
    morphPadPuck: {
      position: 'absolute',
      width: '12px',
      height: '12px',
      borderRadius: '50%',
      background: '#007aff',
      boxShadow: '0 0 8px rgba(0, 122, 255, 0.8), 0 0 16px rgba(0, 122, 255, 0.4)',
      transform: 'translate(-50%, -50%)',
      left: '50%',
      top: '50%',
    },
    morphPadLabelX: {
      position: 'absolute',
      bottom: '4px',
      left: '50%',
      transform: 'translateX(-50%)',
      fontSize: '8px',
      color: '#666',
      textTransform: 'uppercase',
    },
    morphPadLabelY: {
      position: 'absolute',
      left: '4px',
      top: '50%',
      transform: 'translateY(-50%) rotate(-90deg)',
      fontSize: '8px',
      color: '#666',
      textTransform: 'uppercase',
    },
  };

  // Calculate black key positions
  const getBlackKeyLeft = (whiteKeyIndex) => {
    // Calculate percentage position: each white key is 1/11 of the container width (11 white keys)
    const whiteKeyWidthPercent = 100 / 11; // ~9.09% per white key
    return `${whiteKeyIndex * whiteKeyWidthPercent + whiteKeyWidthPercent * 0.6}%`;
  };

  return (
    <React.Fragment>
      <style dangerouslySetInnerHTML={{ __html: '@keyframes breathe { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.9; } } body, #root { user-select: none; -webkit-user-select: none; }' }} />
      {/* Drawer Overlay */}
      {libraryOpen && (
        <div
          style={styles.drawerOverlay}
          onClick={() => setLibraryOpen(false)}
        />
      )}

      {/* Parameter Library Drawer */}
      <div style={styles.drawer}>
        <div style={styles.drawerHeader}>
          <div style={styles.drawerTitle}>Parameter Library</div>
          <button
            style={styles.drawerClose}
            onClick={() => setLibraryOpen(false)}
          >
            ×
          </button>
        </div>
        {Object.entries(parameterLibrary).map(([category, params]) => (
          <div key={category} style={styles.drawerCategory}>
            <div style={styles.drawerCategoryTitle}>{category}</div>
            <div style={styles.drawerChips}>
              {params.map((param) => {
                const inMainSynth = isEffectInMainSynth(param);
                const inSequencer = isEffectInSequencer(param);
                return (
                  <div
                    key={param}
                    style={{
                      ...styles.parameterChip,
                      ...(hoveredChip === param ? styles.parameterChipHover : {}),
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                    draggable={true}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', param);
                      setLibraryOpen(false); // Auto-close drawer when dragging starts
                    }}
                    onMouseEnter={() => setHoveredChip(param)}
                    onMouseLeave={() => setHoveredChip(null)}
                  >
                    {/* LED 1: Main Synth Indicator */}
                    <div
                      style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        backgroundColor: inMainSynth ? '#00aaff' : 'rgba(0, 170, 255, 0.2)',
                        boxShadow: inMainSynth ? '0 0 5px #00aaff' : 'none',
                        flexShrink: 0,
                      }}
                    />
                    {/* LED 2: Sequencer Indicator */}
                    <div
                      style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        backgroundColor: inSequencer ? '#ff9900' : 'rgba(255, 153, 0, 0.2)',
                        boxShadow: inSequencer ? '0 0 5px #ff9900' : 'none',
                        flexShrink: 0,
                      }}
                    />
                    <span>{param}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Studio Layout Wrapper */}
      <div style={styles.studioLayout}>
      <div
        style={{
          ...styles.container,
          ...(isExpanded ? { paddingBottom: '220px' } : {}),
          transition: 'padding 0.4s ease-out',
        }}
        onMouseDown={() => {
          // Audio wake-up: Resume audio context on first user interaction
          window.globalAudioContext?.resume();
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (draggingKnob !== null) {
            const src = draggingKnob;
            setAssignedSlots(prev => {
              const next = [...prev];
              next[src] = null;
              return next;
            });
            setSlotValues(prev => {
              const next = [...prev];
              next[src] = 0.5;
              return next;
            });
            setDraggingKnob(null);
            isDropSuccessful.current = true;
          }
        }}
      >
        {/* Vertical flex wrapper: squeeze layout when Spectrum Lab is expanded */}
        <div style={{ transition: 'all 0.4s ease-out' }}>
        {/* Header: Drag Handle + Top Controls — fixed at top when expanded */}
        <div
          style={{
            ...(isExpanded ? { position: 'sticky', top: 0, zIndex: 10, background: '#2b2b2b' } : {}),
          }}
        >
        {/* Drag Handle */}
        <div style={styles.dragHandle}>
          <button
            style={styles.libraryButton}
            onClick={() => setLibraryOpen(!libraryOpen)}
            title="Parameter Library"
          >
            📚
          </button>
          <div style={{ flex: 1 }}></div>
        </div>

      {/* Top Control Strip */}
      <div
        style={{
          ...styles.topControls,
          ...(isExpanded ? { paddingBottom: '6px' } : {}),
        }}
      >
        <div style={styles.controlGroup}>
          <button
            type="button"
            style={{
              ...styles.oscillatorPad,
              ...(selectedOscillator === 1 ? styles.oscillatorPadActive : {}),
              ...(padPressed.osc1 ? styles.oscillatorPadPressed : {}),
            }}
            onClick={() => setSelectedOscillator(1)}
            onMouseDown={() => setPadPressed((p) => ({ ...p, osc1: true }))}
            onMouseUp={() => setPadPressed((p) => ({ ...p, osc1: false }))}
            onMouseLeave={() => setPadPressed((p) => ({ ...p, osc1: false }))}
            title="Oscillator 1"
          >
            1
          </button>
          <button
            type="button"
            style={{
              ...styles.oscillatorPad,
              ...(selectedOscillator === 2 ? styles.oscillatorPadActive : {}),
              ...(padPressed.osc2 ? styles.oscillatorPadPressed : {}),
            }}
            onClick={() => setSelectedOscillator(2)}
            onMouseDown={() => setPadPressed((p) => ({ ...p, osc2: true }))}
            onMouseUp={() => setPadPressed((p) => ({ ...p, osc2: false }))}
            onMouseLeave={() => setPadPressed((p) => ({ ...p, osc2: false }))}
            title="Oscillator 2"
          >
            2
          </button>
          <button
            type="button"
            style={{
              ...styles.modePad,
              ...(isPoly ? styles.modePadPoly : styles.modePadMono),
              ...(padPressed.mode ? styles.modePadPressed : {}),
            }}
            onClick={() => {
              const next = !isPoly;
              setIsPoly(next);
              setPolyphony(next);
            }}
            onMouseDown={() => setPadPressed((p) => ({ ...p, mode: true }))}
            onMouseUp={() => setPadPressed((p) => ({ ...p, mode: false }))}
            onMouseLeave={() => setPadPressed((p) => ({ ...p, mode: false }))}
            title={isPoly ? 'Polyphonic (chords)' : 'Monophonic (one note)'}
          >
            {isPoly ? 'POLY' : 'MONO'}
          </button>
          
          {/* Scale Selector */}
          <select
            value={selectedScale}
            onChange={(e) => {
              setSelectedScale(e.target.value);
              e.target.blur(); // Release focus immediately after selection
            }}
            onKeyDown={(e) => {
              // Prevent keyboard navigation through dropdown (except Escape/Enter)
              // This prevents accidental scale switching when user intends to play notes
              if (e.key !== 'Escape' && e.key !== 'Enter' && e.key !== 'Tab') {
                e.stopPropagation();
                // Blur immediately to return focus to window
                if (e.key.length === 1 || e.key.startsWith('Arrow')) {
                  e.target.blur();
                }
              }
            }}
            style={{
              backgroundColor: '#333',
              color: '#fff',
              border: '1px solid #555',
              borderRadius: '6px',
              padding: '0px 2px',
              fontSize: '11px',
              fontFamily: 'inherit',
              cursor: 'pointer',
              width: '80px',
              marginLeft: '12px',
            }}
          >
            <option value="">- Key -</option>
            {/* Major Keys */}
            <option value="C Major">C Major</option>
            <option value="C# Major">C# Major</option>
            <option value="D Major">D Major</option>
            <option value="D# Major">D# Major</option>
            <option value="E Major">E Major</option>
            <option value="F Major">F Major</option>
            <option value="F# Major">F# Major</option>
            <option value="G Major">G Major</option>
            <option value="G# Major">G# Major</option>
            <option value="A Major">A Major</option>
            <option value="A# Major">A# Major</option>
            <option value="B Major">B Major</option>
            {/* Minor Keys */}
            <option value="C Minor">C Minor</option>
            <option value="C# Minor">C# Minor</option>
            <option value="D Minor">D Minor</option>
            <option value="D# Minor">D# Minor</option>
            <option value="E Minor">E Minor</option>
            <option value="F Minor">F Minor</option>
            <option value="F# Minor">F# Minor</option>
            <option value="G Minor">G Minor</option>
            <option value="G# Minor">G# Minor</option>
            <option value="A Minor">A Minor</option>
            <option value="A# Minor">A# Minor</option>
            <option value="B Minor">B Minor</option>
          </select>
        </div>

        {/* Oscillator Visor */}
        <div style={styles.oscillatorVisor}>
          <div style={styles.visorLabel}>OSC A</div>
          <button
            style={{
              ...styles.visorArrow,
              position: 'absolute',
              top: '4px',
              right: '8px',
              fontSize: '14px',
            }}
            onClick={() => setIsExpanded(!isExpanded)}
            onMouseEnter={(e) => e.currentTarget.style.color = '#007aff'}
            onMouseLeave={(e) => e.currentTarget.style.color = '#666'}
            title={isExpanded ? 'Collapse Spectrum Lab' : 'Expand Spectrum Lab'}
          >
            ⤢
          </button>
          <button
            style={styles.visorArrow}
            onClick={() => cycleWaveform('prev')}
            onMouseEnter={(e) => e.currentTarget.style.color = '#007aff'}
            onMouseLeave={(e) => e.currentTarget.style.color = '#666'}
          >
            ‹
          </button>
          <div
            ref={visorDisplayRef}
            style={styles.visorDisplay}
            onClick={() => {
              if (!isAudioPlaying || window.globalAudioContext?.state === 'suspended') {
                resumeAudioContext();
                if (window.globalAnalyser) analyserRef.current = window.globalAnalyser;
              }
            }}
          >
            {/* Restored dual-view: when playing, show dancing bars; else static waveform. Stays inside vertical flex / squeezed layout. */}
            {isAudioPlaying && analyserRef.current
              ? <SpectrumAnalyzer analyzer={analyserRef.current} />
              : getWaveformSVG(waveform)
            }
            {showDebug && (
              <DiagnosticProbe
                audioPlaying={isAudioPlaying}
                analyzer={analyserRef.current}
                width={visorSize.width}
                height={visorSize.height}
              />
            )}
          </div>
          <button
            style={styles.visorArrow}
            onClick={() => cycleWaveform('next')}
            onMouseEnter={(e) => e.currentTarget.style.color = '#007aff'}
            onMouseLeave={(e) => e.currentTarget.style.color = '#666'}
          >
            ›
          </button>
        </div>

        <div style={styles.controlGroup}>
          {[3, 4, 5, 6, 7, 8].map(num => (
            <button
              key={num}
              style={{
                ...styles.button,
                ...styles.buttonPurple,
                ...(modulation >= (num - 3) * 25.4 && modulation < (num - 2) * 25.4 ? styles.buttonPurpleActive : {}),
              }}
              onMouseDown={() => setModulation((num - 3) * 25.4)}
              onMouseUp={() => setModulation(0)}
            >
              {num}
            </button>
          ))}
        </div>
      </div>
        </div>

      {/* Keyboard Section — reduced height when expanded; extra bottom padding to clear footer */}
      <div
        style={{
          ...styles.keyboardSection,
          transition: 'padding 0.4s ease-out, min-height 0.4s ease-out',
          ...(isExpanded ? {
            paddingTop: '6px',
            paddingRight: '12px',
            paddingBottom: '20px',
            paddingLeft: '12px',
            minHeight: '105px',
          } : {}),
        }}
      >
        {/* Sustain Button */}
        <button
          style={{
            ...styles.sustainButton,
            ...(isExpanded ? { height: '90px' } : {}),
          }}
          onMouseDown={() => setSustain(true)}
          onMouseUp={() => setSustain(false)}
        >
          <div style={{ fontSize: '10px', marginBottom: '4px' }}>SUSTAIN</div>
          <div style={{ fontSize: '16px', fontWeight: 'bold' }}>Tab</div>
        </button>

        {/* Piano Keys */}
        <div style={styles.pianoContainer}>
          {/* White Keys */}
          {PIANO_KEYS.filter(k => !k.isBlack).map((keyInfo, index, arr) => {
            const isHeld = pressedKeys.has(keyInfo.key);
            let keyFreq = getFrequencyFromIndex(keyInfo.absoluteIndex, octave);
            if (pitchBend !== 0) keyFreq = keyFreq * Math.pow(2, pitchBend / 12);
            const isSounding = visualState.active.some((f) => Math.abs(f - keyFreq) < 1);
            const isLatched = isSounding && !isHeld;
            const isLastWhiteKey = index === arr.length - 1;
            return (
              <div
                key={`white-${keyInfo.key}`}
                style={{
                  ...styles.whiteKey,
                  ...(isHeld ? styles.whiteKeyHeld : isLatched ? styles.whiteKeyLatched : {}),
                  ...(isLastWhiteKey ? { borderRightWidth: 0 } : {}),
                  ...(isExpanded ? { height: '90px' } : {}),
                }}
                onMouseDown={() => {
                  if (!pressedKeys.has(keyInfo.key)) {
                    const noteName = KEY_TO_NOTE[keyInfo.key];
                    let frequency = getFrequencyFromIndex(keyInfo.absoluteIndex, octave);
                    if (pitchBend !== 0) {
                      frequency = frequency * Math.pow(2, pitchBend / 12);
                    }
                    setPressedKeys(prev => new Set([...prev, keyInfo.key]));
                    setActiveNotes(prev => new Map([...prev, [keyInfo.key, { note: noteName, frequency }]]));
                    if (audioInitialized.current) {
                      addLog('Playing: ' + frequency + 'Hz', 'log');
                      console.log('🎹 UI: Note Down', { frequency, velocity: velocity / 127 });
                      playTone(frequency, waveform, velocity / 127);
                    }
                  }
                }}
                onMouseUp={() => {
                  if (pressedKeys.has(keyInfo.key)) {
                    const noteData = activeNotes.get(keyInfo.key);
                    setPressedKeys(prev => {
                      const newSet = new Set(prev);
                      newSet.delete(keyInfo.key);
                      return newSet;
                    });
                    setActiveNotes(prev => {
                      const newMap = new Map(prev);
                      newMap.delete(keyInfo.key);
                      return newMap;
                    });
                    if (!sustainRef.current && noteData) {
                      addLog('Stopping: ' + noteData.frequency + 'Hz', 'log');
                      stopTone(noteData.frequency);
                    }
                  }
                }}
                onMouseLeave={() => {
                  if (pressedKeys.has(keyInfo.key)) {
                    const noteData = activeNotes.get(keyInfo.key);
                    setPressedKeys(prev => {
                      const newSet = new Set(prev);
                      newSet.delete(keyInfo.key);
                      return newSet;
                    });
                    setActiveNotes(prev => {
                      const newMap = new Map(prev);
                      newMap.delete(keyInfo.key);
                      return newMap;
                    });
                    if (!sustainRef.current && noteData) {
                      addLog('Stopping: ' + noteData.frequency + 'Hz', 'log');
                      stopTone(noteData.frequency);
                    }
                  }
                }}
              >
                <div style={{
                  ...styles.whiteKeyLabel,
                  ...(isHeld || isLatched ? styles.whiteKeyLabelActive : {}),
                }}>
                  {keyInfo.key.toUpperCase()}
                </div>
                {/* Octave label for C keys */}
                {keyInfo.note === 'C' && (
                  <div style={{
                    position: 'absolute',
                    bottom: '22%',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    fontFamily: 'monospace',
                    fontSize: '10px',
                    color: 'rgba(80, 80, 80, 0.7)',
                    textShadow: '0px 1px 0px rgba(255,255,255,0.8)',
                    pointerEvents: 'none',
                    fontWeight: '500',
                  }}>
                    C{octave + Math.floor(keyInfo.absoluteIndex / 12)}
                  </div>
                )}
                {/* Scale indicators */}
                {(() => {
                  const scaleStatus = getScaleNoteStatus(keyInfo.note);
                  if (scaleStatus === 'root') {
                    return (
                      <div style={{
                        position: 'absolute',
                        bottom: '4px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        color: '#FFD700',
                        fontSize: '30px',
                        opacity: 1.0,
                        pointerEvents: 'none',
                        fontWeight: 'bold',
                        zIndex: 20,
                      }}>
                        *
                      </div>
                    );
                  } else if (scaleStatus === 'scale') {
                    return (
                      <div style={{
                        position: 'absolute',
                        bottom: '4px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        color: '#2196F3',
                        fontSize: '24px',
                        opacity: 0.8,
                        pointerEvents: 'none',
                        fontWeight: 'bold',
                        zIndex: 20,
                      }}>
                        •
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>
            );
          })}

          {/* Black Keys */}
          {PIANO_KEYS.filter(k => k.isBlack).map((keyInfo) => {
            const isHeld = pressedKeys.has(keyInfo.key);
            let keyFreq = getFrequencyFromIndex(keyInfo.absoluteIndex, octave);
            if (pitchBend !== 0) keyFreq = keyFreq * Math.pow(2, pitchBend / 12);
            const isSounding = visualState.active.some((f) => Math.abs(f - keyFreq) < 1);
            const isLatched = isSounding && !isHeld;
            const leftPos = getBlackKeyLeft(keyInfo.whiteKeyIndex);
            return (
              <div
                key={`black-${keyInfo.key}`}
                style={{
                  ...styles.blackKey,
                  left: leftPos,
                  ...(isHeld ? styles.blackKeyHeld : isLatched ? styles.blackKeyLatched : {}),
                  ...(isExpanded ? { height: '52px' } : {}),
                }}
                onMouseDown={() => {
                  if (!pressedKeys.has(keyInfo.key)) {
                    const noteName = KEY_TO_NOTE[keyInfo.key];
                    let frequency = getFrequencyFromIndex(keyInfo.absoluteIndex, octave);
                    if (pitchBend !== 0) {
                      frequency = frequency * Math.pow(2, pitchBend / 12);
                    }
                    setPressedKeys(prev => new Set([...prev, keyInfo.key]));
                    setActiveNotes(prev => new Map([...prev, [keyInfo.key, { note: noteName, frequency }]]));
                    if (audioInitialized.current) {
                      addLog('Playing: ' + frequency + 'Hz', 'log');
                      console.log('🎹 UI: Note Down', { frequency, velocity: velocity / 127 });
                      playTone(frequency, waveform, velocity / 127);
                    }
                  }
                }}
                onMouseUp={() => {
                  if (pressedKeys.has(keyInfo.key)) {
                    const noteData = activeNotes.get(keyInfo.key);
                    setPressedKeys(prev => {
                      const newSet = new Set(prev);
                      newSet.delete(keyInfo.key);
                      return newSet;
                    });
                    setActiveNotes(prev => {
                      const newMap = new Map(prev);
                      newMap.delete(keyInfo.key);
                      return newMap;
                    });
                    if (!sustainRef.current && noteData) {
                      addLog('Stopping: ' + noteData.frequency + 'Hz', 'log');
                      stopTone(noteData.frequency);
                    }
                  }
                }}
                onMouseLeave={() => {
                  if (pressedKeys.has(keyInfo.key)) {
                    const noteData = activeNotes.get(keyInfo.key);
                    setPressedKeys(prev => {
                      const newSet = new Set(prev);
                      newSet.delete(keyInfo.key);
                      return newSet;
                    });
                    setActiveNotes(prev => {
                      const newMap = new Map(prev);
                      newMap.delete(keyInfo.key);
                      return newMap;
                    });
                    if (!sustainRef.current && noteData) {
                      addLog('Stopping: ' + noteData.frequency + 'Hz', 'log');
                      stopTone(noteData.frequency);
                    }
                  }
                }}
              >
                <div style={{
                  ...styles.blackKeyLabel,
                  ...(isHeld || isLatched ? styles.blackKeyLabelActive : {}),
                }}>
                  {keyInfo.key.toUpperCase()}
                </div>
                {/* Scale indicators */}
                {(() => {
                  const scaleStatus = getScaleNoteStatus(keyInfo.note);
                  if (scaleStatus === 'root') {
                    return (
                      <div style={{
                        position: 'absolute',
                        bottom: '12px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        color: '#FFD700',
                        fontSize: '30px',
                        opacity: 1.0,
                        pointerEvents: 'none',
                        fontWeight: 'bold',
                        zIndex: 20,
                      }}>
                        *
                      </div>
                    );
                  } else if (scaleStatus === 'scale') {
                    return (
                      <div style={{
                        position: 'absolute',
                        bottom: '12px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        color: '#2196F3',
                        fontSize: '24px',
                        opacity: 0.8,
                        pointerEvents: 'none',
                        fontWeight: 'bold',
                        zIndex: 20,
                      }}>
                        •
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>
            );
          })}
        </div>
      </div>

      {/* Modular Smart Control Rack — compact when expanded */}
      <div
        style={{
          ...styles.controlRack,
          transition: 'transform 0.4s ease-out, padding 0.4s ease-out, margin 0.4s ease-out',
          ...(isExpanded
            ? {
                padding: '8px 12px',
                transform: 'scale(0.85)',
                transformOrigin: 'top center',
                margin: '-10px 0',
              }
            : {}),
        }}
      >
        <div
        style={{
          ...styles.controlRackGrid,
          transition: 'gap 0.4s ease-out',
          ...(isExpanded ? { gap: '8px' } : {}),
        }}
        >
          {/* Left Zone: 2x2 Grid of Ghost Knobs */}
          <div style={styles.knobGrid}>
            {[0, 1, 2, 3].map((slotIndex) => {
              const assignedParam = assignedSlots[slotIndex];
              const isDragOver = dragOverSlot === slotIndex;
              
              if (assignedParam) {
                const knobValue = slotValues[slotIndex];
                const isEditing = editingKnob === slotIndex;
                const isDragging = draggingKnob === slotIndex;
                
                return (
                  <div
                    key={`left-knob-${slotIndex}`}
                    style={{
                      ...styles.activeKnobContainer,
                      ...(isDragging ? styles.activeKnobContainerDragging : {}),
                    }}
                    onDragOver={(e) => {
                      if (draggingKnob !== null && draggingKnob !== slotIndex) {
                        e.preventDefault();
                        e.stopPropagation();
                        setDragOverSlot(slotIndex);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (draggingKnob === null || draggingKnob === slotIndex) return;
                      const src = draggingKnob;
                      setAssignedSlots(prev => {
                        const next = [...prev];
                        const a = next[src];
                        next[src] = next[slotIndex];
                        next[slotIndex] = a;
                        return next;
                      });
                      setSlotValues(prev => {
                        const next = [...prev];
                        const a = next[src];
                        next[src] = next[slotIndex];
                        next[slotIndex] = a;
                        return next;
                      });
                      setDraggingKnob(null);
                      setDragOverSlot(null);
                      isDropSuccessful.current = true;
                    }}
                  >
                    <div
                      style={styles.activeKnob}
                      draggable={false}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setEditingKnob(slotIndex);
                        knobDragStartY.current = e.clientY;
                        knobDragStartValue.current = knobValue;
                        
                        const handleMouseMove = (moveEvent) => {
                          const deltaY = knobDragStartY.current - moveEvent.clientY;
                          const sensitivity = 0.005;
                          const newValue = Math.max(0, Math.min(1, knobDragStartValue.current + deltaY * sensitivity));
                          setSlotValues(prev => {
                            const newValues = [...prev];
                            newValues[slotIndex] = newValue;
                            return newValues;
                          });
                        };
                        
                        const handleMouseUp = () => {
                          setEditingKnob(null);
                          document.removeEventListener('mousemove', handleMouseMove);
                          document.removeEventListener('mouseup', handleMouseUp);
                        };
                        
                        document.addEventListener('mousemove', handleMouseMove);
                        document.addEventListener('mouseup', handleMouseUp);
                      }}
                    >
                      <KnobSVG value={knobValue} isDragging={isEditing} label={assignedParam} />
                    </div>
                    <div
                      style={styles.activeKnobLabel}
                      draggable={true}
                      onDragStart={(e) => {
                        isDropSuccessful.current = false;
                        setDraggingKnob(slotIndex);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={(e) => {
                        if (!isDropSuccessful.current) {
                          setAssignedSlots(prev => {
                            const next = [...prev];
                            next[slotIndex] = null;
                            return next;
                          });
                          setSlotValues(prev => {
                            const next = [...prev];
                            next[slotIndex] = 0.5;
                            return next;
                          });
                        }
                        setDraggingKnob(null);
                        isDropSuccessful.current = false;
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = '#888'; }}
                    >
                      {assignedParam}
                    </div>
                  </div>
                );
              } else {
                // Ghost Knob (Empty Slot)
                return (
                  <div
                    key={`left-knob-${slotIndex}`}
                    style={{
                      ...styles.ghostKnob,
                      ...(isDragOver ? styles.ghostKnobDragOver : {}),
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverSlot(slotIndex);
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverSlot(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      isDropSuccessful.current = true;
                      if (draggingKnob === null) {
                        const paramName = e.dataTransfer.getData('text/plain');
                        if (paramName) {
                          // Smart Move: Find if effect already exists, remove it first
                          // Compute existing index before state updates to avoid stale closure
                          const existingIndex = assignedSlots.findIndex(slot => slot === paramName);
                          const existingValue = existingIndex !== -1 ? slotValues[existingIndex] : 0.5;
                          
                          setAssignedSlots(prev => {
                            const next = [...prev];
                            if (existingIndex !== -1 && existingIndex !== slotIndex) {
                              // Remove from old slot
                              next[existingIndex] = null;
                            }
                            // Place in new slot
                            next[slotIndex] = paramName;
                            return next;
                          });
                          setSlotValues(prev => {
                            const next = [...prev];
                            if (existingIndex !== -1 && existingIndex !== slotIndex) {
                              // Move value from old slot
                              next[slotIndex] = existingValue;
                              next[existingIndex] = 0.5;
                            } else {
                              // New effect, default value
                              next[slotIndex] = 0.5;
                            }
                            return next;
                          });
                        }
                      } else {
                        const src = draggingKnob;
                        setAssignedSlots(prev => {
                          const next = [...prev];
                          next[slotIndex] = next[src];
                          next[src] = null;
                          return next;
                        });
                        setSlotValues(prev => {
                          const next = [...prev];
                          next[slotIndex] = next[src];
                          next[src] = 0.5;
                          return next;
                        });
                        setDraggingKnob(null);
                      }
                      setDragOverSlot(null);
                    }}
                  >
                    <div style={styles.ghostKnobIndicator}></div>
                    <div style={styles.ghostKnobPlus}>+</div>
                    <div style={styles.ghostKnobLabel}>Empty Slot</div>
                  </div>
                );
              }
            })}
          </div>

          {/* Center Zone: 2 Large Square XY Morph Pads */}
          <div style={styles.morphPadContainer}>
            {[1, 2].map((index) => (
              <div key={`morph-pad-${index}`} style={styles.morphPad}>
                <div style={styles.morphPadPuck}></div>
                <div style={styles.morphPadLabelX}>Parameter X</div>
                <div style={styles.morphPadLabelY}>Parameter Y</div>
              </div>
            ))}
          </div>

          {/* Right Zone: 2x2 Grid of Ghost Knobs */}
          <div style={styles.knobGrid}>
            {[4, 5, 6, 7].map((slotIndex) => {
              const assignedParam = assignedSlots[slotIndex];
              const isDragOver = dragOverSlot === slotIndex;
              
              if (assignedParam) {
                const knobValue = slotValues[slotIndex];
                const isEditing = editingKnob === slotIndex;
                const isDragging = draggingKnob === slotIndex;
                
                return (
                  <div
                    key={`right-knob-${slotIndex}`}
                    style={{
                      ...styles.activeKnobContainer,
                      ...(isDragging ? styles.activeKnobContainerDragging : {}),
                    }}
                    onDragOver={(e) => {
                      if (draggingKnob !== null && draggingKnob !== slotIndex) {
                        e.preventDefault();
                        e.stopPropagation();
                        setDragOverSlot(slotIndex);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (draggingKnob === null || draggingKnob === slotIndex) return;
                      const src = draggingKnob;
                      setAssignedSlots(prev => {
                        const next = [...prev];
                        const a = next[src];
                        next[src] = next[slotIndex];
                        next[slotIndex] = a;
                        return next;
                      });
                      setSlotValues(prev => {
                        const next = [...prev];
                        const a = next[src];
                        next[src] = next[slotIndex];
                        next[slotIndex] = a;
                        return next;
                      });
                      setDraggingKnob(null);
                      setDragOverSlot(null);
                      isDropSuccessful.current = true;
                    }}
                  >
                    <div
                      style={styles.activeKnob}
                      draggable={false}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setEditingKnob(slotIndex);
                        knobDragStartY.current = e.clientY;
                        knobDragStartValue.current = knobValue;
                        
                        const handleMouseMove = (moveEvent) => {
                          const deltaY = knobDragStartY.current - moveEvent.clientY;
                          const sensitivity = 0.005;
                          const newValue = Math.max(0, Math.min(1, knobDragStartValue.current + deltaY * sensitivity));
                          setSlotValues(prev => {
                            const newValues = [...prev];
                            newValues[slotIndex] = newValue;
                            return newValues;
                          });
                        };
                        
                        const handleMouseUp = () => {
                          setEditingKnob(null);
                          document.removeEventListener('mousemove', handleMouseMove);
                          document.removeEventListener('mouseup', handleMouseUp);
                        };
                        
                        document.addEventListener('mousemove', handleMouseMove);
                        document.addEventListener('mouseup', handleMouseUp);
                      }}
                    >
                      <KnobSVG value={knobValue} isDragging={isEditing} label={assignedParam} />
                    </div>
                    <div
                      style={styles.activeKnobLabel}
                      draggable={true}
                      onDragStart={(e) => {
                        isDropSuccessful.current = false;
                        setDraggingKnob(slotIndex);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={(e) => {
                        if (!isDropSuccessful.current) {
                          setAssignedSlots(prev => {
                            const next = [...prev];
                            next[slotIndex] = null;
                            return next;
                          });
                          setSlotValues(prev => {
                            const next = [...prev];
                            next[slotIndex] = 0.5;
                            return next;
                          });
                        }
                        setDraggingKnob(null);
                        isDropSuccessful.current = false;
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = '#888'; }}
                    >
                      {assignedParam}
                    </div>
                  </div>
                );
              } else {
                return (
                  <div
                    key={`right-knob-${slotIndex}`}
                    style={{
                      ...styles.ghostKnob,
                      ...(isDragOver ? styles.ghostKnobDragOver : {}),
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverSlot(slotIndex);
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverSlot(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      isDropSuccessful.current = true;
                      if (draggingKnob === null) {
                        const paramName = e.dataTransfer.getData('text/plain');
                        if (paramName) {
                          // Smart Move: Find if effect already exists, remove it first
                          setAssignedSlots(prev => {
                            const next = [...prev];
                            // Find existing index of this effect
                            const existingIndex = next.findIndex(slot => slot === paramName);
                            if (existingIndex !== -1 && existingIndex !== slotIndex) {
                              // Remove from old slot
                              next[existingIndex] = null;
                            }
                            // Place in new slot
                            next[slotIndex] = paramName;
                            return next;
                          });
                          setSlotValues(prev => {
                            const next = [...prev];
                            // Find existing index to preserve its value
                            const existingIndex = prev.findIndex((val, idx) => assignedSlots[idx] === paramName);
                            if (existingIndex !== -1 && existingIndex !== slotIndex) {
                              // Move value from old slot
                              next[slotIndex] = prev[existingIndex];
                              next[existingIndex] = 0.5;
                            } else {
                              // New effect, default value
                              next[slotIndex] = 0.5;
                            }
                            return next;
                          });
                        }
                      } else {
                        const src = draggingKnob;
                        setAssignedSlots(prev => {
                          const next = [...prev];
                          next[slotIndex] = next[src];
                          next[src] = null;
                          return next;
                        });
                        setSlotValues(prev => {
                          const next = [...prev];
                          next[slotIndex] = next[src];
                          next[src] = 0.5;
                          return next;
                        });
                        setDraggingKnob(null);
                      }
                      setDragOverSlot(null);
                    }}
                  >
                    <div style={styles.ghostKnobIndicator}></div>
                    <div style={styles.ghostKnobPlus}>+</div>
                    <div style={styles.ghostKnobLabel}>Empty Slot</div>
                  </div>
                );
              }
            })}
          </div>
        </div>
      </div>

      {/* Bottom Control Strip */}
      <div style={styles.bottomControls}>
        <div>
          <div style={styles.controlLabel}>Octave</div>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button
              style={{
                ...styles.button,
                ...styles.buttonOrange,
              }}
              onMouseDown={() => setOctave(prev => Math.max(0, prev - 1))}
            >
              Z
            </button>
            <div style={styles.controlValue}>{getNoteDisplay('C')}</div>
            <button
              style={{
                ...styles.button,
                ...styles.buttonOrange,
              }}
              onMouseDown={() => setOctave(prev => Math.min(8, prev + 1))}
            >
              X
            </button>
          </div>
        </div>
        <div>
          <div style={styles.controlLabel}>Velocity</div>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button
              style={{
                ...styles.button,
                ...styles.buttonOrange,
              }}
              onMouseDown={() => setVelocity(prev => Math.max(0, prev - 1))}
            >
              C
            </button>
            <div style={styles.controlValue}>{velocity}</div>
            <button
              style={{
                ...styles.button,
                ...styles.buttonOrange,
              }}
              onMouseDown={() => setVelocity(prev => Math.min(127, prev + 1))}
            >
              V
            </button>
          </div>
        </div>
      </div>
        </div>
    </div>

      {/* Sequencer Sidecar */}
      <div style={styles.sequencerSidecar}>
        {/* Master LCD (Transport, BPM, Waveform) */}
        <div style={styles.sequencerMasterLCD}>
          <button
            type="button"
            style={{
              ...styles.sequencerLCDPlayStatus,
              color: isPlaying ? '#0f0' : '#f00',
              ...(isPlaying ? { textShadow: '0 0 5px rgba(0, 255, 0, 0.6)' } : {}),
            }}
            onClick={() => setIsPlaying(!isPlaying)}
            title={isPlaying ? 'Stop' : 'Play'}
          >
            {isPlaying ? 'RUN' : 'STOP'}
          </button>
          <button
            type="button"
            style={{
              ...styles.sequencerRecButton,
              ...(isRecording ? styles.sequencerRecButtonActive : {}),
            }}
            onClick={() => {
              const next = !isRecording;
              setIsRecording(next);
              if (next) setRecordingIndex(0); // start at step 1 when turning record on
            }}
            title={isRecording ? 'Stop recording' : 'Record steps'}
            >
            RECORD
          </button>
          {isRecording && (
            <button
              type="button"
              style={styles.sequencerRestButton}
              onClick={() => {
                setSequencerSteps(prev => {
                  const next = prev.map((step, i) =>
                    i === recordingIndex ? { active: false, tied: false, note: null } : step
                  );
                  return next;
                });
                setRecordingIndex(prev => (prev + 1) % 16);
              }}
              title="Insert rest (silence) and advance"
            >
              REST
            </button>
          )}
          <button
            type="button"
            style={{
              ...styles.sequencerClearButton,
              ...(clearButtonHover ? { background: '#522', color: '#f88', borderColor: '#833' } : {}),
            }}
            onMouseEnter={() => setClearButtonHover(true)}
            onMouseLeave={() => setClearButtonHover(false)}
            onClick={() => {
              setSequencerSteps(() =>
                Array.from({ length: 16 }, () => ({ active: false, tied: false, note: null }))
              );
              setRecordingIndex(0);
            }}
            title="Clear all steps"
          >
            CLEAR
          </button>
          <input
            type="number"
            value={bpm}
            onChange={(e) => setBpm(Math.max(1, Math.min(300, parseInt(e.target.value) || 120)))}
            style={styles.sequencerLCDBPM}
            min="1"
            max="300"
            title="BPM"
          />
          <button
            style={{
              ...styles.sequencerLCDWaveform,
              cursor: 'pointer',
            }}
            onClick={() => setSeqWave(seqWave === 'saw' ? 'square' : 'saw')}
            title={`Waveform: ${seqWave} (click to toggle)`}
          >
            {getWaveformSVG(seqWave)}
          </button>
        </div>

        {/* Section B: ADSR Visualizer & Strip (Module Bay) */}
        <div style={styles.sequencerModuleBay}>
          {/* Serum-Style ADSR Visualizer */}
          <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'center' }}>
            <ADSRVisualizer
              attack={seqAttack}
              decay={seqDecay}
              sustain={seqSustain}
              release={seqRelease}
            />
          </div>
          <div style={styles.sequencerADSRStrip}>
            <SmallKnob value={seqAttack} onChange={setSeqAttack} label="ATTACK" />
            <SmallKnob value={seqDecay} onChange={setSeqDecay} label="DECAY" />
            <SmallKnob value={seqSustain} onChange={setSeqSustain} label="SUSTAIN" />
            <SmallKnob value={seqRelease} onChange={setSeqRelease} label="RELEASE" />
          </div>
        </div>

        {/* Section C: Effects Rack (Module Bay) */}
        <div style={styles.sequencerModuleBay}>
          <div style={styles.sequencerFxRack}>
            <div style={styles.sequencerFxLabel}>SEQUENCER FX</div>
            <div style={styles.sequencerFxSlotsGrid}>
              {seqFxSlots.map((fx, index) => {
                const isDragOver = dragOverSeqSlot === index;
                const assignedFx = seqFxSlots[index];
                
                if (assignedFx) {
                  // Active FX slot with interactive knob
                  const knobValue = seqFxValues[index];
                  const isEditing = editingSeqFx === index;
                  const isDragging = draggingSeqFx === index;
                  
                  return (
                    <div
                      key={index}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        width: '60px',
                        userSelect: 'none',
                        ...(isDragging ? { opacity: 0.4, filter: 'grayscale(100%) brightness(0.7)' } : {}),
                      }}
                      onDragOver={(e) => {
                        if (draggingSeqFx !== null && draggingSeqFx !== index) {
                          e.preventDefault();
                          e.stopPropagation();
                          setDragOverSeqSlot(index);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        isSeqFxDropSuccessful.current = true;
                        if (draggingSeqFx !== null && draggingSeqFx !== index) {
                          const src = draggingSeqFx;
                          setSeqFxSlots(prev => {
                            const next = [...prev];
                            next[index] = next[src];
                            next[src] = null;
                            return next;
                          });
                          setSeqFxValues(prev => {
                            const next = [...prev];
                            next[index] = next[src];
                            next[src] = 0.5;
                            return next;
                          });
                          setDraggingSeqFx(null);
                        }
                        setDragOverSeqSlot(null);
                      }}
                    >
                      <div
                        style={{
                          width: '40px',
                          height: '40px',
                          position: 'relative',
                          cursor: 'pointer',
                        }}
                        draggable={false}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditingSeqFx(index);
                          knobDragStartY.current = e.clientY;
                          knobDragStartValue.current = knobValue;
                          
                          const handleMouseMove = (moveEvent) => {
                            const deltaY = knobDragStartY.current - moveEvent.clientY;
                            const sensitivity = 0.005;
                            const newValue = Math.max(0, Math.min(1, knobDragStartValue.current + deltaY * sensitivity));
                            setSeqFxValues(prev => {
                              const next = [...prev];
                              next[index] = newValue;
                              return next;
                            });
                          };
                          
                          const handleMouseUp = () => {
                            setEditingSeqFx(null);
                            document.removeEventListener('mousemove', handleMouseMove);
                            document.removeEventListener('mouseup', handleMouseUp);
                          };
                          
                          document.addEventListener('mousemove', handleMouseMove);
                          document.addEventListener('mouseup', handleMouseUp);
                        }}
                      >
                        <SequencerFxKnobSVG value={knobValue} isDragging={isEditing} />
                      </div>
                      <div
                        style={{
                          fontSize: '7px',
                          color: '#888',
                          textAlign: 'center',
                          marginTop: '4px',
                          textTransform: 'uppercase',
                          cursor: 'move',
                        }}
                        draggable={true}
                        onDragStart={(e) => {
                          isSeqFxDropSuccessful.current = false;
                          setDraggingSeqFx(index);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={(e) => {
                          // If drag ended without successful drop, remove the slot
                          if (!isSeqFxDropSuccessful.current) {
                            setSeqFxSlots(prev => {
                              const next = [...prev];
                              next[index] = null;
                              return next;
                            });
                            setSeqFxValues(prev => {
                              const next = [...prev];
                              next[index] = 0.5;
                              return next;
                            });
                          }
                          setDraggingSeqFx(null);
                          isSeqFxDropSuccessful.current = false;
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = '#888'; }}
                      >
                        {assignedFx}
                      </div>
                    </div>
                  );
                }
                
                // Empty slot
                return (
                  <div
                    key={index}
                    style={{
                      ...styles.sequencerEmptySlot,
                      ...(isDragOver ? { opacity: 0.8, border: '1px dashed #fff' } : {}),
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverSeqSlot(index);
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverSeqSlot(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      isSeqFxDropSuccessful.current = true;
                      const paramName = e.dataTransfer.getData('text/plain');
                      if (paramName) {
                        // Smart Move: Find if effect already exists, remove it first
                        // Compute existing index before state updates to avoid stale closure
                        const existingIndex = seqFxSlots.findIndex(slot => slot === paramName);
                        const existingValue = existingIndex !== -1 ? seqFxValues[existingIndex] : 0.5;
                        
                        setSeqFxSlots(prev => {
                          const next = [...prev];
                          if (existingIndex !== -1 && existingIndex !== index) {
                            // Remove from old slot
                            next[existingIndex] = null;
                          }
                          // Place in new slot
                          next[index] = paramName;
                          return next;
                        });
                        setSeqFxValues(prev => {
                          const next = [...prev];
                          if (existingIndex !== -1 && existingIndex !== index) {
                            // Move value from old slot
                            next[index] = existingValue;
                            next[existingIndex] = 0.5;
                          } else {
                            // New effect, default value
                            next[index] = 0.5;
                          }
                          return next;
                        });
                      } else if (draggingSeqFx !== null) {
                        const src = draggingSeqFx;
                        setSeqFxSlots(prev => {
                          const next = [...prev];
                          next[index] = next[src];
                          next[src] = null;
                          return next;
                        });
                        setSeqFxValues(prev => {
                          const next = [...prev];
                          next[index] = next[src];
                          next[src] = 0.5;
                          return next;
                        });
                        setDraggingSeqFx(null);
                      }
                      setDragOverSeqSlot(null);
                    }}
                  >
                    <div style={styles.sequencerEmptySlotIndicator}></div>
                    <div style={styles.sequencerEmptySlotPlus}>+</div>
                    <div style={styles.sequencerEmptySlotLabel}>Empty</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Section D: Step Grid (Rail + Rhythm Guide) */}
        <div style={styles.sequencerStepRail}>
          <div style={styles.sequencerStepsGrid}>
          {sequencerSteps.map((step, index) => {
            const isActive = step && step.active;
            const isTied = step && step.tied;
            const isDownbeat = index % 4 === 0;
            const isRecordingCursor = isRecording && index === recordingIndex;
            return (
              <button
                key={index}
                type="button"
                style={{
                  ...styles.sequencerStepButton,
                  ...(!isActive && isDownbeat ? styles.sequencerStepButtonDownbeat : {}),
                  ...(isActive && !isTied ? styles.sequencerStepButtonActive : {}),
                  ...(isActive && isTied ? styles.sequencerStepButtonTied : {}),
                  ...(currentStep === index ? styles.sequencerStepButtonCurrent : {}),
                  ...(isRecordingCursor ? styles.sequencerStepButtonRecordingCursor : {}),
                }}
                onClick={() => {
                  if (isRecording) {
                    setRecordingIndex(index); // click-to-set cursor
                    return;
                  }
                  // Multi-Click Tie Workflow: Cycle through 3 states
                  // State A (Empty): !active -> active: true, tied: false
                  // State B (Standard): active && !tied -> active: true, tied: true
                  // State C (Tied): active && tied -> active: false, tied: false
                  setSequencerSteps(prev =>
                    prev.map((s, i) => {
                      if (i !== index) return s;
                      if (!s.active) {
                        // State A -> State B
                        return { active: true, tied: false, note: s.note };
                      } else if (s.active && !s.tied) {
                        // State B -> State C
                        return { active: true, tied: true, note: s.note };
                      } else {
                        // State C -> State A
                        return { active: false, tied: false, note: null };
                      }
                    })
                  );
                }}
                title={step.note ? `Step ${index + 1}: ${step.note}` : `Step ${index + 1}`}
              >
                {isActive && step.note ? step.note : index + 1}
              </button>
            );
          })}
          </div>
        </div>
      </div>
      </div>

      {/* Debug Toggle Button */}
      <button
        onClick={() => setShowDebug(!showDebug)}
        style={{
          position: 'fixed',
          bottom: 10,
          right: 10,
          zIndex: 10000,
          background: showDebug ? '#007aff' : '#333',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          padding: '6px 12px',
          fontSize: '11px',
          cursor: 'pointer',
          fontFamily: 'monospace',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
        }}
      >
        🐞 DEBUG
      </button>

      {/* Debug Overlay - Only shown when showDebug is true */}
      {showDebug && (
        <div
          style={{
            position: 'fixed',
            bottom: 50,
            right: 10,
            zIndex: 9999,
            background: '#000',
            color: '#0f0',
            padding: 10,
            fontFamily: 'monospace',
            fontSize: 12,
            pointerEvents: 'auto',
            maxWidth: '400px',
            maxHeight: '300px',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            borderRadius: '4px',
            border: '1px solid #333',
          }}
        >
          <div>Audio Context: {window.globalAudioContext ? window.globalAudioContext.state : 'Not Created'}</div>
          <div>{filterDiagnostic || getFilterDiagnostics()}</div>
          {logs.map((logEntry, i) => {
            const color = logEntry.type === 'error' ? '#f00' : logEntry.type === 'warn' ? '#ff0' : '#0f0';
            return (
              <div key={i} style={{ color }}>
                {logEntry.message}
              </div>
            );
          })}
        </div>
      )}

      {/* Spectrum Lab Footer — high-detail view; same analyserRef as top SpectrumAnalyzer (dual-view) */}
      {isExpanded && analyserRef.current && (
        <SpectrumLab analyzer={analyserRef.current} />
      )}
    </React.Fragment>
  );
}
