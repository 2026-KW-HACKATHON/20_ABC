package kr.wolgyeon.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.provider.MediaStore
import android.view.View
import android.webkit.GeolocationPermissions
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePadding
import java.io.File

/**
 * 월계온 웹앱을 감싸는 앱.
 * - 서버 주소: gradle.properties 의 wolgyeonServerUrl
 * - 위치 권한, 카메라 촬영/갤러리 선택, 뒤로가기, 오프라인 화면을 처리
 * - 휴대폰 알림: FeedWorker(15분마다 서버 확인) + AppBridge(웹 설정·로그인 토큰 저장)
 */
class MainActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_LINK = "link"       // 알림을 눌렀을 때 열 앱 안 화면 (예: #/event/12)
    }

    private lateinit var web: WebView
    private lateinit var progress: ProgressBar
    private lateinit var offline: LinearLayout

    private val serverUrl = BuildConfig.SERVER_URL
    private val serverHost: String? = Uri.parse(serverUrl).host

    // 파일 선택(사진) 상태
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraUri: Uri? = null

    // 위치 권한 요청 상태
    private var geoOrigin: String? = null
    private var geoCallback: GeolocationPermissions.Callback? = null

    private val locationPermission = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val granted = result.values.any { it }
        geoCallback?.invoke(geoOrigin, granted, false)
        if (!granted) Toast.makeText(this, R.string.location_denied, Toast.LENGTH_SHORT).show()
        geoCallback = null
        geoOrigin = null
    }

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        reportNotifPermission()
    }

    /** 웹 설정 화면에서 '휴대폰 알림 받기'를 켤 때 */
    fun askNotificationPermission() {
        when {
            Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED ->
                notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            !Notifier.permitted(this) -> {        // 시스템 설정에서 알림을 꺼 둔 경우 → 앱 알림 설정 화면으로
                try {
                    startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
                } catch (_: ActivityNotFoundException) { }
            }
            else -> reportNotifPermission()
        }
    }

    private fun reportNotifPermission() {
        val st = if (Notifier.permitted(this)) "granted" else "denied"
        if (st == "granted") FeedWorker.runNow(this)
        web.evaluateJavascript("window.__wgNotifPerm && window.__wgNotifPerm('$st')", null)
    }

    private fun linkUrl(intent: Intent?): String? {
        val link = intent?.getStringExtra(EXTRA_LINK)?.takeIf { it.startsWith("#/") } ?: return null
        return "$serverUrl/$link"
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        linkUrl(intent)?.let { web.loadUrl(it) }
    }

    private val pickImage = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val cb = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        if (res.resultCode != Activity.RESULT_OK) {
            cb.onReceiveValue(null)
            return@registerForActivityResult
        }
        val data = res.data
        val uris: Array<Uri>? = when {
            data?.clipData != null -> Array(data.clipData!!.itemCount) { i -> data.clipData!!.getItemAt(i).uri }
            data?.data != null -> arrayOf(data.data!!)
            cameraUri != null && File(cacheDir, "camera/photo.jpg").length() > 0 -> arrayOf(cameraUri!!)
            else -> null
        }
        cb.onReceiveValue(uris)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        progress = findViewById(R.id.progress)
        offline = findViewById(R.id.offline)

        // 화면 끝까지 그리고, 상태바(남색)·내비바(흰색) 자리는 배경 뷰로 채움 — 안드로이드 15 대응
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false      // 남색 위 흰 아이콘
            isAppearanceLightNavigationBars = true   // 흰색 위 어두운 아이콘
        }
        val root = findViewById<View>(R.id.root)
        val statusBg = findViewById<View>(R.id.status_bg)
        val navBg = findViewById<View>(R.id.nav_bg)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            statusBg.updateLayoutParams { height = bars.top }
            navBg.updateLayoutParams { height = maxOf(bars.bottom, ime.bottom) }
            v.updatePadding(left = bars.left, right = bars.right)
            WindowInsetsCompat.CONSUMED
        }

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = true
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportMultipleWindows(false) // target=_blank 링크도 shouldOverrideUrlLoading 으로
            userAgentString = "$userAgentString WolgyeonApp/${BuildConfig.VERSION_NAME}"
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.host == serverHost && (uri.scheme == "https" || uri.scheme == "http")) return false
                // 외부 링크(행사 원문 등)는 기본 브라우저로
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                } catch (e: ActivityNotFoundException) {
                    true
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                progress.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                progress.visibility = View.GONE
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    offline.visibility = View.VISIBLE
                }
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress < 100) View.VISIBLE else View.GONE
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                val fine = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION)
                val coarse = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_COARSE_LOCATION)
                if (fine == PackageManager.PERMISSION_GRANTED || coarse == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false)
                } else {
                    geoOrigin = origin
                    geoCallback = callback
                    locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                }
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                openChooser(params)
                return true
            }
        }

        findViewById<Button>(R.id.retry).setOnClickListener {
            offline.visibility = View.GONE
            if (web.url.isNullOrEmpty() || web.url == "about:blank") web.loadUrl(serverUrl) else web.reload()
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        web.addJavascriptInterface(AppBridge(this), "WolgyeonAndroid")
        Notifier.ensureChannels(this)
        FeedWorker.schedule(this)
        FeedWorker.runNow(this)          // 1분 간격 확인 체인 시작

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(linkUrl(intent) ?: serverUrl)
    }

    /** 사진이면 카메라 촬영 + 갤러리, 그 밖의 파일(관리자 지도 파일 등)은 파일 선택 */
    private fun openChooser(params: WebChromeClient.FileChooserParams) {
        val types = params.acceptTypes.filter { it.isNotBlank() }
        val imageOnly = types.isNotEmpty() && types.all { it.startsWith("image/") }
        val picker = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (imageOnly) "image/*" else "*/*"
            if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
        }
        cameraUri = null
        val intent = if (imageOnly) {
            val dir = File(cacheDir, "camera").apply { mkdirs() }
            val photo = File(dir, "photo.jpg").apply { if (exists()) delete() }
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", photo)
            cameraUri = uri
            val camera = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, uri)
                clipData = ClipData.newRawUri("photo", uri)   // 선택창 안에서도 쓰기 권한이 넘어가도록
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            if (params.isCaptureEnabled) {
                Intent.createChooser(camera, getString(R.string.choose_photo)).apply {
                    putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(picker))
                }
            } else {
                Intent.createChooser(picker, getString(R.string.choose_photo)).apply {
                    putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera))
                }
            }
        } else {
            Intent.createChooser(picker, getString(R.string.choose_photo))
        }
        try {
            pickImage.launch(intent)
        } catch (e: ActivityNotFoundException) {
            fileCallback?.onReceiveValue(null)
            fileCallback = null
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
