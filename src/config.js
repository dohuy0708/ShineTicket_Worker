import dotenv from "dotenv";
dotenv.config();

const config = {
  // 1. Cấu hình Redis
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD, // <--- THÊM DÒNG NÀY
  },

  // 2. Cấu hình Blockchain (Polygon Amoy)
  blockchain: {
    rpcUrl: process.env.RPC_URL,
    privateKey: process.env.PRIVATE_KEY,
    contractAddress: process.env.CONTRACT_ADDRESS,
  },

  // 3. Chiến lược MINT (Ưu tiên tốc độ UX)
  // Worker sẽ gom vé để mint, nhưng không đợi quá lâu (mặc định 10s)
  mintStrategy: {
    batchSize: parseInt(process.env.MINT_BATCH_SIZE) || 10, // Gom 10 vé
    batchTimeout: parseInt(process.env.MINT_BATCH_TIMEOUT) || 10000, // Hoặc đợi 10s
    queueName: "mint-queue",
  },

  // 4. Chiến lược CHECK-IN (Ưu tiên tiết kiệm Gas)
  // Worker gom các vé đã soát ở cổng để đồng bộ lên Chain 1 thể
  checkInStrategy: {
    batchSize: parseInt(process.env.CHECKIN_BATCH_SIZE) || 50, // Gom 50 vé
    batchTimeout: parseInt(process.env.CHECKIN_BATCH_TIMEOUT) || 60000, // Hoặc đợi 60s
    queueName: "checkin-queue",
  },

  // 5. Cấu hình IPFS (Pinata)
  ipfs: {
    pinataApiKey: process.env.PINATA_API_KEY,
    pinataSecretKey: process.env.PINATA_SECRET_KEY,
  },
};

// --- VALIDATE ---
// Kiểm tra các biến bắt buộc, nếu thiếu thì crash app ngay lập tức để dễ debug
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
