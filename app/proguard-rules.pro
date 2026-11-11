# SPDX-License-Identifier: GPL-3.0-or-later
# JNI is resolved by exact symbol name; never rename or strip the bridge.
-keepclasseswithmembernames class * {
    native <methods>;
}
-keep class io.shieldtube.nativebridge.AdBlockBridge { *; }

# JavascriptInterface / WebMessageListener callbacks are invoked reflectively.
-keepclassmembers class io.shieldtube.player.** {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep the document-start JS asset names out of resource shrinking surprises.
-keep class io.shieldtube.R$raw { *; }
