package com.picolink.bluetooth

/**
 * A byte-stream link to the Pico. Implementations deliver received bytes to
 * [onData] as they arrive (framing into lines is done by the caller) and
 * report an unexpected drop through [onClosed].
 */
interface Transport {
    /** Establish the link. Throws on failure. Must be called off the main thread. */
    suspend fun connect()

    /** Queue raw bytes for transmission. Throws if the link is down. */
    suspend fun send(bytes: ByteArray)

    /** Tear down the link. Safe to call multiple times. */
    fun close()

    var onData: ((ByteArray) -> Unit)?
    var onClosed: ((reason: String) -> Unit)?
}
