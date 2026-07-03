package com.picolink.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.picolink.viewmodel.MainViewModel
import kotlin.math.roundToInt

@Composable
fun SettingsScreen(vm: MainViewModel, modifier: Modifier = Modifier) {
    val settings by vm.settings.collectAsState()

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Settings", style = MaterialTheme.typography.titleLarge)

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Connection", fontWeight = FontWeight.Bold)

                ToggleRow(
                    title = "Auto-reconnect",
                    subtitle = "Retry with backoff if the link drops",
                    checked = settings.autoReconnect,
                ) { on -> vm.updateSettings { it.copy(autoReconnect = on) } }

                ToggleRow(
                    title = "Sync time on connect",
                    subtitle = "Send the phone's clock to the Pico automatically",
                    checked = settings.autoTimeSyncOnConnect,
                ) { on -> vm.updateSettings { it.copy(autoTimeSyncOnConnect = on) } }

                ToggleRow(
                    title = "Live pin polling",
                    subtitle = "Periodically refresh pin states while connected",
                    checked = settings.autoPollPins,
                ) { on -> vm.updateSettings { it.copy(autoPollPins = on) } }

                if (settings.autoPollPins) {
                    Text(
                        "Poll every ${settings.pollIntervalS}s",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Slider(
                        value = settings.pollIntervalS.toFloat(),
                        onValueChange = { v ->
                            vm.updateSettings { it.copy(pollIntervalS = v.roundToInt().coerceIn(1, 30)) }
                        },
                        valueRange = 1f..30f,
                        steps = 28,
                    )
                }
            }
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Terminal", fontWeight = FontWeight.Bold)

                ToggleRow(
                    title = "Timestamps",
                    subtitle = "Prefix log lines with the time received",
                    checked = settings.terminalTimestamps,
                ) { on -> vm.updateSettings { it.copy(terminalTimestamps = on) } }

                ToggleRow(
                    title = "Hex view",
                    subtitle = "Show received data as hex bytes",
                    checked = settings.hexView,
                ) { on -> vm.updateSettings { it.copy(hexView = on) } }

                HorizontalDivider(Modifier.padding(vertical = 8.dp))

                Text("Line ending", style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("\n" to "LF", "\r\n" to "CRLF", "\r" to "CR").forEach { (ending, label) ->
                        FilterChip(
                            selected = settings.lineEnding == ending,
                            onClick = { vm.updateSettings { it.copy(lineEnding = ending) } },
                            label = { Text(label) },
                        )
                    }
                }

                HorizontalDivider(Modifier.padding(vertical = 8.dp))

                Text(
                    "Log history: ${settings.maxLogLines} lines",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Slider(
                    value = settings.maxLogLines.toFloat(),
                    onValueChange = { v ->
                        vm.updateSettings { it.copy(maxLogLines = (v / 100).roundToInt() * 100) }
                    },
                    valueRange = 100f..2000f,
                    steps = 18,
                )
            }
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Display", fontWeight = FontWeight.Bold)
                ToggleRow(
                    title = "Keep screen on",
                    subtitle = "Prevent the screen sleeping while the app is open",
                    checked = settings.keepScreenOn,
                ) { on -> vm.updateSettings { it.copy(keepScreenOn = on) } }
            }
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("About", fontWeight = FontWeight.Bold)
                Text(
                    "PicoLink 1.0.0 — control a Raspberry Pi Pico over Bluetooth.\n\n" +
                        "Works with the bundled MicroPython firmware over BLE (Pico W / Pico 2 W) " +
                        "or a Classic SPP module such as an HC-05/HC-06 wired to a plain Pico.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun ToggleRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Text(subtitle, style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
