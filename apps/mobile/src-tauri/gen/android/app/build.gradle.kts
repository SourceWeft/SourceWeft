import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release Rust builds load the production web origin. Verification changes only
// the package identity and signing certificate, never the Rust build profile.
val signingMode = System.getenv("SOURCEWEFT_ANDROID_SIGNING_MODE") ?: "development"
require(signingMode in setOf("development", "verification", "release")) {
    "Invalid SOURCEWEFT_ANDROID_SIGNING_MODE"
}
fun signingValue(name: String): String = System.getenv(name)?.takeIf { it.isNotBlank() }
    ?: throw GradleException("$name is required for Android release signing")

gradle.taskGraph.whenReady {
    if (allTasks.any { it.name.contains("Release", ignoreCase = true) }) {
        require(signingMode != "development") {
            "Choose android:verify or android:release; unsigned release builds are disabled"
        }
    }
}

android {
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    ndkVersion = "28.2.13676358"
    namespace = "nicelab.sourceweft.mobile"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        manifestPlaceholders["applicationLabel"] = "@string/app_name"
        applicationId = "nicelab.sourceweft.mobile"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (signingMode == "release") {
            create("sourceweftRelease") {
                storeFile = file(signingValue("ANDROID_KEYSTORE_PATH"))
                require(storeFile!!.isFile) { "Android release keystore does not exist" }
                storePassword = signingValue("ANDROID_STORE_PASSWORD")
                keyAlias = signingValue("ANDROID_KEY_ALIAS")
                keyPassword = signingValue("ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isDebuggable = false
            if (signingMode == "verification") {
                signingConfig = signingConfigs.getByName("debug")
                applicationIdSuffix = ".verification"
                versionNameSuffix = "-verification"
                manifestPlaceholders["applicationLabel"] = "SourceWeft Mobile (Verification)"
            } else if (signingMode == "release") {
                signingConfig = signingConfigs.getByName("sourceweftRelease")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
