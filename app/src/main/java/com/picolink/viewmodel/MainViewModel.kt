package com.picolink.viewmodel

import android.app.Application
import android.bluetooth.BluetoothManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.picolink.bluetooth.ConnectionManager
import com.picolink.bluetooth.DeviceScanner
import com.picolink.model.AppSettings
import com.picolink.model.ConnectionState
import com.picolink.model.DeviceInfo
import com.picolink.model.DiscoveredDevice
import com.picolink.model.LogDirection
import com.picolink.model.LogEntry
import com.picolink.model.Macro
import com.picolink.model.PinMode
import com.picolink.model.PinUiState
import com.picolink.model.Program
import com.picolink.model.TransportType
import com.picolink.protocol.Protocol
import com.picolink.storage.Prefs
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainViewModel(app: Application) : AndroidViewModel(app) {

    private val btManager = app.getSystemService(BluetoothManager::class.java)
    private val adapter = btManager?.adapter
    private val prefs = Prefs(app)

    val scanner = DeviceScanner(app, adapter)
    private val connection = ConnectionManager(app, adapter, viewModelScope)

    val connectionState: StateFlow<ConnectionState> = connection.state
    val scanResults: StateFlow<List<DiscoveredDevice>> = scanner.devices
    val isScanning: StateFlow<Boolean> = scanner.isScanning

    private val _settings = MutableStateFlow(prefs.loadSettings())
    val settings: StateFlow<AppSettings> = _settings.asStateFlow()

    private val _pinStates = MutableStateFlow<Map<Int, PinUiState>>(emptyMap())
    val pinStates: StateFlow<Map<Int, PinUiState>> = _pinStates.asStateFlow()

    private val _programs = MutableStateFlow<List<Program>>(emptyList())
    val programs: StateFlow<List<Program>> = _programs.asStateFlow()

    private val _log = MutableStateFlow<List<LogEntry>>(emptyList())
    val log: StateFlow<List<LogEntry>> = _log.asStateFlow()

    private val _macros = MutableStateFlow(prefs.loadMacros())
    val macros: StateFlow<List<Macro>> = _macros.asStateFlow()

    private val _deviceInfo = MutableStateFlow<DeviceInfo?>(null)
    val deviceInfo: StateFlow<DeviceInfo?> = _deviceInfo.asStateFlow()

    private val _picoTime = MutableStateFlow<String?>(null)
    val picoTime: StateFlow<String?> = _picoTime.asStateFlow()

    private val _latencyMs = MutableStateFlow<Long?>(null)
    val latencyMs: StateFlow<Long?> = _latencyMs.asStateFlow()

    private val _adcReadings = MutableStateFlow<Map<Int, Double>>(emptyMap())
    val adcReadings: StateFlow<Map<Int, Double>> = _adcReadings.asStateFlow()

    private val _snackbar = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val snackbar: SharedFlow<String> = _snackbar.asSharedFlow()

    val bluetoothAvailable: Boolean get() = adapter != null
    val bluetoothEnabled: Boolean get() = adapter?.isEnabled == true

    /** GP pins that are safe/typical to expose on a Pico (0..22, 25=LED, 26..28=ADC-capable). */
    val availablePins: List<Int> = (0..22).toList() + listOf(25, 26, 27, 28)

    private var pollJob: Job? = null

    init {
        connection.autoReconnect = _settings.value.autoReconnect

        viewModelScope.launch {
            connection.lines.collect { line -> handleIncoming(line) }
        }
        viewModelScope.launch {
            connection.errors.collect { err ->
                appendLog(LogDirection.ERROR, err)
                _snackbar.tryEmit(err)
            }
        }
        viewModelScope.launch {
            connection.state.collect { state ->
                when (state) {
                    is ConnectionState.Connected -> {
                        appendLog(LogDirection.INFO, "Connected to ${state.device.displayName} (${state.device.type})")
                        prefs.setLastDevice(state.device.address, state.device.name, state.device.type.name)
                        onConnected()
                    }
                    is ConnectionState.Disconnected -> {
                        pollJob?.cancel()
                        _latencyMs.value = null
                    }
                    else -> Unit
                }
            }
        }
    }

    // ---------- Scanning / connecting ----------

    fun startScan() {
        if (!bluetoothEnabled) {
            _snackbar.tryEmit("Bluetooth is off — enable it in system settings")
            return
        }
        scanner.start()
        // Auto-stop scanning after 20s to save battery.
        viewModelScope.launch {
            delay(20_000)
            scanner.stop()
        }
    }

    fun stopScan() = scanner.stop()

    fun connect(device: DiscoveredDevice) {
        scanner.stop()
        connection.connect(device)
    }

    fun reconnectLastDevice() {
        val addr = prefs.lastDeviceAddress() ?: run {
            _snackbar.tryEmit("No previous device")
            return
        }
        val type = try {
            TransportType.valueOf(prefs.lastDeviceType() ?: "BLE")
        } catch (_: Exception) { TransportType.BLE }
        connect(DiscoveredDevice(addr, prefs.lastDeviceName(), null, type, bonded = true))
    }

    fun hasLastDevice(): Boolean = prefs.lastDeviceAddress() != null
    fun lastDeviceLabel(): String = prefs.lastDeviceName() ?: prefs.lastDeviceAddress() ?: ""

    fun disconnect() = connection.disconnect()

    private fun onConnected() {
        viewModelScope.launch {
            delay(300) // give the link a beat to settle
            if (_settings.value.autoTimeSyncOnConnect) syncTime()
            requestSysInfo()
            refreshPrograms()
            readAllPins()
            startPollingIfEnabled()
        }
    }

    private fun startPollingIfEnabled() {
        pollJob?.cancel()
        if (!_settings.value.autoPollPins) return
        pollJob = viewModelScope.launch {
            while (isActive) {
                delay(_settings.value.pollIntervalS * 1000L)
                if (connection.isConnected) {
                    sendJson(Protocol.pinReadAll(), quiet = true)
                }
            }
        }
    }

    // ---------- Sending ----------

    private fun sendJson(obj: JSONObject, quiet: Boolean = false) {
        val text = obj.toString()
        if (!quiet) appendLog(LogDirection.SENT, text)
        connection.send(text, _settings.value.lineEnding)
    }

    fun sendRaw(text: String) {
        if (text.isBlank()) return
        appendLog(LogDirection.SENT, text)
        connection.send(text, _settings.value.lineEnding)
    }

    fun ping() {
        pingSentAt = System.currentTimeMillis()
        sendJson(Protocol.ping())
    }

    fun syncTime() = sendJson(Protocol.timeSet())
    fun requestTime() = sendJson(Protocol.timeGet())
    fun requestSysInfo() = sendJson(Protocol.sysInfo())

    fun setPinMode(pin: Int, mode: PinMode) {
        updatePin(pin) { it.copy(mode = mode) }
        sendJson(Protocol.pinMode(pin, mode))
    }

    fun writePin(pin: Int, value: Int) {
        updatePin(pin) { it.copy(value = value, lastUpdated = System.currentTimeMillis()) }
        sendJson(Protocol.pinWrite(pin, value))
    }

    fun readPin(pin: Int) = sendJson(Protocol.pinRead(pin))
    fun readAllPins() = sendJson(Protocol.pinReadAll(), quiet = true)

    fun setPwm(pin: Int, freq: Int, duty: Float) {
        updatePin(pin) { it.copy(mode = PinMode.PWM, pwmFreq = freq, pwmDuty = duty) }
        sendJson(Protocol.pwmSet(pin, freq, duty))
    }

    fun readAdc(channel: Int) = sendJson(Protocol.adcRead(channel))

    // ---------- Programs / scheduler ----------

    fun refreshPrograms() = sendJson(Protocol.schedList(), quiet = true)

    fun addProgram(program: Program) {
        sendJson(Protocol.schedAdd(program))
        refreshProgramsSoon()
    }

    fun deleteProgram(id: Int) {
        sendJson(Protocol.schedDelete(id))
        refreshProgramsSoon()
    }

    fun setProgramEnabled(id: Int, enabled: Boolean) {
        sendJson(Protocol.schedSetEnabled(id, enabled))
        refreshProgramsSoon()
    }

    fun clearPrograms() {
        sendJson(Protocol.schedClear())
        refreshProgramsSoon()
    }

    fun nextProgramId(): Int = (_programs.value.maxOfOrNull { it.id } ?: 0) + 1

    private fun refreshProgramsSoon() {
        viewModelScope.launch {
            delay(400)
            refreshPrograms()
        }
    }

    // ---------- Macros ----------

    fun addMacro(name: String, command: String) {
        val m = Macro(System.currentTimeMillis(), name, command)
        _macros.value = _macros.value + m
        prefs.saveMacros(_macros.value)
    }

    fun deleteMacro(id: Long) {
        _macros.value = _macros.value.filterNot { it.id == id }
        prefs.saveMacros(_macros.value)
    }

    fun runMacro(macro: Macro) = sendRaw(macro.command)

    // ---------- Settings ----------

    fun updateSettings(transform: (AppSettings) -> AppSettings) {
        val s = transform(_settings.value)
        _settings.value = s
        prefs.saveSettings(s)
        connection.autoReconnect = s.autoReconnect
        if (connection.isConnected) startPollingIfEnabled()
    }

    // ---------- Log ----------

    fun clearLog() {
        _log.value = emptyList()
    }

    fun exportLogText(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)
        return _log.value.joinToString("\n") { e ->
            "${fmt.format(Date(e.timestamp))} [${e.direction}] ${e.text}"
        }
    }

    private fun appendLog(direction: LogDirection, text: String) {
        val entry = LogEntry(System.currentTimeMillis(), direction, text)
        val max = _settings.value.maxLogLines
        _log.value = (_log.value + entry).takeLast(max)
    }

    // ---------- Incoming message handling ----------

    private var pingSentAt: Long = 0

    private fun handleIncoming(line: String) {
        val display = if (_settings.value.hexView) {
            line.toByteArray(Charsets.UTF_8).joinToString(" ") { "%02X".format(it) }
        } else line
        appendLog(LogDirection.RECEIVED, display)

        val obj = try { JSONObject(line) } catch (_: Exception) { return }

        // Async events pushed by the firmware.
        when (obj.optString("event")) {
            "pin" -> {
                val pin = obj.optInt("pin", -1)
                if (pin >= 0) updatePin(pin) {
                    it.copy(value = obj.optInt("value"), lastUpdated = System.currentTimeMillis())
                }
                return
            }
            "sched.fired" -> {
                _snackbar.tryEmit("Program \"${obj.optString("name")}\" ran on the Pico")
                return
            }
        }

        when (obj.optString("cmd")) {
            "ping" -> {
                if (pingSentAt > 0) {
                    _latencyMs.value = System.currentTimeMillis() - pingSentAt
                    pingSentAt = 0
                }
            }
            "time.get", "time.set" -> {
                obj.optString("iso").takeIf { it.isNotEmpty() }?.let { _picoTime.value = it }
            }
            "sys.info" -> {
                _deviceInfo.value = DeviceInfo(
                    firmware = obj.optString("fw", "?"),
                    platform = obj.optString("platform", "?"),
                    uptimeS = obj.optLong("uptime_s"),
                    tempC = if (obj.has("temp_c")) obj.optDouble("temp_c") else null,
                    freeMemBytes = if (obj.has("mem_free")) obj.optLong("mem_free") else null,
                )
            }
            "pin.read" -> {
                val pin = obj.optInt("pin", -1)
                if (pin >= 0) updatePin(pin) {
                    it.copy(value = obj.optInt("value"), lastUpdated = System.currentTimeMillis())
                }
            }
            "pin.read_all" -> {
                val pins = obj.optJSONObject("pins") ?: return
                val now = System.currentTimeMillis()
                val current = _pinStates.value.toMutableMap()
                for (key in pins.keys()) {
                    val pin = key.toIntOrNull() ?: continue
                    val v = pins.optInt(key)
                    val prev = current[pin] ?: PinUiState(pin)
                    current[pin] = prev.copy(value = v, lastUpdated = now)
                }
                _pinStates.value = current
            }
            "adc.read" -> {
                val ch = obj.optInt("ch", -1)
                if (ch >= 0) {
                    _adcReadings.value = _adcReadings.value + (ch to obj.optDouble("volts", 0.0))
                }
            }
            "sched.list" -> {
                val arr = obj.optJSONArray("progs") ?: return
                val list = buildList {
                    for (i in 0 until arr.length()) {
                        arr.optJSONObject(i)?.let { p -> Protocol.parseProgram(p)?.let(::add) }
                    }
                }
                _programs.value = list.sortedBy { it.hour * 60 + it.minute }
            }
        }

        if (!obj.optBoolean("ok", true)) {
            val err = obj.optString("err", "Unknown device error")
            _snackbar.tryEmit("Pico error: $err")
        }
    }

    private fun updatePin(pin: Int, transform: (PinUiState) -> PinUiState) {
        val current = _pinStates.value.toMutableMap()
        current[pin] = transform(current[pin] ?: PinUiState(pin))
        _pinStates.value = current
    }

    override fun onCleared() {
        scanner.stop()
        connection.disconnect()
        super.onCleared()
    }
}
