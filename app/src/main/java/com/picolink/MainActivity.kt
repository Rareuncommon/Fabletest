package com.picolink

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.picolink.ui.screens.ConnectScreen
import com.picolink.ui.screens.PinsScreen
import com.picolink.ui.screens.SchedulerScreen
import com.picolink.ui.screens.SettingsScreen
import com.picolink.ui.screens.TerminalScreen
import com.picolink.ui.theme.PicoLinkTheme
import com.picolink.viewmodel.MainViewModel

enum class Tab(val label: String, val icon: ImageVector) {
    CONNECT("Connect", Icons.Filled.Bluetooth),
    PINS("Pins", Icons.Filled.Memory),
    SCHEDULE("Programs", Icons.Filled.Schedule),
    TERMINAL("Terminal", Icons.Filled.Terminal),
    SETTINGS("Settings", Icons.Filled.Settings),
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            PicoLinkTheme {
                PicoLinkApp(
                    onKeepScreenOn = { on ->
                        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                )
            }
        }
    }
}

private fun requiredPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

@Composable
fun PicoLinkApp(onKeepScreenOn: (Boolean) -> Unit) {
    val vm: MainViewModel = viewModel()
    var tab by rememberSaveable { mutableStateOf(Tab.CONNECT) }
    val snackbarHostState = remember { SnackbarHostState() }
    val settings by vm.settings.collectAsState()

    val context = androidx.compose.ui.platform.LocalContext.current
    var permissionsGranted by remember {
        mutableStateOf(
            requiredPermissions().all {
                ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
            }
        )
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        permissionsGranted = results.values.all { it }
    }

    LaunchedEffect(Unit) {
        if (!permissionsGranted) permissionLauncher.launch(requiredPermissions())
    }
    LaunchedEffect(settings.keepScreenOn) {
        onKeepScreenOn(settings.keepScreenOn)
    }
    LaunchedEffect(Unit) {
        vm.snackbar.collect { msg -> snackbarHostState.showSnackbar(msg) }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Icon(t.icon, contentDescription = t.label) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { padding ->
        val modifier = Modifier.padding(padding)
        when (tab) {
            Tab.CONNECT -> ConnectScreen(
                vm = vm,
                permissionsGranted = permissionsGranted,
                onRequestPermissions = { permissionLauncher.launch(requiredPermissions()) },
                modifier = modifier,
            )
            Tab.PINS -> PinsScreen(vm = vm, modifier = modifier)
            Tab.SCHEDULE -> SchedulerScreen(vm = vm, modifier = modifier)
            Tab.TERMINAL -> TerminalScreen(vm = vm, modifier = modifier)
            Tab.SETTINGS -> SettingsScreen(vm = vm, modifier = modifier)
        }
    }
}
