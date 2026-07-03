package com.picolink.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import com.picolink.model.DiscoveredDevice
import com.picolink.model.TransportType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Scans for devices over both radios at once: BLE scan results and Classic
 * discovery broadcasts are merged into one de-duplicated list, with bonded
 * devices pre-seeded so a paired Pico shows up instantly.
 */
@SuppressLint("MissingPermission")
class DeviceScanner(
    private val context: Context,
    private val adapter: BluetoothAdapter?,
) {
    private val _devices = MutableStateFlow<List<DiscoveredDevice>>(emptyList())
    val devices: StateFlow<List<DiscoveredDevice>> = _devices.asStateFlow()

    private val _isScanning = MutableStateFlow(false)
    val isScanning: StateFlow<Boolean> = _isScanning.asStateFlow()

    private val found = LinkedHashMap<String, DiscoveredDevice>()
    private var receiverRegistered = false

    private val bleCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val d = result.device
            upsert(
                DiscoveredDevice(
                    address = d.address,
                    name = result.scanRecord?.deviceName ?: d.name,
                    rssi = result.rssi,
                    type = TransportType.BLE,
                    bonded = d.bondState == BluetoothDevice.BOND_BONDED,
                )
            )
        }
    }

    private val classicReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            when (intent.action) {
                BluetoothDevice.ACTION_FOUND -> {
                    @Suppress("DEPRECATION")
                    val device: BluetoothDevice? =
                        intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                    val rssi = intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE)
                    if (device != null) {
                        upsert(
                            DiscoveredDevice(
                                address = device.address,
                                name = device.name,
                                rssi = if (rssi == Short.MIN_VALUE) null else rssi.toInt(),
                                type = TransportType.CLASSIC,
                                bonded = device.bondState == BluetoothDevice.BOND_BONDED,
                            )
                        )
                    }
                }
                BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
                    // BLE scan may still be running; only flip the flag when we stop everything.
                }
            }
        }
    }

    @Synchronized
    private fun upsert(device: DiscoveredDevice) {
        val existing = found[device.address]
        // Prefer entries that have a name; keep the freshest RSSI.
        val merged = if (existing != null) {
            existing.copy(
                name = device.name ?: existing.name,
                rssi = device.rssi ?: existing.rssi,
                bonded = device.bonded || existing.bonded,
            )
        } else device
        found[device.address] = merged
        publish()
    }

    private fun publish() {
        _devices.value = found.values.sortedWith(
            compareByDescending<DiscoveredDevice> { it.bonded }
                .thenByDescending { it.name != null }
                .thenByDescending { it.rssi ?: Int.MIN_VALUE }
        )
    }

    fun seedBondedDevices() {
        val bonded = adapter?.bondedDevices ?: return
        for (d in bonded) {
            val type = if (d.type == BluetoothDevice.DEVICE_TYPE_LE) TransportType.BLE
            else TransportType.CLASSIC
            upsert(DiscoveredDevice(d.address, d.name, null, type, bonded = true))
        }
    }

    fun start() {
        val a = adapter ?: return
        if (_isScanning.value) return
        found.clear()
        publish()
        seedBondedDevices()

        a.bluetoothLeScanner?.let { scanner ->
            val settings = ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()
            try { scanner.startScan(null, settings, bleCallback) } catch (_: Exception) {}
        }

        val filter = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_FOUND)
            addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
        }
        context.registerReceiver(classicReceiver, filter)
        receiverRegistered = true
        try { a.startDiscovery() } catch (_: Exception) {}

        _isScanning.value = true
    }

    fun stop() {
        val a = adapter
        if (!_isScanning.value) return
        try { a?.bluetoothLeScanner?.stopScan(bleCallback) } catch (_: Exception) {}
        try { a?.cancelDiscovery() } catch (_: Exception) {}
        if (receiverRegistered) {
            try { context.unregisterReceiver(classicReceiver) } catch (_: Exception) {}
            receiverRegistered = false
        }
        _isScanning.value = false
    }
}
