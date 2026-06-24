import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

const config = {
  // 1. Cấu hình Redis (Tối ưu số connections - tránh vượt giới hạn 30 của free tier)
  redis: {
    host: process.env.REDIS_HOST?.trim() || "localhost",
    port: parseInt(process.env.REDIS_PORT?.trim()) || 6379,
    password: process.env.REDIS_PASSWORD?.trim(),

    // BẮT BUỘC cho BullMQ
    maxRetriesPerRequest: null,

    // Thời gian chờ kết nối tối đa
    connectTimeout: 10000,

    // Tăng thời gian giữa các lần retry để tránh tạo quá nhiều connections
    retryStrategy: function (times) {
      if (times > 10) return null; // Dừng sau 10 lần thất bại
      const delay = Math.min(times * 200, 5000); // Tăng lên 200ms/lần, tối đa 5 giây
      return delay;
    },

    // (Tùy chọn) Nếu dùng Redis Cloud có SSL (địa chỉ rediss://), bỏ comment dòng dưới:
    // tls: { rejectUnauthorized: false },
  },

  // 2. Cấu hình Blockchain (Polygon Amoy)
  blockchain: {
    rpcUrl: process.env.RPC_URL,
    privateKey: process.env.PRIVATE_KEY,
    contractAddress: process.env.CONTRACT_ADDRESS,
    usdtAddress: process.env.USDT_ADDRESS,
    usdtDecimals: parseInt(process.env.USDT_DECIMALS) || 6,
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

  // 4c. Chiến lược GAS FUND (Quỹ Gas - Cách ly & Thực thi)
  // Worker kiểm tra số dư POL của địa chỉ, nếu < 0.01 POL thì transfer gas
  gasFundStrategy: {
    queueName: process.env.GAS_FUND_QUEUE_NAME || "gas-fund-queue",
    minBalance: ethers.parseEther(process.env.GAS_FUND_MIN_BALANCE || "0.02"), // 0.01 POL (tối thiểu)
    gasTransferAmount: ethers.parseEther(
      process.env.GAS_FUND_TRANSFER_AMOUNT || "0.05",
    ), // 0.05 POL (bơm)
    concurrency: parseInt(process.env.GAS_FUND_CONCURRENCY) || 1, // Giảm từ 5 → 1 để tiết kiệm connections
    webhookPath: process.env.GAS_FUND_WEBHOOK_PATH || "/webhooks/gas-callback",
  },

  // 5. Cấu hình IPFS (Pinata)
  ipfs: {
    pinataApiKey: process.env.PINATA_API_KEY,
    pinataSecretKey: process.env.PINATA_SECRET_KEY,
  },
  // 6. Cấu hình Backend API
  backend: {
    url: process.env.BACKEND_URL || "http://localhost:3001/api",
    beApiUrl: process.env.BE_API_URL,
    internalWebhookSecret: process.env.INTERNAL_WEBHOOK_SECRET,
  },

  // 7. Cấu hình Relayer Buy Worker
  relayerStrategy: {
    queueName: "relayer-buy-queue",
    dlqQueueName: process.env.RELAYER_DLQ_QUEUE_NAME || "relayer-buy-dlq",
    attempts: parseInt(process.env.RELAYER_ATTEMPTS) || 3, // Giảm từ 5 → 3
    backoffDelay: parseInt(process.env.RELAYER_BACKOFF_DELAY) || 5000,
    concurrency: parseInt(process.env.RELAYER_CONCURRENCY) || 1,
  },

  relayerApi: {
    orderLookupPath:
      process.env.RELAYER_ORDER_LOOKUP_PATH || "/api/v1/internal/orders/",
    resultPath: process.env.RELAYER_RESULT_PATH || "/webhooks/relayer-callback",
  },

  // Alias để giữ tương thích với các file worker cũ đang dùng config.webhook
  webhook: {
    beApiUrl: process.env.BE_API_URL,
    internalWebhookSecret: process.env.INTERNAL_WEBHOOK_SECRET,
  },
};

// --- VALIDATE ---
if (
  !config.blockchain.privateKey ||
  !config.blockchain.contractAddress ||
  !config.blockchain.rpcUrl
) {
  console.error(
    "❌ LỖI CRITICAL: Thiếu biến môi trường Blockchain (RPC_URL, PRIVATE_KEY, hoặc CONTRACT_ADDRESS) trong file .env",
  );
  process.exit(1);
}

export default config;
