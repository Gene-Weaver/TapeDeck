#!/bin/zsh
# Builds TapeDeck.app, a small launcher for the Electron app in this folder, and copies it to /Applications.
#   zsh launcher/make_launcher.sh            build + install
#   zsh launcher/make_launcher.sh --no-install   build only (launcher/TapeDeck.app)
# The launcher only starts Electron on this project folder, so app updates need no rebuild. If the project moves,
# run this again from the new place.
set -e
HERE="${0:A:h}"; PROJECT="${HERE:h}"; APP="$HERE/TapeDeck.app"
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# --- icon: the app's own (build/icon.png) ---
ICON="$PROJECT/build/icon.png"
SET="$HERE/TapeDeck.iconset"; rm -rf "$SET"; mkdir "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ICON" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done

# --- the .app ---
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
iconutil -c icns "$SET" -o "$APP/Contents/Resources/TapeDeck.icns"; rm -rf "$SET"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>TapeDeck</string>
  <key>CFBundleDisplayName</key><string>TapeDeck</string>
  <key>CFBundleIdentifier</key><string>local.tapedeck.launcher</string>
  <key>CFBundleExecutable</key><string>TapeDeck</string>
  <key>CFBundleIconFile</key><string>TapeDeck</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/TapeDeck" <<LAUNCH
#!/bin/zsh
# Starts TapeDeck (Electron) from its project folder. A second launch just brings the running window forward.
PROJECT="$PROJECT"
ELECTRON="\$PROJECT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [[ ! -x "\$ELECTRON" ]]; then
  osascript -e "display alert \"TapeDeck\" message \"Could not find the app in \$PROJECT. If the folder moved, run launcher/make_launcher.sh again from the new place.\""
  exit 1
fi
unset ELECTRON_RUN_AS_NODE
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
mkdir -p "\$HOME/Library/Logs/TapeDeck"
cd "\$PROJECT" && exec "\$ELECTRON" . >> "\$HOME/Library/Logs/TapeDeck/launcher.log" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/TapeDeck"
echo "built $APP"
if [[ "$1" != "--no-install" ]]; then
  rm -rf /Applications/TapeDeck.app && cp -R "$APP" /Applications/TapeDeck.app && touch /Applications/TapeDeck.app
  echo "installed /Applications/TapeDeck.app"
fi
