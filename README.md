# NguonC Phim — Stremio Addon (Cloudflare Workers)

Addon Stremio **không chính thức** lấy dữ liệu phim từ API công khai của
`phim.nguonc.com`, chạy hoàn toàn trên Cloudflare Workers (serverless, miễn phí
trong hạn mức free tier).

> ⚠️ Đây là API không chính thức của bên thứ ba, có thể thay đổi cấu trúc bất
> cứ lúc nào khiến addon lỗi. Nếu gặp lỗi, hãy kiểm tra lại response thực tế
> từ `https://phim.nguonc.com/api/...` và chỉnh `src/worker.js` cho khớp.

## 1. Cài công cụ

Cần có [Node.js](https://nodejs.org) (>= 18) và tài khoản Cloudflare (miễn phí).

```bash
npm install
```

Lệnh này cài `wrangler` — CLI chính thức của Cloudflare để deploy Workers.

## 2. Đăng nhập Cloudflare

```bash
npx wrangler login
```

Trình duyệt sẽ mở ra để bạn đăng nhập / cấp quyền cho Wrangler.

## 3. Chạy thử local (tuỳ chọn)

```bash
npm run dev
```

Wrangler sẽ chạy addon tại `http://localhost:8787`. Kiểm tra bằng cách mở:

- `http://localhost:8787/manifest.json`

## 4. Deploy lên Cloudflare

```bash
npm run deploy
```

Sau khi deploy xong, Wrangler sẽ in ra một URL dạng:

```
https://nguonc-stremio-addon.<subdomain-của-bạn>.workers.dev
```

Đây chính là domain addon của bạn.

## 5. Thêm addon vào Stremio

Có 2 cách:

1. **Dán link cài đặt**: mở Stremio → mục **Addons** → ô tìm kiếm ở trên →
   dán vào:
   ```
   https://nguonc-stremio-addon.<subdomain-của-bạn>.workers.dev/manifest.json
   ```
   rồi nhấn Enter/Install.

2. **Dùng link `stremio://`**: mở trang chủ addon
   (`https://.../`) trên trình duyệt và bấm nút "Cài vào Stremio".

Sau khi cài, bạn sẽ thấy 2 catalog mới trên trang chủ Stremio:
- **NguonC - Phim Lẻ**
- **NguonC - Phim Bộ**

Tìm kiếm trong Stremio (mục Search) cũng sẽ gọi tới addon này để trả kết quả
từ nguonc.com.

## Cấu trúc project

```
nguonc-stremio-addon/
├── src/
│   └── worker.js      # Toàn bộ logic addon (manifest, catalog, meta, stream)
├── wrangler.toml      # Cấu hình Cloudflare Workers
├── package.json
└── README.md
```

## Cách addon hoạt động

- `GET /manifest.json` — khai báo addon với Stremio.
- `GET /catalog/movie/nguonc-movie.json` — danh sách phim lẻ mới cập nhật.
- `GET /catalog/series/nguonc-series.json` — danh sách phim bộ mới cập nhật.
- `GET /catalog/.../search=từ khoá.json` — tìm kiếm phim.
- `GET /meta/{type}/{id}.json` — thông tin chi tiết + danh sách tập (nếu là
  phim bộ).
- `GET /stream/{type}/{id}.json` — trả link stream (HLS `.m3u8`) để Stremio
  phát trực tiếp.

Dữ liệu được cache 30 phút trên Cloudflare Edge (dùng Cache API) để giảm số
lần gọi tới `phim.nguonc.com` và tăng tốc độ phản hồi.

## Ghi chú pháp lý

Addon này chỉ đơn thuần là một client gọi tới API sẵn có, công khai của
`phim.nguonc.com`. Bạn tự chịu trách nhiệm về việc tuân thủ điều khoản sử
dụng của trang nguồn và luật bản quyền tại khu vực của bạn khi sử dụng hoặc
phân phối addon này.
