import {
  DEFAULT_AUDIO_LEVEL_OPTIONS,
  sampleAudioLevel,
  type AudioLevelOptions
} from "./audioLevel";

export type SpeechProgress = {
  currentTime: number;
  duration: number;
  progress: number;
  /** Smoothed, noise-gated level in the inclusive [0, 1] range. */
  audioLevel: number;
  /** Raw RMS from the latest analyser frame. */
  rms: number;
};

export type SpeechPlayerCallbacks = {
  onStart?: () => void;
  onProgress?: (progress: SpeechProgress) => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
};

export type SpeechPlayerOptions = Partial<AudioLevelOptions> & {
  /** Web Audio analyser FFT size. It is normalized to a power of two. */
  fftSize?: number;
};

type ActivePlayback = {
  id: number;
  audio: HTMLAudioElement;
  objectUrl: string;
  callbacks: SpeechPlayerCallbacks;
  source: MediaElementAudioSourceNode | null;
  analyser: AnalyserNode | null;
  samples: Float32Array<ArrayBuffer>;
  animationFrame: number | null;
  lastFrameAt: number;
  audioLevel: number;
  rms: number;
  settled: boolean;
  failure: Error | null;
};

type AudioContextConstructor = new () => AudioContext;

export class SpeechPlayer {
  private readonly levelOptions: AudioLevelOptions;
  private readonly fftSize: number;
  private audioContext: AudioContext | null = null;
  private active: ActivePlayback | null = null;
  private nextPlaybackId = 0;
  private disposed = false;

  constructor(options: SpeechPlayerOptions = {}) {
    this.levelOptions = {
      noiseGate: options.noiseGate ?? DEFAULT_AUDIO_LEVEL_OPTIONS.noiseGate,
      normalizationRms: options.normalizationRms ?? DEFAULT_AUDIO_LEVEL_OPTIONS.normalizationRms,
      responseCurve: options.responseCurve ?? DEFAULT_AUDIO_LEVEL_OPTIONS.responseCurve,
      attackMs: options.attackMs ?? DEFAULT_AUDIO_LEVEL_OPTIONS.attackMs,
      releaseMs: options.releaseMs ?? DEFAULT_AUDIO_LEVEL_OPTIONS.releaseMs
    };
    this.fftSize = normalizeFftSize(options.fftSize ?? 1024);
  }

  get isPlaying(): boolean {
    return this.active !== null && !this.active.audio.paused && !this.active.audio.ended;
  }

  /**
   * Resumes (or lazily creates) the shared AudioContext. Call from a user gesture
   * when a browser requires explicit audio activation.
   */
  async resume(): Promise<void> {
    this.assertUsable();
    const context = this.getOrCreateAudioContext();
    if (context.state === "closed") throw new Error("AudioContext is closed.");
    if (context.state !== "running") await context.resume();
  }

  /** Starts Blob playback. The promise resolves once media playback has started. */
  async play(blob: Blob, callbacks: SpeechPlayerCallbacks = {}): Promise<void> {
    this.assertUsable();
    if (blob.size === 0) {
      const error = new Error("Cannot play an empty audio Blob.");
      safelyCall(callbacks.onError, error);
      throw error;
    }

    this.stop();
    let objectUrl: string;
    try {
      objectUrl = URL.createObjectURL(blob);
    } catch (cause) {
      const error = toError(cause, "Could not create an audio object URL.");
      safelyCall(callbacks.onError, error);
      throw error;
    }
    let audio: HTMLAudioElement;
    try {
      audio = new Audio(objectUrl);
    } catch (cause) {
      URL.revokeObjectURL(objectUrl);
      const error = toError(cause, "Could not create an audio element.");
      safelyCall(callbacks.onError, error);
      throw error;
    }

    const playback: ActivePlayback = {
      id: ++this.nextPlaybackId,
      audio,
      objectUrl,
      callbacks,
      source: null,
      analyser: null,
      samples: new Float32Array(new ArrayBuffer(this.fftSize * Float32Array.BYTES_PER_ELEMENT)),
      animationFrame: null,
      lastFrameAt: performance.now(),
      audioLevel: 0,
      rms: 0,
      settled: false,
      failure: null
    };
    this.active = playback;

    audio.preload = "auto";
    audio.onended = () => this.finish(playback);
    audio.onerror = () => this.fail(playback, mediaError(audio));

    try {
      await this.resume();
      if (!this.isCurrent(playback)) return;

      const context = this.audioContext;
      if (!context) throw new Error("Web Audio is unavailable.");
      playback.source = context.createMediaElementSource(audio);
      playback.analyser = context.createAnalyser();
      playback.analyser.fftSize = this.fftSize;
      playback.analyser.smoothingTimeConstant = 0;
      playback.source.connect(playback.analyser);
      playback.analyser.connect(context.destination);

      await audio.play();
      if (!this.isCurrent(playback)) return;

      playback.lastFrameAt = performance.now();
      safelyCall(callbacks.onStart);
      this.emitProgress(playback);
      this.scheduleProgress(playback);
    } catch (cause) {
      if (!this.isCurrent(playback)) {
        if (playback.failure) throw playback.failure;
        return;
      }
      const error = toError(cause, "Audio playback failed.");
      this.fail(playback, error);
      throw error;
    }
  }

  /** Cancels the active playback without firing onEnded or onError. */
  stop(): void {
    const playback = this.active;
    if (!playback) return;
    this.cleanup(playback);
  }

  /** Permanently releases playback resources and the shared AudioContext. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    const context = this.audioContext;
    this.audioContext = null;
    if (context && context.state !== "closed") await context.close();
  }

  private getOrCreateAudioContext(): AudioContext {
    if (this.audioContext && this.audioContext.state !== "closed") return this.audioContext;

    const constructor = (
      window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext
    ) as AudioContextConstructor | undefined;
    if (!constructor) throw new Error("Web Audio is not supported by this browser.");
    this.audioContext = new constructor();
    return this.audioContext;
  }

  private scheduleProgress(playback: ActivePlayback): void {
    if (!this.isCurrent(playback)) return;
    playback.animationFrame = window.requestAnimationFrame((now) => {
      playback.animationFrame = null;
      if (!this.isCurrent(playback)) return;
      this.emitProgress(playback, now);
      this.scheduleProgress(playback);
    });
  }

  private emitProgress(playback: ActivePlayback, now = performance.now()): void {
    if (!this.isCurrent(playback)) return;
    const analyser = playback.analyser;
    if (analyser) {
      analyser.getFloatTimeDomainData(playback.samples);
      const sample = sampleAudioLevel(
        playback.samples,
        playback.audioLevel,
        Math.max(0, now - playback.lastFrameAt),
        this.levelOptions
      );
      playback.audioLevel = sample.audioLevel;
      playback.rms = sample.rms;
    }
    playback.lastFrameAt = now;
    safelyCall(playback.callbacks.onProgress, progressSnapshot(playback));
  }

  private finish(playback: ActivePlayback): void {
    if (!this.isCurrent(playback)) return;
    const callback = playback.callbacks.onEnded;
    const finalProgress = progressSnapshot(playback, true);
    safelyCall(playback.callbacks.onProgress, finalProgress);
    this.cleanup(playback);
    safelyCall(callback);
  }

  private fail(playback: ActivePlayback, error: Error): void {
    if (!this.isCurrent(playback)) return;
    playback.failure = error;
    const callback = playback.callbacks.onError;
    this.cleanup(playback);
    safelyCall(callback, error);
  }

  private cleanup(playback: ActivePlayback): void {
    if (playback.settled) return;
    playback.settled = true;
    if (playback.animationFrame !== null) {
      window.cancelAnimationFrame(playback.animationFrame);
      playback.animationFrame = null;
    }

    playback.audio.onended = null;
    playback.audio.onerror = null;
    try {
      playback.audio.pause();
    } catch {
      // Cleanup must continue even if a test double or browser rejects pause().
    }
    try {
      playback.source?.disconnect();
    } catch {
      // The node may already have been disconnected by the browser.
    }
    try {
      playback.analyser?.disconnect();
    } catch {
      // The node may already have been disconnected by the browser.
    }
    playback.source = null;
    playback.analyser = null;

    try {
      playback.audio.removeAttribute("src");
      playback.audio.load();
    } catch {
      // Revoking the object URL below is the authoritative resource cleanup.
    } finally {
      URL.revokeObjectURL(playback.objectUrl);
      if (this.active?.id === playback.id) this.active = null;
    }
  }

  private isCurrent(playback: ActivePlayback): boolean {
    return this.active?.id === playback.id && !playback.settled;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("SpeechPlayer has been disposed.");
  }
}

function progressSnapshot(playback: ActivePlayback, ended = false): SpeechProgress {
  const currentTime = finiteNonNegative(playback.audio.currentTime);
  const duration = finiteNonNegative(playback.audio.duration);
  const progress = ended ? 1 : duration > 0 ? Math.min(1, currentTime / duration) : 0;
  return {
    currentTime: ended && duration > 0 ? duration : currentTime,
    duration,
    progress,
    audioLevel: ended ? 0 : playback.audioLevel,
    rms: ended ? 0 : playback.rms
  };
}

function mediaError(audio: HTMLAudioElement): Error {
  const code = audio.error?.code;
  const detail = code === 1
    ? "playback was aborted"
    : code === 2
      ? "a network error interrupted playback"
      : code === 3
        ? "the audio could not be decoded"
        : code === 4
          ? "the audio format is not supported"
          : "an unknown media error occurred";
  return new Error(`Audio playback failed: ${detail}.`);
}

function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}

function safelyCall<T extends unknown[]>(callback: ((...args: T) => void) | undefined, ...args: T): void {
  if (!callback) return;
  try {
    callback(...args);
  } catch (error) {
    console.error("SpeechPlayer callback failed.", error);
  }
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeFftSize(value: number): number {
  const clamped = Math.min(32768, Math.max(32, Math.round(Number.isFinite(value) ? value : 1024)));
  return 2 ** Math.round(Math.log2(clamped));
}
