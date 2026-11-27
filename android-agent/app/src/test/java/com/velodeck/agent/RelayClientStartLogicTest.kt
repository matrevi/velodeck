package com.velodeck.agent

import com.velodeck.agent.network.RelayClient
import com.velodeck.agent.network.RelayConnectionState
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayClientStartLogicTest {

    @Test
    fun healthyConnectedSameUrlWithoutForce_doesNotReconnect() {
        assertFalse(
            RelayClient.shouldReconnectOnStart(
                running = true,
                currentUrl = "wss://relay.example.com/ws",
                nextUrl = "wss://relay.example.com/ws",
                state = RelayConnectionState.CONNECTED,
                forceReconnect = false,
            ),
        )
    }

    @Test
    fun connectingSameUrlWithoutForce_doesNotReconnect() {
        assertFalse(
            RelayClient.shouldReconnectOnStart(
                running = true,
                currentUrl = "wss://relay.example.com/ws",
                nextUrl = "  wss://relay.example.com/ws  ",
                state = RelayConnectionState.CONNECTING,
                forceReconnect = false,
            ),
        )
    }

    @Test
    fun urlChanged_forcesReconnect() {
        assertTrue(
            RelayClient.shouldReconnectOnStart(
                running = true,
                currentUrl = "wss://old.example.com/ws",
                nextUrl = "wss://new.example.com/ws",
                state = RelayConnectionState.CONNECTED,
                forceReconnect = false,
            ),
        )
    }

    @Test
    fun forceReconnectTrue_alwaysReconnects() {
        assertTrue(
            RelayClient.shouldReconnectOnStart(
                running = true,
                currentUrl = "wss://relay.example.com/ws",
                nextUrl = "wss://relay.example.com/ws",
                state = RelayConnectionState.CONNECTED,
                forceReconnect = true,
            ),
        )
    }

    @Test
    fun disconnectedOrAuthErrorOrDisabledOrStopped_reconnects() {
        assertTrue(
            RelayClient.shouldReconnectOnStart(
                running = true,
                currentUrl = "wss://relay.example.com/ws",
                nextUrl = "wss://relay.example.com/ws",
                state = RelayConnectionState.DISCONNECTED,
                forceReconnect = false,
            ),
        )
        assertTrue(
            RelayClient.shouldReconnectOnStart(
                running = true,
                currentUrl = "wss://relay.example.com/ws",
                nextUrl = "wss://relay.example.com/ws",
                state = RelayConnectionState.AUTH_ERROR,
                forceReconnect = false,
            ),
        )
        assertTrue(
            RelayClient.shouldReconnectOnStart(
                running = true,
                currentUrl = "wss://relay.example.com/ws",
                nextUrl = "wss://relay.example.com/ws",
                state = RelayConnectionState.DISABLED,
                forceReconnect = false,
            ),
        )
        assertTrue(
            RelayClient.shouldReconnectOnStart(
                running = false,
                currentUrl = "wss://relay.example.com/ws",
                nextUrl = "wss://relay.example.com/ws",
                state = RelayConnectionState.CONNECTED,
                forceReconnect = false,
            ),
        )
    }

    @Test
    fun heartbeatWatchdog_evaluatesMonotonicElapsedThresholdAccurately() {
        assertFalse(
            RelayClient.isHeartbeatTimedOut(
                nowElapsedMs = 100_000L,
                lastActivityElapsedMs = 100_000L,
            ),
        )
        assertFalse(
            RelayClient.isHeartbeatTimedOut(
                nowElapsedMs = 115_000L,
                lastActivityElapsedMs = 100_000L,
            ),
        )
        assertFalse(
            RelayClient.isHeartbeatTimedOut(
                nowElapsedMs = 135_000L,
                lastActivityElapsedMs = 100_000L,
            ),
        )
        assertTrue(
            RelayClient.isHeartbeatTimedOut(
                nowElapsedMs = 135_001L,
                lastActivityElapsedMs = 100_000L,
            ),
        )
    }
}
