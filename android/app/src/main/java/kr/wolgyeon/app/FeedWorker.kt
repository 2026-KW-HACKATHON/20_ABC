package kr.wolgyeon.app

import android.content.Context
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * 약 1분마다 서버(/api/app/feed)에서 새 알림을 가져와 휴대폰 알림으로 띄움.
 *  - 한 번 돌 때마다 1분 뒤 다음 확인을 예약(체인). 15분 주기 작업은 체인이 끊겼을 때 다시 잇는 안전장치.
 *  - 휴대폰이 절전(도즈) 상태면 안드로이드가 확인을 미룰 수 있음.
 * - 공지(관리자 일괄 알림): 로그인하지 않아도 받음
 * - 내 알림(즐겨찾기 행사 곧 시작·새 행사 등): 앱에서 로그인했을 때
 * - 근처 행사 추천: 하루 한 번, 오전 10시~오후 8시 사이
 * 설정은 웹 화면의 설정에서 바꾸면 AppBridge 가 SharedPreferences 에 저장함.
 */
class FeedWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        val sp = Prefs.of(applicationContext)
        if (!sp.getBoolean(Prefs.PUSH, true) || !Notifier.permitted(applicationContext)) return Result.success()
        val fast = inputData.getBoolean(KEY_FAST, false)
        val r = check(sp)
        if (fast) scheduleNext(applicationContext)      // 1분 간격 체인: 다음 확인을 내 뒤에 이어 붙임
        else if (!fastPending(applicationContext)) runNow(applicationContext)   // 15분 안전장치: 체인이 끊겼으면 다시 시작
        return r
    }

    private fun check(sp: android.content.SharedPreferences): Result {
        val token = sp.getString(Prefs.TOKEN, null)
        val lastBc = sp.getInt(Prefs.LAST_BC, -1)
        val lastNt = if (token.isNullOrEmpty()) -1 else sp.getInt(Prefs.LAST_NT, -1)
        val today = SimpleDateFormat("yyyyMMdd", Locale.KOREA).format(Calendar.getInstance().time)
        val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        val wantPromo = sp.getBoolean(Prefs.PROMO, true) && hour in 10..19 && sp.getString(Prefs.PROMO_DAY, "") != today
        val url = "${BuildConfig.SERVER_URL}/api/app/feed?after_bc=$lastBc&after_nt=$lastNt" +
            "&promo=${if (wantPromo) 1 else 0}&last_promo=${sp.getInt(Prefs.LAST_PROMO, 0)}"

        val json = try {
            val c = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15000; readTimeout = 20000
                setRequestProperty("Accept", "application/json")
                if (!token.isNullOrEmpty()) setRequestProperty("Authorization", "Bearer $token")
            }
            if (c.responseCode == 401) { sp.edit().remove(Prefs.TOKEN).apply(); return Result.success() }
            if (c.responseCode != 200) return Result.success()
            JSONObject(c.inputStream.bufferedReader().use { it.readText() })
        } catch (e: Exception) {
            return Result.success()          // 다음 1분 확인에서 다시 시도
        }

        val ed = sp.edit()
        // 공지
        if (lastBc >= 0) {
            val arr = json.optJSONArray("broadcasts")
            for (i in 0 until (arr?.length() ?: 0)) {
                val o = arr!!.getJSONObject(i)
                Notifier.show(applicationContext, 100000 + o.getInt("id"), Notifier.CH_NOTICE,
                    o.optString("title"), o.optString("body"), o.optString("link"))
            }
        }
        ed.putInt(Prefs.LAST_BC, maxOf(lastBc, json.optInt("latest_bc", 0)))
        // 내 알림
        if (!token.isNullOrEmpty()) {
            if (lastNt >= 0) {
                val arr = json.optJSONArray("notifications")
                for (i in 0 until (arr?.length() ?: 0)) {
                    val o = arr!!.getJSONObject(i)
                    Notifier.show(applicationContext, 200000 + (o.getInt("id") % 800000), Notifier.CH_EVENT,
                        o.optString("title"), o.optString("body"), o.optString("link"))
                }
            }
            ed.putInt(Prefs.LAST_NT, maxOf(lastNt, json.optInt("latest_nt", 0)))
        }
        // 근처 행사 추천 (하루 한 번)
        json.optJSONObject("promo")?.let { p ->
            if (wantPromo) {
                Notifier.show(applicationContext, 3000, Notifier.CH_PROMO, p.optString("title"), p.optString("body"), p.optString("link"))
                ed.putString(Prefs.PROMO_DAY, today).putInt(Prefs.LAST_PROMO, p.optInt("id"))
            }
        }
        ed.apply()
        return Result.success()
    }

    companion object {
        private val net = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<FeedWorker>(15, TimeUnit.MINUTES).setConstraints(net).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("feed", ExistingPeriodicWorkPolicy.KEEP, req)
        }

        private const val KEY_FAST = "fast"
        private const val FAST = "feed-fast"
        private val fastData = Data.Builder().putBoolean(KEY_FAST, true).build()

        /** 지금 바로 확인하고, 그 뒤로 1분 간격 체인을 (다시) 시작 */
        fun runNow(ctx: Context) {
            val req = OneTimeWorkRequestBuilder<FeedWorker>().setConstraints(net).setInputData(fastData).build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(FAST, ExistingWorkPolicy.REPLACE, req)
        }

        /** 1분 뒤 한 번 더 확인 (관리자가 보낸 알림이 거의 바로 오도록). 실행 중인 나의 뒤에 이어 붙임 */
        private fun scheduleNext(ctx: Context) {
            val req = OneTimeWorkRequestBuilder<FeedWorker>().setConstraints(net).setInputData(fastData)
                .setInitialDelay(60, TimeUnit.SECONDS).build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(FAST, ExistingWorkPolicy.APPEND_OR_REPLACE, req)
        }

        private fun fastPending(ctx: Context): Boolean = try {
            WorkManager.getInstance(ctx).getWorkInfosForUniqueWork(FAST).get().any { !it.state.isFinished }
        } catch (e: Exception) { false }
    }
}

object Prefs {
    const val TOKEN = "token"
    const val PUSH = "push"
    const val PROMO = "promo"
    const val LAST_BC = "last_bc"
    const val LAST_NT = "last_nt"
    const val LAST_PROMO = "last_promo"
    const val PROMO_DAY = "promo_day"
    fun of(ctx: Context) = ctx.getSharedPreferences("wolgyeon", Context.MODE_PRIVATE)!!
}
