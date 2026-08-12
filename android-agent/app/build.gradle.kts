plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "technology.influence.sourcingagent"
    compileSdk = 34

    defaultConfig {
        applicationId = "technology.influence.sourcingagent"
        // API 30 (Android 11) is the floor: AccessibilityService.takeScreenshot()
        // and WindowMetrics both land here, and they are what let the agent work
        // with a single permission toggle instead of a MediaProjection prompt.
        minSdk = 30
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")

    // org.json ships with Android, but the SDK stub throws on the JVM — pull the
    // real implementation in so the payload-shape tests actually execute.
    testImplementation("org.json:json:20240303")
    testImplementation("junit:junit:4.13.2")
}
