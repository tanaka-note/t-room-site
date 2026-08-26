import java.util.Properties
import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// 新しい鍵は作らず、既存T-ROOM release署名設定をローカルから参照する。
val sharedSigningFile = rootProject.file("../android-tcloud/keystore.properties")
val sharedSigning = Properties().apply {
    if (sharedSigningFile.exists()) sharedSigningFile.inputStream().use(::load)
}
val sharedStoreValue = sharedSigning.getProperty("storeFile", "")
val sharedStoreFile = File(sharedStoreValue).let { if (it.isAbsolute) it else rootProject.file("../android-tcloud/$sharedStoreValue") }

android {
    namespace = "jp.tanaka.troom.ai"
    compileSdk = 36

    defaultConfig {
        applicationId = "jp.tanaka.troom.ai"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        buildConfigField("String", "SERVER_BASE_URL", "\"https://tanaka-note.com\"")
    }

    signingConfigs {
        if (sharedSigningFile.exists()) {
            create("sharedTRoomRelease") {
                storeFile = sharedStoreFile
                storePassword = sharedSigning.getProperty("storePassword")
                keyAlias = sharedSigning.getProperty("keyAlias")
                keyPassword = sharedSigning.getProperty("keyPassword")
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            if (sharedSigningFile.exists()) signingConfig = signingConfigs.getByName("sharedTRoomRelease")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.06.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation("androidx.activity:activity-compose:1.12.3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
