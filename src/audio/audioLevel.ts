export type AudioLevelOptions = {
  /** RMS values at or below this level are treated as silence. */
  noiseGate: number;
  /** RMS value that maps to a normalized level of 1. */
  normalizationRms: number;
  /** Values below 1 make quieter speech more visible. */
  responseCurve: number;
  /** Rise time constant in milliseconds. */
  attackMs: number;
  /** Fall time constant in milliseconds. */
  releaseMs: number;
};

export type AudioLevelSample = {
  rms: number;
  normalized: number;
  audioLevel: number;
};

export const DEFAULT_AUDIO_LEVEL_OPTIONS: Readonly<AudioLevelOptions> = Object.freeze({
  noiseGate: 0.008,
  normalizationRms: 0.22,
  responseCurve: 0.65,
  attackMs: 35,
  releaseMs: 140
});

/** Calculates root mean square for normalized time-domain samples. */
export function calculateRms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;

  let sumOfSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number.isFinite(samples[index]) ? samples[index] : 0;
    sumOfSquares += sample * sample;
  }
  return Math.sqrt(sumOfSquares / samples.length);
}

/** Applies a noise gate and maps RMS to the inclusive [0, 1] range. */
export function normalizeRms(
  rms: number,
  options: Pick<AudioLevelOptions, "noiseGate" | "normalizationRms" | "responseCurve"> = DEFAULT_AUDIO_LEVEL_OPTIONS
): number {
  const safeRms = Math.max(0, finiteOr(rms, 0));
  const noiseGate = Math.max(0, finiteOr(options.noiseGate, DEFAULT_AUDIO_LEVEL_OPTIONS.noiseGate));
  const normalizationRms = Math.max(
    noiseGate + Number.EPSILON,
    finiteOr(options.normalizationRms, DEFAULT_AUDIO_LEVEL_OPTIONS.normalizationRms)
  );
  if (safeRms <= noiseGate) return 0;

  const linear = clamp01((safeRms - noiseGate) / (normalizationRms - noiseGate));
  const responseCurve = Math.max(
    Number.EPSILON,
    finiteOr(options.responseCurve, DEFAULT_AUDIO_LEVEL_OPTIONS.responseCurve)
  );
  return clamp01(linear ** responseCurve);
}

/**
 * Smooths toward the target with separate attack and release time constants.
 * The result is frame-rate independent as long as deltaMs reflects elapsed time.
 */
export function smoothAudioLevel(
  previousLevel: number,
  targetLevel: number,
  deltaMs: number,
  options: Pick<AudioLevelOptions, "attackMs" | "releaseMs"> = DEFAULT_AUDIO_LEVEL_OPTIONS
): number {
  const previous = clamp01(finiteOr(previousLevel, 0));
  const target = clamp01(finiteOr(targetLevel, 0));
  const elapsed = Math.max(0, finiteOr(deltaMs, 0));
  if (elapsed === 0 || previous === target) return previous;

  const configuredTime = target > previous ? options.attackMs : options.releaseMs;
  const timeConstant = Math.max(0, finiteOr(
    configuredTime,
    target > previous ? DEFAULT_AUDIO_LEVEL_OPTIONS.attackMs : DEFAULT_AUDIO_LEVEL_OPTIONS.releaseMs
  ));
  if (timeConstant === 0) return target;

  const blend = 1 - Math.exp(-elapsed / timeConstant);
  return clamp01(previous + (target - previous) * blend);
}

/** Runs the complete testable RMS -> gate/normalize -> attack/release pipeline. */
export function sampleAudioLevel(
  samples: ArrayLike<number>,
  previousLevel: number,
  deltaMs: number,
  options: AudioLevelOptions = DEFAULT_AUDIO_LEVEL_OPTIONS
): AudioLevelSample {
  const rms = calculateRms(samples);
  const normalized = normalizeRms(rms, options);
  return {
    rms,
    normalized,
    audioLevel: smoothAudioLevel(previousLevel, normalized, deltaMs, options)
  };
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
