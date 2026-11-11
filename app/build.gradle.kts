// SPDX-License-Identifier: GPL-3.0-or-later
import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val abis = listOf("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
val jniLibsDir = File(projectDir, "src/main/jniLibs")
val hostLibDir = File(rootDir, "rust/target/debug")

fun allNativeLibsPresent(): Boolean =
    abis.all { File(jniLibsDir, "$it/libshieldtube.so").isFile }

// Build the four ABI libraries only when they are missing. CI and developers
// with a Rust+NDK toolchain get a real build; anyone with the prebuilt jniLibs
// (e.g. a CI artifact) still gets assembleDebug green.
val buildRustForAndroid = tasks.register<Exec>("buildRustForAndroid") {
    group = "shieldtube"
    description = "cargo ndk --release for all four Android ABIs"
    workingDir = rootDir
    commandLine("bash", "scripts/build-rust.sh")
    onlyIf { !allNativeLibsPresent() }
}

// Host cdylib for JVM unit tests that exercise the JNI surface.
val buildRustHost = tasks.register<Exec>("buildRustHost") {
    group = "shieldtube"
    description = "cargo build (host) for JVM/JNI unit tests"
    workingDir = rootDir
    commandLine("bash", "scripts/build-rust-host.sh")
}

android {
    namespace = "io.shieldtube"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.shieldtube"
        minSdk = 23
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += abis }
    }

    signingConfigs {
        // Real release signing is opt-in via environment variables (docs/BUILD.md).
        // Per the 2026-11-11 lead decision, fallback is the debug key: the APK is
        // installable and clearly labelled NON-DISTRIBUTABLE.
        create("release") {
            val store = System.getenv("SHIELDTUBE_RELEASE_STORE_FILE")
            if (!store.isNullOrBlank()) {
                storeFile = file(store)
                storePassword = System.getenv("SHIELDTUBE_RELEASE_STORE_PASSWORD") ?: ""
                keyAlias = System.getenv("SHIELDTUBE_RELEASE_KEY_ALIAS") ?: ""
                keyPassword = System.getenv("SHIELDTUBE_RELEASE_KEY_PASSWORD") ?: ""
            }
        }
    }

    buildTypes {
        debug {
            isDebuggable = true
            // Keep the engine's JNI symbols; ProGuard is off for debug anyway.
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = if (
                !System.getenv("SHIELDTUBE_RELEASE_STORE_FILE").isNullOrBlank()
            ) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("src/main/jniLibs")
            assets.srcDirs("src/main/assets")
        }
    }

    packaging {
        jniLibs { useLegacyPackaging = false }
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    // 1.9.0 is the first release with WebViewCompat.addDocumentStartJavaScript.
    implementation("androidx.webkit:webkit:1.9.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}

tasks.named("preBuild") { dependsOn(buildRustForAndroid) }

tasks.withType<Test>().configureEach {
    dependsOn(buildRustHost)
    val existing = System.getProperty("java.library.path").orEmpty()
    systemProperty(
        "java.library.path",
        listOf(hostLibDir.absolutePath, existing).filter { it.isNotEmpty() }
            .joinToString(File.pathSeparator)
    )
}
