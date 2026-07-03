package com.picolink.ui.screens

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.picolink.model.LogDirection
import com.picolink.viewmodel.MainViewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun TerminalScreen(vm: MainViewModel, modifier: Modifier = Modifier) {
    val log by vm.log.collectAsState()
    val macros by vm.macros.collectAsState()
    val settings by vm.settings.collectAsState()
    val context = LocalContext.current

    var input by remember { mutableStateOf("") }
    val history = remember { mutableStateListOf<String>() }
    var historyMenuOpen by remember { mutableStateOf(false) }
    var showAddMacro by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val timeFmt = remember { SimpleDateFormat("HH:mm:ss", Locale.US) }

    LaunchedEffect(log.size) {
        if (log.isNotEmpty()) listState.animateScrollToItem(log.size - 1)
    }

    fun send(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        vm.sendRaw(t)
        history.remove(t)
        history.add(0, t)
        while (history.size > 30) history.removeAt(history.lastIndex)
        input = ""
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Terminal", style = MaterialTheme.typography.titleLarge)
            Row {
                IconButton(onClick = {
                    val share = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_TEXT, vm.exportLogText())
                        putExtra(Intent.EXTRA_SUBJECT, "PicoLink log")
                    }
                    context.startActivity(Intent.createChooser(share, "Share log"))
                }) {
                    Icon(Icons.Filled.Share, contentDescription = "Share log")
                }
                IconButton(onClick = vm::clearLog) {
                    Icon(Icons.Filled.Delete, contentDescription = "Clear log")
                }
            }
        }

        // Macro chips
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(macros, key = { it.id }) { macro ->
                var menuOpen by remember { mutableStateOf(false) }
                AssistChip(
                    onClick = { vm.runMacro(macro) },
                    label = { Text(macro.name) },
                    trailingIcon = {
                        IconButton(
                            onClick = { menuOpen = true },
                            modifier = Modifier.width(24.dp),
                        ) {
                            Icon(
                                Icons.Filled.MoreVert,
                                contentDescription = "Macro options",
                            )
                        }
                    },
                )
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("Delete \"${macro.name}\"") },
                        onClick = {
                            menuOpen = false
                            vm.deleteMacro(macro.id)
                        },
                    )
                }
            }
            item {
                AssistChip(
                    onClick = { showAddMacro = true },
                    label = { Text("New macro") },
                    leadingIcon = { Icon(Icons.Filled.Add, contentDescription = null) },
                )
            }
        }

        // Log
        LazyColumn(
            state = listState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .background(
                    MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                    RoundedCornerShape(8.dp),
                )
                .padding(8.dp),
        ) {
            itemsIndexed(log) { _, entry ->
                val color = when (entry.direction) {
                    LogDirection.SENT -> MaterialTheme.colorScheme.primary
                    LogDirection.RECEIVED -> MaterialTheme.colorScheme.onSurface
                    LogDirection.INFO -> MaterialTheme.colorScheme.secondary
                    LogDirection.ERROR -> MaterialTheme.colorScheme.error
                }
                val prefix = when (entry.direction) {
                    LogDirection.SENT -> "→ "
                    LogDirection.RECEIVED -> "← "
                    LogDirection.INFO -> "· "
                    LogDirection.ERROR -> "! "
                }
                val ts = if (settings.terminalTimestamps) {
                    timeFmt.format(Date(entry.timestamp)) + " "
                } else ""
                Text(
                    text = "$ts$prefix${entry.text}",
                    color = color,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        // Input row
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = { historyMenuOpen = true }, enabled = history.isNotEmpty()) {
                Icon(Icons.Filled.History, contentDescription = "History")
            }
            DropdownMenu(expanded = historyMenuOpen, onDismissRequest = { historyMenuOpen = false }) {
                history.forEach { h ->
                    DropdownMenuItem(
                        text = { Text(h, maxLines = 1) },
                        onClick = {
                            input = h
                            historyMenuOpen = false
                        },
                    )
                }
            }
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("""{"cmd":"ping"} or raw text""") },
                singleLine = true,
            )
            Spacer(Modifier.width(4.dp))
            IconButton(onClick = { send(input) }) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
            }
        }
    }

    if (showAddMacro) {
        var name by remember { mutableStateOf("") }
        var command by remember { mutableStateOf(input) }
        AlertDialog(
            onDismissRequest = { showAddMacro = false },
            title = { Text("New macro") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("Name") },
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = command,
                        onValueChange = { command = it },
                        label = { Text("Command") },
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = name.isNotBlank() && command.isNotBlank(),
                    onClick = {
                        vm.addMacro(name.trim(), command.trim())
                        showAddMacro = false
                    },
                ) { Text("Save") }
            },
            dismissButton = {
                TextButton(onClick = { showAddMacro = false }) { Text("Cancel") }
            },
        )
    }
}
