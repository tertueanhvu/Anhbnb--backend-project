const MESSAGES = Object.freeze({
  VALIDATION_ERROR: "Dữ liệu đầu vào không hợp lệ.",
  INVALID_DATE_RANGE: "Khoảng ngày lưu trú không hợp lệ.",
  STAY_OUTSIDE_CALENDAR: "Khoảng ngày nằm ngoài lịch đang mở bán.",
  IDEMPOTENCY_KEY_REQUIRED: "Thiếu Idempotency-Key.",
  UNAUTHORIZED: "Yêu cầu xác thực không hợp lệ.",
  INVALID_CREDENTIALS: "Email hoặc mật khẩu không đúng.",
  FORBIDDEN: "Bạn không có quyền thực hiện thao tác này.",
  NOT_FOUND: "Không tìm thấy tài nguyên.",
  INTERNAL_ERROR: "Đã xảy ra lỗi hệ thống.",
});

module.exports = { MESSAGES };
