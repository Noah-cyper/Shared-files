# ⚡ Shared Files — chia sẻ file tốc độ cao (P2P)

Gửi file thẳng từ máy này sang máy kia bằng WebRTC. Server **không hề nhận file** — nó chỉ giúp hai máy tìm thấy nhau, nên tốc độ chỉ phụ thuộc vào đường mạng giữa hai thiết bị, không phụ thuộc băng thông server.

Chạy được cả ba tình huống:

| Tình huống | Cách dùng | Đường đi của file |
|---|---|---|
| **Cùng WiFi / LAN** | Hai máy tự thấy nhau trong mục "Cùng mạng WiFi" | Thẳng trong LAN — nhanh nhất, đạt tốc độ WiFi/Gigabit |
| **Cùng Internet, khác WiFi** | Nhập mã 6 ký tự hoặc quét QR | Thẳng máy ↔ máy qua NAT (STUN) |
| **Khác mạng, NAT chặn** | Như trên, cần cấu hình TURN | Qua TURN relay (chậm hơn, luôn chạy được) |

Giao diện hiển thị đang chạy đường nào ngay trên thẻ thiết bị: *Mạng nội bộ* / *P2P qua Internet* / *Qua TURN*.

## Chạy

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

**Trên điện thoại nên dùng link HTTPS.** Chứng chỉ tự ký được sinh tự động ở lần chạy đầu (`.cert/`), trình duyệt sẽ cảnh báo — bấm *Advanced / Nâng cao → Proceed*. Dùng HTTPS thì mới có service worker để stream file lớn thẳng xuống ổ đĩa và mới copy được vào clipboard.

Tắt HTTPS: `HTTPS=0 npm start`. Đổi cổng: `PORT=8080 HTTPS_PORT=8443 npm start`.

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
server.js            signaling qua WebSocket, gom peer theo IP public, sinh QR, tự tạo chứng chỉ
public/js/rtc.js     engine truyền file: 4 DataChannel song song, backpressure, giao thức chunk
public/js/writer.js  ba cách lưu file nhận được (thư mục / stream / RAM)
public/js/app.js     giao diện, danh sách thiết bị, tiến trình, ghép đôi bằng mã
public/sw.js         service worker biến stream thành file download
```
