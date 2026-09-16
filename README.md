# Hotel Booking API — Phase 1

Backend REST API cho luồng duyệt chỗ ở, kiểm tra phòng trống, cart, booking giữ phòng và thanh toán ZaloPay. Một booking chỉ chứa một room type, nhưng có thể giữ nhiều phòng vật lý cùng loại qua `roomQuantity`.

## Stack và quy ước chính

- Node.js 22+, Express 5, PostgreSQL, Knex.
- Joi validation, bcrypt password hash, JWT HS256 hết hạn mặc định sau `1d`.
- Tiền là số nguyên VND; khoảng lưu trú là `[checkIn, checkOut)`.
- `room_availability` là nguồn sự thật cho giá và trạng thái từng phòng từng đêm.
- Booking mới ở `PENDING_PAYMENT`; quá hạn tự chuyển `EXPIRED` và nhả phòng về `OPEN`.
- Phase 1 không có refresh token và không có admin API.

Bản project này chỉ chứa các artifact cần cho development/runtime; các file planning nội bộ không được đóng gói cùng source.

## Chạy local

Yêu cầu PostgreSQL Server đang chạy và có hai database dev/test riêng. DBeaver chỉ là GUI; không bắt buộc cài `psql`.

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run db:migrate:test
npm run db:seed:test
npm run dev
```

Không chạy `cp` nếu `.env` đã tồn tại. Điền `DATABASE_URL`, `TEST_DATABASE_URL` và một `JWT_SECRET` ngẫu nhiên dài ít nhất 32 ký tự. Không commit `.env`.

Kiểm tra server:

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

## Payment local và ZaloPay sandbox

Mặc định dùng:

```dotenv
PAYMENT_PROVIDER_MODE=mock
```

Chế độ này không cần tài khoản ZaloPay và đủ để phát triển/test luồng backend. URL checkout trả về là URL giả; integration test gửi callback đã ký để xác nhận booking.

Khi test sandbox thật, developer phải tự:

1. lấy `ZALOPAY_APP_ID`, `ZALOPAY_KEY1`, `ZALOPAY_KEY2` từ tài khoản sandbox;
2. đặt `PAYMENT_PROVIDER_MODE=zalopay`;
3. mở HTTPS tunnel tới port API và điền URL public vào `ZALOPAY_CALLBACK_URL`;
4. restart server rồi thực hiện một payment sandbox.

Đây là bước thủ công vì credential và callback public nằm ngoài repository.

## Scripts

| Command                    | Công dụng                                      |
| -------------------------- | ---------------------------------------------- |
| `npm run dev`              | Chạy server với Node watch mode                |
| `npm start`                | Chạy server bình thường                        |
| `npm run db:migrate`       | Migrate database dev                           |
| `npm run db:seed`          | Seed catalog và lịch 365 ngày cho database dev |
| `npm run db:migrate:test`  | Migrate database test                          |
| `npm run db:seed:test`     | Seed database test                             |
| `npm run db:check`         | Kiểm tra số dòng lịch và state mismatch        |
| `npm test`                 | Unit tests                                     |
| `npm run test:integration` | Integration + transaction/concurrency tests    |
| `npm run test:all`         | Toàn bộ Vitest tests                           |
| `npm run test:newman`      | Chạy Postman collection; server phải đang chạy |
| `npm run lint`             | ESLint                                         |
| `npm run format:check`     | Kiểm tra Prettier                              |

`db:reset:test` là thao tác destructive và chỉ chấp nhận database có tên kết thúc bằng `_test` hoặc `-test`.

## API chính

Base URL: `http://localhost:3000/api/v1`.

- Auth: `POST /auth/register`, `POST /auth/login`, `GET/PATCH /users/me`.
- Catalog: `GET /properties`, `GET /properties/:propertyId`.
- Availability: `GET /properties/:propertyId/room-types/:roomTypeId/availability`.
- Cart: `GET /cart`, `POST /cart/items`, `PATCH/DELETE /cart/items/:cartItemId`.
- Booking: `POST /bookings` với header `Idempotency-Key`, `GET /bookings`, `GET /bookings/:id`, `POST /bookings/:id/cancellations`.
- Payment: `POST /bookings/:id/payments`, `GET /payments/:id`, `POST /payments/:id/reconcile`, ZaloPay callback public.

Import hai file trong [postman](./postman) vào Postman để chạy flow mẫu. Environment example không chứa password, JWT secret hoặc ZaloPay key.
Chạy collection theo thứ tự folder để Postman tự lưu access token và các resource ID cho những request sau.

## Cấu trúc source

```text
src/
├── app.js                 # Express middleware và health endpoints
├── server.js              # HTTP lifecycle và các interval job
├── routes.js              # Dependency wiring
├── modules/               # auth, properties, availability, carts, bookings, payments
├── jobs/                  # reconciliation và mở rộng lịch
└── shared/                # date, money, error, HTTP helpers
```

## Security note

`npm audit --omit=dev` phải sạch trước khi deploy. Newman hiện chỉ là công cụ dev và kéo một số transitive package cũ; chỉ chạy collection do chính project kiểm soát, không dùng Newman để chạy collection không đáng tin.
