/**
 * Audio format conversion utilities
 * Framework-agnostic - works with any audio API
 */

/**
 * Convert Float32Array to Int16Array PCM
 */
export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);

  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  return int16;
}

/**
 * Convert AudioBuffer to Int16Array PCM
 * @param audioBuffer - Web Audio API AudioBuffer
 * @param targetSampleRate - Target sample rate (default: 16000)
 * @returns Int16Array PCM data
 */
export function audioBufferToInt16(
  audioBuffer: AudioBuffer,
  targetSampleRate = 16000
): Int16Array {
  const float32 = audioBuffer.getChannelData(0);

  // Resample if needed
  if (audioBuffer.sampleRate !== targetSampleRate) {
    const resampled = resample(
      float32,
      audioBuffer.sampleRate,
      targetSampleRate
    );
    return float32ToInt16(resampled);
  }

  return float32ToInt16(float32);
}

/**
 * Simple linear resampling
 * For better quality, consider using a dedicated library
 *
 * @param input - Input audio samples
 * @param fromRate - Source sample rate
 * @param toRate - Target sample rate
 * @returns Resampled audio
 */
export function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) {
    return input;
  }

  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    output[i] = input[srcIndex];
  }

  return output;
}

/**
 * Record audio from microphone
 *
 * @param durationMs - Recording duration in milliseconds
 * @param sampleRate - Target sample rate (default: 16000)
 * @returns Object containing PCM16 data and AudioBuffer
 */
export async function recordAudio(
  durationMs: number,
  sampleRate = 16000
): Promise<{ pcm16: Int16Array; audioBuffer: AudioBuffer }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  const mediaRecorder = new MediaRecorder(stream);
  const audioChunks: Blob[] = [];

  mediaRecorder.ondataavailable = (event) => {
    audioChunks.push(event.data);
  };

  // Start recording
  mediaRecorder.start();

  // Record for specified duration
  await new Promise((resolve) => setTimeout(resolve, durationMs));

  // Stop recording
  mediaRecorder.stop();
  stream.getTracks().forEach((track) => track.stop());

  // Wait for final data
  await new Promise((resolve) => {
    mediaRecorder.onstop = resolve;
  });

  // Convert recorded audio to PCM
  const audioBlob = new Blob(audioChunks);
  const arrayBuffer = await audioBlob.arrayBuffer();

  const audioContext = new AudioContext({ sampleRate });
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  const pcm16 = audioBufferToInt16(audioBuffer, sampleRate);

  return { pcm16, audioBuffer };
}

/**
 * Load audio from a URL or File
 *
 * @param source - URL string or File object
 * @param targetSampleRate - Target sample rate (default: 16000)
 * @returns Object containing PCM16 data and AudioBuffer
 */
export async function loadAudio(
  source: string | File,
  targetSampleRate = 16000
): Promise<{ pcm16: Int16Array; audioBuffer: AudioBuffer }> {
  let arrayBuffer: ArrayBuffer;

  if (typeof source === 'string') {
    // Load from URL
    const response = await fetch(source);
    arrayBuffer = await response.arrayBuffer();
  } else {
    // Load from File
    arrayBuffer = await source.arrayBuffer();
  }

  const audioContext = new AudioContext({ sampleRate: targetSampleRate });
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  const pcm16 = audioBufferToInt16(audioBuffer, targetSampleRate);

  return { pcm16, audioBuffer };
}
