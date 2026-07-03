package com.picolink.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID

/**
 * Bluetooth Classic RFCOMM/SPP transport. This is what HC-05/HC-06 modules
 * wired to a plain Pico's UART speak, and it also works with any SPP-capable
 * bridge.
 */
@SuppressLint("MissingPermission")
class ClassicSppTransport(
    private val device: BluetoothDevice,
    private val adapter: BluetoothAdapter,
) : Transport {

    companion object {
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }

    private var socket: BluetoothSocket? = null
    private var input: InputStream? = null
    private var output: OutputStream? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var readJob: Job? = null
    @Volatile private var closed = false

    override var onData: ((ByteArray) -> Unit)? = null
    override var onClosed: ((String) -> Unit)? = null

    override suspend fun connect() = withContext(Dispatchers.IO) {
        adapter.cancelDiscovery()
        val sock = try {
            device.createRfcommSocketToServiceRecord(SPP_UUID).also { it.connect() }
        } catch (e: IOException) {
            // Fallback for stubborn devices: reflection channel-1 connect.
            try {
                val m = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
                (m.invoke(device, 1) as BluetoothSocket).also { it.connect() }
            } catch (e2: Exception) {
                throw IOException("SPP connect failed: ${e.message}", e)
            }
        }
        socket = sock
        input = sock.inputStream
        output = sock.outputStream
        startReadLoop()
    }

    private fun startReadLoop() {
        readJob = scope.launch {
            val buffer = ByteArray(1024)
            while (isActive) {
                val n = try {
                    input?.read(buffer) ?: -1
                } catch (e: IOException) {
                    -1
                }
                if (n < 0) {
                    if (!closed) {
                        closed = true
                        onClosed?.invoke("Connection lost")
                    }
                    break
                }
                if (n > 0) onData?.invoke(buffer.copyOf(n))
            }
        }
    }

    override suspend fun send(bytes: ByteArray) = withContext(Dispatchers.IO) {
        val out = output ?: throw IOException("Not connected")
        out.write(bytes)
        out.flush()
    }

    override fun close() {
        closed = true
        readJob?.cancel()
        try { socket?.close() } catch (_: IOException) {}
        socket = null
        input = null
        output = null
        scope.cancel()
    }
}
