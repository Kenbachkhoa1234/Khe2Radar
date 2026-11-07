package com.example.khe2radar

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.PixelFormat
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import com.google.android.gms.location.*
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import kotlin.math.sqrt

class MainActivity : AppCompatActivity(), SensorEventListener {

    // === CẤU HÌNH KẾT NỐI SERVER ===
    // Đổi thành domain Render của bạn (hoặc http://IP_LAN:3000 nếu test local)
    private val SERVER_URL = "https://khe2-radar.onrender.com"
    private val ROOM_ID = "khe2"
    private val CHILD_TOKEN = "khe2-device"
    private lateinit var deviceId: String
    private var isAuthenticated = false

    private lateinit var mSocket: Socket
    private lateinit var sensorManager: SensorManager
    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var locationCallback: LocationCallback

    private lateinit var rootLayout: LinearLayout
    private lateinit var modeBanner: TextView
    private lateinit var statusText: TextView

    private var windowManager: WindowManager? = null
    private var overlayView: View? = null
    private var ringtone: Ringtone? = null

    private var currentLat = 10.762622
    private var currentLng = 106.660172
    private var isMoving = false
    private var currentMode = "NORMAL"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val androidId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
        deviceId = "${Build.MANUFACTURER}_${Build.MODEL}_$androidId"

        // Dựng giao diện bằng code thuần
        rootLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0E0E11"))
            setPadding(50, 120, 50, 50)
        }

        modeBanner = TextView(this).apply {
            text = "🟢 KHE2 RADAR: ĐỊNH VỊ CHILL"
            textSize = 20f
            setTextColor(Color.BLACK)
            setBackgroundColor(Color.parseColor("#00E676"))
            gravity = Gravity.CENTER
            setPadding(30, 40, 30, 40)
        }

        statusText = TextView(this).apply {
            text = "\n📱 ID Thiết bị: $deviceId\n📡 Đang kết nối Trạm Trung Tâm..."
            textSize = 15f
            setTextColor(Color.WHITE)
        }

        rootLayout.addView(modeBanner)
        rootLayout.addView(statusText)
        setContentView(rootLayout)

        checkAndRequestPermissions()
        setupSensorsAndLocation()
        setupSocketConnection()

        // Lặp định kỳ gửi tọa độ & pin về server
        val handler = Handler(Looper.getMainLooper())
        handler.post(object : Runnable {
            override fun run() {
                sendDeviceUpdate()
                val delay = if (currentMode == "SHIELD") 1500L else 4000L
                handler.postDelayed(this, delay)
            }
        })
    }

    private fun checkAndRequestPermissions() {
        if (!Settings.canDrawOverlays(this)) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }

        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            ), 101)
        }
    }

    private fun setupSensorsAndLocation() {
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        sensorManager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_NORMAL)

        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        val locationRequest = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2000)
            .setMinUpdateIntervalMillis(1000)
            .build()

        locationCallback = object : LocationCallback() {
            override fun onLocationResult(res: LocationResult) {
                res.lastLocation?.let {
                    currentLat = it.latitude
                    currentLng = it.longitude
                }
            }
        }

        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            fusedLocationClient.requestLocationUpdates(locationRequest, locationCallback, Looper.getMainLooper())
        }
    }

    private fun setupSocketConnection() {
        try {
            mSocket = IO.socket(SERVER_URL)

            mSocket.on(Socket.EVENT_CONNECT) {
                runOnUiThread {
                    statusText.text = "\n📱 ID: $deviceId\n🟢 Đã kết nối Trạm: $ROOM_ID"
                }
                // Xác thực là Máy Con
                val auth = JSONObject().apply {
                    put("role", "CHILD")
                    put("roomId", ROOM_ID)
                    put("token", CHILD_TOKEN)
                    put("deviceId", deviceId)
                    put("name", Build.MODEL)
                }
                mSocket.emit("join_room", auth)
            }

            mSocket.on("auth_success") {
                isAuthenticated = true
                runOnUiThread {
                    statusText.text = "\n📱 ID: $deviceId\n🟢 Máy con đã được xác thực."
                }
                sendDeviceUpdate()
            }

            mSocket.on("auth_error") { args ->
                isAuthenticated = false
                val message = args.firstOrNull()?.toString() ?: "Xác thực thất bại"
                runOnUiThread { statusText.text = "\n🔴 $message" }
            }

            mSocket.on("server_error") { args ->
                val message = args.firstOrNull()?.toString() ?: "Server từ chối yêu cầu"
                runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
            }

            mSocket.on(Socket.EVENT_DISCONNECT) {
                isAuthenticated = false
                runOnUiThread { statusText.text = "\n🟠 Mất kết nối, đang thử kết nối lại..." }
            }

            mSocket.on(Socket.EVENT_CONNECT_ERROR) { args ->
                isAuthenticated = false
                val message = args.firstOrNull()?.toString() ?: "Không kết nối được server"
                runOnUiThread { statusText.text = "\n🔴 $message" }
            }

            mSocket.on("mode_changed") { args ->
                val newMode = args[0] as String
                runOnUiThread { updateAppModeUI(newMode) }
            }

            mSocket.on("execute_command") { args ->
                val data = args[0] as JSONObject
                val cmd = data.getString("command")
                runOnUiThread { handleRemoteCommand(cmd) }
            }

            mSocket.connect()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun updateAppModeUI(mode: String) {
        currentMode = mode
        if (mode == "SHIELD") {
            modeBanner.text = "🔴 KHE2 RADAR: CẢNH GIỚI 10M"
            modeBanner.setBackgroundColor(Color.parseColor("#FF1744"))
            modeBanner.setTextColor(Color.WHITE)
            statusText.text = "\n📱 ID: $deviceId\n⚠️ Cảm biến chống nhấc máy: ĐANG BẬT\n🔒 Khóa khẩn cấp đã sẵn sàng!"
        } else {
            modeBanner.text = "🟢 KHE2 RADAR: ĐỊNH VỊ CHILL"
            modeBanner.setBackgroundColor(Color.parseColor("#00E676"))
            modeBanner.setTextColor(Color.BLACK)
            statusText.text = "\n📱 ID: $deviceId\n😊 Chế độ bạn bè bình thường\n🔓 Cảm biến báo động: ĐÃ TẮT"
            stopAlarm()
            removeOverlay()
        }
    }

    private fun sendDeviceUpdate() {
        if (!mSocket.connected() || !isAuthenticated) return

        val bm = getSystemService(BATTERY_SERVICE) as BatteryManager
        val batteryPct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)

        val data = JSONObject().apply {
            put("deviceId", deviceId)
            put("name", Build.MODEL)
            put("battery", batteryPct)
            put("isCharging", bm.isCharging)
            put("isMoving", isMoving)
            put("lat", currentLat)
            put("lng", currentLng)
        }
        mSocket.emit("device_update", data)
    }

    private fun handleRemoteCommand(cmd: String) {
        when (cmd) {
            "PING_HEART" -> Toast.makeText(this, "💖 Trạm Trung Tâm vừa thả tim bạn!", Toast.LENGTH_LONG).show()
            "RING" -> playAlarm()
            "LOCK" -> showOverlay(fakeShutdown = false)
            "FAKE_SHUTDOWN" -> showOverlay(fakeShutdown = true)
            "PANIC" -> {
                playAlarm()
                showOverlay(fakeShutdown = false)
            }
            "UNLOCK" -> {
                stopAlarm()
                removeOverlay()
            }
        }
    }

    private fun playAlarm() {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val maxVol = audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM)
        audioManager.setStreamVolume(AudioManager.STREAM_ALARM, maxVol, 0)

        val alarmUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        ringtone = RingtoneManager.getRingtone(applicationContext, alarmUri)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ringtone?.isLooping = true
        }
        ringtone?.play()
    }

    private fun stopAlarm() {
        ringtone?.stop()
    }

    private fun showOverlay(fakeShutdown: Boolean) {
        if (overlayView != null) removeOverlay()
        if (!Settings.canDrawOverlays(this)) return

        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        )

        overlayView = TextView(this).apply {
            if (fakeShutdown) {
                setBackgroundColor(Color.BLACK)
                text = ""
                stopAlarm()
            } else {
                setBackgroundColor(Color.parseColor("#D50000"))
                setTextColor(Color.WHITE)
                textSize = 24f
                gravity = Gravity.CENTER
                text = "🚨 KHE2 RADAR LOCK!\n\nThiết bị đã rời khỏi phạm vi an toàn.\nTọa độ đang truyền liên tục về Trạm Quản Lý."
            }
        }
        windowManager?.addView(overlayView, params)
    }

    private fun removeOverlay() {
        overlayView?.let {
            windowManager?.removeView(it)
            overlayView = null
        }
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event?.sensor?.type == Sensor.TYPE_ACCELEROMETER) {
            val x = event.values[0]
            val y = event.values[1]
            val z = event.values[2]
            val acceleration = sqrt((x * x + y * y + z * z).toDouble())

            // Lắc hoặc nhấc máy mạnh
            if (acceleration > 13.5) {
                if (!isMoving) {
                    isMoving = true
                    if (currentMode == "SHIELD") {
                        val alert = JSONObject().apply {
                            put("name", Build.MODEL)
                            put("message", "Thiết bị vừa bị nhấc lên khỏi vị trí hoặc di chuyển!")
                        }
                        if (isAuthenticated) mSocket.emit("device_alert", alert)
                    }
                }
            } else {
                isMoving = false
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    override fun onDestroy() {
        super.onDestroy()
        fusedLocationClient.removeLocationUpdates(locationCallback)
        sensorManager.unregisterListener(this)
        mSocket.disconnect()
    }
}
