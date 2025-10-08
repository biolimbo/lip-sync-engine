import { useState, useRef, useEffect } from 'react';
import { recordAudio, loadAudio } from 'lip-sync-js';
import { useLipSync } from './hooks/useLipSync';
import './App.css';

interface LogEntry {
  message: string;
  type: 'info' | 'error' | 'warn' | 'success';
  timestamp: string;
}

function App() {
  const { analyze, result, isAnalyzing, error, reset } = useLipSync();
  const [dialogText, setDialogText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [currentViseme, setCurrentViseme] = useState('X');
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const visemeNames: Record<string, string> = {
    X: 'Closed/Rest',
    A: 'Open',
    B: 'Lips Together',
    C: 'Rounded',
    D: 'Tongue-Teeth',
    E: 'Slightly Open',
    F: 'F/V Sound',
    G: 'Open Back',
    H: 'Wide Open',
  };

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = (hours % 12 || 12).toString();
    const timestamp = `[${displayHours}:${minutes}:${seconds} ${ampm}]`;

    setLogs(prev => [...prev, { message, type, timestamp }]);
  };

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    addLog('Initializing LipSync WASM module...', 'info');
    addLog('✅ WASM module loaded successfully', 'success');
    addLog('Viseme images preloaded', 'info');
  }, []);

  const playAnimation = (mouthCues: Array<{ start: number; end: number; value: string }>, buffer: AudioBuffer) => {
    if (!buffer) return;

    setIsPlaying(true);
    const audioContext = new AudioContext();
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    audioContextRef.current = audioContext;
    audioSourceRef.current = source;

    const startTime = audioContext.currentTime;
    source.start(0);

    let currentCueIndex = 0;

    const updateViseme = () => {
      const elapsed = audioContext.currentTime - startTime;

      while (currentCueIndex < mouthCues.length && mouthCues[currentCueIndex].end < elapsed) {
        currentCueIndex++;
      }

      if (currentCueIndex < mouthCues.length) {
        setCurrentViseme(mouthCues[currentCueIndex].value);
        requestAnimationFrame(updateViseme);
      } else {
        setCurrentViseme('X');
      }
    };

    updateViseme();

    source.onended = () => {
      setCurrentViseme('X');
      setIsPlaying(false);
    };
  };

  const handleRecord = async () => {
    setIsRecording(true);
    reset();
    setAudioBuffer(null);
    try {
      addLog('=== Starting Recording ===', 'info');
      addLog('Microphone access granted', 'info');
      addLog('Recording 5 seconds...', 'info');

      const { pcm16, audioBuffer: buffer } = await recordAudio(5000);

      addLog('Recording stopped', 'info');
      const duration = (pcm16.length / 16000).toFixed(2);
      addLog(`✅ Captured ${pcm16.length} samples (${duration}s)`, 'success');

      setAudioBuffer(buffer);

      addLog('=== Starting Analysis ===', 'info');
      addLog(`Analyzing ${pcm16.length} samples (${duration}s at 16kHz)${dialogText ? ' with dialog text' : ''}`, 'info');

      await analyze(pcm16, {
        dialogText: dialogText.trim() || undefined,
        sampleRate: 16000,
      });

      addLog(`✅ Analysis complete!`, 'success');
    } catch (err) {
      console.error('Recording failed:', err);
      addLog(`Error: ${err instanceof Error ? err.message : 'Recording failed'}`, 'error');
    } finally {
      setIsRecording(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    reset();
    setAudioBuffer(null);
    try {
      addLog('=== Loading Audio File ===', 'info');
      addLog(`File: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`, 'info');

      const { pcm16, audioBuffer: buffer } = await loadAudio(file);

      const duration = (pcm16.length / 16000).toFixed(2);
      addLog(`✅ Decoded: ${pcm16.length} samples (${duration}s at 16kHz)`, 'success');

      setAudioBuffer(buffer);

      addLog('=== Starting Analysis ===', 'info');
      addLog(`Analyzing ${pcm16.length} samples (${duration}s at 16kHz)${dialogText ? ' with dialog text' : ''}`, 'info');

      await analyze(pcm16, {
        dialogText: dialogText.trim() || undefined,
        sampleRate: 16000,
      });

      addLog(`✅ Analysis complete!`, 'success');
    } catch (err) {
      console.error('File load failed:', err);
      addLog(`Error: ${err instanceof Error ? err.message : 'File load failed'}`, 'error');
    }
    e.target.value = '';
  };

  const handlePlay = () => {
    if (result && audioBuffer) {
      if (audioSourceRef.current) {
        audioSourceRef.current.stop();
      }
      playAnimation(result.mouthCues, audioBuffer);
    }
  };

  useEffect(() => {
    if (result && audioBuffer && !isPlaying) {
      playAnimation(result.mouthCues, audioBuffer);
    }
  }, [result]);

  return (
    <div className="app">
      <div className="container">
        <h1>🎤 LipSync.js</h1>
        <p className="subtitle">React Example</p>

        <div className="input-group">
          <label htmlFor="dialogText">
            Dialog Text (Optional - improves accuracy)
          </label>
          <input
            id="dialogText"
            type="text"
            value={dialogText}
            onChange={(e) => setDialogText(e.target.value)}
            placeholder="Enter the text that will be spoken..."
            disabled={isAnalyzing || isRecording}
          />
        </div>

        <div className="controls">
          <button
            onClick={handleRecord}
            disabled={isAnalyzing || isRecording}
            className="btn"
          >
            {isRecording ? '🎙️ Recording...' : '🎙️ Record Audio (5s)'}
          </button>
          <label className="btn">
            📁 Load Audio File
            <input
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              disabled={isAnalyzing || isRecording}
              style={{ display: 'none' }}
            />
          </label>
        </div>

        <div className={`status ${isRecording ? 'recording' : isAnalyzing ? 'analyzing' : ''}`}>
          {isRecording ? 'Recording... Speak now!' : isAnalyzing ? 'Analyzing audio...' : 'Ready to analyze audio'}
        </div>

        <div className="viseme-display">
          <div>
            <div className="viseme-images">
              {['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((viseme) => (
                <img
                  key={viseme}
                  src={`/visemes/${viseme}.png`}
                  alt={viseme}
                  className={currentViseme === viseme ? 'active' : ''}
                />
              ))}
            </div>
            <div className="viseme-label">
              {visemeNames[currentViseme]} ({currentViseme})
            </div>
          </div>
        </div>

        {result && (
          <div className="results">
            <div className="results-header">
              <h3>Lip Sync Results</h3>
              <button
                className="play-btn"
                onClick={handlePlay}
                disabled={isPlaying}
              >
                {isPlaying ? '⏸ Playing' : '▶ Play'}
              </button>
            </div>
            <div className="cues-list">
              {result.mouthCues.map((cue, index) => (
                <div key={index} className="cue">
                  <span className="cue-time">
                    {cue.start.toFixed(2)}s - {cue.end.toFixed(2)}s
                  </span>
                  <span className="cue-value">{cue.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="error">
            Error: {error.message}
          </div>
        )}

        <div className="logs">
          <h3>Logs</h3>
          <div className="logs-content">
            {logs.map((log, index) => (
              <div key={index} className={`log-entry ${log.type}`}>
                {log.timestamp} {log.message}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
