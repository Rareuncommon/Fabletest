package com.picolink.protocol

import com.picolink.model.PinMode
import com.picolink.model.Program
import com.picolink.model.ProgramAction
import org.json.JSONArray
import org.json.JSONObject
import java.util.TimeZone
import java.util.concurrent.atomic.AtomicInteger

/**
 * Builds newline-delimited JSON commands understood by the PicoLink firmware
 * (see PROTOCOL.md and firmware/main.py). Every request carries a
 * monotonically increasing "id"; the firmware echoes both "id" and "cmd"
 * in its reply so responses are trivially matched.
 */
object Protocol {
    private val nextId = AtomicInteger(1)

    private fun cmd(name: String): JSONObject =
        JSONObject().put("cmd", name).put("id", nextId.getAndIncrement())

    fun ping(): JSONObject = cmd("ping").put("t", System.currentTimeMillis())

    fun timeSet(): JSONObject {
        val nowMs = System.currentTimeMillis()
        val offsetMin = TimeZone.getDefault().getOffset(nowMs) / 60000
        return cmd("time.set")
            .put("epoch", nowMs / 1000)
            .put("tz_offset_min", offsetMin)
    }

    fun timeGet(): JSONObject = cmd("time.get")

    fun sysInfo(): JSONObject = cmd("sys.info")

    fun pinMode(pin: Int, mode: PinMode): JSONObject =
        cmd("pin.mode").put("pin", pin).put("mode", mode.wire)

    fun pinWrite(pin: Int, value: Int): JSONObject =
        cmd("pin.write").put("pin", pin).put("value", value)

    fun pinRead(pin: Int): JSONObject = cmd("pin.read").put("pin", pin)

    fun pinReadAll(): JSONObject = cmd("pin.read_all")

    fun pwmSet(pin: Int, freq: Int, duty: Float): JSONObject =
        cmd("pwm.set").put("pin", pin).put("freq", freq).put("duty", duty.toDouble())

    fun adcRead(channel: Int): JSONObject = cmd("adc.read").put("ch", channel)

    fun schedList(): JSONObject = cmd("sched.list")

    fun schedAdd(program: Program): JSONObject =
        cmd("sched.add").put("prog", programToJson(program))

    fun schedDelete(id: Int): JSONObject = cmd("sched.del").put("prog_id", id)

    fun schedSetEnabled(id: Int, enabled: Boolean): JSONObject =
        cmd("sched.enable").put("prog_id", id).put("enabled", enabled)

    fun schedClear(): JSONObject = cmd("sched.clear")

    fun programToJson(p: Program): JSONObject = JSONObject()
        .put("id", p.id)
        .put("name", p.name)
        .put("hour", p.hour)
        .put("min", p.minute)
        .put("days", JSONArray(p.days.sorted()))
        .put("enabled", p.enabled)
        .put("action", actionToJson(p.action))

    private fun actionToJson(a: ProgramAction): JSONObject = when (a) {
        is ProgramAction.PinWrite -> JSONObject()
            .put("type", "pin.write").put("pin", a.pin).put("value", a.value)
        is ProgramAction.PwmSet -> JSONObject()
            .put("type", "pwm.set").put("pin", a.pin).put("freq", a.freq).put("duty", a.duty.toDouble())
        is ProgramAction.PinPulse -> JSONObject()
            .put("type", "pin.pulse").put("pin", a.pin).put("value", a.value).put("ms", a.durationMs)
    }

    fun parseAction(o: JSONObject): ProgramAction? = when (o.optString("type")) {
        "pin.write" -> ProgramAction.PinWrite(o.optInt("pin"), o.optInt("value"))
        "pwm.set" -> ProgramAction.PwmSet(o.optInt("pin"), o.optInt("freq", 1000), o.optDouble("duty", 0.0).toFloat())
        "pin.pulse" -> ProgramAction.PinPulse(o.optInt("pin"), o.optInt("value", 1), o.optInt("ms", 1000))
        else -> null
    }

    fun parseProgram(o: JSONObject): Program? {
        val action = o.optJSONObject("action")?.let { parseAction(it) } ?: return null
        val daysArr = o.optJSONArray("days") ?: JSONArray()
        val days = buildSet { for (i in 0 until daysArr.length()) add(daysArr.optInt(i)) }
        return Program(
            id = o.optInt("id"),
            name = o.optString("name", "Program"),
            hour = o.optInt("hour"),
            minute = o.optInt("min"),
            days = days,
            action = action,
            enabled = o.optBoolean("enabled", true),
        )
    }
}
