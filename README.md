# Bot đồng hành Minecraft (Java 1.8.8 – 1.21.11+, Auto-LAN / e4mc / Fabric) — Kiến trúc Antigravity + Jev

Bot kết nối vào thế giới LAN / `e4mc` / Server Minecraft Java (**1.8.8 → 1.21.11+**, hỗ trợ Vanilla, OptiFine, Sodium và **Fabric Registry Sync**) theo kiến trúc **3 tầng mô phỏng não người**:

- **Tầng 2 — Não chính (System 2): Antigravity qua MCP (`src/mcp/server.js`)**
  Nhận yêu cầu ngôn ngữ tự nhiên từ chủ nhân qua `mc_get_inbox` (kèm snapshot trạng thái, rương, đồ quanh bot & lịch sử chat để phản hồi **1 lượt** nhanh nhất), lập kế hoạch, chia việc tuần tự bằng `mc_plan_execute` / `mc_run_macro` / `mc_command`, và tự xử lý chuỗi bước bù đắp khi gặp `task_failed`.
  Khi thật sự cần thêm lệnh JS cục bộ hoặc tự vá lỗi runtime của bot, Antigravity (và bộ bắt lỗi nội bộ) xếp hàng vào **duy nhất 1 tab `Orchestrator / Gemini 4 Carbon High`** chạy lần lượt từng việc, có cooldown 3 phút và **tự xóa tab tạm sau khi sửa & test pass**.
- **Tầng 1 — Hỗ trợ phản ứng nhanh (System 1): Jev (`TYPESAFE_API_KEY`, `src/llm.js`)**
  Không dùng LLM chat hay đoán ý định; Jev chỉ làm quyết định xác suất cực nhanh (`chooseCombat`, `chooseSurvivalAction`) khi bot gặp nguy hiểm, cần chọn chiến thuật chiến đấu hoặc hủy việc khẩn cấp.
- **Tầng 0 — Phản xạ & Tự chủ sinh tồn cục bộ (`src/commands.js`, `src/equipment.js`, `src/humanizer.js`, `src/combat/`, `src/survival/`, `src/mining_farming.js`, `src/building/`, `src/smelting.js`, `src/swarm/`)**
  Phản xạ tức thì lệnh chuẩn / khẩn cấp (`!stop`, `đứng đây`, `lại đây`), `MotorHumanizer` (xoay đầu mượt, di chuyển thẳng mượt không khựng, ánh nhìn tự nhiên theo chủ, độ trễ gõ chat, combat strafe + W-tap), dập lửa/lava, giữ nhịp đánh 1.9+, chặt trọn cây cao/tán nổi, đào bậc thang an toàn xuống tầng đá khi bị đất che, làm ruộng tự đập cỏ kiếm hạt khi được lệnh, lọc vật phẩm thông minh (**Giữ** nâng cấp & luôn nhặt sắt, **Dừng nhặt** thêm kim cương khi túi đã đủ `64`, **Bỏ qua/Vứt** rác & đồ chủ quăng ra hướng an toàn lúc đứng yên, **Cất rương** đồ dư có giá trị), nấu luyện bất đồng bộ, xây schematic và điều phối bầy đàn.

Yêu cầu **Node.js >= 22.5** (khuyến nghị Node 24 LTS, dùng built-in `node:sqlite`).

---

## Cấu hình & API Key

Chỉ cần **duy nhất 1 key tùy chọn** cho Jev (không còn dùng CrowLLM, OpenRouter, DeepSeek, Gemini, OpenAI, ChatFree hay Ollama bên trong bot):

- Đặt `TYPESAFE_API_KEY` trong `.env` (xem [.env.example](.env.example)) hoặc `~/.dsh/.credentials.yaml`.
- Nếu chưa đặt `TYPESAFE_API_KEY`, bot vẫn hoạt động bình thường với Antigravity MCP + phản xạ chiến đấu cục bộ.

---

## Cách chạy

### Chạy trực tiếp (Windows / Linux / macOS)

1. Mở sẵn **Antigravity Desktop** (đã cài sẵn plugin **Minecraft Bot Companion** / `minecraft-bot-plugin` với sidecar **Minecraft Bot Bridge** tự chạy nền).
2. Copy `config.example.json` thành `config.json` (mặc định bật `"version": "auto"` và `"autoDiscoverLan": true`).
3. (Tuỳ chọn) Copy `.env.example` thành `.env` và điền `TYPESAFE_API_KEY`.
4. Khởi động bot trước hoặc sau khi mở game đều được:
   - Windows: chạy `run.bat` (hỗ trợ tự dò cổng LAN hoặc gõ domain `*.e4mc.link` thẳng vào CMD)
   - Linux / macOS: chạy `./run.sh` (hoặc `sh run.sh`)
   - Chạy thủ công / kết nối `e4mc`: `node src/index.js --port <cổng>` hoặc `node src/index.js --e4mc <domain.e4mc.link> [--auth microsoft]` / kiểm tra hệ thống: `node src/index.js --doctor`
5. Vào thế giới Minecraft bất kỳ (`1.8.8` → `1.21.11+`, Vanilla / OptiFine / Sodium / **Fabric** có đồng bộ **Fabric Registry Sync**) → Esc → **Mở cho mạng LAN / Open to LAN** (hoặc gửi domain `e4mc`) — bot tự bắt kết nối, tự nhận diện phiên bản, tách SQLite memory theo từng thế giới (`data/worlds/`) và tự đánh thức Antigravity khi bạn chat.

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
3. **14 công cụ MCP:**
   - Quan sát & nhận lệnh: `mc_get_state`, `mc_get_nearby`, `mc_get_inbox`, `mc_wait_event`
   - Lập kế hoạch & thực thi: `mc_plan_execute`, `mc_run_macro`, `mc_command`, `mc_smelt`, `mc_scratchpad`
   - Tương tác, tự sửa & quản trị: `mc_say`, `mc_inventory`, `mc_control`, `mc_connect`, `mc_open_dev_tab` (`open` / `complete`)

---

## Lệnh nhanh trực tiếp trong game (Tier 0 — không tốn LLM)

- **Khẩn cấp / Di chuyển:** `!stop` (`đứng đây`), `!come` (`lại đây`), `!home` (`về nhà`), `!follow` (`theo tôi`, `tt`)
- **Tọa độ & điểm đánh dấu:** `đi tới 100 64 -50`, `lưu điểm mỏ`, `đi tới mỏ`, `danh sách điểm`
- **Nhà & đồ:** `đây là nhà`, `đây là rương`, `cất đồ`, `xem rương`, `lấy từ rương <sl> <đồ>`, `ngủ`, `nhặt đồ chết`
- **Thu thập, chế tạo & nông trại:** `lấy 16 gỗ`, `chế tạo 1 cuốc sắt`, `nung 8 sắt`, `đào hầm 16`, `làm ruộng`, `farm enderman [sl]`, `bật tự farm` / `tắt tự farm`, `đưa tôi 10 bánh mì` (khi nhắn lượng ước lượng như `chặt ít gỗ` / `chặt in ít gỗ` bot sẽ hỏi lại số lượng, chặt hết cả cây và giao đủ `>= số lượng`)
- **Trang bị & xây dựng:** `trang bị`, `trạng thái`, `ăn`, `dọn túi`, `tắt đánh` / `bật đánh`, `dọn mặt bằng <file>`, `xây <file> [0|90|180|270]` → `xác nhận` / `hủy`

Mọi câu chat tự nhiên, chào hỏi hoặc yêu cầu phức tạp sẽ đi thẳng vào `mc_get_inbox` (gắn nhãn `OWNER_TRUSTED` / `UNTRUSTED_PUBLIC_PLAYER`) để Antigravity xử lý và phân công.
