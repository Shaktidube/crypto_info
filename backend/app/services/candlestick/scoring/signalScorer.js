/**
 * Evidence scoring model (engineering — not predictive certainty).
 *
 * confidence =
 *   patternQuality * w.patternQuality +
 *   contextStrength * w.context +
 *   confirmationStrength * w.confirmation +
 *   volumeStrength * w.volume
 *
 * Each component is clamped to [0, 1]. A detected pattern is evidence only.
 */
function scoreSignal({
    patternQuality = 0.5,
    contextStrength = 0,
    contextMatched = false,
    confirmationStrength = 0,
    volumeStrength = 0,
    weights,
}) {
    const w = weights || {
        patternQuality: 0.40,
        context: 0.30,
        confirmation: 0.20,
        volume: 0.10,
    };
    const ctx = contextMatched ? clamp(contextStrength) : 0;
    const confidence = clamp(
        clamp(patternQuality) * w.patternQuality +
        ctx * w.context +
        clamp(confirmationStrength) * w.confirmation +
        clamp(volumeStrength) * w.volume,
    );
    return {
        patternQuality: clamp(patternQuality),
        contextStrength: ctx,
        confirmationStrength: clamp(confirmationStrength),
        volumeStrength: clamp(volumeStrength),
        confidence,
        weights: w,
    };
}

function clamp(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

module.exports = { scoreSignal, clamp };
