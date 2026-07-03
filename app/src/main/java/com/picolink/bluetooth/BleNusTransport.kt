package com.picolink.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import java.io.IOException
import java.util.UUID

/**
 * BLE transport speaking the Nordic UART Service (NUS) — the de-facto
 * standard "serial over BLE" service, and what the bundled MicroPython
 * firmware for the Pico W / Pico 2 W advertises.
 */
@SuppressLint("MissingPermission")
class BleNusTransport(
    private val context: Context,
    private val device: BluetoothDevice,
) : Transport {

    companion object {
        val NUS_SERVICE: UUID = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
        val NUS_RX: UUID = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E") // app -> pico (write)
        val NUS_TX: UUID = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E") // pico -> app (notify)
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")
        private const val CONNECT_TIMEOUT_MS = 15_000L
        private const val OP_TIMEOUT_MS = 5_000L
    }

    private var gatt: BluetoothGatt? = null
    private var rxChar: BluetoothGattCharacteristic? = null
    @Volatile private var mtuPayload = 20
    @Volatile private var closed = false

    private var connectDeferred: CompletableDeferred<Unit>? = null
    private var servicesDeferred: CompletableDeferred<Unit>? = null
    private var mtuDeferred: CompletableDeferred<Unit>? = null
    private var descriptorDeferred: CompletableDeferred<Unit>? = null
    private var writeDeferred: CompletableDeferred<Unit>? = null
    private val writeMutex = Mutex()

    override var onData: ((ByteArray) -> Unit)? = null
    override var onClosed: ((String) -> Unit)? = null

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                connectDeferred?.complete(Unit)
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                val err = IOException("GATT disconnected (status $status)")
                connectDeferred?.completeExceptionally(err)
                writeDeferred?.completeExceptionally(err)
                if (!closed) {
                    closed = true
                    onClosed?.invoke("Connection lost (status $status)")
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) mtuPayload = mtu - 3
            mtuDeferred?.complete(Unit)
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) servicesDeferred?.complete(Unit)
            else servicesDeferred?.completeExceptionally(IOException("Service discovery failed: $status"))
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) descriptorDeferred?.complete(Unit)
            else descriptorDeferred?.completeExceptionally(IOException("CCCD write failed: $status"))
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) writeDeferred?.complete(Unit)
            else writeDeferred?.completeExceptionally(IOException("Write failed: $status"))
        }

        @Deprecated("Deprecated in API 33, still delivered on older devices")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            if (c.uuid == NUS_TX) {
                @Suppress("DEPRECATION") val v = c.value
                if (v != null) onData?.invoke(v)
            }
        }

        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            c: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            if (c.uuid == NUS_TX) onData?.invoke(value)
        }
    }

    override suspend fun connect() {
        connectDeferred = CompletableDeferred()
        gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        withTimeout(CONNECT_TIMEOUT_MS) { connectDeferred!!.await() }

        val g = gatt ?: throw IOException("GATT null after connect")

        mtuDeferred = CompletableDeferred()
        if (g.requestMtu(247)) {
            try {
                withTimeout(OP_TIMEOUT_MS) { mtuDeferred!!.await() }
            } catch (_: Exception) { /* keep default MTU */ }
        }

        servicesDeferred = CompletableDeferred()
        if (!g.discoverServices()) throw IOException("discoverServices() refused")
        withTimeout(OP_TIMEOUT_MS + 5_000) { servicesDeferred!!.await() }

        val service = g.getService(NUS_SERVICE)
            ?: throw IOException("Device does not expose the Nordic UART Service — is the PicoLink firmware running?")
        rxChar = service.getCharacteristic(NUS_RX) ?: throw IOException("NUS RX characteristic missing")
        val txChar = service.getCharacteristic(NUS_TX) ?: throw IOException("NUS TX characteristic missing")

        if (!g.setCharacteristicNotification(txChar, true)) {
            throw IOException("Failed to enable notifications")
        }
        val cccd = txChar.getDescriptor(CCCD) ?: throw IOException("CCCD descriptor missing")
        descriptorDeferred = CompletableDeferred()
        @Suppress("DEPRECATION")
        run {
            cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            if (!g.writeDescriptor(cccd)) throw IOException("writeDescriptor() refused")
        }
        withTimeout(OP_TIMEOUT_MS) { descriptorDeferred!!.await() }
    }

    override suspend fun send(bytes: ByteArray) {
        val g = gatt ?: throw IOException("Not connected")
        val c = rxChar ?: throw IOException("Not connected")
        writeMutex.withLock {
            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(offset + mtuPayload, bytes.size)
                val chunk = bytes.copyOfRange(offset, end)
                writeDeferred = CompletableDeferred()
                @Suppress("DEPRECATION")
                run {
                    c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                    c.value = chunk
                    if (!g.writeCharacteristic(c)) throw IOException("writeCharacteristic() refused")
                }
                withTimeout(OP_TIMEOUT_MS) { writeDeferred!!.await() }
                offset = end
            }
        }
    }

    override fun close() {
        closed = true
        try {
            gatt?.disconnect()
            gatt?.close()
        } catch (_: Exception) {}
        gatt = null
        rxChar = null
    }
}
