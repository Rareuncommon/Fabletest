# PicoLink Protocol

PicoLink uses **newline-delimited JSON** in both directions. Every message is a
single-line JSON object terminated by `\n`. The same protocol runs over both
transports:

- **BLE** — Nordic UART Service (`6E400001-B5A3-F393-E0A9-E50E24DCCA9E`);
  the app writes to RX (`…0002`) and subscribes to TX (`…0003`) notifications.
- **Bluetooth Classic (SPP/RFCOMM)** — e.g. an HC-05/HC-06 wired to the
  Pico's UART0 (GP0/GP1, 9600 baud by default).

## Requests

Each request carries a `cmd` and an optional monotonically increasing `id`.
The firmware echoes both `cmd` and `id` in the reply so responses can be
matched without extra state.

| Command | Extra fields | Purpose |
|---|---|---|
| `ping` | `t` (ms timestamp, echoed) | Liveness + round-trip latency |
| `time.set` | `epoch` (Unix seconds), `tz_offset_min` | Set the Pico RTC to local time |
| `time.get` | — | Read the Pico clock |
| `sys.info` | — | Firmware/platform/uptime/temp/free memory |
| `pin.mode` | `pin`, `mode` (`out`, `in`, `in_pullup`, `in_pulldown`, `pwm`) | Configure a GPIO |
| `pin.write` | `pin`, `value` (0/1) | Drive an output pin |
| `pin.read` | `pin` | Read one pin |
| `pin.read_all` | — | Read every configured (non-PWM) pin |
| `pwm.set` | `pin`, `freq` (Hz), `duty` (0.0–1.0) | PWM output |
| `adc.read` | `ch` (0–2 → GP26–28, 4 → internal temp sensor) | Analog read |
| `sched.add` | `prog` (see below) | Store/replace a scheduled program |
| `sched.list` | — | List stored programs |
| `sched.del` | `prog_id` | Delete a program |
| `sched.enable` | `prog_id`, `enabled` | Enable/disable a program |
| `sched.clear` | — | Delete all programs |

### Program objects

Programs persist on the Pico in `schedules.json` and run even while the phone
is disconnected. `days` uses MicroPython weekday numbering: **0 = Monday …
6 = Sunday**.

```json
{
  "id": 1,
  "name": "Morning lamp",
  "hour": 7,
  "min": 30,
  "days": [0, 1, 2, 3, 4],
  "enabled": true,
  "action": {"type": "pin.write", "pin": 15, "value": 1}
}
```

Supported actions:

- `{"type": "pin.write", "pin": N, "value": 0|1}`
- `{"type": "pwm.set", "pin": N, "freq": Hz, "duty": 0.0-1.0}`
- `{"type": "pin.pulse", "pin": N, "value": 0|1, "ms": duration}` — drive the
  pin, then restore the opposite level after `ms` milliseconds.

## Responses

Every reply contains `ok` (boolean), the echoed `cmd`/`id`, and command-
specific fields; failures carry `err`:

```json
{"ok": true, "cmd": "pin.read", "id": 12, "pin": 25, "value": 1}
{"ok": false, "cmd": "pin.write", "id": 13, "err": "invalid pin 99"}
{"ok": true, "cmd": "sys.info", "fw": "1.0.0", "platform": "rp2", "uptime_s": 120, "temp_c": 24.5, "mem_free": 145000}
{"ok": true, "cmd": "pin.read_all", "pins": {"25": 1, "15": 0}}
{"ok": true, "cmd": "adc.read", "ch": 0, "raw": 32768, "volts": 1.65}
```

## Asynchronous events

The firmware may push messages at any time (no `id`):

```json
{"event": "pin", "pin": 16, "value": 1}                       // watched input changed
{"event": "sched.fired", "prog_id": 1, "name": "Morning lamp"} // program ran
{"event": "sched.error", "prog_id": 1, "err": "..."}           // program failed
```

Inputs are watched automatically once configured via `pin.mode` with any
`in*` mode (checked every ~100 ms).
