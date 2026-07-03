package com.picolink.storage

import android.content.Context
import android.content.SharedPreferences
import com.picolink.model.AppSettings
import com.picolink.model.Macro
import org.json.JSONArray
import org.json.JSONObject

/** Simple SharedPreferences-backed persistence for settings and macros. */
class Prefs(context: Context) {
    private val sp: SharedPreferences =
        context.getSharedPreferences("picolink", Context.MODE_PRIVATE)

    fun loadSettings(): AppSettings = AppSettings(
        autoReconnect = sp.getBoolean("autoReconnect", true),
        autoTimeSyncOnConnect = sp.getBoolean("autoTimeSync", true),
        autoPollPins = sp.getBoolean("autoPollPins", true),
        pollIntervalS = sp.getInt("pollIntervalS", 3),
        terminalTimestamps = sp.getBoolean("terminalTimestamps", true),
        hexView = sp.getBoolean("hexView", false),
        keepScreenOn = sp.getBoolean("keepScreenOn", false),
        lineEnding = sp.getString("lineEnding", "\n") ?: "\n",
        maxLogLines = sp.getInt("maxLogLines", 500),
    )

    fun saveSettings(s: AppSettings) {
        sp.edit()
            .putBoolean("autoReconnect", s.autoReconnect)
            .putBoolean("autoTimeSync", s.autoTimeSyncOnConnect)
            .putBoolean("autoPollPins", s.autoPollPins)
            .putInt("pollIntervalS", s.pollIntervalS)
            .putBoolean("terminalTimestamps", s.terminalTimestamps)
            .putBoolean("hexView", s.hexView)
            .putBoolean("keepScreenOn", s.keepScreenOn)
            .putString("lineEnding", s.lineEnding)
            .putInt("maxLogLines", s.maxLogLines)
            .apply()
    }

    fun loadMacros(): List<Macro> {
        val raw = sp.getString("macros", null) ?: return defaultMacros()
        return try {
            val arr = JSONArray(raw)
            buildList {
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    add(Macro(o.getLong("id"), o.getString("name"), o.getString("command")))
                }
            }
        } catch (_: Exception) {
            defaultMacros()
        }
    }

    fun saveMacros(macros: List<Macro>) {
        val arr = JSONArray()
        macros.forEach { m ->
            arr.put(JSONObject().put("id", m.id).put("name", m.name).put("command", m.command))
        }
        sp.edit().putString("macros", arr.toString()).apply()
    }

    fun lastDeviceAddress(): String? = sp.getString("lastDevice", null)
    fun setLastDevice(address: String?, name: String?, type: String?) {
        sp.edit()
            .putString("lastDevice", address)
            .putString("lastDeviceName", name)
            .putString("lastDeviceType", type)
            .apply()
    }
    fun lastDeviceName(): String? = sp.getString("lastDeviceName", null)
    fun lastDeviceType(): String? = sp.getString("lastDeviceType", null)

    private fun defaultMacros(): List<Macro> = listOf(
        Macro(1, "LED on", """{"cmd":"pin.write","pin":25,"value":1}"""),
        Macro(2, "LED off", """{"cmd":"pin.write","pin":25,"value":0}"""),
        Macro(3, "Read all pins", """{"cmd":"pin.read_all"}"""),
        Macro(4, "Board temp", """{"cmd":"sys.info"}"""),
    )
}
