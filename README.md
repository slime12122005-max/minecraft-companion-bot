# Bot đồng hành Minecraft (Java 1.21.1) — Kiến trúc Antigravity + Jev

Bot kết nối vào thế giới LAN/Server Minecraft Java 1.21.1 theo kiến trúc **3 tầng mô phỏng não người**:

- **Tầng 2 — Não chính (System 2): Antigravity qua MCP (`src/mcp/server.js`)**
  Nhận yêu cầu ngôn ngữ tự nhiên từ chủ nhân qua `mc_get_inbox`, lập kế hoạch, chia việc tuần tự bằng `mc_plan_execute` / `mc_run_macro` / `mc_command`, theo dõi tiến độ & cảnh báo qua `mc_wait_event`.
- **Tầng 1 — Hỗ trợ phản ứng nhanh (System 1): Jev (`TYPESAFE_API_KEY`, `src/llm.js`)**
  Không dùng LLM chat hay đoán ý định nữa; Jev chỉ làm quyết định xác suất cực nhanh (`chooseCombat`, `chooseSurvivalAction`) khi bot gặp nguy hiểm, cần chọn chiến thuật chiến đấu hoặc hủy việc khẩn cấp.
- **Tầng 0 — Phản xạ & Tay chân cục bộ (`src/commands.js`, `src/combat/`, `src/survival/`, `src/mining_farming.js`, `src/building/`, `src/smelting.js`, `src/swarm/`)**
  Phản xạ tức thì lệnh chuẩn / khẩn cấp (`!stop`, `đứng đây`, `lại đây`), dập lửa/lava, giữ nhịp đánh 1.9+, né hất Creeper về phía chủ, chặt cây/đào hầm an toàn, nấu luyện bất đồng bộ, xây schematic và điều phối bầy đàn.

Yêu cầu **Node.js >= 22.5** (khuyến nghị Node 24 LTS, dùng built-in `node:sqlite`).

---

## Cấu hình & API Key

Chỉ cần **duy nhất 1 key tùy chọn** cho Jev (không còn dùng CrowLLM, OpenRouter, DeepSeek, Gemini, OpenAI, ChatFree hay Ollama bên trong bot):

- Đặt `TYPESAFE_API_KEY` trong `.env` (xem [.env.example](.env.example)) hoặc `~/.dsh/.credentials.yaml`.
- Nếu chưa đặt `TYPESAFE_API_KEY`, bot vẫn hoạt động bình thường với Antigravity MCP + phản xạ chiến đấu cục bộ.

---

## Cách chạy

### Chạy trực tiếp (Windows / Linux / macOS)

1. Vào thế giới Minecraft → Esc → **Mở cho mạng LAN / Open to LAN** → ghi nhớ số cổng.
2. Copy `config.example.json` thành `config.json`, sửa `host`, `port`, `username`, `owner`.
3. (Tuỳ chọn) Copy `.env.example` thành `.env` và điền `TYPESAFE_API_KEY`.
4. Kiểm tra và chạy:
   - Windows: chạy `run.bat` hoặc `node src/index.js --doctor` → `node src/index.js`
   - Linux / macOS: chạy `./run.sh` (hoặc `sh run.sh`)

### Chạy bằng Docker Compose

```sh
cp config.example.json config.json
docker compose up -d --build
```

Dashboard mặc định mở tại `http://127.0.0.1:3000`.

---

## Điều khiển trực tiếp bằng Antigravity (MCP Server)

Bot cung cấp Stdio MCP Server tại `src/mcp/server.js` (chạy qua `npm run mcp`):

1. Đảm bảo `dashboard.enabled: true` trong `config.json` (mặc định bật tại `http://127.0.0.1:3000`).
2. Đăng ký server `minecraft-bot` trong `~/.gemini/config/mcp_config.json` trỏ tới `node src/mcp/server.js` với `BOT_API_URL=http://127.0.0.1:3000` (nếu đặt `DASHBOARD_TOKEN`, truyền thêm `BOT_API_TOKEN`).
3. **12 công cụ MCP:**
   - Quan sát & nhận lệnh: `mc_get_state`, `mc_get_nearby`, `mc_get_inbox`, `mc_wait_event`
   - Lập kế hoạch & thực thi: `mc_plan_execute`, `mc_run_macro`, `mc_command`, `mc_smelt`
   - Tương tác & quản trị: `mc_say`, `mc_inventory`, `mc_control`, `mc_connect`

---

## Lệnh nhanh trực tiếp trong game (Tier 0 — không tốn LLM)

- **Khẩn cấp / Di chuyển:** `!stop` (`đứng đây`), `!come` (`lại đây`), `!home` (`về nhà`), `!follow` (`theo tôi`, `tt`)
- **Tọa độ & điểm đánh dấu:** `đi tới 100 64 -50`, `lưu điểm mỏ`, `đi tới mỏ`, `danh sách điểm`
- **Nhà & đồ:** `đây là nhà`, `đây là rương`, `cất đồ`, `xem rương`, `lấy từ rương <sl> <đồ>`, `ngủ`, `nhặt đồ chết`
- **Thu thập, chế tạo & nông trại:** `lấy 16 gỗ`, `chế tạo 1 cuốc sắt`, `nung 8 sắt`, `đào hầm 16`, `làm ruộng`, `đưa tôi 10 bánh mì`
- **Trang bị & xây dựng:** `trang bị`, `trạng thái`, `ăn`, `dọn túi`, `tắt đánh` / `bật đánh`, `dọn mặt bằng <file>`, `xây <file> [0|90|180|270]` → `xác nhận` / `hủy`

Mọi câu chat tự nhiên, chào hỏi hoặc yêu cầu phức tạp sẽ đi thẳng vào `mc_get_inbox` (gắn nhãn `OWNER_TRUSTED` / `UNTRUSTED_PUBLIC_PLAYER`) để Antigravity xử lý và phân công.
