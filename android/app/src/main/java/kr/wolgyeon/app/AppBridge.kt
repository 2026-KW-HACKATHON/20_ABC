package kr.wolgyeon.app

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * 웹 화면(JS) ↔ 앱 연결. JS 에서는 window.WolgyeonAndroid.xxx() 로 부름.
 * 로그인 토큰과 알림 설정을 앱에 저장해, 화면을 닫아도 FeedWorker 가 알림을 가져올 수 있게 함.
 */
class AppBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun setAuth(token: String?) {
        val sp = Prefs.of(activity)
        val old = sp.getString(Prefs.TOKEN, null)
        if (old == token) return
        sp.edit().apply {
            if (token.isNullOrEmpty()) remove(Prefs.TOKEN) else putString(Prefs.TOKEN, token)
            putInt(Prefs.LAST_NT, -1)         // 계정이 바뀌면 지난 알림은 다시 띄우지 않음
        }.apply()
        if (!token.isNullOrEmpty()) FeedWorker.runNow(activity)
    }

    /** {"push": true, "promo": true} */
    @JavascriptInterface
    fun setPrefs(json: String) {
        val o = try { JSONObject(json) } catch (e: Exception) { return }
        Prefs.of(activity).edit().apply {
            if (o.has("push")) putBoolean(Prefs.PUSH, o.getBoolean("push"))
            if (o.has("promo")) putBoolean(Prefs.PROMO, o.getBoolean("promo"))
        }.apply()
        if (o.optBoolean("push", false)) FeedWorker.runNow(activity)   // 켜면 1분 간격 확인을 다시 시작
    }

    /** "granted" | "denied" */
    @JavascriptInterface
    fun notifPermission(): String = if (Notifier.permitted(activity)) "granted" else "denied"

    @JavascriptInterface
    fun requestNotifPermission() {
        activity.runOnUiThread { activity.askNotificationPermission() }
    }

    /** 알림 확인용: 지금 바로 서버에서 새 알림을 가져옴 */
    @JavascriptInterface
    fun checkNow() = FeedWorker.runNow(activity)

    /** 화면에서 이미 보여준 알림은 휴대폰 알림으로 또 띄우지 않게 마지막 번호를 맞춤 */
    @JavascriptInterface
    fun markSeen(bc: Int, nt: Int) {
        val sp = Prefs.of(activity)
        sp.edit().apply {
            if (bc > sp.getInt(Prefs.LAST_BC, -1)) putInt(Prefs.LAST_BC, bc)
            if (nt >= 0 && !sp.getString(Prefs.TOKEN, null).isNullOrEmpty() && nt > sp.getInt(Prefs.LAST_NT, -1)) putInt(Prefs.LAST_NT, nt)
        }.apply()
    }

    @JavascriptInterface
    fun testNotification() {
        Notifier.show(activity, 9999, Notifier.CH_NOTICE, "월계온 알림 테스트", "알림이 이렇게 표시돼요.", "#/notifications")
    }
}
