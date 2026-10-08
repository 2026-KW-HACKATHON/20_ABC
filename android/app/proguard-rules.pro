# WebView 에서 쓰는 클래스는 기본 규칙으로 충분합니다.
-keepclassmembers class * extends android.webkit.WebChromeClient { *; }

# 웹 화면에서 부르는 앱 기능 (window.WolgyeonAndroid)
-keepclassmembers class kr.wolgyeon.app.AppBridge { @android.webkit.JavascriptInterface <methods>; }
-keep class kr.wolgyeon.app.FeedWorker { *; }
