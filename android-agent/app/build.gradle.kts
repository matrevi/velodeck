import java.io.FileInputStream
import java.net.URI
import java.util.Properties
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction

plugins {
    id("com.android.application")
}

abstract class GenerateNetworkSecurityConfigTask : DefaultTask() {
    @get:Input
    abstract val cleartextHosts: ListProperty<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val xmlDir = outputDir.get().asFile.resolve("xml")
        xmlDir.mkdirs()
        val domains = linkedSetOf("localhost", "127.0.0.1")
        cleartextHosts.get().forEach { host ->
            val trimmed = host.trim()
            if (trimmed.isNotEmpty()) {
                domains.add(trimmed)
            }
        }
        val content = buildString {
            appendLine("""<?xml version="1.0" encoding="utf-8"?>""")
            appendLine("<network-security-config>")
            appendLine("    <!-- Block cleartext HTTP/WS traffic globally by default -->")
            appendLine("""    <base-config cleartextTrafficPermitted="false" />""")
            appendLine()
            appendLine("    <!-- Explicitly allow cleartext ONLY for loopback and optional configured HTTP/WS host -->")
            appendLine("""    <domain-config cleartextTrafficPermitted="true">""")
            domains.forEach { domain ->
                val escaped = domain
                    .replace("&", "&amp;")
                    .replace("<", "&lt;")
                    .replace(">", "&gt;")
                appendLine("""        <domain includeSubdomains="false">$escaped</domain>""")
            }
            appendLine("    </domain-config>")
            appendLine("</network-security-config>")
        }
        xmlDir.resolve("network_security_config.xml").writeText(content, Charsets.UTF_8)
    }
}

val localPropertiesFile = rootProject.file("local.properties")
val localProperties = Properties().apply {
    if (localPropertiesFile.isFile) {
        FileInputStream(localPropertiesFile).use { load(it) }
    }
}

val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.isFile) {
        FileInputStream(keystorePropertiesFile).use { load(it) }
    }
}
val releaseStoreFileProp = keystoreProperties.getProperty("storeFile")?.trim().orEmpty()
val releaseStoreFile = if (releaseStoreFileProp.isNotEmpty()) {
    rootProject.file(releaseStoreFileProp)
} else {
    null
}
val hasReleaseSigning = releaseStoreFile != null &&
    releaseStoreFile.isFile &&
    !keystoreProperties.getProperty("storePassword").isNullOrBlank() &&
    !keystoreProperties.getProperty("keyAlias").isNullOrBlank() &&
    !keystoreProperties.getProperty("keyPassword").isNullOrBlank()

val defaultRelayUrl = (project.findProperty("velodeckRelayUrl") as? String)
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?: localProperties.getProperty("velodeck.relayUrl")?.trim()?.takeIf { it.isNotEmpty() }
    ?: "ws://your-server.example.com/ws"

val defaultApiBaseUrl = (project.findProperty("velodeckApiUrl") as? String)
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?: localProperties.getProperty("velodeck.apiUrl")?.trim()?.takeIf { it.isNotEmpty() }
    ?: "https://your-server.example.com"

fun extractCleartextHost(url: String, cleartextScheme: String): String? {
    if (!url.startsWith("$cleartextScheme://", ignoreCase = true)) return null
    val host = runCatching { URI(url).host?.trim() }.getOrNull().orEmpty()
    if (host.isEmpty()) return null
    if (host.equals("localhost", ignoreCase = true) ||
        host == "127.0.0.1" ||
        host.equals("your-server.example.com", ignoreCase = true)
    ) {
        return null
    }
    return host
}

val extraCleartextHosts = buildList {
    extractCleartextHost(defaultApiBaseUrl, "http")?.let { add(it) }
    extractCleartextHost(defaultRelayUrl, "ws")?.let { if (!contains(it)) add(it) }
}

val generatedNetSecResDir = layout.buildDirectory.dir("generated/res/velodeckNetSec")

val generateNetworkSecurityConfig = tasks.register<GenerateNetworkSecurityConfigTask>(
    "generateVeloDeckNetworkSecurityConfig",
) {
    cleartextHosts.set(extraCleartextHosts)
    outputDir.set(generatedNetSecResDir)
}

android {
    namespace = "com.velodeck.agent"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.velodeck.agent"
        minSdk = 26
        targetSdk = 36
        versionCode = 8
        versionName = "1.0.7"

        ndk {
            // Strip desktop emulator x86/x86_64 native libs (~25 MB bloat); cover 100% of real ARM Android devices
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }

        buildConfigField(
            "String",
            "DEFAULT_RELAY_URL",
            "\"${defaultRelayUrl.replace("\\", "\\\\").replace("\"", "\\\"")}\"",
        )
        buildConfigField(
            "String",
            "DEFAULT_API_BASE_URL",
            "\"${defaultApiBaseUrl.replace("\\", "\\\\").replace("\"", "\\\"")}\"",
        )

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = releaseStoreFile
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isDebuggable = false
            isMinifyEnabled = true
            isShrinkResources = true
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    packaging {
        jniLibs {
            // DEFLATE-compress native WebRTC .so libraries in the APK (~45 MB -> ~10 MB for fast mobile OTA downloads)
            useLegacyPackaging = true
        }
        resources {
            excludes += setOf(
                "META-INF/INDEX.LIST",
                "META-INF/DEPENDENCIES",
                "META-INF/io.netty.versions.properties",
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
            )
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(
            generateNetworkSecurityConfig,
            GenerateNetworkSecurityConfigTask::outputDir,
        )
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")

    // Outbound Relay WebSocket
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Embedded Direct Mode HTTP + WebSocket server
    implementation("io.ktor:ktor-server-core:3.1.3")
    implementation("io.ktor:ktor-server-cio:3.1.3")
    implementation("io.ktor:ktor-server-websockets:3.1.3")
    implementation("org.slf4j:slf4j-nop:2.0.16")

    // WebRTC video + DataChannel engine
    implementation("io.getstream:stream-webrtc-android:1.3.10")

    // Unit tests
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.1")
}
