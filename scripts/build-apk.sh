#!/usr/bin/env bash
# Builds the Android debug APK and copies it to release/lifeboard.apk (gitignored), named so
# it isn't confused with FitApp's app-debug.apk. Debug-signed with this computer's debug key,
# whose SHA-1 is the one registered for the phone's Google sign-in
# (agent-notes/2026-10-17-phone-google-sign-in.md).
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-$HOME/android-studio/jbr}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"

cd "$PROJECT_DIR"
npm run android
(cd android && ./gradlew assembleDebug)
mkdir -p release
cp android/app/build/outputs/apk/debug/app-debug.apk release/lifeboard.apk
echo "APK: $PROJECT_DIR/release/lifeboard.apk"
