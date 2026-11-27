package com.velodeck.agent.capture

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.PixelFormat
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.Surface
import android.view.WindowManager
import com.velodeck.agent.protocol.StreamQuality
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.roundToInt

/**
 * Pure Android-free display scaling math so JVM unit tests can verify short-edge portrait &
 * landscape scaling and long-edge encoder safety caps.
 */
internal object DisplayScaleMath {
    fun computeScaledSize(srcW: Int, srcH: Int, maxWidth: Int): Pair<Int, Int> {
        val safeSrcW = srcW.coerceAtLeast(1)
        val safeSrcH = srcH.coerceAtLeast(1)
        val shortEdge = minOf(safeSrcW, safeSrcH)
        val longEdge = maxOf(safeSrcW, safeSrcH)
        val targetShortEdge = maxWidth.coerceIn(240, 1080)
        val maxLongEdge = when {
            targetShortEdge >= 1080 -> 2480
            targetShortEdge >= 864 -> 2048
            targetShortEdge >= 720 -> 1680
            else -> 1280
        }
        val shortScale = if (shortEdge > targetShortEdge) {
            targetShortEdge.toFloat() / shortEdge.toFloat()
        } else {
            1f
        }
        val longScale = if (longEdge > maxLongEdge) {
            maxLongEdge.toFloat() / longEdge.toFloat()
        } else {
            1f
        }
        val scale = minOf(shortScale, longScale)
        val w = alignEven((safeSrcW * scale).roundToInt().coerceAtLeast(160))
        val h = alignEven((safeSrcH * scale).roundToInt().coerceAtLeast(160))
        return w to h
    }

    fun alignEven(value: Int): Int = (value / 2) * 2
}

data class EncodedJpegFrame(
    val width: Int,
    val height: Int,
    val rotation: Int,
    val timestampMs: Long,
    val jpegBytes: ByteArray,
)

data class DisplayGeometry(
    val width: Int,
    val height: Int,
    val densityDpi: Int,
    val rotation: Int,
)

/**
 * Manages a single persistent [MediaProjection] + [VirtualDisplay] inside the foreground service.
 *
 * Key design for 7x24 unattended operation:
 * - Registers [MediaProjection.Callback] BEFORE creating the VirtualDisplay (Android 14+ requirement).
 * - When all remote sessions disconnect, calls `virtualDisplay.setSurface(null)` and closes the
 *   [ImageReader] WITHOUT stopping [MediaProjection] — zero CPU/battery overhead while idle,
 *   and zero consent re-prompts when the next remote session starts!
 * - Supports both JPEG frame capture (`ws-jpeg`) and direct zero-copy external [Surface] attachment
 *   (`webrtc` via `SurfaceTextureHelper`).
 */
class ScreenCaptureManager(
    context: Context,
    private val onProjectionRevoked: () -> Unit,
    private val onContentResized: (() -> Unit)?,
) {
    constructor(
        context: Context,
        onProjectionRevoked: () -> Unit,
    ) : this(context, onProjectionRevoked, null)

    private val appContext = context.applicationContext
    private val projectionManager =
        appContext.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    private val windowManager =
        appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private val lock = Any()
    private val bitmapLock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var captureThread: HandlerThread? = null
    private var captureHandler: Handler? = null

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null

    @Volatile
    private var imageReader: ImageReader? = null

    private var scratchBitmap: Bitmap? = null
    private var croppedBitmap: Bitmap? = null
    private var cropCanvas: Canvas? = null
    private val cropSrcRect = Rect()
    private val cropDstRect = Rect()
    private val jpegBuffer = ByteArrayOutputStream(64 * 1024)

    @Volatile
    private var currentQuality: StreamQuality = StreamQuality.BALANCED

    private var currentCaptureWidth: Int = 540
    private var currentCaptureHeight: Int = 1208
    private var currentDpi: Int = DisplayMetrics.DENSITY_DEFAULT

    @Volatile
    private var jpegFrameListener: ((EncodedJpegFrame) -> Unit)? = null

    @Volatile
    private var canAcceptJpegFrame: (() -> Boolean)? = null

    @Volatile
    private var externalResizeListener: (() -> Unit)? = null

    private var externalSurfaceAttached: Boolean = false

    @Volatile
    private var lastEncodedFrame: EncodedJpegFrame? = null

    private val isEncoding = AtomicBoolean(false)
    private val lastFrameEmitElapsedMs = AtomicLong(0L)
    private val forceNextFrame = AtomicBoolean(false)

    private val _hasProjectionFlow = MutableStateFlow(false)
    val hasProjectionFlow: StateFlow<Boolean> = _hasProjectionFlow.asStateFlow()

    val hasProjection: Boolean
        get() = _hasProjectionFlow.value

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.w(TAG, "MediaProjection stopped/revoked by system")
            releaseAll(notifyRevoked = true)
        }

        override fun onCapturedContentResize(width: Int, height: Int) {
            Log.i(TAG, "Captured content resized to ${width}x${height}")
            handleDisplayConfigChanged()
            val contentCb = onContentResized
            val rtcCb = externalResizeListener
            if (contentCb != null || rtcCb != null) {
                mainHandler.post {
                    rtcCb?.invoke()
                    contentCb?.invoke()
                }
            }
        }
    }

    internal fun setExternalResizeListener(listener: (() -> Unit)?) {
        externalResizeListener = listener
    }

    fun getDisplayGeometry(): DisplayGeometry {
        val dpi = appContext.resources.displayMetrics.densityDpi.coerceAtLeast(120)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = windowManager.maximumWindowMetrics.bounds
            val rot = try {
                val dm = appContext.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
                dm?.getDisplay(Display.DEFAULT_DISPLAY)?.rotation ?: Surface.ROTATION_0
            } catch (_: Throwable) {
                Surface.ROTATION_0
            }
            DisplayGeometry(
                width = bounds.width().coerceAtLeast(1),
                height = bounds.height().coerceAtLeast(1),
                densityDpi = dpi,
                rotation = rot and 0x03,
            )
        } else {
            val dm = DisplayMetrics()
            @Suppress("DEPRECATION")
            val display = windowManager.defaultDisplay
            @Suppress("DEPRECATION")
            display.getRealMetrics(dm)
            @Suppress("DEPRECATION")
            val rot = display.rotation
            DisplayGeometry(
                width = dm.widthPixels.coerceAtLeast(1),
                height = dm.heightPixels.coerceAtLeast(1),
                densityDpi = dm.densityDpi.coerceAtLeast(120),
                rotation = rot and 0x03,
            )
        }
    }

    fun setProjection(resultCode: Int, data: Intent): Boolean {
        synchronized(lock) {
            releaseAllLocked(notifyRevoked = false)
            ensureCaptureThreadLocked()

            val projection = try {
                projectionManager.getMediaProjection(resultCode, data)
            } catch (t: Throwable) {
                Log.e(TAG, "getMediaProjection failed", t)
                return false
            } ?: return false

            // Android 14+ requires registering callback BEFORE createVirtualDisplay
            projection.registerCallback(projectionCallback, mainHandler)
            mediaProjection = projection

            val geom = getDisplayGeometry()
            val (w, h) = computeScaledSize(geom.width, geom.height, currentQuality.maxWidth)
            currentCaptureWidth = w
            currentCaptureHeight = h
            currentDpi = geom.densityDpi

            // Create a single persistent VirtualDisplay with null surface initially (zero idle cost!)
            virtualDisplay = projection.createVirtualDisplay(
                VIRTUAL_DISPLAY_NAME,
                w,
                h,
                geom.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                null,
                null,
                captureHandler,
            )
            _hasProjectionFlow.value = true
            Log.i(TAG, "Persistent MediaProjection & VirtualDisplay initialized (${w}x${h}, idle surface=null)")
            return true
        }
    }

    fun startJpegStream(
        quality: StreamQuality,
        canAcceptFrame: () -> Boolean = { true },
        onFrame: (EncodedJpegFrame) -> Unit,
    ): Boolean {
        synchronized(lock) {
            val vd = virtualDisplay ?: return false
            ensureCaptureThreadLocked()
            currentQuality = quality
            canAcceptJpegFrame = canAcceptFrame
            jpegFrameListener = onFrame
            externalSurfaceAttached = false
            forceNextFrame.set(true)

            val geom = getDisplayGeometry()
            val (w, h) = computeScaledSize(geom.width, geom.height, jpegTargetMaxWidth(quality.maxWidth))
            attachImageReaderLocked(vd, w, h, geom.densityDpi)
            Log.i(TAG, "Started ws-jpeg stream (${w}x${h} @ ${quality.fps}fps, q=${quality.jpegQuality})")
            return true
        }
    }

    fun updateQuality(quality: StreamQuality) {
        synchronized(lock) {
            currentQuality = quality
            val vd = virtualDisplay ?: return
            if (jpegFrameListener != null && !externalSurfaceAttached) {
                val geom = getDisplayGeometry()
                val (w, h) = computeScaledSize(geom.width, geom.height, jpegTargetMaxWidth(quality.maxWidth))
                if (w != currentCaptureWidth || h != currentCaptureHeight) {
                    attachImageReaderLocked(vd, w, h, geom.densityDpi)
                    Log.i(TAG, "Resized ws-jpeg stream to ${w}x${h} @ ${quality.fps}fps")
                }
            }
        }
    }

    fun attachExternalSurface(surface: Surface, width: Int, height: Int): Boolean {
        synchronized(lock) {
            val vd = virtualDisplay ?: return false
            closeImageReaderLocked()
            jpegFrameListener = null
            externalSurfaceAttached = true

            val geom = getDisplayGeometry()
            val alignedW = alignEven(width.coerceAtLeast(160))
            val alignedH = alignEven(height.coerceAtLeast(160))
            currentCaptureWidth = alignedW
            currentCaptureHeight = alignedH
            currentDpi = geom.densityDpi
            vd.resize(alignedW, alignedH, geom.densityDpi)
            vd.surface = surface
            Log.i(TAG, "Attached external WebRTC surface (${alignedW}x${alignedH}) to persistent VirtualDisplay")
            return true
        }
    }

    /**
     * Idle zero-cost pause: detaches surface and closes ImageReader while keeping
     * [MediaProjection] and [VirtualDisplay] alive so future sessions need NO re-prompt!
     */
    fun pauseStreaming() {
        synchronized(lock) {
            jpegFrameListener = null
            canAcceptJpegFrame = null
            externalSurfaceAttached = false
            lastEncodedFrame = null
            virtualDisplay?.surface = null
            closeImageReaderLocked()
            Log.i(TAG, "Paused screen streaming (VirtualDisplay surface=null; MediaProjection kept alive)")
        }
    }

    fun requestKeyframe() {
        forceNextFrame.set(true)
        val cached = lastEncodedFrame
        val listener = synchronized(lock) { jpegFrameListener }
        if (cached != null && listener != null) {
            listener(cached.copy(timestampMs = System.currentTimeMillis()))
        }
    }

    fun handleDisplayConfigChanged() {
        synchronized(lock) {
            val vd = virtualDisplay ?: return
            if (jpegFrameListener != null && !externalSurfaceAttached) {
                val geom = getDisplayGeometry()
                val (w, h) = computeScaledSize(geom.width, geom.height, jpegTargetMaxWidth(currentQuality.maxWidth))
                if (w != currentCaptureWidth || h != currentCaptureHeight) {
                    attachImageReaderLocked(vd, w, h, geom.densityDpi)
                    forceNextFrame.set(true)
                }
            }
        }
    }

    fun computeTargetDimensions(maxWidth: Int): Pair<Int, Int> {
        val geom = getDisplayGeometry()
        return computeScaledSize(geom.width, geom.height, maxWidth)
    }

    fun releaseAll(notifyRevoked: Boolean = false) {
        synchronized(lock) {
            releaseAllLocked(notifyRevoked)
        }
    }

    private fun releaseAllLocked(notifyRevoked: Boolean) {
        jpegFrameListener = null
        canAcceptJpegFrame = null
        externalSurfaceAttached = false
        lastEncodedFrame = null
        closeImageReaderLocked()

        try {
            virtualDisplay?.surface = null
            virtualDisplay?.release()
        } catch (_: Throwable) {
        }
        virtualDisplay = null

        try {
            mediaProjection?.unregisterCallback(projectionCallback)
            mediaProjection?.stop()
        } catch (_: Throwable) {
        }
        mediaProjection = null

        val wasActive = _hasProjectionFlow.value
        _hasProjectionFlow.value = false

        if (notifyRevoked && wasActive) {
            mainHandler.post { onProjectionRevoked() }
        }
    }

    fun shutdown() {
        releaseAll(notifyRevoked = false)
        synchronized(lock) {
            captureThread?.quitSafely()
            captureThread = null
            captureHandler = null
        }
    }

    private fun ensureCaptureThreadLocked() {
        if (captureThread == null || captureThread?.isAlive != true) {
            val thread = HandlerThread("VeloDeckCapture").apply { start() }
            captureThread = thread
            captureHandler = Handler(thread.looper)
        }
    }

    private fun attachImageReaderLocked(vd: VirtualDisplay, width: Int, height: Int, dpi: Int) {
        vd.surface = null
        closeImageReaderLocked()

        currentCaptureWidth = width
        currentCaptureHeight = height
        currentDpi = dpi

        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        reader.setOnImageAvailableListener({ r -> onImageAvailable(r) }, captureHandler)
        imageReader = reader

        vd.resize(width, height, dpi)
        vd.surface = reader.surface
    }

    private fun closeImageReaderLocked() {
        try {
            imageReader?.setOnImageAvailableListener(null, null)
            imageReader?.close()
        } catch (_: Throwable) {
        }
        imageReader = null
        synchronized(bitmapLock) {
            scratchBitmap?.recycle()
            scratchBitmap = null
            croppedBitmap?.recycle()
            croppedBitmap = null
            cropCanvas = null
        }
    }

    private fun onImageAvailable(reader: ImageReader) {
        val image = try {
            reader.acquireLatestImage()
        } catch (_: Throwable) {
            null
        } ?: return

        if (imageReader !== reader) {
            image.close()
            return
        }

        val quality = currentQuality
        val minIntervalMs = (1_000L / quality.fps.coerceIn(1, 60)).coerceAtLeast(16L)
        val nowElapsed = SystemClock.elapsedRealtime()
        val forced = forceNextFrame.getAndSet(false)

        if (!forced && (nowElapsed - lastFrameEmitElapsedMs.get()) < minIntervalMs) {
            image.close()
            return
        }

        if (!forced && canAcceptJpegFrame?.invoke() == false) {
            // Skip CPU JPEG encoding completely while outbound WS buffer is draining
            image.close()
            return
        }

        if (!isEncoding.compareAndSet(false, true)) {
            // Backpressure: drop frame immediately if encoder is still busy
            image.close()
            return
        }

        try {
            val plane = image.planes.firstOrNull() ?: return
            val buffer = plane.buffer
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val imgWidth = image.width
            val imgHeight = image.height
            val rowPadding = (rowStride - pixelStride * imgWidth).coerceAtLeast(0)
            val paddedWidth = imgWidth + rowPadding / pixelStride

            val jpegBytes = synchronized(bitmapLock) {
                if (imageReader !== reader) return
                var bmp = scratchBitmap
                if (bmp == null || bmp.isRecycled || bmp.width != paddedWidth || bmp.height != imgHeight) {
                    bmp?.recycle()
                    bmp = Bitmap.createBitmap(paddedWidth, imgHeight, Bitmap.Config.ARGB_8888)
                    scratchBitmap = bmp
                }
                bmp.copyPixelsFromBuffer(buffer)

                val finalBmp = if (paddedWidth != imgWidth) {
                    var cropped = croppedBitmap
                    if (cropped == null || cropped.isRecycled || cropped.width != imgWidth || cropped.height != imgHeight) {
                        cropped?.recycle()
                        cropped = Bitmap.createBitmap(imgWidth, imgHeight, Bitmap.Config.ARGB_8888)
                        croppedBitmap = cropped
                        cropCanvas = Canvas(cropped)
                    }
                    cropSrcRect.set(0, 0, imgWidth, imgHeight)
                    cropDstRect.set(0, 0, imgWidth, imgHeight)
                    cropCanvas?.drawBitmap(bmp, cropSrcRect, cropDstRect, null)
                    cropped
                } else {
                    bmp
                }

                jpegBuffer.reset()
                finalBmp.compress(
                    Bitmap.CompressFormat.JPEG,
                    jpegTargetQuality(quality.jpegQuality),
                    jpegBuffer,
                )
                jpegBuffer.toByteArray()
            }

            val geom = getDisplayGeometry()
            val frame = EncodedJpegFrame(
                width = imgWidth,
                height = imgHeight,
                rotation = geom.rotation,
                timestampMs = System.currentTimeMillis(),
                jpegBytes = jpegBytes,
            )
            lastEncodedFrame = frame
            lastFrameEmitElapsedMs.set(nowElapsed)
            jpegFrameListener?.invoke(frame)
        } catch (t: Throwable) {
            Log.w(TAG, "Frame encode failed", t)
        } finally {
            image.close()
            isEncoding.set(false)
        }
    }

    /** Caps software ws-jpeg resolution & quality to keep TCP fallback frames ~15-35 KB (~15-20fps even on 3 Mbps VPS). */
    private fun jpegTargetMaxWidth(requestedMaxWidth: Int): Int = when {
        requestedMaxWidth <= 480 -> 360
        requestedMaxWidth <= 900 -> 432
        else -> 540
    }

    private fun jpegTargetQuality(requestedQuality: Int): Int = when {
        requestedQuality <= 52 -> 42
        requestedQuality <= 68 -> 48
        else -> 58
    }

    private fun computeScaledSize(srcW: Int, srcH: Int, maxWidth: Int): Pair<Int, Int> =
        DisplayScaleMath.computeScaledSize(srcW, srcH, maxWidth)

    private fun alignEven(value: Int): Int = DisplayScaleMath.alignEven(value)

    companion object {
        private const val TAG = "ScreenCaptureManager"
        private const val VIRTUAL_DISPLAY_NAME = "VeloDeckVirtualDisplay"
    }
}
