package com.picolink.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.BluetoothConnected
import androidx.compose.material.icons.filled.BluetoothSearching
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material.icons.filled.SignalCellularAlt
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.picolink.model.ConnectionState
import com.picolink.model.DiscoveredDevice
import com.picolink.model.TransportType
import com.picolink.viewmodel.MainViewModel

@Composable
fun ConnectScreen(
    vm: MainViewModel,
    permissionsGranted: Boolean,
    onRequestPermissions: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val connState by vm.connectionState.collectAsState()
    val devices by vm.scanResults.collectAsState()
    val isScanning by vm.isScanning.collectAsState()
    val deviceInfo by vm.deviceInfo.collectAsState()
    val latency by vm.latencyMs.collectAsState()
    val picoTime by vm.picoTime.collectAsState()

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        StatusCard(
            connState = connState,
            latency = latency,
            picoTime = picoTime,
            infoLine = deviceInfo?.let { info ->
                buildString {
                    append(info.platform)
                    append(" · fw ").append(info.firmware)
                    info.tempC?.let { append(" · %.1f°C".format(it)) }
                    info.freeMemBytes?.let { append(" · ${it / 1024} KiB free") }
                }
            },
            onDisconnect = vm::disconnect,
            onPing = vm::ping,
        )

        if (!permissionsGranted) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Bluetooth permission needed", fontWeight = FontWeight.Bold)
                    Text(
                        "PicoLink needs Bluetooth (and on older Android versions, location) permission to scan for your Pico.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Button(onClick = onRequestPermissions) { Text("Grant permission") }
                }
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = { if (isScanning) vm.stopScan() else vm.startScan() },
                enabled = permissionsGranted,
            ) {
                Icon(
                    if (isScanning) Icons.Filled.BluetoothSearching else Icons.Filled.Bluetooth,
                    contentDescription = null,
                )
                Spacer(Modifier.width(8.dp))
                Text(if (isScanning) "Stop scan" else "Scan")
            }
            if (vm.hasLastDevice() && connState is ConnectionState.Disconnected) {
                OutlinedButton(onClick = vm::reconnectLastDevice, enabled = permissionsGranted) {
                    Icon(Icons.Filled.History, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Last: ${vm.lastDeviceLabel()}", maxLines = 1)
                }
            }
            if (isScanning) {
                CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
            }
        }

        Text(
            "Nearby devices (${devices.size})",
            style = MaterialTheme.typography.titleMedium,
        )

        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(devices, key = { it.address + it.type.name }) { device ->
                DeviceRow(
                    device = device,
                    connState = connState,
                    onConnect = { vm.connect(device) },
                )
            }
        }
    }
}

@Composable
private fun StatusCard(
    connState: ConnectionState,
    latency: Long?,
    picoTime: String?,
    infoLine: String?,
    onDisconnect: () -> Unit,
    onPing: () -> Unit,
) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                when (connState) {
                    is ConnectionState.Connected -> {
                        Icon(
                            Icons.Filled.BluetoothConnected,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.secondary,
                        )
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text(
                                connState.device.displayName,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                            )
                            Text(
                                "${connState.device.type} · ${connState.device.address}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                    is ConnectionState.Connecting -> {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("Connecting to ${connState.device.displayName}…")
                    }
                    is ConnectionState.Reconnecting -> {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("Reconnecting (attempt ${connState.attempt})…")
                    }
                    is ConnectionState.Disconnected -> {
                        Icon(Icons.Filled.LinkOff, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text("Not connected", style = MaterialTheme.typography.titleMedium)
                    }
                }
            }
            if (connState is ConnectionState.Connected) {
                infoLine?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                picoTime?.let { Text("Pico clock: $it", style = MaterialTheme.typography.bodySmall) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onPing) {
                        Text(latency?.let { "Ping ${it}ms" } ?: "Ping")
                    }
                    OutlinedButton(onClick = onDisconnect) { Text("Disconnect") }
                }
            }
        }
    }
}

@Composable
private fun DeviceRow(
    device: DiscoveredDevice,
    connState: ConnectionState,
    onConnect: () -> Unit,
) {
    val connectedTo = (connState as? ConnectionState.Connected)?.device?.address
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(device.displayName, fontWeight = FontWeight.SemiBold)
                Text(device.address, style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    AssistChip(
                        onClick = {},
                        label = { Text(if (device.type == TransportType.BLE) "BLE" else "Classic") },
                    )
                    if (device.bonded) {
                        AssistChip(onClick = {}, label = { Text("Paired") })
                    }
                    device.rssi?.let { rssi ->
                        AssistChip(
                            onClick = {},
                            label = { Text("$rssi dBm") },
                            leadingIcon = {
                                Icon(
                                    Icons.Filled.SignalCellularAlt,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                )
                            },
                        )
                    }
                }
            }
            Spacer(Modifier.width(8.dp))
            if (connectedTo == device.address) {
                Icon(
                    Icons.Filled.Link,
                    contentDescription = "Connected",
                    tint = MaterialTheme.colorScheme.secondary,
                )
            } else {
                Button(onClick = onConnect) { Text("Connect") }
            }
        }
    }
    Spacer(Modifier.height(2.dp))
}
