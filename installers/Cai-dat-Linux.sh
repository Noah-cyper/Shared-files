#!/bin/sh
# Cài Shared Files cho người dùng hiện tại:  sh Cai-dat-Linux.sh
set -e
cd "$(dirname "$0")"

SRC="$PWD/app"
DEST="$HOME/.local/share/shared-files"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"

echo ""
echo "  =========================================="
echo "   Cài đặt Shared Files"
echo "  =========================================="
echo ""

if [ ! -f "$SRC/server.js" ]; then
  echo "  [!] Không thấy thư mục \"app\" bên cạnh file này. Hãy giải nén cả gói ra rồi chạy lại."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "  [!] Máy chưa cài Node.js. Cài rồi chạy lại file này:"
  echo "      Ubuntu/Debian : sudo apt install nodejs"
  echo "      Fedora        : sudo dnf install nodejs"
  echo "      Arch          : sudo pacman -S nodejs"
  exit 1
fi

echo "  Đang cài vào: $DEST"
rm -rf "$DEST"
mkdir -p "$DEST" "$APPS" "$ICONS"
cp -R "$SRC/." "$DEST/"
chmod +x "$DEST/start.sh"
cp "$SRC/public/icons/icon-512.png" "$ICONS/shared-files.png"

cat > "$APPS/shared-files.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Shared Files
Comment=Chia sẻ file tốc độ cao giữa các máy
Exec=sh "$DEST/start.sh"
Icon=shared-files
Terminal=true
Categories=Network;FileTransfer;
DESKTOP
chmod +x "$APPS/shared-files.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true

cat > "$DEST/go-cai-dat.sh" <<UNINST
#!/bin/sh
rm -rf "$DEST"
rm -f "$APPS/shared-files.desktop" "$ICONS/shared-files.png"
echo "Đã gỡ Shared Files."
UNINST
chmod +x "$DEST/go-cai-dat.sh"

echo ""
echo "  Xong. Tìm \"Shared Files\" trong danh sách ứng dụng."
echo "  Gỡ cài đặt: sh $DEST/go-cai-dat.sh"
echo ""
printf "  Chạy thử ngay bây giờ? [Y/n] "
read -r yn
case "$yn" in
  [Nn]*) ;;
  *) sh "$DEST/start.sh" ;;
esac
