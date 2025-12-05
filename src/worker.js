import { Worker } from "bullmq";
import config from "./config.js";
import {
  mintBatchOnChain,
  executeBatchCheckInOnChain,
  verifyConnection,
} from "./blockchain.js";

console.log("🚀 Đang khởi động ShineTicket Worker...");

// ==========================================
// PHẦN 1: QUẢN LÝ BUFFER (HỒ CHỨA)
// ==========================================

// --- Buffer cho MINT ---
let mintBuffer = [];
let mintTimer = null;

// --- Buffer cho CHECK-IN ---
let checkInBuffer = [];
let checkInTimer = null;

// ==========================================
// PHẦN 2: LOGIC XẢ BATCH (FLUSH)
// ==========================================

/**
 * Xử lý gom đơn MINT
 */
async function flushMintBatch() {
  if (mintBuffer.length === 0) return;

  // 1. Snapshot và Reset Buffer
  const currentBatch = [...mintBuffer];
  mintBuffer = [];
  if (mintTimer) {
    clearTimeout(mintTimer);
    mintTimer = null;
  }

  console.log(`⚡ [MINT] Kích hoạt Batch: ${currentBatch.length} đơn...`);

  const recipients = currentBatch.map((req) => req.recipient);
  const quantities = currentBatch.map((req) => req.quantity);

  try {
    // Gọi Blockchain
    const result = await mintBatchOnChain(recipients, quantities);

    // Báo thành công cho BullMQ
    currentBatch.forEach((req) => {
      req.resolve({
        status: "success",
        txHash: result.txHash,
        batchSize: currentBatch.length,
      });
    });
  } catch (error) {
    console.error("🔥 [MINT] Lỗi Batch:", error.message);
    // Báo lỗi để BullMQ retry
    currentBatch.forEach((req) => {
      req.reject(new Error(`Mint Batch Failed: ${error.message}`));
    });
  }
}

/**
 * Xử lý gom đơn CHECK-IN
 */
async function flushCheckInBatch() {
  if (checkInBuffer.length === 0) return;

  // 1. Snapshot và Reset Buffer
  const currentBatch = [...checkInBuffer];
  checkInBuffer = [];
  if (checkInTimer) {
    clearTimeout(checkInTimer);
    checkInTimer = null;
  }

  console.log(`⚡ [CHECK-IN] Kích hoạt Batch: ${currentBatch.length} vé...`);

  const tokenIds = currentBatch.map((req) => req.ticketId);

  try {
    // Gọi Blockchain
    const result = await executeBatchCheckInOnChain(tokenIds);

    // Báo thành công
    currentBatch.forEach((req) => {
      req.resolve({
        status: "synced",
        txHash: result.txHash,
      });
    });
  } catch (error) {
    console.error("🔥 [CHECK-IN] Lỗi Batch:", error.message);
    // Báo lỗi
    currentBatch.forEach((req) => {
      req.reject(new Error(`Check-in Batch Failed: ${error.message}`));
    });
  }
}

// ==========================================
// PHẦN 3: LOGIC THÊM VÀO BUFFER (ADD TO BATCH)
// ==========================================

/**
 * Thêm vào hàng chờ MINT
 */
function addToMintBuffer(recipient, quantity) {
  return new Promise((resolve, reject) => {
    mintBuffer.push({ recipient, quantity, resolve, reject });

    console.log(
      `📥 [MINT] Buffer: ${mintBuffer.length}/${config.mintStrategy.batchSize}`
    );

    if (mintBuffer.length >= config.mintStrategy.batchSize) {
      flushMintBatch();
    } else if (!mintTimer) {
      mintTimer = setTimeout(flushMintBatch, config.mintStrategy.batchTimeout);
    }
  });
}

/**
 * Thêm vào hàng chờ CHECK-IN
 */
function addToCheckInBuffer(ticketId) {
  return new Promise((resolve, reject) => {
    checkInBuffer.push({ ticketId, resolve, reject });

    console.log(
      `📥 [CHECK-IN] Buffer: ${checkInBuffer.length}/${config.checkInStrategy.batchSize}`
    );

    if (checkInBuffer.length >= config.checkInStrategy.batchSize) {
      flushCheckInBatch();
    } else if (!checkInTimer) {
      checkInTimer = setTimeout(
        flushCheckInBatch,
        config.checkInStrategy.batchTimeout
      );
    }
  });
}

// ==========================================
// PHẦN 4: KHỞI TẠO WORKERS
// ==========================================

async function startWorkers() {
  // 1. Kiểm tra kết nối Blockchain
  const isConnected = await verifyConnection();
  if (!isConnected) {
    console.error("❌ Kết nối Blockchain thất bại. Dừng Worker.");
    process.exit(1);
  }

  // 2. Worker MINT
  const mintWorker = new Worker(
    config.mintStrategy.queueName,
    async (job) => {
      const { recipients, quantities } = job.data;

      // Hỗ trợ cả 2 định dạng dữ liệu: mảng hoặc đơn lẻ
      // Nếu Backend gửi mảng, ta tách ra push từng cái
      if (Array.isArray(recipients)) {
        // Logic phức tạp hơn nếu nhận mảng, tạm thời giả định Backend gửi đơn lẻ
        // Hoặc job.data là { recipient: "0x...", quantity: 1 }
        // Ở đây tôi viết hỗ trợ job đơn lẻ chuẩn Microservices
        await addToMintBuffer(job.data.recipient, job.data.quantity);
      } else {
        // Fallback nếu job data khác
        // Điều chỉnh tùy theo cách test-producer gửi
        await addToMintBuffer(recipients, quantities);
      }
      return { processed: true };
    },
    {
      connection: config.redis,
      concurrency: 50, // QUAN TRỌNG: Để tránh Deadlock khi đợi Batch
      skipConfigValidation: true, //
    }
  );

  // 3. Worker CHECK-IN
  const checkInWorker = new Worker(
    config.checkInStrategy.queueName,
    async (job) => {
      const { ticketId } = job.data;
      await addToCheckInBuffer(ticketId);
      return { processed: true };
    },
    {
      connection: config.redis,
      concurrency: 50, // QUAN TRỌNG
      skipConfigValidation: true, //
    }
  );

  // Log trạng thái
  mintWorker.on("ready", () =>
    console.log(`✅ Mint Worker Ready: ${config.mintStrategy.queueName}`)
  );
  mintWorker.on("failed", (job, err) =>
    console.error(`❌ Mint Job ${job.id} Failed: ${err.message}`)
  );

  checkInWorker.on("ready", () =>
    console.log(`✅ Check-in Worker Ready: ${config.checkInStrategy.queueName}`)
  );
  checkInWorker.on("failed", (job, err) =>
    console.error(`❌ Check-in Job ${job.id} Failed: ${err.message}`)
  );
}

// Handle Graceful Shutdown
process.on("SIGINT", async () => {
  console.log("Đang tắt Worker...");
  process.exit(0);
});

// CHẠY
startWorkers();
