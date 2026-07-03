package com.picolink.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
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
import com.picolink.model.Program
import com.picolink.model.ProgramAction
import com.picolink.viewmodel.MainViewModel

private val DAY_LABELS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

@Composable
fun SchedulerScreen(vm: MainViewModel, modifier: Modifier = Modifier) {
    val programs by vm.programs.collectAsState()
    val connState by vm.connectionState.collectAsState()
    val picoTime by vm.picoTime.collectAsState()
    val connected = connState is ConnectionState.Connected

    var showEditor by remember { mutableStateOf(false) }

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
            Text("Scheduled programs", style = MaterialTheme.typography.titleLarge)
            Row {
                IconButton(onClick = vm::refreshPrograms, enabled = connected) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                }
                IconButton(onClick = vm::clearPrograms, enabled = connected && programs.isNotEmpty()) {
                    Icon(Icons.Filled.DeleteSweep, contentDescription = "Clear all")
                }
                IconButton(onClick = { showEditor = true }, enabled = connected) {
                    Icon(Icons.Filled.Add, contentDescription = "Add program")
                }
            }
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Row(
                Modifier.padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Filled.AccessTime, contentDescription = null)
                Column(Modifier.weight(1f)) {
                    Text(
                        picoTime?.let { "Pico clock: $it" } ?: "Pico clock not read yet",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        "Programs run on the Pico itself, even when the phone is away.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                TextButton(onClick = vm::syncTime, enabled = connected) { Text("Sync time") }
            }
        }

        if (!connected) {
            Text("Connect to a Pico to manage its programs.", style = MaterialTheme.typography.bodyMedium)
        } else if (programs.isEmpty()) {
            Text("No programs stored on the Pico yet. Tap + to create one.", style = MaterialTheme.typography.bodyMedium)
        }

        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(programs, key = { it.id }) { program ->
                ProgramCard(
                    program = program,
                    enabled = connected,
                    onToggle = { vm.setProgramEnabled(program.id, !program.enabled) },
                    onDelete = { vm.deleteProgram(program.id) },
                )
            }
        }
    }

    if (showEditor) {
        ProgramEditorDialog(
            nextId = vm.nextProgramId(),
            availablePins = vm.availablePins,
            onSave = { program ->
                vm.addProgram(program)
                showEditor = false
            },
            onDismiss = { showEditor = false },
        )
    }
}

@Composable
private fun ProgramCard(
    program: Program,
    enabled: Boolean,
    onToggle: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(program.name, fontWeight = FontWeight.Bold)
                Text(
                    "%02d:%02d".format(program.hour, program.minute) + "  ·  " +
                        formatDays(program.days),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(program.action.describe(), style = MaterialTheme.typography.bodySmall)
            }
            Switch(checked = program.enabled, onCheckedChange = { onToggle() }, enabled = enabled)
            IconButton(onClick = onDelete, enabled = enabled) {
                Icon(Icons.Filled.Delete, contentDescription = "Delete")
            }
        }
    }
}

private fun formatDays(days: Set<Int>): String = when {
    days.size == 7 -> "Every day"
    days == setOf(0, 1, 2, 3, 4) -> "Weekdays"
    days == setOf(5, 6) -> "Weekends"
    days.isEmpty() -> "Never"
    else -> days.sorted().joinToString(", ") { DAY_LABELS.getOrElse(it) { "?" } }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProgramEditorDialog(
    nextId: Int,
    availablePins: List<Int>,
    onSave: (Program) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf("Program $nextId") }
    val timeState = rememberTimePickerState(initialHour = 8, initialMinute = 0, is24Hour = true)
    var days by remember { mutableStateOf(setOf(0, 1, 2, 3, 4, 5, 6)) }
    var actionType by remember { mutableStateOf("pin.write") }
    var pin by remember { mutableStateOf(25) }
    var pinMenuOpen by remember { mutableStateOf(false) }
    var value by remember { mutableStateOf(1) }
    var freqText by remember { mutableStateOf("1000") }
    var dutyText by remember { mutableStateOf("50") }
    var pulseMsText by remember { mutableStateOf("1000") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New program") },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.verticalScroll(rememberScrollState()),
            ) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name") },
                    singleLine = true,
                )

                Text("Run at", fontWeight = FontWeight.SemiBold)
                TimePicker(state = timeState)

                Text("Days", fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    DAY_LABELS.forEachIndexed { i, label ->
                        FilterChip(
                            selected = i in days,
                            onClick = {
                                days = if (i in days) days - i else days + i
                            },
                            label = { Text(label.take(2)) },
                        )
                    }
                }

                Text("Action", fontWeight = FontWeight.SemiBold)
                Column {
                    listOf(
                        "pin.write" to "Set a pin high/low",
                        "pin.pulse" to "Pulse a pin",
                        "pwm.set" to "Set PWM output",
                    ).forEach { (type, label) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(
                                selected = actionType == type,
                                onClick = { actionType = type },
                            )
                            Text(label)
                        }
                    }
                }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Pin: ", fontWeight = FontWeight.SemiBold)
                    FilterChip(
                        selected = false,
                        onClick = { pinMenuOpen = true },
                        label = { Text("GP$pin") },
                    )
                    DropdownMenu(expanded = pinMenuOpen, onDismissRequest = { pinMenuOpen = false }) {
                        availablePins.forEach { p ->
                            DropdownMenuItem(
                                text = { Text("GP$p" + if (p == 25) " (LED)" else "") },
                                onClick = {
                                    pin = p
                                    pinMenuOpen = false
                                },
                            )
                        }
                    }
                }

                when (actionType) {
                    "pin.write", "pin.pulse" -> {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Level: ", fontWeight = FontWeight.SemiBold)
                            FilterChip(
                                selected = value == 1,
                                onClick = { value = 1 },
                                label = { Text("HIGH") },
                            )
                            FilterChip(
                                selected = value == 0,
                                onClick = { value = 0 },
                                label = { Text("LOW") },
                            )
                        }
                        if (actionType == "pin.pulse") {
                            OutlinedTextField(
                                value = pulseMsText,
                                onValueChange = { pulseMsText = it.filter(Char::isDigit) },
                                label = { Text("Pulse duration (ms)") },
                                singleLine = true,
                            )
                        }
                    }
                    "pwm.set" -> {
                        OutlinedTextField(
                            value = freqText,
                            onValueChange = { freqText = it.filter(Char::isDigit) },
                            label = { Text("Frequency (Hz)") },
                            singleLine = true,
                        )
                        OutlinedTextField(
                            value = dutyText,
                            onValueChange = { dutyText = it.filter(Char::isDigit) },
                            label = { Text("Duty cycle (%)") },
                            singleLine = true,
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(
                enabled = days.isNotEmpty() && name.isNotBlank(),
                onClick = {
                    val action = when (actionType) {
                        "pwm.set" -> ProgramAction.PwmSet(
                            pin = pin,
                            freq = freqText.toIntOrNull()?.coerceIn(8, 1_000_000) ?: 1000,
                            duty = ((dutyText.toIntOrNull() ?: 50).coerceIn(0, 100)) / 100f,
                        )
                        "pin.pulse" -> ProgramAction.PinPulse(
                            pin = pin,
                            value = value,
                            durationMs = pulseMsText.toIntOrNull()?.coerceIn(1, 3_600_000) ?: 1000,
                        )
                        else -> ProgramAction.PinWrite(pin, value)
                    }
                    onSave(
                        Program(
                            id = nextId,
                            name = name.trim(),
                            hour = timeState.hour,
                            minute = timeState.minute,
                            days = days,
                            action = action,
                            enabled = true,
                        )
                    )
                },
            ) { Text("Save to Pico") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
