# =========================================================================
# VeloDeck (极控) Android Agent — Release R8 / ProGuard Rules
# =========================================================================

# 1. Keep Android Manifest Components & WorkManager Workers
-keep public class com.velodeck.agent.ui.MainActivity { *; }
-keep public class com.velodeck.agent.service.WakeActivity { *; }
-keep public class com.velodeck.agent.service.BlackScreenActivity { *; }
-keep public class com.velodeck.agent.capture.ProjectionConsentActivity { *; }
-keep public class com.velodeck.agent.service.AgentForegroundService { *; }
-keep public class com.velodeck.agent.input.VeloDeckAccessibilityService { *; }
-keep public class com.velodeck.agent.service.BootReceiver { *; }
-keep public class com.velodeck.agent.service.WatchdogWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}
-keep class * extends androidx.work.ListenableWorker {
    <init>(android.content.Context, androidx.work.WorkerParameters);
}
# AGP 9.0 R8 full-mode fix: room-runtime 2.6.1 & WorkManager consumer rules omit <init>()
-keep class * extends androidx.room.RoomDatabase {
    <init>();
}
-keep class * extends androidx.work.InputMerger {
    <init>();
}
-keep class * implements androidx.versionedparcelable.VersionedParcelable {
    <init>();
}

# 2. Keep Protocol Models & Serialization Classes
-keep class com.velodeck.agent.protocol.** { *; }

# 3. Keep WebRTC Native JNI Bridges, Custom Hardware Encoder & Stream WebRTC Wrappers
-keep class org.webrtc.** { *; }
-keep class io.getstream.webrtc.** { *; }
-keep class com.velodeck.agent.capture.LowLatencyH264Encoder { *; }
-keep class com.velodeck.agent.capture.LowLatencyH264EncoderFactory { *; }
-keep class com.velodeck.agent.capture.LowLatencyEncoderMath { *; }
-dontwarn org.webrtc.**
-dontwarn io.getstream.webrtc.**

# 4. Keep Ktor CIO / Server / WebSockets, Coroutines, OkHttp & Okio
-keep class io.ktor.** { *; }
-keep class kotlinx.coroutines.** { *; }
-keep class okhttp3.** { *; }
-keep class okio.** { *; }
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-keepclassmembers class kotlinx.coroutines.** {
    volatile <fields>;
}

# Suppress harmless warnings from JVM-only / optional references inside Ktor, OkHttp, SLF4J
-dontwarn org.slf4j.**
-dontwarn io.ktor.**
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.codehaus.mojo.animal_sniffer.**
-dontwarn javax.annotation.**
-dontwarn java.lang.invoke.**
-dontwarn java.lang.management.**
-dontwarn sun.misc.Unsafe
-dontwarn kotlin.Metadata

# 5. Strip verbose & debug logs in Release builds
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
}
