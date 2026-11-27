package com.velodeck.agent

import com.velodeck.agent.service.BackoffPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BackoffPolicyTest {

    @Test
    fun exponentialGrowthAndCap_withoutJitter() {
        val policy = BackoffPolicy(
            initialDelayMs = 1_000L,
            maxDelayMs = 30_000L,
            multiplier = 2.0,
            jitterRatio = 0.0,
        )

        assertEquals(1_000L, policy.nextDelayMs())
        assertEquals(2_000L, policy.nextDelayMs())
        assertEquals(4_000L, policy.nextDelayMs())
        assertEquals(8_000L, policy.nextDelayMs())
        assertEquals(16_000L, policy.nextDelayMs())
        assertEquals(30_000L, policy.nextDelayMs())
        assertEquals(30_000L, policy.nextDelayMs())
        assertEquals(7, policy.attemptCount)

        policy.reset()
        assertEquals(0, policy.attemptCount)
        assertEquals(1_000L, policy.nextDelayMs())
    }

    @Test
    fun jitterBounds_minMidMax() {
        val minPolicy = BackoffPolicy(
            initialDelayMs = 1_000L,
            maxDelayMs = 30_000L,
            jitterRatio = 0.2,
            randomDouble = { 0.0 },
        )
        val midPolicy = BackoffPolicy(
            initialDelayMs = 1_000L,
            maxDelayMs = 30_000L,
            jitterRatio = 0.2,
            randomDouble = { 0.5 },
        )
        val maxPolicy = BackoffPolicy(
            initialDelayMs = 1_000L,
            maxDelayMs = 30_000L,
            jitterRatio = 0.2,
            randomDouble = { 1.0 },
        )

        assertEquals(800L, minPolicy.nextDelayMs())
        assertEquals(1_000L, midPolicy.nextDelayMs())
        assertEquals(1_200L, maxPolicy.nextDelayMs())

        // Repeat random draws stay strictly within [80%, 120%] of base
        val randomPolicy = BackoffPolicy(initialDelayMs = 1_000L, maxDelayMs = 30_000L, jitterRatio = 0.2)
        repeat(50) {
            randomPolicy.reset()
            val d1 = randomPolicy.nextDelayMs()
            assertTrue("Expected $d1 in 800..1200", d1 in 800L..1_200L)
            val d2 = randomPolicy.nextDelayMs()
            assertTrue("Expected $d2 in 1600..2400", d2 in 1_600L..2_400L)
        }
    }
}
