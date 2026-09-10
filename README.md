# NguonC → Stremio trên Cloudflare Workers

Addon HTTP thuần JavaScript: danh mục, tìm kiếm, metadata, tập phim và stream HLS/direct CDN. Runtime không cần thư viện npm, cơ sở dữ liệu hay server Node chạy liên tục. Wrangler chỉ dùng để phát triển/deploy.

**Giới hạn nguồn đã xác minh ngày 10/09/2026:** bốn phim được lấy mẫu từ API chỉ có trường `embed` ở tập phim. Một trang nhúng được thử trả trang chặn truy cập tự động. Vì vậy đây là addon có khả năng xử lý HLS/direct, **không phải lời cam kết mọi phim NguonC đều xem được**. Cài manifest thành công không đồng nghĩa nguồn video hoạt động.

## 1. Đưa mã lên GitHub

Giải nén ZIP. Tạo repository mới và tải **nội dung bên trong thư mục `nguonc-stremio`** lên gốc repo. Gốc repo cần có `package.json`, `wrangler.jsonc`, `src/`, `test/`, `scripts/`, `README.md`. Nếu dùng GitHub web, thư mục `.github` có thể cần tải riêng để có workflow; không bắt buộc khi deploy bằng Cloudflare Builds.

Hoặc dùng Git trong thư mục mã:

```sh
git init -b main
git add .
git commit -m "Add NguonC Stremio Worker"
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

Các giá trị `YOUR_*` phải thay bằng tài khoản/repo của bạn.

## 2. Deploy từ GitHub qua Cloudflare

Trong Cloudflare Dashboard, mở **Workers & Pages**, tạo ứng dụng **Worker**, chọn nhập/kết nối repository GitHub. Đây là backend Worker; không chọn cấu hình xuất trang tĩnh.

| Thiết lập | Giá trị |
| --- | --- |
| Worker name | `nguonc-stremio` — khớp `name` trong `wrangler.jsonc` |
| Production branch | `main` |
| Root directory | Gốc repo chứa `package.json` |
| Build command | `npm run check && npm test` |
| Deploy command | `npm run deploy` |
| Node version | 22 trở lên |

Cloudflare Builds cài dependencies từ `package.json`. Nếu tên Worker đã được dùng trong tài khoản, đổi `name` trong `wrangler.jsonc` và tên trên Dashboard cho giống nhau. Nếu repo giữ thêm một lớp thư mục, đặt root directory là `nguonc-stremio`.

Sau khi deploy, Cloudflare cấp địa chỉ dạng `https://nguonc-stremio.YOUR_SUBDOMAIN.workers.dev`. Lấy URL thực tế từ Dashboard. Lần push sau sẽ cập nhật Worker nếu đã bật Git integration.

### Deploy bằng máy cá nhân

Cài Node.js 22+, mở terminal trong thư mục mã:

```sh
npm install
npm run check
npm test
npx wrangler login
npm run deploy
```

`npm run dev` chạy thử cục bộ. `npm run build` kiểm tra đóng gói bằng Wrangler mà không publish.

### GitHub Actions tùy chọn

Workflow `Test` tự chạy khi push/PR. Workflow `Deploy Cloudflare Worker` chỉ chạy khi bạn bấm **Actions → Run workflow**. Để dùng nó, tạo repository secrets `CLOUDFLARE_API_TOKEN` và `CLOUDFLARE_ACCOUNT_ID`. API token cần quyền chỉnh sửa Workers Scripts trong đúng tài khoản. Chỉ chọn một luồng deploy để dễ theo dõi.

Bản giao chưa có `package-lock.json` vì môi trường tạo mã không cài được Wrangler qua npm. Sau lần `npm install` thành công, commit lockfile; bạn có thể đổi bước cài trong workflow thành `npm ci` để cố định dependencies.

## 3. Cài addon vào Stremio

Mở URL Worker rồi thêm `/manifest.json`. Ví dụ minh họa:

```text
https://nguonc-stremio.YOUR_SUBDOMAIN.workers.dev/manifest.json
```

Trong Stremio, mở **Addons**, dán URL manifest vào ô tìm kiếm/thêm addon rồi cài. Endpoint gốc `/` cũng trả trường `install` dạng `stremio://...` để mở bằng ứng dụng Stremio.

Tìm phim trong các mục **NguonC • Mới cập nhật**, **NguonC • Phim lẻ**, **NguonC • Phim bộ**, hoặc tìm kiếm NguonC. Phim bộ có danh sách tập; chọn tập rồi chọn server HLS/Direct nếu có.

Addon dùng ID riêng `nguonc:slug`, không ánh xạ IMDb/Cinemeta. Mở phim từ catalog khác sẽ không tự có stream NguonC. Catalog mới cập nhật/tìm kiếm có thể chứa cả phim lẻ và phim bộ. Khi danh sách upstream thiếu định dạng, addon suy đoán từ tổng tập/trạng thái; catalog Phim lẻ/Phim bộ có type cố định. Nếu phim bị phân loại sai trong mục mới cập nhật, mở từ catalog chuyên biệt.

## 4. Cách lấy stream

1. Đọc các trường video như `m3u8`, `link_m3u8`, `hls`, `mp4`, `direct`; các trường `url/file/link` chỉ được nhận khi đường dẫn có phần mở rộng video.
2. Nếu chưa có video và có `embed`, thử đọc trang công khai trên host được cho phép. Chỉ lấy URL media hiện diện dưới dạng chuỗi rõ ràng trong HTML/script, không chạy JavaScript.
3. Nếu nguồn trả lỗi, chặn truy cập, dùng mã hóa/JavaScript động hoặc không công khai media URL, trả danh sách stream rỗng kèm thông báo. Một số Stremio client chỉ hiện “No streams found”; xem endpoint chẩn đoán để biết nguyên nhân.
4. `DIRECT_SOURCES` cho phép bạn gắn nguồn HLS/direct do bạn có quyền sử dụng vào một ID phim/tập.

Worker **chỉ cung cấp metadata và URL**, video được phát từ CDN trên thiết bị người xem. Không chuyển tiếp segment HLS hoặc toàn bộ phim qua Worker. Không dùng iframe làm stream video và không có cơ chế vượt CAPTCHA, DRM hay đăng nhập.

Tối đa 6 server được xử lý cho mỗi tập. Các tập được ghép bằng nhãn/số tập, không ghép theo vị trí mảng: server thiếu tập 2 không làm tập 3 bị phát nhầm thành tập 2. API không cung cấp mùa rõ ràng nên tập số nằm trong Season 1; tập đặc biệt nằm trong Season 0, không tự gộp các phần phim khác slug.

## 5. Tùy chỉnh

`RESOLVE_PUBLIC_EMBED` và `PREFERRED_FORMAT` đã khai báo trong `wrangler.jsonc`; sửa trực tiếp trong file để lần deploy sau giữ đúng giá trị.

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `RESOLVE_PUBLIC_EMBED` | `true` | `false`: chỉ dùng link trực tiếp từ API hoặc nguồn riêng |
| `PREFERRED_FORMAT` | `hls` | `direct`: đưa direct lên đầu; vẫn giữ cả hai nếu nguồn có |
| `EMBED_ALLOWED_HOSTS` | Trống | Host HTTPS bổ sung, cách nhau bởi dấu phẩy; không dùng wildcard |
| `DIRECT_SOURCES` | Trống | Chuỗi JSON ánh xạ ID sang mảng nguồn riêng |

Các host `embed.streamc.xyz`, `embed11.streamc.xyz` và dạng `embed<số>.streamc.xyz` được chấp nhận sẵn. Chỉ thêm host nhúng mà bạn kiểm soát hoặc tin cậy. Chuyển hướng đến host không được phép sẽ bị dừng.

### Gắn HLS/direct riêng

Trong Worker **Settings → Variables and Secrets**, thêm `DIRECT_SOURCES` dạng secret chứa JSON. Secret tránh đưa cấu hình vào repo; URL vẫn được cung cấp cho người dùng addon khi họ yêu cầu stream, nên đây không phải hệ thống giữ kín link video.

Ví dụ dưới đây chỉ là địa chỉ minh họa, phải thay bằng link của bạn:

```json
{
  "nguonc:ten-phim": [
    { "name": "CDN của tôi • HLS", "url": "https://cdn.example.com/movie/master.m3u8" },
    { "name": "CDN của tôi • MP4", "url": "https://cdn.example.com/movie/video.mp4" }
  ],
  "nguonc:ten-phim-bo:n1": [
    { "name": "Tập 1 • HLS", "url": "https://cdn.example.com/series/ep1.m3u8" }
  ]
}
```

Dùng slug thật trong catalog. Với phim bộ, lấy chính xác `videos[].id` từ `/meta/series/nguonc:SLUG.json`. Nếu có nguồn riêng cho đúng ID, nó thay thế việc tìm stream upstream cho ID đó. Metadata của phim vẫn lấy từ NguonC.

Nếu CDN của bạn yêu cầu header, có thể thêm `requestHeaders`, ví dụ `{"Referer":"https://your-player.example.com/"}` vào đối tượng nguồn. Addon đưa header này vào `behaviorHints.proxyHeaders` theo giao thức Stremio; hiệu lực tùy client/streaming server. Không thêm thông tin đăng nhập cá nhân vào addon công khai. Link ký có thời hạn cần được thay khi hết hạn; addon không tự gia hạn.

## 6. Chẩn đoán

| Endpoint | Công dụng |
| --- | --- |
| `/health` | Worker đang chạy; không kiểm tra API/CDN |
| `/manifest.json` | Manifest cài addon |
| `/catalog/movie/nguonc-new.json` | Danh sách mới cập nhật |
| `/catalog/series/nguonc-series/skip=10.json` | Phân trang phim bộ |
| `/catalog/movie/nguonc-search/search=TU_KHOA.json` | Tìm kiếm; URL-encode từ khóa |
| `/meta/series/nguonc:SLUG.json` | Chi tiết và ID tập |
| `/stream/series/nguonc:SLUG:n1.json` | Nguồn tập 1 |
| `/stream/movie/nguonc:SLUG.json` | Nguồn phim lẻ |
| `/diagnose/series/nguonc:SLUG:n1.json` | Số link và trạng thái từng server, không tải video |

Các trạng thái thường gặp: `api_direct_link`, `public_link_found`, `no_public_media_url`, `embed_http_403`, `embed_unreachable`, `host_not_allowed`. `streamCount` trong diagnose là số link tự tìm được; `customStreams` đếm riêng nguồn cấu hình.

Chạy kiểm tra backend sau deploy:

```sh
npm run smoke -- https://YOUR-WORKER.workers.dev
```

Exit code 0: cấu trúc API và stream hợp lệ, **chưa xác minh phát video**. Exit code 2: backend có dữ liệu nhưng phim mẫu không có nguồn phát truy cập được. Lỗi khác: kiểm tra HTTP/JSON/CORS thất bại.

Nếu có URL mà vẫn không phát: CDN có thể giới hạn IP, hết token, yêu cầu header, hoặc codec/container không được thiết bị hỗ trợ. Stremio Web có thể cần streaming server để xử lý HLS/codec/CORS; bản này đánh dấu `notWebReady: true` thận trọng theo hướng dẫn stream của Stremio. CORS của addon không thay đổi CORS của CDN. Chất lượng hình ảnh phụ thuộc nguồn và bitrate, không chỉ nhãn HLS/direct.

## 7. Kiểm chứng bản giao

- 13 kiểm thử tự động bằng Node: manifest/CORS, phân trang lệch offset, tìm kiếm tiếng Việt, ghép tập khác server, HLS/direct, parser embed công khai, lỗi 403, chặn redirect không hợp lệ, cấu hình CDN riêng, lỗi upstream.
- API danh sách và chi tiết thực tế đã đọc được; dữ liệu mẫu có `movie.episodes[].items[].embed`.
- Kiểm tra tương thích parser với bản JSON thật được thực hiện bằng dữ liệu tạm; dữ liệu phim và link nguồn không đóng gói vào repository.
- Chưa triển khai lên tài khoản Cloudflare hoặc chạy phát video trong Stremio.
- Chưa chạy Wrangler dry-run vì bước cài dependencies qua mạng không hoàn tất trong môi trường tạo mã. Chạy `npm install && npm run build` tại máy của bạn để kiểm tra bundle trước deploy.

## Tài liệu tham chiếu

- [NguonC API](https://phim.nguonc.com/api-document)
- [Stremio addon protocol](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md)
- [Stremio stream response](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md)
- [Cloudflare Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers Builds với GitHub](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
