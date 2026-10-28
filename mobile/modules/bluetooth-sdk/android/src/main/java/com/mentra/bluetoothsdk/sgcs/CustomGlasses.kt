package com.mentra.bluetoothsdk.sgcs

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import com.google.protobuf.InvalidProtocolBufferException
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.PhotoRequest
import com.mentra.bluetoothsdk.utils.ConnTypes
import com.mentra.bluetoothsdk.utils.DeviceTypes
import com.mentra.bluetoothsdk.utils.NexBluetoothConstants
import mentraos.ble.MentraosBle.BatteryStateRequest
import mentraos.ble.MentraosBle.ButtonEvent
import mentraos.ble.MentraosBle.ClearDisplay
import mentraos.ble.MentraosBle.CommitDisplay
import mentraos.ble.MentraosBle.DisconnectRequest
import mentraos.ble.MentraosBle.DisplayText
import mentraos.ble.MentraosBle.GlassesInfoRequest
import mentraos.ble.MentraosBle.GlassesToPhone
import mentraos.ble.MentraosBle.MicStateConfig
import mentraos.ble.MentraosBle.PhoneToGlasses
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import com.mentra.bluetoothsdk.utils.NativeLog as Log

/**
 * Driver for the user's own glasses (Sprint 1: nRF5340 dev board + 128x64 OLED).
 *
 * Speaks LINK_CONTRACT v0: the MentraOS BLE service 0x4860, 4-byte fragmented
 * protobuf frames phone -> glasses, single-packet protobuf and 0xA0 LC3 audio
 * glasses -> phone. Only what Sprint 1 needs is implemented: scan, connect, MTU,
 * notifications, text/clear/commit, battery, device info, buttons, mic audio.
 * Everything else logs "not supported" so the engine keeps working.
 */
@SuppressLint("MissingPermission")
class CustomGlasses : SGCManager() {
    companion object {
        private const val TAG = "CustomGlasses"
        /** Advertised name prefix the firmware uses, e.g. "MYGL-1A2B". */
        const val NAME_PREFIX = "MYGL-"
        private const val MTU_REQUEST = 247
        private const val SCAN_TIMEOUT_MS = 10_000L
        private const val RECONNECT_DELAY_MS = 2_000L
        private const val WRITE_TIMEOUT_MS = 400L
        private const val LONG_PRESS_MS = 600L

        // Sprint 1 stand-in OLED text layout (must match CUSTOM_PROFILE in the engine).
        const val LINE_HEIGHT_PX = 16
        const val MAX_LINES = 4
        const val FONT_CODE = 0
        const val FONT_SIZE_PX = 8
        const val TEXT_INTENSITY = 15

        /** Builds the PhoneToGlasses messages for one text wall: clear, one line each, commit. */
        @JvmStatic
        fun textWallMessages(text: String, msgIdPrefix: String = "txt"): List<PhoneToGlasses> {
            val lines = text.split("\n").take(MAX_LINES)
            val out = mutableListOf<PhoneToGlasses>()
            out += PhoneToGlasses.newBuilder().setMsgId("$msgIdPrefix-clear")
                .setClearDisplay(ClearDisplay.getDefaultInstance()).build()
            lines.forEachIndexed { i, line ->
                if (line.isEmpty()) return@forEachIndexed
                out += PhoneToGlasses.newBuilder().setMsgId("$msgIdPrefix-$i")
                    .setDisplayText(
                        DisplayText.newBuilder()
                            .setText(line)
                            .setColor(TEXT_INTENSITY)
                            .setFontCode(FONT_CODE)
                            .setX(0)
                            .setY(i * LINE_HEIGHT_PX)
                            .setSize(FONT_SIZE_PX)
                    ).build()
            }
            out += PhoneToGlasses.newBuilder().setMsgId("$msgIdPrefix-commit")
                .setCommit(CommitDisplay.getDefaultInstance()).build()
            return out
        }
    }

    private val adapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private val main = Handler(Looper.getMainLooper())
    private var gatt: BluetoothGatt? = null
    private var device: BluetoothDevice? = null
    private var writeChar: BluetoothGattCharacteristic? = null
    @Volatile private var connected = false
    @Volatile private var ready = false
    @Volatile private var killed = false
    @Volatile private var mtu = CustomGlassesFraming.MTU_DEFAULT
    private var seq = 0
    private var preferredName: String? = null
    private var scanCallback: ScanCallback? = null
    private var buttonDownAt = 0L

    // Single writer thread: Android allows one outstanding GATT write.
    private val queue = LinkedBlockingQueue<ByteArray>()
    private val writeDone = java.util.concurrent.Semaphore(0)
    private var writer: Thread? = null

    init {
        type = DeviceTypes.CUSTOM
        hasMic = true
        DeviceStore.apply("glasses", "micEnabled", false)
    }

    // ---------------------------------------------------------------- scanning

    private fun isOurs(result: ScanResult): Boolean {
        val name = result.device.name ?: result.scanRecord?.deviceName
        if (name != null && name.startsWith(NAME_PREFIX)) return true
        val uuids = result.scanRecord?.serviceUuids ?: return false
        return uuids.contains(ParcelUuid(NexBluetoothConstants.MAIN_SERVICE_UUID))
    }

    private fun startScan(onFound: (ScanResult) -> Unit) {
        val scanner = adapter?.bluetoothLeScanner ?: run {
            Log.e(TAG, "BluetoothLeScanner not available")
            return
        }
        stopScan()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                if (isOurs(result)) onFound(result)
            }
            override fun onScanFailed(errorCode: Int) {
                Log.e(TAG, "Scan failed: $errorCode")
            }
        }
        scanCallback = cb
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanner.startScan(emptyList<ScanFilter>(), settings, cb)
        main.postDelayed({ stopScan() }, SCAN_TIMEOUT_MS)
    }

    override fun findCompatibleDevices() {
        val seen = mutableSetOf<String>()
        DeviceStore.apply("glasses", "connectionState", ConnTypes.SCANNING)
        startScan { r ->
            val name = r.device.name ?: r.scanRecord?.deviceName ?: return@startScan
            if (seen.add(name)) {
                Bridge.log("$TAG: found $name ${r.device.address}")
                Bridge.sendDiscoveredDevice(DeviceTypes.CUSTOM, name, r.device.address ?: "", r.rssi)
            }
        }
    }

    override fun stopScan() {
        scanCallback?.let { adapter?.bluetoothLeScanner?.stopScan(it) }
        scanCallback = null
    }

    override fun connectById(id: String) {
        preferredName = id
        killed = false
        val address = DeviceStore.get("bluetooth", "pending_device_address") as? String
        if (!address.isNullOrBlank()) {
            connect(adapter?.getRemoteDevice(address) ?: return)
            return
        }
        DeviceStore.apply("glasses", "connectionState", ConnTypes.SCANNING)
        startScan { r ->
            val name = r.device.name ?: r.scanRecord?.deviceName
            if (preferredName.isNullOrBlank() || name == preferredName) {
                stopScan()
                connect(r.device)
            }
        }
    }

    override fun getConnectedBluetoothName(): String = device?.name ?: ""

    // -------------------------------------------------------------- connection

    private fun connect(d: BluetoothDevice) {
        device = d
        if (gatt != null) return
        DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTING)
        gatt = d.connectGatt(Bridge.getContext(), false, callback, BluetoothDevice.TRANSPORT_LE)
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                connected = true
                g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                g.requestMtu(MTU_REQUEST) // services discovered after MTU result
            } else {
                onLinkLost(g, status)
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, newMtu: Int, status: Int) {
            mtu = if (status == BluetoothGatt.GATT_SUCCESS) newMtu else CustomGlassesFraming.MTU_DEFAULT
            Bridge.log("$TAG: MTU $mtu (status $status)")
            g.discoverServices()
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val svc = g.getService(NexBluetoothConstants.MAIN_SERVICE_UUID)
            val tx = svc?.getCharacteristic(NexBluetoothConstants.WRITE_CHAR_UUID)
            val rx = svc?.getCharacteristic(NexBluetoothConstants.NOTIFY_CHAR_UUID)
            if (tx == null || rx == null) {
                Log.e(TAG, "MentraOS service 0x4860 not found; disconnecting")
                g.disconnect()
                return
            }
            writeChar = tx
            g.setCharacteristicNotification(rx, true)
            rx.getDescriptor(NexBluetoothConstants.CLIENT_CHARACTERISTIC_CONFIG_UUID)?.let {
                it.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                g.writeDescriptor(it)
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            ready = true
            startWriter()
            DeviceStore.apply("glasses", "connected", true)
            DeviceStore.apply("glasses", "fullyBooted", true)
            DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTED)
            sendMessage(PhoneToGlasses.newBuilder().setMsgId("info")
                .setGlassesInfo(GlassesInfoRequest.getDefaultInstance()).build())
            getBatteryStatus()
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            writeDone.release()
        }

        @Deprecated("Deprecated in API 33; still delivered on older devices")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            handleInbound(c.value ?: return)
        }
    }

    private fun onLinkLost(g: BluetoothGatt, status: Int) {
        Bridge.log("$TAG: link lost (status $status)")
        connected = false
        ready = false
        queue.clear()
        g.close()
        if (gatt === g) gatt = null
        DeviceStore.apply("glasses", "connected", false)
        DeviceStore.apply("glasses", "fullyBooted", false)
        DeviceStore.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
        if (!killed) device?.let { d -> main.postDelayed({ if (!killed) connect(d) }, RECONNECT_DELAY_MS) }
    }

    // ----------------------------------------------------------------- sending

    private fun startWriter() {
        if (writer?.isAlive == true) return
        writer = Thread({
            while (!killed) {
                val frame = try { queue.poll(1, TimeUnit.SECONDS) } catch (e: InterruptedException) { break } ?: continue
                val g = gatt
                val c = writeChar
                if (!ready || g == null || c == null) continue
                c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                c.value = frame
                writeDone.drainPermits()
                if (g.writeCharacteristic(c)) {
                    writeDone.tryAcquire(WRITE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                } else {
                    Log.e(TAG, "writeCharacteristic refused; dropping frame")
                }
            }
        }, "CustomGlassesWriter").also { it.start() }
    }

    @Synchronized
    private fun sendMessage(msg: PhoneToGlasses) {
        val frames = CustomGlassesFraming.frame(msg.toByteArray(), seq, mtu)
        if (frames == null) {
            Log.e(TAG, "Message too large to fragment; dropped")
            return
        }
        seq = CustomGlassesFraming.nextSeq(seq)
        frames.forEach { queue.offer(it) }
    }

    // --------------------------------------------------------------- receiving

    private fun handleInbound(data: ByteArray) {
        when (val p = CustomGlassesFraming.parseInbound(data)) {
            is CustomGlassesFraming.Inbound.Audio ->
                DeviceManager.getInstance().handleGlassesMicData(p.lc3, 40, p.seq)
            is CustomGlassesFraming.Inbound.Control -> decode(p.protobuf)
            is CustomGlassesFraming.Inbound.Unknown -> Bridge.log("$TAG: unknown packet 0x%02X".format(p.type))
            CustomGlassesFraming.Inbound.Empty -> {}
        }
    }

    private fun decode(bytes: ByteArray) {
        val msg = try { GlassesToPhone.parseFrom(bytes) } catch (e: InvalidProtocolBufferException) {
            Log.e(TAG, "Bad GlassesToPhone: ${e.message}")
            return
        }
        when (msg.payloadCase) {
            GlassesToPhone.PayloadCase.BATTERY_STATUS -> {
                DeviceStore.apply("glasses", "batteryLevel", msg.batteryStatus.level)
                DeviceStore.apply("glasses", "charging", msg.batteryStatus.charging)
            }
            GlassesToPhone.PayloadCase.DEVICE_INFO -> {
                Bridge.log("$TAG: fw=${msg.deviceInfo.fwVersion} hw=${msg.deviceInfo.hwModel}")
                DeviceStore.apply("glasses", "fwVersion", msg.deviceInfo.fwVersion)
            }
            GlassesToPhone.PayloadCase.BUTTON_EVENT -> onButton(msg.buttonEvent)
            else -> Bridge.log("$TAG: ignored ${msg.payloadCase}")
        }
    }

    /** v0 reports raw DOWN/UP; derive short vs long press on the phone. */
    private fun onButton(e: ButtonEvent) {
        val now = System.currentTimeMillis()
        if (e.state == ButtonEvent.State.DOWN) {
            buttonDownAt = now
            return
        }
        val held = if (buttonDownAt == 0L) 0L else now - buttonDownAt
        buttonDownAt = 0L
        Bridge.sendButtonPressEvent(e.button.name.lowercase(), if (held >= LONG_PRESS_MS) "long" else "short")
    }

    // ------------------------------------------------------------- display API

    override fun clearDisplay() {
        sendMessage(PhoneToGlasses.newBuilder().setMsgId("clear").setClearDisplay(ClearDisplay.getDefaultInstance()).build())
        sendMessage(PhoneToGlasses.newBuilder().setMsgId("commit").setCommit(CommitDisplay.getDefaultInstance()).build())
    }

    override fun sendText(text: String) = sendTextWall(text)

    override fun sendTextWall(text: String) {
        textWallMessages(text).forEach { sendMessage(it) }
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        sendTextWall(listOf(top, bottom).filter { it.isNotEmpty() }.joinToString("\n"))
    }

    override fun displayBitmap(base64ImageData: String, x: Int?, y: Int?, width: Int?, height: Int?): Boolean {
        Bridge.log("$TAG: displayBitmap not supported in Sprint 1")
        return false
    }

    override fun showDashboard() { Bridge.log("$TAG: showDashboard not supported") }
    override fun setDashboardPosition(height: Int, depth: Int) {}
    override fun setBrightness(level: Int, autoMode: Boolean) { Bridge.log("$TAG: brightness not supported on stand-in OLED") }

    // ------------------------------------------------------------- device / mic

    override fun setMicEnabled(enabled: Boolean) {
        DeviceStore.apply("glasses", "micEnabled", enabled)
        sendMessage(PhoneToGlasses.newBuilder().setMsgId("mic")
            .setMicState(MicStateConfig.newBuilder().setEnabled(enabled)).build())
    }

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> = list

    override fun getBatteryStatus() {
        sendMessage(PhoneToGlasses.newBuilder().setMsgId("battery")
            .setBatteryState(BatteryStateRequest.getDefaultInstance()).build())
    }

    override fun ping() {}
    override fun setHeadUpAngle(angle: Int) {}
    override fun setSilentMode(enabled: Boolean) {}

    override fun disconnect() = teardown()
    override fun forget() = teardown()
    override fun exit() = teardown()
    override fun cleanup() = teardown()

    private fun teardown() {
        killed = true
        stopScan()
        main.removeCallbacksAndMessages(null)
        if (ready) {
            // Best effort: tell the firmware this is intentional.
            sendMessage(PhoneToGlasses.newBuilder().setMsgId("bye")
                .setDisconnect(DisconnectRequest.getDefaultInstance()).build())
        }
        ready = false
        queue.clear()
        gatt?.let { it.disconnect(); it.close() }
        gatt = null
        connected = false
        DeviceStore.apply("glasses", "connected", false)
        DeviceStore.apply("glasses", "fullyBooted", false)
        DeviceStore.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
    }

    // ------------------------------------------------------ not supported (v0)

    override fun requestPhoto(request: PhotoRequest) { Bridge.log("$TAG: no camera") }
    override fun startStream(message: MutableMap<String, Any>) {}
    override fun stopStream() {}
    override fun sendStreamKeepAlive(message: MutableMap<String, Any>) {}
    override fun startVideoRecording(requestId: String, save: Boolean, sound: Boolean) {}
    override fun stopVideoRecording(requestId: String) {}
    override fun sendButtonPhotoSettings() {}
    override fun sendButtonVideoRecordingSettings() {}
    override fun sendButtonMaxRecordingTime() {}
    override fun sendCameraFovSetting() {}
    override fun sendShutdown() {}
    override fun sendReboot() {}
    override fun sendRgbLedControl(
        requestId: String, packageName: String?, action: String, color: String?,
        onDurationMs: Int, offDurationMs: Int, count: Int,
    ) { Bridge.sendRgbLedControlResponse(requestId, false, "device_not_supported") }
    override fun dbg1() {}
    override fun dbg2() {}
    override fun requestWifiScan(scanId: String?) {}
    override fun sendWifiCredentials(ssid: String, password: String) {}
    override fun forgetWifiNetwork(ssid: String) {}
    override fun sendHotspotState(enabled: Boolean) {}
    override fun sendUserEmailToGlasses(email: String) {}
    override fun sendIncidentId(incidentId: String, apiBaseUrl: String?) {}
    override fun queryGalleryStatus() {}
    override fun sendGalleryMode() {}
    override fun requestVersionInfo() {
        sendMessage(PhoneToGlasses.newBuilder().setMsgId("info")
            .setGlassesInfo(GlassesInfoRequest.getDefaultInstance()).build())
    }
}
