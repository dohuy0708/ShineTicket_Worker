import dotenv from "dotenv";
dotenv.config();

const config = {
  // 1. Cấu hình Redis (Đã tối ưu để tránh lỗi ECONNRESET)
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,

    // --- BẮT ĐẦU PHẦN SỬA ĐỔI ---

    // 1. Ping Redis mỗi 10 giây để giữ kết nối luôn sống (Fix lỗi ECONNRESET)
    keepAlive: 10000,

    // 2. Bắt buộc phải có dòng này khi dùng BullMQ (theo document)
    // Nếu không có, BullMQ sẽ báo lỗi khi Redis chập chờn
    maxRetriesPerRequest: null,

    // 3. Thời gian chờ kết nối tối đa (10 giây)
    connectTimeout: 10000,

    // 4. Chiến lược tự động kết nối lại khi bị rớt mạng
    retryStrategy: function (times) {
      // Thử lại sau: 50ms, 100ms, 150ms... tối đa chờ 2 giây
      const delay = Math.min(times * 50, 2000);
      return delay;
    },

    // (Tùy chọn) Nếu dùng Redis Cloud có SSL (địa chỉ rediss://), bỏ comment dòng dưới:
    // tls: { rejectUnauthorized: false },

    // --- KẾT THÚC PHẦN SỬA ĐỔI ---
  },

  // 2. Cấu hình Blockchain (Polygon Amoy)
  blockchain: {
    rpcUrl: process.env.RPC_URL,
    privateKey: process.env.PRIVATE_KEY,
    contractAddress: process.env.CONTRACT_ADDRESS,
  },

  // 3. Chiến lược MINT (Ưu tiên tốc độ UX)
  mintStrategy: {
    batchSize: parseInt(process.env.MINT_BATCH_SIZE) || 10,
    batchTimeout: parseInt(process.env.MINT_BATCH_TIMEOUT) || 10000,
    queueName: "mint-queue",
  },

  // 4. Chiến lược CHECK-IN (Ưu tiên tiết kiệm Gas)
  checkInStrategy: {
    batchSize: parseInt(process.env.CHECKIN_BATCH_SIZE) || 50,
    batchTimeout: parseInt(process.env.CHECKIN_BATCH_TIMEOUT) || 60000,
    queueName: "checkin-queue",
  },

  // 4b. Chiến lược EXPIRE (Backend gửi sẵn danh sách vé cần kiểm tra)
  // Không cần batch nội bộ, chỉ cần tên queue để BE push job
  expireStrategy: {
    queueName: "expire-queue",
  },

  // 5. Cấu hình IPFS (Pinata)
  ipfs: {
    pinataApiKey: process.env.PINATA_API_KEY,
    pinataSecretKey: process.env.PINATA_SECRET_KEY,
  },
  // 6. Cấu hình Backend API
  backend: {
    url: process.env.BACKEND_URL || "http://localhost:3001/api",
  },
};

// --- VALIDATE ---
if (
  !config.blockchain.privateKey ||
  !config.blockchain.contractAddress ||
  !config.blockchain.rpcUrl
) {
  console.error(
    "❌ LỖI CRITICAL: Thiếu biến môi trường Blockchain (RPC_URL, PRIVATE_KEY, hoặc CONTRACT_ADDRESS) trong file .env"
  );
  process.exit(1);
}

export default config;
