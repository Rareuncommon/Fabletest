"""PicoLink firmware for Raspberry Pi Pico W / Pico 2 W (MicroPython).

Speaks newline-delimited JSON (see PROTOCOL.md) over:
  * BLE using the Nordic UART Service (Pico W / Pico 2 W built-in radio), and
  * UART0 (GP0=TX, GP1=RX @ 9600 baud) so a plain Pico with an HC-05/HC-06
    Classic Bluetooth module works with the exact same app.

Features:
  * pin.mode / pin.read / pin.write / pin.read_all — digital GPIO control
  * pwm.set — PWM output with frequency + duty
  * adc.read — read ADC0..2 (GP26..28) plus channel 4 (internal temperature)
  * time.set / time.get — phone syncs the on-board RTC (with timezone offset)
  * sched.* — programs stored in flash (schedules.json) that fire at a given
    time on chosen weekdays, even with the phone disconnected
  * pin.pulse actions, async "sched.fired" and input-change "pin" events
  * sys.info — platform, firmware version, uptime, temperature, free memory

Copy this file to the Pico as main.py (e.g. with Thonny or mpremote).
No third-party libraries required.
"""

import json
import machine
import micropython
import sys
import time

try:
    import bluetooth
except ImportError:
    bluetooth = None  # plain Pico without a radio: UART/HC-05 only

micropython.alloc_emergency_exception_buf(100)

FIRMWARE_VERSION = "1.0.0"
DEVICE_NAME = "PicoLink"
SCHEDULE_FILE = "schedules.json"
UART_BAUD = 9600

BOOT_MS = time.ticks_ms()

# ---------------------------------------------------------------------------
# Hardware state
# ---------------------------------------------------------------------------

pins = {}       # gpio number -> machine.Pin
pin_modes = {}  # gpio number -> mode string
pwms = {}       # gpio number -> machine.PWM
watch_inputs = {}  # gpio number -> last value (for change events)

VALID_PINS = list(range(0, 23)) + [25, 26, 27, 28]


def setup_pin(num, mode):
    if num not in VALID_PINS:
        raise ValueError("invalid pin %s" % num)
    if num in pwms:
        pwms[num].deinit()
        del pwms[num]
    if mode == "out":
        pins[num] = machine.Pin(num, machine.Pin.OUT)
    elif mode == "in":
        pins[num] = machine.Pin(num, machine.Pin.IN)
    elif mode == "in_pullup":
        pins[num] = machine.Pin(num, machine.Pin.IN, machine.Pin.PULL_UP)
    elif mode == "in_pulldown":
        pins[num] = machine.Pin(num, machine.Pin.IN, machine.Pin.PULL_DOWN)
    elif mode == "pwm":
        pins[num] = machine.Pin(num)
        pwms[num] = machine.PWM(pins[num])
        pwms[num].freq(1000)
        pwms[num].duty_u16(0)
    else:
        raise ValueError("invalid mode %s" % mode)
    pin_modes[num] = mode
    if mode.startswith("in"):
        watch_inputs[num] = pins[num].value()
    else:
        watch_inputs.pop(num, None)


def write_pin(num, value):
    if pin_modes.get(num) != "out":
        setup_pin(num, "out")
    pins[num].value(1 if value else 0)


def read_pin(num):
    if num not in pins:
        setup_pin(num, "in")
    return pins[num].value()


def set_pwm(num, freq, duty):
    if pin_modes.get(num) != "pwm":
        setup_pin(num, "pwm")
    freq = max(8, min(int(freq), 1000000))
    duty = max(0.0, min(float(duty), 1.0))
    pwms[num].freq(freq)
    pwms[num].duty_u16(int(duty * 65535))


def read_adc(ch):
    if ch == 4:
        adc = machine.ADC(4)  # internal temperature sensor
    elif 0 <= ch <= 2:
        adc = machine.ADC(26 + ch)
    else:
        raise ValueError("invalid adc channel %s" % ch)
    raw = adc.read_u16()
    volts = raw * 3.3 / 65535
    return raw, volts


def board_temp_c():
    raw, volts = read_adc(4)
    return 27 - (volts - 0.706) / 0.001721


# ---------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------

tz_offset_min = 0
rtc = machine.RTC()


def set_time(epoch, offset_min):
    global tz_offset_min
    tz_offset_min = int(offset_min)
    local = int(epoch) + tz_offset_min * 60
    # MicroPython epoch starts 2000-01-01 on the Pico port; convert from Unix.
    try:
        t = time.gmtime(local - 946684800)
    except (OverflowError, ValueError):
        t = time.gmtime(local)
    # rtc.datetime: (year, month, day, weekday, hour, minute, second, subsecond)
    rtc.datetime((t[0], t[1], t[2], t[6], t[3], t[4], t[5], 0))


def iso_now():
    t = time.localtime()
    return "%04d-%02d-%02d %02d:%02d:%02d" % (t[0], t[1], t[2], t[3], t[4], t[5])


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

programs = []          # list of program dicts (see PROTOCOL.md)
_last_fired = {}       # program id -> "day-hour-min" it last fired
_pulse_queue = []      # (deadline_ms, pin, restore_value)


def load_programs():
    global programs
    try:
        with open(SCHEDULE_FILE) as f:
            programs = json.load(f)
    except (OSError, ValueError):
        programs = []


def save_programs():
    try:
        with open(SCHEDULE_FILE, "w") as f:
            json.dump(programs, f)
    except OSError:
        pass


def run_action(action):
    typ = action.get("type")
    if typ == "pin.write":
        write_pin(int(action["pin"]), int(action["value"]))
    elif typ == "pwm.set":
        set_pwm(int(action["pin"]), action.get("freq", 1000), action.get("duty", 0))
    elif typ == "pin.pulse":
        pin = int(action["pin"])
        value = int(action.get("value", 1))
        ms = int(action.get("ms", 1000))
        write_pin(pin, value)
        _pulse_queue.append((time.ticks_add(time.ticks_ms(), ms), pin, 0 if value else 1))


def scheduler_tick(broadcast):
    """Fire due programs. time.localtime() weekday: 0=Monday .. 6=Sunday."""
    t = time.localtime()
    weekday, hour, minute = t[6], t[3], t[4]
    stamp = "%d-%d-%d" % (weekday, hour, minute)
    for prog in programs:
        if not prog.get("enabled", True):
            continue
        if prog.get("hour") != hour or prog.get("min") != minute:
            continue
        if weekday not in prog.get("days", []):
            continue
        pid = prog.get("id")
        if _last_fired.get(pid) == stamp:
            continue
        _last_fired[pid] = stamp
        try:
            run_action(prog.get("action", {}))
            broadcast({"event": "sched.fired", "prog_id": pid,
                       "name": prog.get("name", "")})
        except Exception as e:
            broadcast({"event": "sched.error", "prog_id": pid, "err": str(e)})

    now = time.ticks_ms()
    done = [p for p in _pulse_queue if time.ticks_diff(p[0], now) <= 0]
    for entry in done:
        _pulse_queue.remove(entry)
        try:
            write_pin(entry[1], entry[2])
        except Exception:
            pass


def watch_tick(broadcast):
    """Emit pin events when a watched input changes."""
    for num in list(watch_inputs):
        try:
            v = pins[num].value()
        except KeyError:
            continue
        if v != watch_inputs[num]:
            watch_inputs[num] = v
            broadcast({"event": "pin", "pin": num, "value": v})


# ---------------------------------------------------------------------------
# Command handling
# ---------------------------------------------------------------------------

def handle_command(obj, broadcast):
    cmd = obj.get("cmd", "")
    rsp = {"ok": True, "cmd": cmd}
    if "id" in obj:
        rsp["id"] = obj["id"]
    try:
        if cmd == "ping":
            rsp["t"] = obj.get("t")
            rsp["uptime_s"] = time.ticks_diff(time.ticks_ms(), BOOT_MS) // 1000
        elif cmd == "time.set":
            set_time(obj["epoch"], obj.get("tz_offset_min", 0))
            rsp["iso"] = iso_now()
        elif cmd == "time.get":
            rsp["iso"] = iso_now()
            rsp["tz_offset_min"] = tz_offset_min
        elif cmd == "sys.info":
            import gc
            gc.collect()
            rsp["fw"] = FIRMWARE_VERSION
            rsp["platform"] = sys.platform
            rsp["uptime_s"] = time.ticks_diff(time.ticks_ms(), BOOT_MS) // 1000
            rsp["mem_free"] = gc.mem_free()
            try:
                rsp["temp_c"] = round(board_temp_c(), 2)
            except Exception:
                pass
        elif cmd == "pin.mode":
            setup_pin(int(obj["pin"]), obj["mode"])
            rsp["pin"] = obj["pin"]
            rsp["mode"] = obj["mode"]
        elif cmd == "pin.write":
            write_pin(int(obj["pin"]), int(obj["value"]))
            rsp["pin"] = obj["pin"]
            rsp["value"] = int(obj["value"])
        elif cmd == "pin.read":
            rsp["pin"] = int(obj["pin"])
            rsp["value"] = read_pin(int(obj["pin"]))
        elif cmd == "pin.read_all":
            rsp["pins"] = {str(n): pins[n].value() for n in pins if n not in pwms}
        elif cmd == "pwm.set":
            set_pwm(int(obj["pin"]), obj.get("freq", 1000), obj.get("duty", 0))
            rsp["pin"] = obj["pin"]
        elif cmd == "adc.read":
            ch = int(obj.get("ch", 0))
            raw, volts = read_adc(ch)
            rsp["ch"] = ch
            rsp["raw"] = raw
            rsp["volts"] = round(volts, 4)
        elif cmd == "sched.add":
            prog = obj["prog"]
            programs[:] = [p for p in programs if p.get("id") != prog.get("id")]
            programs.append(prog)
            save_programs()
            rsp["prog_id"] = prog.get("id")
        elif cmd == "sched.del":
            pid = obj.get("prog_id")
            programs[:] = [p for p in programs if p.get("id") != pid]
            save_programs()
        elif cmd == "sched.enable":
            pid = obj.get("prog_id")
            for p in programs:
                if p.get("id") == pid:
                    p["enabled"] = bool(obj.get("enabled", True))
            save_programs()
        elif cmd == "sched.list":
            rsp["progs"] = programs
        elif cmd == "sched.clear":
            programs[:] = []
            save_programs()
        else:
            rsp["ok"] = False
            rsp["err"] = "unknown cmd: %s" % cmd
    except Exception as e:
        rsp["ok"] = False
        rsp["err"] = str(e)
    return rsp


# ---------------------------------------------------------------------------
# BLE transport (Nordic UART Service)
# ---------------------------------------------------------------------------

class BleUart:
    NUS_SERVICE = bluetooth.UUID("6E400001-B5A3-F393-E0A9-E50E24DCCA9E") if bluetooth else None

    def __init__(self, name):
        self._rx_buffer = b""
        self._conn_handle = None
        self.ble = bluetooth.BLE()
        self.ble.active(True)
        self.ble.irq(self._irq)
        RX = (bluetooth.UUID("6E400002-B5A3-F393-E0A9-E50E24DCCA9E"),
              bluetooth.FLAG_WRITE | bluetooth.FLAG_WRITE_NO_RESPONSE)
        TX = (bluetooth.UUID("6E400003-B5A3-F393-E0A9-E50E24DCCA9E"),
              bluetooth.FLAG_NOTIFY)
        ((self._tx_handle, self._rx_handle),) = self.ble.gatts_register_services(
            ((self.NUS_SERVICE, (TX, RX)),))
        self.ble.gatts_set_buffer(self._rx_handle, 512, True)
        self._name = name
        self._advertise()

    def _advertise(self):
        name = bytes(self._name, "utf-8")
        adv = b"\x02\x01\x06" + bytes((len(name) + 1, 0x09)) + name
        self.ble.gap_advertise(100_000, adv_data=adv)

    def _irq(self, event, data):
        if event == 1:  # _IRQ_CENTRAL_CONNECT
            self._conn_handle = data[0]
        elif event == 2:  # _IRQ_CENTRAL_DISCONNECT
            self._conn_handle = None
            self._advertise()
        elif event == 3:  # _IRQ_GATTS_WRITE
            conn_handle, attr_handle = data
            if attr_handle == self._rx_handle:
                self._rx_buffer += self.ble.gatts_read(self._rx_handle)

    def read_lines(self):
        lines = []
        while b"\n" in self._rx_buffer:
            line, self._rx_buffer = self._rx_buffer.split(b"\n", 1)
            line = line.strip()
            if line:
                lines.append(line)
        return lines

    def send(self, data):
        if self._conn_handle is None:
            return
        for i in range(0, len(data), 20):
            try:
                self.ble.gatts_notify(self._conn_handle, self._tx_handle,
                                      data[i:i + 20])
            except OSError:
                break


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    load_programs()

    uart = machine.UART(0, baudrate=UART_BAUD, tx=machine.Pin(0), rx=machine.Pin(1))
    uart_buf = b""

    ble = None
    if bluetooth is not None:
        try:
            ble = BleUart(DEVICE_NAME)
            print("BLE advertising as", DEVICE_NAME)
        except Exception as e:
            print("BLE unavailable:", e)
    print("UART0 listening at", UART_BAUD, "baud (GP0 TX / GP1 RX)")

    def broadcast(obj):
        data = (json.dumps(obj) + "\n").encode()
        if ble:
            ble.send(data)
        try:
            uart.write(data)
        except OSError:
            pass

    last_sched_check = 0
    last_watch_check = 0

    while True:
        # BLE input
        if ble:
            for line in ble.read_lines():
                try:
                    rsp = handle_command(json.loads(line), broadcast)
                except ValueError:
                    rsp = {"ok": False, "err": "bad json"}
                ble.send((json.dumps(rsp) + "\n").encode())

        # UART input
        n = uart.any()
        if n:
            uart_buf += uart.read(n) or b""
            while b"\n" in uart_buf:
                line, uart_buf = uart_buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    rsp = handle_command(json.loads(line), broadcast)
                except ValueError:
                    rsp = {"ok": False, "err": "bad json"}
                try:
                    uart.write((json.dumps(rsp) + "\n").encode())
                except OSError:
                    pass

        now = time.ticks_ms()
        if time.ticks_diff(now, last_sched_check) >= 1000:
            last_sched_check = now
            scheduler_tick(broadcast)
        if time.ticks_diff(now, last_watch_check) >= 100:
            last_watch_check = now
            watch_tick(broadcast)

        time.sleep_ms(20)


if __name__ == "__main__":
    main()
