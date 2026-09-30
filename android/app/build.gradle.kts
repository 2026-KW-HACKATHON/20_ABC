plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val serverUrl: String = (project.findProperty("wolgyeonServerUrl") as String?) ?: "https://wolgyeon.onrender.com"

android {
    namespace = "kr.wolgyeon.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "kr.wolgyeon.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "SERVER_URL", "\"${serverUrl.trimEnd('/')}\"")
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
