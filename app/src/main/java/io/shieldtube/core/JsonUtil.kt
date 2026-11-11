// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.core

/** Minimal JSON string encoder; avoids org.json in JVM unit tests. */
fun jsonString(value: String): String = buildString(value.length + 2) {
    append('"')
    for (c in value) {
        when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            else -> if (c < ' ') {
                append("\\u")
                append(c.code.toString(16).padStart(4, '0'))
            } else {
                append(c)
            }
        }
    }
    append('"')
}

const val EMPTY_COSMETIC_JSON =
    "{\"hide_selectors\":[],\"procedural_actions\":[],\"exceptions\":[],\"injected_script\":\"\",\"generichide\":false}"
