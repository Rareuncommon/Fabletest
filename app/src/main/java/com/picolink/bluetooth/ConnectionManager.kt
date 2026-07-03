package com.picolink.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.content.Context
import com.picolink.model.ConnectionState
import com.picolink.model.DiscoveredDevice
import com.picolink.model.TransportType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Owns the single active [Transport]: connects, frames incoming bytes into
 * newline-delimited messages, and (optionally) reconnects with exponential
 * backoff when the link drops unexpectedly.
 */
@SuppressLint("MissingPermission")
class ConnectionManager(
    private val context: Context,
    private val adapter: BluetoothAdapter?,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val _lines = MutableSharedFlow<String>(extraBufferCapacity = 128)
    /** Complete newline-terminated messages received from the Pico. */
    val lines: SharedFlow<String> = _lines.asSharedFlow()

    private val _errors = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val errors: SharedFlow<String> = _errors.asSharedFlow()

    var autoReconnect: Boolean = true

    private var transport: Transport? = null
    private var currentDevice: DiscoveredDevice? = null
    private var reconnectJob: Job? = null
    private var userInitiatedDisconnect = false
    private val lineBuffer = StringBuilder()

    fun connect(device: DiscoveredDevice) {
        disconnect() // drop any existing link first
        userInitiatedDisconnect = false
        currentDevice = device
        _state.value = ConnectionState.Connecting(device)
        scope.launch {
            try {
                openTransport(device)
                _state.value = ConnectionState.Connected(device)
            } catch (e: Exception) {
                transport?.close()
                transport = null
                _state.value = ConnectionState.Disconnected
                _errors.tryEmit("Connect failed: ${e.message}")
            }
        }
    }

    private suspend fun openTransport(device: DiscoveredDevice) {
        val a = adapter ?: throw IllegalStateException("Bluetooth unavailable")
        val btDevice = a.getRemoteDevice(device.address)
        val t: Transport = when (device.type) {
            TransportType.BLE -> BleNusTransport(context, btDevice)
            TransportType.CLASSIC -> ClassicSppTransport(btDevice, a)
        }
        t.onData = ::handleData
        t.onClosed = ::handleClosed
        t.connect()
        transport = t
    }

    private fun handleData(bytes: ByteArray) {
        synchronized(lineBuffer) {
            lineBuffer.append(String(bytes, Charsets.UTF_8))
            var idx = lineBuffer.indexOf("\n")
            while (idx >= 0) {
                val line = lineBuffer.substring(0, idx).trimEnd('\r')
                lineBuffer.delete(0, idx + 1)
                if (line.isNotBlank()) _lines.tryEmit(line)
                idx = lineBuffer.indexOf("\n")
            }
            // Guard against a peer that never sends a newline.
            if (lineBuffer.length > 16_384) lineBuffer.setLength(0)
        }
    }

    private fun handleClosed(reason: String) {
        val device = currentDevice
        transport = null
        if (userInitiatedDisconnect || device == null) {
            _state.value = ConnectionState.Disconnected
            return
        }
        _errors.tryEmit(reason)
        if (autoReconnect) startReconnect(device) else _state.value = ConnectionState.Disconnected
    }

    private fun startReconnect(device: DiscoveredDevice) {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            var attempt = 1
            while (attempt <= 5) {
                _state.value = ConnectionState.Reconnecting(device, attempt)
                delay(minOf(2000L * (1 shl (attempt - 1)), 15_000L))
                if (userInitiatedDisconnect) return@launch
                try {
                    openTransport(device)
                    _state.value = ConnectionState.Connected(device)
                    return@launch
                } catch (_: Exception) {
                    transport?.close()
                    transport = null
                    attempt++
                }
            }
            _state.value = ConnectionState.Disconnected
            _errors.tryEmit("Reconnect failed after 5 attempts")
        }
    }

    fun send(text: String, lineEnding: String = "\n") {
        val t = transport
        if (t == null) {
            _errors.tryEmit("Not connected")
            return
        }
        scope.launch {
            try {
                t.send((text + lineEnding).toByteArray(Charsets.UTF_8))
            } catch (e: Exception) {
                _errors.tryEmit("Send failed: ${e.message}")
            }
        }
    }

    fun disconnect() {
        userInitiatedDisconnect = true
        reconnectJob?.cancel()
        transport?.close()
        transport = null
        currentDevice = null
        synchronized(lineBuffer) { lineBuffer.setLength(0) }
        _state.value = ConnectionState.Disconnected
    }

    val isConnected: Boolean get() = state.value is ConnectionState.Connected
}
