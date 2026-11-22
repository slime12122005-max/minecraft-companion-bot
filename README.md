# Bot đồng hành Minecraft (Java 1.21.1)

Bot kết nối vào thế giới LAN/Server Minecraft Java 1.21.1, đi cùng chủ nhân, chiến đấu thông minh, thu thập tài nguyên, phân loại rương, xây schematic/blueprint và hỗ trợ sinh tồn. Yêu cầu **Node.js >= 22** (dùng built-in `node:sqlite`, không cần native C++ addons).

## Kiến trúc tổng quan

- **Hệ thống mô-đun (`src/`)**: Tách gọn theo domain (`session/`, `survival/`, `combat/`, `building/`, `dashboard/`, `swarm/`), có `BotStateMachine`, `ConnectionManager` (exponential backoff) và `HealthWatchdog`.
- **2 não AI + 2-tier Router**:
  - **Tier 1 (`src/commands.js`)**: Exact + Fuzzy Levenshtein matcher (>= 75% similarity) phản hồi tức thì các lệnh quen thuộc không tốn token.
  - **System 1 (`llm`)**: `TYPESAFE_API_KEY` dùng cho **Jev (`jev-latest`)** đánh giá xác suất chiến thuật Combat (`melee` / `shield` / `bow` / `retreat`).
  - **System 2 (`chat`)**: Mặc định **CrowLLM** (`particle-1:free`, fallback `grok-4.7-fast:free`) với `CROWLLM_API_KEY` (hoặc OpenRouter / DeepSeek / OpenAI / Gemini / Ollama) kèm Zod structured DAG planner (`planGoal()`) và rate limiter.
- **Bộ nhớ dài hạn SQLite (`src/memory.js`)**: Lưu KV store, POI tọa độ (`spatial_pois`), chỉ mục rương (`chest_index`), hồ sơ người chơi (`player_profiles`) và lịch sử sự kiện (`episodic_events`) vào `data/bot_memory.db` (tự migrate từ `data/memory.json`).
- **Tác chiến, Kho chứa & Chế tạo thông minh**:
  - `src/tasks.js`: Preemptive Priority Task Scheduler (`SURVIVAL` > `COMBAT` > `PLAYER` > `BACKGROUND`) có pause/resume snapshot.
  - `src/combat/` & `src/equipment.js`: Tính Threat Score $T = \sum D_i M_i / (H(1+A))$, đổi vũ khí theo tình huống (rìu phá khiên, cung tầm xa, kiếm đánh lan), cảnh báo độ bền `<10%`.
  - `src/home.js` & `src/crafting.js`: Rương phân loại theo danh mục, tự về cất đồ khi túi >= 80%, công thức đệ quy tự nung quặng qua lò (`SMELT_OUTPUT_TO_INPUT`).
  - `src/building/`: Hỗ trợ cả `.schem` và `.json` Blueprint, tính vật liệu thiếu (`calculateMaterialShortage`) và giàn giáo đất tạm (`autoScaffold`).
- **Realtime SSE Dashboard & Swarm (`src/dashboard/`, `src/swarm/coordinator.js`)**:
  - Live telemetry qua `/api/stream` (SSE), health check `/api/health`, radar 2D không gian POI, lưới trang bị & túi đồ tương tác (Đeo/Vứt), và nút khẩn cấp (`Tạm dừng AI`, `Về nhà khẩn`, `Ngắt an toàn`).
  - `SwarmCoordinator`: Điều phối nhiều bot theo vai trò (`miner`, `carrier`, `guard`, `builder`, `general`), vận chuyển tiếp tế Miner → Carrier và chia sẻ POI/cảnh báo qua SQLite.

## Cách chạy

### Chạy trực tiếp (Windows / Linux / macOS)

1. Vào thế giới Minecraft → Esc → **Mở cho mạng LAN / Open to LAN** → ghi nhớ số cổng.
2. Copy `config.example.json` thành `config.json`, sửa `host`, `port`, `username`, `owner`.
3. (Tuỳ chọn) Copy `.env.example` thành `.env` (hoặc dùng `~/.dsh/.credentials.yaml`).
4. Kiểm tra và chạy:
   - Windows: chạy `run.bat` hoặc `node src/index.js --doctor` → `node src/index.js`.
   - Linux / macOS: chạy `./run.sh` (hoặc `sh run.sh`).

### Chạy bằng Docker Compose

```sh
cp config.example.json config.json
docker compose up -d --build
```

Dashboard mặc định mở tại `http://127.0.0.1:3000`.

## Điều khiển trực tiếp bằng Antigravity (MCP Server)

Bot có sẵn Stdio MCP Server không phụ thuộc LLM ngoài tại `src/mcp/server.js` (chạy qua `npm run mcp`), giúp Antigravity đọc trạng thái, quét môi trường xung quanh, nhận chat trong game và ra lệnh trực tiếp cho bot qua API cục bộ:

1. Trong `config.json`, đặt `"dashboard": { "enabled": true, "host": "127.0.0.1", "port": 3000 }` và tắt `"chat": { "enabled": false }` nếu không dùng LLM free bên ngoài.
2. Đăng ký server `minecraft-bot` trong `~/.gemini/config/mcp_config.json` trỏ tới `node src/mcp/server.js` với `BOT_API_URL=http://127.0.0.1:3000` (nếu đặt `DASHBOARD_TOKEN`, truyền thêm `BOT_API_TOKEN`).
3. Các tool MCP được cung cấp: `mc_get_state`, `mc_get_nearby`, `mc_get_inbox`, `mc_command`, `mc_say`, `mc_control`, `mc_inventory`, `mc_connect`, `mc_wait_event`.
4. Chạy bot bình thường (`run.bat` hoặc `node src/index.js --no-prompt`), rồi yêu cầu Antigravity điều khiển hoặc theo dõi chat trong game.

## Lệnh chat (hỗ trợ cả tiếng Việt có dấu / không dấu, tiếng Anh và `/msg`)

- **Di chuyển & theo chủ**: `theo tôi` (`tt`, `follow me`), `đứng đây` (`stay`, `hủy`), `lại đây` (`come`)
- **Tọa độ & điểm đánh dấu**: `đi tới 100 64 -50`, `lưu điểm mỏ`, `đi tới mỏ`, `danh sách điểm`
- **Nhà & đồ**: `đây là nhà` (`set home`), `đây là rương` (`set chest`), `về nhà` (`go home`), `cất đồ` (`store`), `xem rương`, `lấy từ rương <sl> <đồ>`, `ngủ` (`sleep`), `nhặt đồ chết` (`recover`)
- **Thu thập, chế tạo & nông trại**: `lấy 16 gỗ` (`chặt cây`, `đào đá`), `chế tạo 1 cuốc sắt`, `nung 8 sắt`, `đào hầm 16`, `làm ruộng`, `đưa tôi 10 bánh mì`
- **Trang bị, sinh tồn & điều khiển**: `trang bị` (`gear`), `trạng thái` (`status`), `ăn` (`eat`), `dọn túi` (`vứt đồ dởm`), `tắt đánh` / `bật đánh`, `bật web` / `tắt web`, `giúp` (`help`)
- **Xây dựng**: `tải mẫu <https-url> [tên_file]`, `dọn mặt bằng <file> [0|90|180|270]`, `xây house.schem [0|90|180|270]` → `xác nhận` / `hủy`

## Bản quyền mẫu schematic

Các nguồn đề cập trong dự án chỉ dùng để tham khảo hoặc tải mẫu có giấy phép rõ ràng. Trước khi bot tải hoặc xây file schematic, hãy xác nhận mẫu miễn phí và tôn trọng ghi công tác giả.
