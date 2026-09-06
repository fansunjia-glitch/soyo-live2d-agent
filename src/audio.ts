import { calculateRms, normalizeRms, smoothAudioLevel } from "./audio/audioLevel";

export type VoiceCapture = {
  stop: () => void;
};

export async function startVoiceCapture(
  onPcm: (chunk: ArrayBuffer) => void,
  onLevel?: (level: number) => void
): Promise<VoiceCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let stopped = false;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (processor) processor.onaudioprocess = null;
    try { processor?.disconnect(); } catch { /* already disconnected */ }
    try { source?.disconnect(); } catch { /* already disconnected */ }
    if (audioContext && audioContext.state !== "closed") void audioContext.close();
    stream.getTracks().forEach((track) => track.stop());
    onLevel?.(0);
  };

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio is not supported by this browser.");
    audioContext = new AudioContextClass();
    if (audioContext.state === "suspended") await audioContext.resume();
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    let smoothedLevel = 0;
    let lastFrameAt = performance.now();

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const now = performance.now();
      const normalized = normalizeRms(calculateRms(input));
      smoothedLevel = smoothAudioLevel(smoothedLevel, normalized, now - lastFrameAt);
      lastFrameAt = now;
      onLevel?.(smoothedLevel);
      const pcm = downsampleTo16BitPcm(input, audioContext?.sampleRate ?? 16000, 16000);
      onPcm(pcm);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    return { stop: cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function downsampleTo16BitPcm(input: Float32Array, inputRate: number, outputRate: number) {
  if (inputRate === outputRate) {
    return floatTo16BitPcm(input);
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j];
    }
    output[i] = sum / Math.max(1, end - start);
  }

  return floatTo16BitPcm(output);
}

function floatTo16BitPcm(input: Float32Array) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
