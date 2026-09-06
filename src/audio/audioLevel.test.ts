import { describe, expect, it } from "vitest";
import { calculateRms, normalizeRms, sampleAudioLevel, smoothAudioLevel } from "./audioLevel";

describe("audio level envelope", () => {
  it("calculates RMS and ignores non-finite samples", () => {
    expect(calculateRms([1, -1, 1, -1])).toBe(1);
    expect(calculateRms([Number.NaN, 0])).toBe(0);
  });

  it("gates silence and normalizes speech", () => {
    const options = { noiseGate: 0.01, normalizationRms: 0.21, responseCurve: 1 };
    expect(normalizeRms(0.005, options)).toBe(0);
    expect(normalizeRms(0.11, options)).toBeCloseTo(0.5);
    expect(normalizeRms(0.4, options)).toBe(1);
  });

  it("uses a faster attack than release", () => {
    const options = { attackMs: 20, releaseMs: 200 };
    const attacked = smoothAudioLevel(0, 1, 20, options);
    const released = smoothAudioLevel(1, 0, 20, options);
    expect(attacked).toBeGreaterThan(1 - released);
  });

  it("runs the complete sampling pipeline", () => {
    const sample = sampleAudioLevel(new Float32Array(32).fill(0.2), 0, 16);
    expect(sample.rms).toBeCloseTo(0.2);
    expect(sample.normalized).toBeGreaterThan(0.8);
    expect(sample.audioLevel).toBeGreaterThan(0);
    expect(sample.audioLevel).toBeLessThanOrEqual(1);
  });
});
