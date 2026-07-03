package com.picolink.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.picolink.model.ConnectionState
import com.picolink.model.PinMode
import com.picolink.model.PinUiState
import com.picolink.viewmodel.MainViewModel
import kotlin.math.roundToInt

@Composable
fun PinsScreen(vm: MainViewModel, modifier: Modifier = Modifier) {
    val pinStates by vm.pinStates.collectAsState()
    val connState by vm.connectionState.collectAsState()
    val adcReadings by vm.adcReadings.collectAsState()
    val connected = connState is ConnectionState.Connected

    var showAddPin by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("GPIO Pins", style = MaterialTheme.typography.titleLarge)
            Row {
                IconButton(onClick = vm::readAllPins, enabled = connected) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh all")
                }
                IconButton(onClick = { showAddPin = true }, enabled = connected) {
                    Icon(Icons.Filled.Add, contentDescription = "Add pin")
                }
            }
        }

        if (!connected) {
            Text(
                "Connect to a Pico to control its pins.",
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        AdcCard(
            enabled = connected,
            readings = adcReadings,
            onRead = vm::readAdc,
        )

        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(pinStates.values.sortedBy { it.pin }, key = { it.pin }) { pin ->
                PinCard(
                    pin = pin,
                    enabled = connected,
                    onModeChange = { vm.setPinMode(pin.pin, it) },
                    onToggle = { vm.writePin(pin.pin, if (pin.value == 1) 0 else 1) },
                    onRead = { vm.readPin(pin.pin) },
                    onPwmChange = { freq, duty -> vm.setPwm(pin.pin, freq, duty) },
                )
            }
        }
    }

    if (showAddPin) {
        AddPinDialog(
            availablePins = vm.availablePins.filterNot { pinStates.containsKey(it) },
            onAdd = { pin, mode ->
                vm.setPinMode(pin, mode)
                showAddPin = false
            },
            onDismiss = { showAddPin = false },
        )
    }
}

@Composable
private fun AdcCard(
    enabled: Boolean,
    readings: Map<Int, Double>,
    onRead: (Int) -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Analog inputs", fontWeight = FontWeight.SemiBold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (ch in 0..2) {
                    OutlinedButton(onClick = { onRead(ch) }, enabled = enabled) {
                        val v = readings[ch]
                        Text(if (v != null) "ADC$ch: %.3fV".format(v) else "ADC$ch (GP${26 + ch})")
                    }
                }
            }
        }
    }
}

@Composable
private fun PinCard(
    pin: PinUiState,
    enabled: Boolean,
    onModeChange: (PinMode) -> Unit,
    onToggle: () -> Unit,
    onRead: () -> Unit,
    onPwmChange: (Int, Float) -> Unit,
) {
    var modeMenuOpen by remember { mutableStateOf(false) }
    var duty by remember(pin.pin, pin.pwmDuty) { mutableStateOf(pin.pwmDuty) }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        "GP${pin.pin}" + if (pin.pin == 25) "  (onboard LED)" else "",
                        fontWeight = FontWeight.Bold,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        FilterChip(
                            selected = false,
                            onClick = { modeMenuOpen = true },
                            label = { Text(pin.mode.label) },
                            enabled = enabled,
                        )
                        DropdownMenu(
                            expanded = modeMenuOpen,
                            onDismissRequest = { modeMenuOpen = false },
                        ) {
                            PinMode.entries.forEach { mode ->
                                DropdownMenuItem(
                                    text = { Text(mode.label) },
                                    onClick = {
                                        modeMenuOpen = false
                                        onModeChange(mode)
                                    },
                                )
                            }
                        }
                    }
                }
                when (pin.mode) {
                    PinMode.OUT -> Switch(
                        checked = pin.value == 1,
                        onCheckedChange = { onToggle() },
                        enabled = enabled,
                    )
                    PinMode.IN, PinMode.IN_PULLUP, PinMode.IN_PULLDOWN -> Row(
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            if (pin.value == 1) "HIGH" else "LOW",
                            fontWeight = FontWeight.Bold,
                            color = if (pin.value == 1) MaterialTheme.colorScheme.secondary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.width(8.dp))
                        OutlinedButton(onClick = onRead, enabled = enabled) { Text("Read") }
                    }
                    PinMode.PWM -> Text("${(duty * 100).roundToInt()}%")
                }
            }
            if (pin.mode == PinMode.PWM) {
                Slider(
                    value = duty,
                    onValueChange = { duty = it },
                    onValueChangeFinished = { onPwmChange(pin.pwmFreq, duty) },
                    enabled = enabled,
                )
                Text(
                    "PWM ${pin.pwmFreq} Hz — drag to set duty cycle",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun AddPinDialog(
    availablePins: List<Int>,
    onAdd: (Int, PinMode) -> Unit,
    onDismiss: () -> Unit,
) {
    var selectedPin by remember { mutableStateOf(availablePins.firstOrNull() ?: 0) }
    var selectedMode by remember { mutableStateOf(PinMode.OUT) }
    var pinMenuOpen by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add pin") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Choose a GPIO pin and its mode.")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Pin: ", fontWeight = FontWeight.SemiBold)
                    FilterChip(
                        selected = false,
                        onClick = { pinMenuOpen = true },
                        label = { Text("GP$selectedPin") },
                    )
                    DropdownMenu(
                        expanded = pinMenuOpen,
                        onDismissRequest = { pinMenuOpen = false },
                    ) {
                        availablePins.forEach { p ->
                            DropdownMenuItem(
                                text = { Text("GP$p" + if (p == 25) " (LED)" else "") },
                                onClick = {
                                    selectedPin = p
                                    pinMenuOpen = false
                                },
                            )
                        }
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Mode: ", fontWeight = FontWeight.SemiBold)
                    PinMode.entries.forEach { mode ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            androidx.compose.material3.RadioButton(
                                selected = selectedMode == mode,
                                onClick = { selectedMode = mode },
                            )
                            Text(mode.label)
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onAdd(selectedPin, selectedMode) }) { Text("Add") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
