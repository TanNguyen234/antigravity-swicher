# Nhật Ký Thay Đổi (Changelog)

Tất cả các thay đổi đáng chú ý của extension **Antigravity Safe Account Manager & Dashboard** sẽ được ghi chép chi tiết tại tệp này.

Định dạng dựa trên [Keep a Changelog](https://keepachangelog.com/vi/1.0.0/), và dự án tuân thủ [Semantic Versioning](https://semver.org/).

---

## [1.2.1] - 2026-09-21

### 🛠️ Cải Thiện Nền Tảng & Chuẩn Hóa Quality Gates
- **Chuẩn hóa đường dẫn lưu trữ**:
  - Loại bỏ các đường dẫn ổ đĩa cố định (`Drive D`).
  - Hỗ trợ thư mục lưu trữ chuẩn qua `context.globalStorageUri` và thư mục cấu hình tiêu chuẩn của hệ điều hành.
  - Cầu nối SQLite `vscdb_bridge.py` và `vscdbHelper.js` hỗ trợ phân giải đa nền tảng (Windows, macOS, Linux).
- **Hệ thống Quality Gates tự động**:
  - Bổ sung `npm run typecheck` (TypeScript/JSDoc qua `jsconfig.json`).
  - Bổ sung `npm run build` và `npm run check-package`.
  - Phân tách lệnh kiểm thử: `npm test` (Suite A - unit tests độc lập không phụ thuộc IDE) và `npm run test:live` (Suite B - live probes).
  - Khắc phục lỗi kiểm thử khi chạy trên môi trường CI không có Antigravity IDE.
- **Tối ưu hóa đóng gói Extension**:
  - Cập nhật `.vscodeignore` loại trừ hoàn toàn cache Python (`__pycache__`, `*.pyc`), kịch bản gỡ lỗi và tệp kiểm thử.
  - Cập nhật `.gitignore` ngăn chặn việc commit các file export bundle và bytecode.
- **Trung thực hóa tài liệu**:
  - Cập nhật tài liệu mô tả chính xác cơ chế luân chuyển tài khoản kèm bảo toàn workspace tabs và cursor sau khi làm mới cửa sổ.

---

## [1.2.0] - 2026-09-20

### 🚀 Tính Năng Mới & Nâng Cấp
- **Giao Diện Dashboard Tối Giản**:
  - Tái thiết kế toàn bộ Dashboard theo phong cách tối giản, trực quan.
  - Bố cục Bento Grid thẻ tài khoản tự động thích ứng từ thanh Sidebar (1 cột) đến Tab rộng (3 cột).
  - Banner phím tắt `Ctrl` + `Alt` + `S` kèm nút bấm *Đổi tài khoản kế tiếp (Fast Swap)* trực quan.
  - **Stepper HUD Progress Visualizer**: Thanh tiến trình 4 giai đoạn thể hiện trực quan quá trình đổi tài khoản (`Sao lưu` $\rightarrow$ `Nạp Token` $\rightarrow$ `Làm mới IDE` $\rightarrow$ `Hoàn tất`).
  - Hệ thống Quota Gauges trực quan phân cấp màu theo mức độ: Xanh lục (>30%), Vàng hổ phách (11-30%), Đỏ (≤10%).
  - Đổi tên gợi nhớ inline cho từng slot (click icon bút chì).
  - Sao chép email 1-click có tooltip phản hồi trực quan.
  - Đồng hồ đếm ngược phục hồi Quota thời gian thực (`Hồi sau: Xh Ym Zs`).
- **Bảo Vệ Dữ Liệu Khi Di Chuyển (Verified Migration)**:
  - `ProfileSecretStorage` bắt buộc xác minh đọc lại thành công trước khi hủy bất kỳ file token nào trên ổ đĩa.
  - Tự động nhận diện môi trường: Giữ nguyên file đĩa khi chạy ngoài môi trường VS Code.
  - Thêm phương thức `hasTokens(slot)` kiểm tra nhanh tính khả dụng của slot.
- **Tối Ưu SQLite & Chống Khóa Database (SQLite PRAGMA)**:
  - `vscdb_bridge.py`: Bổ sung `PRAGMA busy_timeout = 5000;` giải quyết lỗi database lock khi IDE đang ghi log.
  - Xuất dữ liệu qua buffer nhị phân UTF-8 (`sys.stdout.buffer.write`) chống văng lỗi bảng mã Windows CP1252.
- **Bất Đồng Bộ Hóa IO Không Gây Khựng UI**:
  - `vscdbHelper.js`: Chuyển đổi toàn bộ `execFileSync` sang `execFile` bất đồng bộ.
  - Bổ sung cơ chế tự động tìm kiếm đa binary Python (`python`, `py -3`, `py`, `python3`).
- **Thuật Toán Luân Chuyển Tự Động Chống Dao Động (Anti-Flapping)**:
  - Chấm điểm kết hợp $(\text{Flash} \times 0.55 + \text{Pro} \times 0.35 + \text{Claude} \times 0.10)$.
  - Bổ sung ngưỡng an toàn hysteresis (+15 điểm) ngăn chặn hiện tượng đổi slot qua lại liên tục khi quota xấp xỉ nhau.
- **Bảo Toàn Dirty Documents**:
  - `workspaceState.js`: Tự động phát hiện tài liệu chưa lưu (`hasDirtyDocuments`) và kích hoạt `saveAll()` trước khi reload nếu cần.
- **Di Chuyển Đa Thiết Bị (Multi-Device Bundle)**:
  - Cung cấp 2 lệnh Command Palette mới:
    - `Antigravity Account: Export Profiles & Tokens Bundle (JSON)`
    - `Antigravity Account: Import Profiles & Tokens Bundle (JSON)`
- **Bộ Kiểm Thử Tự Động**:
  - Phân tách độc lập Suite A (Unit & Logic Cô lập) và Suite B (Live Integration Probes).

---

## [1.1.0] - 2026-09-15

### ⚡ Cải Tiến
- **Fast Swap với Workspace Restoration**:
  - Cập nhật chứng thực tài khoản và tự động khôi phục ngữ cảnh code sau khi làm mới cửa sổ.
- **Smart Dual-Protocol Probe**:
  - Tự động thăm dò kết nối HTTPS hoặc HTTP fallback đến Antigravity Language Server.
- **SQLite Bridge cho `state.vscdb`**:
  - Trích xuất và khôi phục an toàn snapshot xác thực SQLite.
- **Workspace State Restorer**:
  - Ghi nhớ và khôi phục chính xác các file đang mở, view columns và vị trí con trỏ chuột.

---

## [1.0.0] - 2026-09-01

### 🎉 Bản Phát Hành Đầu Tiên
- Quản lý 3 Slot tài khoản Google độc lập.
- Lưu trữ cấu hình cục bộ an toàn.
- Thanh Status Bar hiển thị Quota thời gian thực.
- Phím tắt `Ctrl + Alt + S` xoay vòng nhanh các tài khoản.
