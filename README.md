# ⚡ Shared Files — chia sẻ file tốc độ cao (P2P)

Gửi file thẳng từ máy này sang máy kia bằng WebRTC. Server **không hề nhận file** — nó chỉ giúp hai máy tìm thấy nhau, nên tốc độ chỉ phụ thuộc vào đường mạng giữa hai thiết bị, không phụ thuộc băng thông server.

Chạy được cả ba tình huống:

| Tình huống | Cách dùng | Đường đi của file |
|---|---|---|
| **Cùng WiFi / LAN** | Hai máy tự thấy nhau trong mục "Cùng mạng WiFi" | Thẳng trong LAN — nhanh nhất, đạt tốc độ WiFi/Gigabit |
| **Cùng Internet, khác WiFi** | Nhập mã 6 ký tự hoặc quét QR | Thẳng máy ↔ máy qua NAT (STUN) |
| **Khác mạng, NAT chặn** | Như trên, cần cấu hình TURN | Qua TURN relay (chậm hơn, luôn chạy được) |

Giao diện hiển thị đang chạy đường nào ngay trên thẻ thiết bị: *Mạng nội bộ* / *P2P qua Internet* / *Qua TURN*.

## Cài đặt

**Bản đóng gói** (không cần `npm install`): giải nén rồi chạy `Cai-dat-Windows.bat`, `Cai-dat-macOS.command` hoặc `sh Cai-dat-Linux.sh`. Bộ cài chép app vào máy và tạo lối tắt/biểu tượng ứng dụng; xem `HUONG-DAN.txt` trong gói.

**Từ mã nguồn:**

```bash
npm install
npm start
```

Terminal sẽ in ra các địa chỉ:

```
HTTP : http://localhost:3000
       http://192.168.1.20:3000
HTTPS: https://192.168.1.20:3443
```

Mở địa chỉ đó trên các thiết bị khác trong cùng WiFi là chúng tự thấy nhau.

**Trên điện thoại nên dùng link HTTPS** — xem mục *Cài lên điện thoại* ngay dưới. Chứng chỉ được sinh tự động ở lần chạy đầu và cấp lại khi IP LAN của máy đổi.

Terminal cũng vẽ luôn một mã QR trỏ tới trang hướng dẫn cài lên điện thoại — quét bằng camera là mở được ngay.

Tắt HTTPS: `HTTPS=0 npm start`. Đổi cổng: `PORT=8080 HTTPS_PORT=8443 npm start`.

## Cài lên điện thoại

Điện thoại không cần file cài riêng: app trên điện thoại chính là trang web này, và thêm được vào màn hình chính như app thật (PWA). Trang `/cai-dat.html` hướng dẫn từng bước cho iPhone và Android.

Bước đáng làm nhất ở đó là **cài chứng chỉ của máy chủ vào điện thoại**. Lần chạy đầu, app tự sinh một CA riêng cho máy đang chạy nó (`.cert/ca.key` — khoá này không bao giờ rời khỏi máy) rồi ký chứng chỉ cho các IP LAN của máy. Cài CA đó vào điện thoại một lần thì:

- HTTPS hết cảnh báo, nên service worker chạy được → file nhận về **stream thẳng xuống máy** thay vì phải nằm hết trong RAM
- Chrome/Safari mới cho **cài app vào màn hình chính**
- Clipboard, và các API chỉ chạy trong secure context, hoạt động bình thường

App tải về ở hai dạng: `/ca.crt` cho Android và `/ca.mobileconfig` (hồ sơ cấu hình) cho iOS. Muốn gỡ: xoá *Shared Files Local CA* trong phần chứng chỉ của điện thoại.

Vì lý do an toàn, CA **không được phát hành kèm mã nguồn**: nếu mọi bản cài dùng chung một CA thì ai cầm khoá đó cũng giả mạo được HTTPS của mọi máy đã cài. Mỗi máy tự sinh CA của riêng mình.

Bỏ qua bước chứng chỉ vẫn dùng được bình thường qua `http://<ip>:3000`, chỉ là file nhận về đi qua RAM và không thêm được app vào màn hình chính.

## Cách dùng

1. Bấm **Chọn file** (hoặc kéo–thả file/thư mục vào trang).
2. Bấm vào thiết bị muốn gửi. Có thể kéo file thả thẳng lên thẻ thiết bị.
3. Bên kia bấm **Nhận** (hoặc bật *Tự động nhận file* để khỏi hỏi).

Ghép đôi hai máy khác mạng: máy A đưa **mã 6 ký tự** hoặc **QR**, máy B nhập mã / quét QR. Link chia sẻ dạng `https://host/#MÃ` tự ghép đôi khi mở.

Ngoài file còn có ô **gửi nhanh đoạn text** (link, mật khẩu, ghi chú) tới mọi thiết bị đang kết nối.

## Nơi lưu file nhận được

Ứng dụng tự chọn cách lưu tốt nhất mà trình duyệt hỗ trợ:

1. **Thư mục bạn chọn** (Chrome/Edge desktop, nút *Chọn thư mục lưu*) — ghi thẳng xuống ổ, không giới hạn dung lượng, nhanh nhất, giữ nguyên cây thư mục khi gửi cả folder.
2. **Stream xuống Downloads** — service worker biến luồng dữ liệu thành một file download, file lớn cỡ nào cũng không nạp vào RAM.
3. **RAM rồi mới lưu** — fallback cuối khi trình duyệt không hỗ trợ hai cách trên; chỉ nên dùng cho file nhỏ.

Trạng thái hiện tại hiển thị ở cuối trang.

## Vì sao nhanh

- **4 DataChannel song song**, mỗi channel tự bốc chunk kế tiếp nên channel nhanh kéo được nhiều hơn — tận dụng hết băng thông thay vì nghẽn ở một luồng.
- **Channel unordered**: một gói bị mất không chặn cả dòng dữ liệu (bỏ head-of-line blocking). Mỗi chunk mang sẵn `fileIndex + offset` nên bên nhận ghép lại đúng vị trí.
- **Chunk lớn nhất SCTP cho phép** (tới 256 KB) thay vì 16 KB như đa số app cùng loại.
- **Backpressure hai chiều**: bên gửi theo dõi `bufferedAmount`, bên nhận báo `pause/resume` khi ghi đĩa không kịp — không bao giờ phình RAM hay đứt kết nối.
- **Không đọc cả file vào RAM**: đọc theo `slice()` đúng đoạn cần gửi, nên gửi file 50 GB cũng không tốn thêm RAM.

## Bảo mật

- File được mã hoá đầu-cuối bởi DTLS của WebRTC, đi thẳng giữa hai máy.
- Server chỉ chuyển tiếp SDP/ICE, và **chỉ giữa hai peer đã ở chung một phòng** — không thể quét ID để bắt chuyện với người lạ.
- Mã ghép đôi sinh ngẫu nhiên, sống đúng một phiên kết nối, mất khi đóng tab.

## Dùng qua Internet với TURN (tuỳ chọn)

Khoảng 5–10% mạng (NAT đối xứng, WiFi công cộng, một số 4G) không đục lỗ trực tiếp được. Khi đó cần TURN:

```bash
TURN_URL=turn:turn.example.com:3478 \
TURN_USERNAME=user TURN_PASSWORD=pass \
npm start
```

Có thể tự dựng bằng [coturn](https://github.com/coturn/coturn). Không có TURN thì hai máy dạng này sẽ báo không kết nối được; các trường hợp còn lại vẫn chạy bình thường.

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng HTTP |
| `HTTPS_PORT` | `3443` | Cổng HTTPS |
| `HTTPS` | bật | `HTTPS=0` để tắt |
| `TURN_URL` / `TURN_USERNAME` / `TURN_PASSWORD` | — | TURN server |

## Cấu trúc

```
server.js              signaling qua WebSocket, gom peer theo IP public, sinh QR, phục vụ CA
certs.js               sinh CA riêng của máy + chứng chỉ cho IP LAN, hồ sơ .mobileconfig cho iOS
public/js/rtc.js       engine truyền file: 4 DataChannel song song, backpressure, giao thức chunk
public/js/writer.js    ba cách lưu file nhận được (thư mục / stream / RAM)
public/js/app.js       giao diện, danh sách thiết bị, tiến trình, ghép đôi bằng mã
public/sw.js           service worker: biến stream thành file download + cache vỏ app
public/cai-dat.html    hướng dẫn cài lên điện thoại
tools/make-icons.mjs   sinh icon PNG/ICO/ICNS cho PWA và cho app trên máy tính
installers/            bộ cài cho Windows, macOS, Linux
```
