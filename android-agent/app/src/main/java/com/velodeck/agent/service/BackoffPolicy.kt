package com.velodeck.agent.service

import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToLong
import kotlin.random.Random

/**
 * Pure Kotlin exponential backoff with bounded symmetric jitter.
 * Default progression: 1s -> 2s -> 4s -> 8s -> 16s -> 30s (capped), +/- 20% jitter.
 */
class BackoffPolicy(
    val initialDelayMs: Long = 1_000L,
    val maxDelayMs: Long = 30_000L,
    val multiplier: Double = 2.0,
    val jitterRatio: Double = 0.2,
    private val randomDouble: () -> Double = { Random.nextDouble() },
) {
    init {
        require(initialDelayMs > 0L) { "initialDelayMs must be > 0" }
        require(maxDelayMs >= initialDelayMs) { "maxDelayMs must be >= initialDelayMs" }
        require(multiplier >= 1.0) { "multiplier must be >= 1.0" }
        require(jitterRatio in 0.0..1.0) { "jitterRatio must be in [0.0, 1.0]" }
    }

    var attemptCount: Int = 0
        private set

    fun nextDelayMs(): Long {
        val exponent = attemptCount.coerceAtMost(30)
        val rawBase = initialDelayMs.toDouble() * multiplier.pow(exponent.toDouble())
        val cappedBase = min(rawBase, maxDelayMs.toDouble())
        attemptCount += 1

        if (jitterRatio == 0.0) {
            return cappedBase.roundToLong().coerceAtLeast(1L)
        }

        // Uniform jitter factor in [1 - jitterRatio, 1 + jitterRatio]
        val u = randomDouble().coerceIn(0.0, 1.0)
        val factor = (1.0 - jitterRatio) + (2.0 * jitterRatio * u)
        val jittered = (cappedBase * factor).roundToLong()
        return jittered.coerceIn(1L, (maxDelayMs * (1.0 + jitterRatio)).roundToLong())
    }

    fun reset() {
        attemptCount = 0
    }
}
