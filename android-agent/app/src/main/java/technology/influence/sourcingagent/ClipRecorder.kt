package technology.influence.sourcingagent

import android.annotation.SuppressLint
import android.hardware.display.DisplayManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.projection.MediaProjection
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Records a short screen clip **with internal audio** for the reel judge.
 *
 * This is what lets the phone replace `scrcpy` on the laptop: `adb screenrecord`
 * cannot capture audio at all, which is why the Node runner needed a separate
 * binary on PATH. Here the screen goes through a VirtualDisplay into an AVC
 * encoder, the app's own audio goes through AudioPlaybackCapture into an AAC
 * encoder, and both are muxed into one mp4.
 *
 * The MediaProjection is acquired once per agent session and reused for every
 * clip — on Android 14+ each `getMediaProjection()` needs fresh consent, so
 * re-acquiring per clip would pop a system dialog mid-run.
 *
 * Caveat worth knowing: an app may set `allowAudioPlaybackCapture="false"` in
 * its manifest, in which case the platform hands us silence. Video always works.
 */
class ClipRecorder(
    private val projection: MediaProjection,
    screenWidth: Int,
    screenHeight: Int,
    private val dpi: Int,
) : ClipProvider {

    companion object {
        private const val TAG = "ClipRecorder"

        // Spelled out rather than referencing MediaFormat.MIMETYPE_* so these
        // stay valid `const val` initializers on every Kotlin/AGP combination.
        private const val VIDEO_MIME = "video/avc"
        private const val AUDIO_MIME = "audio/mp4a-latm"

        private const val FRAME_RATE = 30
        private const val I_FRAME_INTERVAL = 1
        private const val VIDEO_BITRATE = 2_500_000

        private const val SAMPLE_RATE = 44_100
        private const val AUDIO_BITRATE = 128_000
        private const val AUDIO_CHANNELS = 1

        private const val DEQUEUE_TIMEOUT_US = 10_000L

        /** Cap the encode size: the judge needs legible video, not pixel-perfect. */
        private const val MAX_VIDEO_WIDTH = 720
    }

    // AVC requires even dimensions; scale down first, then round.
    private val width: Int
    private val height: Int

    init {
        val scale = if (screenWidth > MAX_VIDEO_WIDTH) MAX_VIDEO_WIDTH.toFloat() / screenWidth else 1f
        width = ((screenWidth * scale).toInt()) and 0xFFFFFFFE.toInt()
        height = ((screenHeight * scale).toInt()) and 0xFFFFFFFE.toInt()
    }

    @SuppressLint("MissingPermission")
    override fun record(seconds: Int): ByteArray {
        val durationMs = seconds.coerceIn(1, 60) * 1000L
        val outFile = File.createTempFile("reel-", ".mp4")

        var muxer: MediaMuxer? = null
        var videoEncoder: MediaCodec? = null
        var audioEncoder: MediaCodec? = null
        var audioRecord: AudioRecord? = null
        var virtualDisplay: android.hardware.display.VirtualDisplay? = null

        val state = MuxState()
        val stopping = AtomicBoolean(false)

        try {
            // Non-null locals for the worker threads to close over; the nullable
            // vars above exist only so the finally block can release whatever
            // managed to get created.
            val mux = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            muxer = mux

            // ── video ───────────────────────────────────────────────────────
            val vEncoder = MediaCodec.createEncoderByType(VIDEO_MIME)
            videoEncoder = vEncoder
            val videoFormat = MediaFormat.createVideoFormat(VIDEO_MIME, width, height).apply {
                setInteger(
                    MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface,
                )
                setInteger(MediaFormat.KEY_BIT_RATE, VIDEO_BITRATE)
                setInteger(MediaFormat.KEY_FRAME_RATE, FRAME_RATE)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL)
            }
            vEncoder.configure(videoFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            val inputSurface = vEncoder.createInputSurface()
            vEncoder.start()

            virtualDisplay = projection.createVirtualDisplay(
                "sourcing-agent-clip",
                width,
                height,
                dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                inputSurface,
                null,
                null,
            )

            // ── audio (best effort) ─────────────────────────────────────────
            val audio = runCatching { startAudio() }.getOrElse {
                Log.w(TAG, "internal audio capture unavailable, recording video only: ${it.message}")
                null
            }
            audioEncoder = audio?.encoder
            audioRecord = audio?.record
            state.expectedTracks = if (audio != null) 2 else 1

            // ── drain both encoders until the clock runs out ────────────────
            val videoThread = Thread {
                drain(vEncoder, mux, state, isVideo = true, stopping = stopping)
            }
            val audioThread = audio?.let { pipeline ->
                Thread { pumpAudio(pipeline.record, pipeline.encoder, mux, state, stopping) }
            }

            videoThread.start()
            audioThread?.start()

            Thread.sleep(durationMs)
            stopping.set(true)
            vEncoder.signalEndOfInputStream()

            videoThread.join(10_000)
            audioThread?.join(10_000)

            if (!state.started) {
                throw IllegalStateException("recorder produced no output — the encoder never started")
            }
            return outFile.readBytes().also {
                if (it.isEmpty()) throw IllegalStateException("recording produced an empty file")
            }
        } finally {
            stopping.set(true)
            runCatching { virtualDisplay?.release() }
            runCatching { audioRecord?.stop() }
            runCatching { audioRecord?.release() }
            runCatching { audioEncoder?.stop() }
            runCatching { audioEncoder?.release() }
            runCatching { videoEncoder?.stop() }
            runCatching { videoEncoder?.release() }
            runCatching { if (state.started) muxer?.stop() }
            runCatching { muxer?.release() }
            runCatching { outFile.delete() }
        }
    }

    private class AudioPipeline(val record: AudioRecord, val encoder: MediaCodec)

    @SuppressLint("MissingPermission")
    private fun startAudio(): AudioPipeline {
        val config = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build()

        val channelMask = AudioFormat.CHANNEL_IN_MONO
        val minBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            channelMask,
            AudioFormat.ENCODING_PCM_16BIT,
        ).coerceAtLeast(8 * 1024)

        val record = AudioRecord.Builder()
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(channelMask)
                    .build()
            )
            .setBufferSizeInBytes(minBuffer * 2)
            .setAudioPlaybackCaptureConfig(config)
            .build()

        val encoder = MediaCodec.createEncoderByType(AUDIO_MIME)
        val format = MediaFormat.createAudioFormat(AUDIO_MIME, SAMPLE_RATE, AUDIO_CHANNELS).apply {
            setInteger(
                MediaFormat.KEY_AAC_PROFILE,
                MediaCodecInfo.CodecProfileLevel.AACObjectLC,
            )
            setInteger(MediaFormat.KEY_BIT_RATE, AUDIO_BITRATE)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, minBuffer * 2)
        }
        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        encoder.start()
        record.startRecording()
        return AudioPipeline(record, encoder)
    }

    /** Feed captured PCM into the AAC encoder, then drain it into the muxer. */
    private fun pumpAudio(
        record: AudioRecord,
        encoder: MediaCodec,
        muxer: MediaMuxer,
        state: MuxState,
        stopping: AtomicBoolean,
    ) {
        val buffer = ByteArray(4 * 1024)
        val startedAt = SystemClock.elapsedRealtime()
        var sawEos = false

        try {
            while (!sawEos) {
                if (!stopping.get()) {
                    val index = encoder.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
                    if (index >= 0) {
                        val input: ByteBuffer = encoder.getInputBuffer(index)!!
                        input.clear()
                        val read = record.read(buffer, 0, minOf(buffer.size, input.remaining()))
                        val ptsUs = (SystemClock.elapsedRealtime() - startedAt) * 1000L
                        if (read > 0) {
                            input.put(buffer, 0, read)
                            encoder.queueInputBuffer(index, 0, read, ptsUs, 0)
                        } else {
                            encoder.queueInputBuffer(index, 0, 0, ptsUs, 0)
                        }
                    }
                } else {
                    val index = encoder.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
                    if (index >= 0) {
                        val ptsUs = (SystemClock.elapsedRealtime() - startedAt) * 1000L
                        encoder.queueInputBuffer(
                            index, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                        )
                    }
                }
                sawEos = drainOnce(encoder, muxer, state, isVideo = false)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "audio pump stopped: ${t.message}")
        }
    }

    /** Pull encoded samples until end-of-stream. */
    private fun drain(
        encoder: MediaCodec,
        muxer: MediaMuxer,
        state: MuxState,
        isVideo: Boolean,
        stopping: AtomicBoolean,
    ) {
        try {
            while (true) {
                if (drainOnce(encoder, muxer, state, isVideo)) return
                if (stopping.get() && Thread.currentThread().isInterrupted) return
            }
        } catch (t: Throwable) {
            Log.w(TAG, "drain stopped: ${t.message}")
        }
    }

    /** @return true once this encoder has emitted end-of-stream. */
    private fun drainOnce(
        encoder: MediaCodec,
        muxer: MediaMuxer,
        state: MuxState,
        isVideo: Boolean,
    ): Boolean {
        val info = MediaCodec.BufferInfo()
        when (val index = encoder.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US)) {
            MediaCodec.INFO_TRY_AGAIN_LATER -> return false

            MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                synchronized(state) {
                    val track = muxer.addTrack(encoder.outputFormat)
                    if (isVideo) state.videoTrack = track else state.audioTrack = track
                    if (state.trackCount() >= state.expectedTracks && !state.started) {
                        muxer.start()
                        state.started = true
                    }
                }
                return false
            }

            else -> {
                if (index < 0) return false
                val encoded = encoder.getOutputBuffer(index) ?: return false

                // Codec config bytes are carried in the track format, not as a sample.
                if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                    info.size = 0
                }

                if (info.size > 0) {
                    synchronized(state) {
                        if (state.started) {
                            val track = if (isVideo) state.videoTrack else state.audioTrack
                            if (track >= 0) {
                                encoded.position(info.offset)
                                encoded.limit(info.offset + info.size)
                                muxer.writeSampleData(track, encoded, info)
                            }
                        }
                    }
                }
                encoder.releaseOutputBuffer(index, false)
                return info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            }
        }
    }

    private class MuxState {
        var videoTrack = -1
        var audioTrack = -1
        var started = false
        var expectedTracks = 2

        fun trackCount(): Int =
            (if (videoTrack >= 0) 1 else 0) + (if (audioTrack >= 0) 1 else 0)
    }
}
