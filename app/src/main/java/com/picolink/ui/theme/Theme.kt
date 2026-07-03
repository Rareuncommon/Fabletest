package com.picolink.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val PicoBlue = Color(0xFF5FA8D3)
private val PicoDeep = Color(0xFF1B4965)
private val PicoLight = Color(0xFFCAE9FF)
private val PicoGreen = Color(0xFF62B36F)

private val DarkColors = darkColorScheme(
    primary = PicoBlue,
    onPrimary = Color(0xFF00293D),
    primaryContainer = PicoDeep,
    onPrimaryContainer = PicoLight,
    secondary = PicoGreen,
    background = Color(0xFF0B141B),
    surface = Color(0xFF101B24),
)

private val LightColors = lightColorScheme(
    primary = PicoDeep,
    onPrimary = Color.White,
    primaryContainer = PicoLight,
    onPrimaryContainer = Color(0xFF001E2E),
    secondary = Color(0xFF2E7D32),
)

@Composable
fun PicoLinkTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }
    MaterialTheme(colorScheme = colorScheme, content = content)
}
