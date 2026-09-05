#!/bin/sh
# Cài Shared Files vào ~/Applications. Nhấn đôi file này để chạy.
set -e
cd "$(dirname "$0")"

SRC="$PWD/app"
APP="$HOME/Applications/Shared Files.app"

echo ""
echo "  =========================================="
echo "   Cài đặt Shared Files"
echo "  =========================================="
echo ""

if [ ! -f "$SRC/server.js" ]; then
  echo "  [!] Không thấy thư mục \"app\" bên cạnh file này."
  echo "      Hãy giải nén cả gói ra rồi chạy lại."
  echo ""
  read -r _ 2>/dev/null || true
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "  [!] Máy chưa cài Node.js — ứng dụng cần nó để chạy."
  echo "      Đang mở trang tải, cài xong thì chạy lại file này."
  open "https://nodejs.org/vi/download" 2>/dev/null || true
  echo ""
  read -r _ 2>/dev/null || true
  exit 1
fi

echo "  Đang cài vào: $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
cp -R "$SRC/." "$APP/Contents/Resources/app/"
cp "$SRC/public/icons/app.icns" "$APP/Contents/Resources/app.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Shared Files</string>
  <key>CFBundleDisplayName</key><string>Shared Files</string>
  <key>CFBundleIdentifier</key><string>local.sharedfiles.app</string>
  <key>CFBundleExecutable</key><string>SharedFiles</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
</dict>
</plist>
PLIST

# Mở qua Terminal để người dùng thấy địa chỉ, mã QR và tắt được bằng Ctrl+C
cat > "$APP/Contents/MacOS/SharedFiles" <<'RUN'
#!/bin/sh
DIR="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
open -a Terminal "$DIR/start.command"
RUN
chmod +x "$APP/Contents/MacOS/SharedFiles" "$APP/Contents/Resources/app/start.command" "$APP/Contents/Resources/app/start.sh"

# Bỏ cờ cách ly để macOS không bắt xác nhận lại app do chính máy này tạo ra
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

cat > "$HOME/Applications/Go-cai-dat-SharedFiles.command" <<UNINST
#!/bin/sh
rm -rf "$APP"
rm -f "\$0"
echo "Đã gỡ Shared Files."
UNINST
chmod +x "$HOME/Applications/Go-cai-dat-SharedFiles.command"

echo ""
echo "  Xong. Mở Finder → thư mục Applications trong Home → \"Shared Files\"."
echo "  (Kéo vào Dock cho tiện. Gỡ cài: chạy Go-cai-dat-SharedFiles.command)"
echo ""
printf "  Chạy thử ngay bây giờ? [Y/n] "
read -r yn
case "$yn" in
  [Nn]*) ;;
  *) open "$APP" ;;
esac
