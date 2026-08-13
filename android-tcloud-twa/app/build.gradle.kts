import java.util.Properties

plugins {
    id("com.android.application")
}

val signingPropertiesFile = sequenceOf(
    rootProject.file("keystore.properties"),
    rootProject.file("../android-tcloud/keystore.properties"),
).firstOrNull { it.exists() }
val signingProperties = Properties().apply {
    signingPropertiesFile?.inputStream()?.use(::load)
}

android {
    namespace = "jp.tanaka.tcloud.twa"
    compileSdk = 36

    defaultConfig {
        applicationId = "jp.tanaka.tcloud.twa"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (signingPropertiesFile != null) {
            create("privateRelease") {
                storeFile = file(signingProperties.getProperty("storeFile"))
                storePassword = signingProperties.getProperty("storePassword")
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("keyPassword")
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
            if (signingPropertiesFile != null) {
                signingConfig = signingConfigs.getByName("privateRelease")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.2")
}
