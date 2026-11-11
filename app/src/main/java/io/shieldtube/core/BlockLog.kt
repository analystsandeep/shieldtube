// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.core

/**
 * Fixed-capacity (500) in-memory ring buffer plus monotonic counters.
 *
 * Slots are preallocated: recording a block does not allocate, so the hot
 * `shouldInterceptRequest` path only allocates when a request is actually
 * blocked (the WebResourceResponse).
 */
object BlockLog {
    const val CAPACITY = 500

    class Entry {
        @JvmField var url: String = ""
        @JvmField var type: String = ""
        @JvmField var atMillis: Long = 0L
    }

    private val ring = Array(CAPACITY) { Entry() }
    private val lock = Any()

    @Volatile private var index = 0
    @Volatile private var size = 0

    @Volatile var totalBlocked: Long = 0L
        private set

    fun record(url: String, type: String) {
        synchronized(lock) {
            val slot = ring[index]
            slot.url = url
            slot.type = type
            slot.atMillis = System.currentTimeMillis()
            index = (index + 1) % CAPACITY
            if (size < CAPACITY) size++
            totalBlocked++
        }
    }

    /** Newest first, for the diagnostics screen and instrumented smoke test. */
    fun snapshot(): List<String> = synchronized(lock) {
        val out = ArrayList<String>(size)
        for (i in 0 until size) {
            val entry = ring[(index - 1 - i + CAPACITY * 2) % CAPACITY]
            out.add("${entry.atMillis} ${entry.type} ${entry.url}")
        }
        out
    }

    fun reset() {
        synchronized(lock) {
            index = 0
            size = 0
            totalBlocked = 0L
        }
    }
}
