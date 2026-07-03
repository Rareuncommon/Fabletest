package com.picolink.model

/** Which Bluetooth transport a discovered device was seen on. */
enum class TransportType { BLE, CLASSIC }

/** A device found during scanning (or from the bonded-device list). */
data class DiscoveredDevice(
    val address: String,
    val name: String?,
    val rssi: Int?,
    val type: TransportType,
    val bonded: Boolean,
) {
    val displayName: String get() = name ?: "Unknown device"
}

/** Connection lifecycle for the single active link. */
sealed class ConnectionState {
    data object Disconnected : ConnectionState()
    data class Connecting(val device: DiscoveredDevice) : ConnectionState()
    data class Connected(val device: DiscoveredDevice) : ConnectionState()
    data class Reconnecting(val device: DiscoveredDevice, val attempt: Int) : ConnectionState()
}

/** Pin operating modes supported by the firmware. */
enum class PinMode(val wire: String, val label: String) {
    OUT("out", "Output"),
    IN("in", "Input"),
    IN_PULLUP("in_pullup", "Input (pull-up)"),
    IN_PULLDOWN("in_pulldown", "Input (pull-down)"),
    PWM("pwm", "PWM"),
}

/** UI state for a single GPIO pin. */
data class PinUiState(
    val pin: Int,
    val mode: PinMode = PinMode.OUT,
    val value: Int = 0,
    val pwmFreq: Int = 1000,
    val pwmDuty: Float = 0f,
    val lastUpdated: Long = 0L,
)

/** A scheduled program stored on the Pico. */
data class Program(
    val id: Int,
    val name: String,
    val hour: Int,
    val minute: Int,
    /** Days of week the program runs on: 0 = Monday … 6 = Sunday (matches MicroPython localtime). */
    val days: Set<Int>,
    val action: ProgramAction,
    val enabled: Boolean = true,
)

/** What a scheduled program does when it fires. */
sealed class ProgramAction {
    data class PinWrite(val pin: Int, val value: Int) : ProgramAction()
    data class PwmSet(val pin: Int, val freq: Int, val duty: Float) : ProgramAction()
    data class PinPulse(val pin: Int, val value: Int, val durationMs: Int) : ProgramAction()

    fun describe(): String = when (this) {
        is PinWrite -> "Set GP$pin ${if (value == 1) "HIGH" else "LOW"}"
        is PwmSet -> "PWM GP$pin ${freq}Hz @ ${(duty * 100).toInt()}%"
        is PinPulse -> "Pulse GP$pin ${if (value == 1) "HIGH" else "LOW"} for ${durationMs}ms"
    }
}

/** Direction/kind of an entry in the terminal log. */
enum class LogDirection { SENT, RECEIVED, INFO, ERROR }

data class LogEntry(
    val timestamp: Long,
    val direction: LogDirection,
    val text: String,
)

/** A saved quick command. */
data class Macro(
    val id: Long,
    val name: String,
    val command: String,
)

/** System info reported by the Pico firmware. */
data class DeviceInfo(
    val firmware: String,
    val platform: String,
    val uptimeS: Long,
    val tempC: Double?,
    val freeMemBytes: Long?,
)

/** User-tunable app settings, persisted in SharedPreferences. */
data class AppSettings(
    val autoReconnect: Boolean = true,
    val autoTimeSyncOnConnect: Boolean = true,
    val autoPollPins: Boolean = true,
    val pollIntervalS: Int = 3,
    val terminalTimestamps: Boolean = true,
    val hexView: Boolean = false,
    val keepScreenOn: Boolean = false,
    val lineEnding: String = "\n",
    val maxLogLines: Int = 500,
)
