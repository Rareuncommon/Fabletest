# PicoLink 📱↔🔌

An Android app + MicroPython firmware pair for controlling a **Raspberry Pi
Pico over Bluetooth**: read and set GPIO pins, drive PWM, read analog inputs,
sync the Pico's clock from your phone, and store scheduled programs that run
on the Pico itself — even when your phone is out of range.

## Repository layout

| Path | What it is |
|---|---|
| `app/` | Android app (Kotlin, Jetpack Compose, Material 3) |
| `firmware/main.py` | MicroPython firmware for the Pico (BLE + UART) |
| `PROTOCOL.md` | The newline-delimited JSON protocol both sides speak |

## Feature highlights

### Connectivity
- **Dual transport** — BLE (Nordic UART Service, for Pico W / Pico 2 W) *and*
  Bluetooth Classic SPP (for a plain Pico wired to an HC-05/HC-06 module).
  One merged scanner finds devices on both radios at once.
- Bonded devices pre-seeded into scan results; results sorted by
  paired-status, name, and signal strength with live RSSI chips.
- **One-tap reconnect** to the last used device.
- **Auto-reconnect** with exponential backoff when a link drops.
- BLE MTU negotiation (247 bytes) with automatic write chunking.
- Ping with **round-trip latency** display.
- Runtime permission flow for both modern (API 31+) and legacy Android.

### Pins
- Configure any GPIO as output, input, input pull-up/pull-down, or PWM.
- Toggle outputs with switches; read inputs on demand.
- **Live polling** keeps pin states fresh at a configurable interval.
- Input pins are also **watched on the Pico** — changes push instantly as events.
- PWM frequency + duty-cycle slider.
- ADC readout for GP26–28 in volts, plus the on-board temperature sensor.
- Onboard LED (GP25) labelled and available as a quick macro.

### Time & scheduled programs
- **Sync the phone's clock (with timezone) to the Pico RTC**, automatically on
  connect or manually.
- Create programs with a name, time-of-day picker, and weekday selection
  (weekday/weekend/every-day patterns recognised).
- Actions: set a pin high/low, pulse a pin for a duration, or set a PWM output.
- Programs are **stored in the Pico's flash** and fire from the firmware's own
  scheduler — no phone needed. The app gets a `sched.fired` toast when
  connected.
- Enable/disable, delete, or clear programs remotely.

### Terminal & macros
- Full duplex console with color-coded sent/received/info/error lines,
  timestamps, monospace output, and auto-scroll.
- Send raw JSON or plain text; command **history** picker (last 30 commands).
- **Macros**: save any command as a named chip for one-tap reuse (ships with
  LED on/off, read-all, board-temp examples).
- **Share/export the log** via any Android share target.
- Optional hex view for received data.

### Quality of life
- Material 3 with dynamic color (Android 12+) and dark mode.
- Configurable line ending (LF/CRLF/CR), log history depth, keep-screen-on.
- Settings persist across launches.
- Snackbar surfacing of device-side errors (`{"ok": false, ...}`).

## Getting started

### 1. Flash the Pico

1. Install MicroPython on your Pico W / Pico 2 W (or plain Pico + HC-05).
2. Copy `firmware/main.py` to the board as `main.py` (Thonny → *Save as… →
   Raspberry Pi Pico*, or `mpremote cp firmware/main.py :main.py`).
3. Reset the board. A Pico W starts advertising as **PicoLink** over BLE;
   UART0 (GP0 TX / GP1 RX, 9600 baud) is always active for HC-05/HC-06 setups.

For an HC-05/HC-06: wire VCC→VSYS(5V), GND→GND, HC TX→GP1, HC RX→GP0, and pair
it in Android's Bluetooth settings first (PIN is usually `1234`).

### 2. Build the app

Open the project in Android Studio (Hedgehog or newer) and press Run, or:

```bash
gradle wrapper --gradle-version 8.9   # once, if gradlew isn't present
./gradlew assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/`. Requires JDK 17.

### 3. Connect

1. Grant the Bluetooth permission when prompted.
2. Tap **Scan**, pick your Pico (BLE) or HC-05 (Classic), tap **Connect**.
3. The app pings the board, syncs the clock, loads stored programs, and reads
   pin states automatically.

## Protocol

Both sides speak a small newline-delimited JSON protocol — documented in
[PROTOCOL.md](PROTOCOL.md) — so you can also drive the firmware from a laptop,
`mpremote`, or your own scripts.

## License

MIT — do whatever you like with it.
