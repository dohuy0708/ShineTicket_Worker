import { Worker } from "bullmq";
import config from "./config.js";
import axios from "axios";
import express from "express";
import {
  mintBatchOnChain,
  executeBatchCheckInOnChain,
  getBatchTicketStatusOnChain,
  verifyConnection,
} from "./blockchain.js";

console.log("🚀 Đang khởi động ShineTicket Worker...");

// ==========================================
// PHẦN 1: QUẢN LÝ BUFFER (HỒ CHỨA)
// ==========================================

// --- Buffer cho MINT ---
let mintBuffer = [];
let mintTimer = null;

// Counters cho MINT
let totalMintTicketsQueued = 0; // Tổng số vé đã vào buffer
let totalMintTicketsMinted = 0; // Tổng số vé đã mint thành công

// --- Buffer cho CHECK-IN ---
let checkInBuffer = [];
let checkInTimer = null;

// Counters cho CHECK-IN
let totalCheckInTicketsQueued = 0; // Tổng vé vào hàng chờ check-in
let totalCheckInTicketsSynced = 0; // Tổng vé đã sync lên chain

// --- Không dùng buffer cho EXPIRE, vì BE sẽ gửi sẵn list token ---

// ==========================================
// [UPDATE 2] HÀM GỌI WEBHOOK VỀ BACKEND
// ==========================================
// orderMappings: [{ orderId: string, tokenIds: string[] }, ...]
async function syncMintStatusToBackend(orderIds, txHash, orderMappings) {
  console.log(
    "🧪 [DEBUG] syncMintStatusToBackend được gọi với:",
    orderIds,
    txHash,
    orderMappings
  );
  try {
    if (!orderIds || orderIds.length === 0) return;

    // Lọc bỏ các giá trị null/undefined nếu có
    const validOrderIds = orderIds.filter((id) => id);

    if (validOrderIds.length === 0) return;

    // Lọc mapping theo các orderId hợp lệ
    const validMappings = (orderMappings || []).filter(
      (m) => m && m.orderId && validOrderIds.includes(m.orderId)
    );

    const payload = {
      txHash: txHash,
      orderIds: validOrderIds,
      mapping: validMappings,
      timestamp: new Date().toISOString(),
    };

    console.log(
      `📞 Đang gọi Webhook Mint: ${
        config.backend.url
      }/webhooks/mint-success với payload: ${JSON.stringify(payload)}`
    );

    // Gọi API của Repo 1 (Hoàng)

    const response = await axios.post(
      `${config.backend.url}/webhooks/mint-success`,
      payload
    );

    console.log(`✅ Webhook thành công: ${response.data.message || "OK"}`);
  } catch (error) {
    // Chỉ log lỗi, không throw để tránh crash Worker
    // Trong thực tế: Nên lưu vào Queue "Retry" để gọi lại sau
    console.error(`⚠️ Lỗi gọi Webhook Backend: ${error.message}`);
    if (error.response) {
      console.error("Response Data:", error.response.data);
    }
  }
}
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
  // [UPDATE] Lấy danh sách Order ID để log
  const orderIds = currentBatch.map((req) => req.orderId);

  const batchTicketCount = quantities.reduce(
    (sum, q) => sum + Number(q || 0),
    0
  );
  console.log(
    `🎟️ [MINT] Batch hiện tại: ${batchTicketCount} vé. Tổng vé đang trong buffer (chưa gửi lên chain): ${totalMintTicketsQueued}`
  );

  try {
    // Gọi Blockchain
    const result = await mintBatchOnChain(recipients, quantities);

    const mintedTokenIds = result.tokenIds || [];

    if (mintedTokenIds.length !== batchTicketCount) {
      console.warn(
        `⚠️ [MINT] Số tokenId mint được (${mintedTokenIds.length}) không khớp số vé trong batch (${batchTicketCount}).`
      );
    }

    // Build mapping: mỗi orderId ánh xạ tới danh sách tokenIds của đơn đó
    let cursor = 0;
    const orderMappings = currentBatch.map((req) => {
      const count = Number(req.quantity || 0);
      const idsForOrder = mintedTokenIds.slice(cursor, cursor + count);
      cursor += count;
      return {
        orderId: req.orderId,
        tokenIds: idsForOrder,
      };
    });

    console.log(`✅ Batch Mint Thành công! Tx: ${result.txHash}`);
    console.log(`📦 Order IDs: ${orderIds.join(", ")}`);
    console.log(
      `🧾 [MINT] Mapping orderId → tokenIds: ${JSON.stringify(orderMappings)}`
    );

    totalMintTicketsMinted += batchTicketCount;
    totalMintTicketsQueued -= batchTicketCount;

    console.log(
      `📊 [MINT] Tổng đã mint: ${totalMintTicketsMinted} vé, còn trong buffer: ${totalMintTicketsQueued} vé`
    );

    // 2. [UPDATE 3] Gọi Webhook đồng bộ về Backend
    // Chạy bất đồng bộ (không await) hoặc await tùy logic bạn muốn chặn hay không
    // Ở đây mình await để đảm bảo log đẹp
    await syncMintStatusToBackend(orderIds, result.txHash, orderMappings);
    // Báo thành công cho BullMQ
    currentBatch.forEach((req) => {
      req.resolve({
        status: "success",
        txHash: result.txHash,
        batchSize: currentBatch.length,
        orderIds: orderIds, // Trả về OrderIDs để sau này dùng
        mapping: orderMappings,
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

  console.log(
    `🎟️ [CHECK-IN] Batch hiện tại: ${tokenIds.length} vé. Tổng vé đang trong buffer (check-in): ${totalCheckInTicketsQueued}`
  );

  try {
    // Gọi Blockchain
    console.log(
      `🔗 [CHECK-IN] Gửi batch lên Blockchain với ${
        tokenIds.length
      } vé: ${tokenIds.join(", ")}`
    );
    const result = await executeBatchCheckInOnChain(tokenIds);

    console.log(
      `✅ [CHECK-IN] Blockchain trả kết quả thành công, txHash: ${result.txHash}`
    );

    totalCheckInTicketsSynced += tokenIds.length;
    totalCheckInTicketsQueued -= tokenIds.length;

    console.log(
      `📊 [CHECK-IN] Tổng đã sync: ${totalCheckInTicketsSynced} vé, còn trong buffer: ${totalCheckInTicketsQueued} vé`
    );

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
 * [FIX] Chỉ giữ lại 1 hàm duy nhất có tham số orderId
 */
function addToMintBuffer(recipient, quantity, orderId) {
  return new Promise((resolve, reject) => {
    // [UPDATE] Lưu orderId vào object
    mintBuffer.push({ recipient, quantity, orderId, resolve, reject });

    const q = Number(quantity || 0);
    totalMintTicketsQueued += q;

    console.log(
      `📥 [MINT] Buffer: ${mintBuffer.length}/${config.mintStrategy.batchSize} job, tổng vé đang chờ mint: ${totalMintTicketsQueued} (Order: ${orderId})`
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

    totalCheckInTicketsQueued += 1;

    console.log(
      `📥 [CHECK-IN] Buffer: ${checkInBuffer.length}/${config.checkInStrategy.batchSize} job, tổng vé đang chờ sync: ${totalCheckInTicketsQueued}`
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
      // [FIX] Khai báo biến data để không bị lỗi undefined
      const data = job.data;

      // Ưu tiên tìm biến số ít (recipient) và có orderId (Format chuẩn từ Repo 1)
      if (data.recipient && data.quantity) {
        await addToMintBuffer(data.recipient, data.quantity, data.orderId);
      }
      // Fallback: Hỗ trợ nếu backend gửi mảng (dự phòng)
      else if (Array.isArray(data.recipients)) {
        // Logic cũ nếu cần, hoặc bỏ qua
        console.warn(
          "⚠️ Nhận được job dạng Array (chưa hỗ trợ OrderID đầy đủ)"
        );
        // Giả sử mảng recipients không có orderId tương ứng từng cái
        for (let i = 0; i < data.recipients.length; i++) {
          await addToMintBuffer(data.recipients[i], data.quantities[i], null);
        }
      } else {
        console.error("❌ Job data không hợp lệ:", data);
      }
      return { processed: true };
    },
    {
      connection: config.redis,
      concurrency: 50,
      skipConfigValidation: true,
    }
  );

  // 3. Worker CHECK-IN
  const checkInWorker = new Worker(
    config.checkInStrategy.queueName,
    async (job) => {
      const { ticketId } = job.data;

      console.log(
        `📨 [CHECK-IN] Nhận job từ Backend: jobId=${job.id}, ticketId=${ticketId}`
      );
      await addToCheckInBuffer(ticketId);
      return { processed: true };
    },
    {
      connection: config.redis,
      concurrency: 50,
      skipConfigValidation: true,
    }
  );

  // 4. Worker AUTO CHECK-IN (dùng giống batch check-in)
  // BE sẽ push job với dạng: { ticketIds: [1,2,3,...], showId?: string }
  // Điều kiện "đã qua ngày diễn" (nếu cần) sẽ do BE kiểm tra trước khi đẩy job.
  const expireWorker = new Worker(
    config.expireStrategy.queueName,
    async (job) => {
      const { ticketIds } = job.data || {};

      if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
        console.warn(
          `⚠️ [AUTO-CHECKIN] Job ${job.id} không có danh sách ticketIds hợp lệ.`,
          job.data
        );
        return { processed: false };
      }

      console.log(
        `📨 [AUTO-CHECKIN] Nhận job: jobId=${job.id}, tickets=${ticketIds.join(
          ","
        )}`
      );

      // 1. Đọc trạng thái vé trên Blockchain (đã check-in hay chưa)
      const statuses = await getBatchTicketStatusOnChain(ticketIds);

      if (!statuses || statuses.length !== ticketIds.length) {
        console.warn(
          `⚠️ [AUTO-CHECKIN] Số lượng trạng thái trả về không khớp danh sách tokenIds.`
        );
      }

      // 2. Lọc ra các vé CHƯA check-in (false) để thực hiện batch check-in on-chain
      const needCheckInTicketIds = [];
      for (let i = 0; i < ticketIds.length; i++) {
        const used = statuses[i]; // true = đã check-in, false = chưa dùng
        if (!used) {
          needCheckInTicketIds.push(ticketIds[i]);
        }
      }

      if (needCheckInTicketIds.length === 0) {
        console.log(
          `✅ [AUTO-CHECKIN] Tất cả vé trong job ${job.id} đều đã check-in trên chain, không cần thực hiện batch check-in.`
        );
        return { processed: true, checkedInCount: 0 };
      }

      console.log(
        `✅ [AUTO-CHECKIN] Có ${
          needCheckInTicketIds.length
        } vé chưa check-in, sẽ thực hiện batch check-in on-chain: ${needCheckInTicketIds.join(
          ","
        )}`
      );

      // 3. Thực hiện batch check-in on-chain cho các vé chưa dùng
      let txHash = null;
      try {
        const result = await executeBatchCheckInOnChain(needCheckInTicketIds);
        txHash = result.txHash;
        console.log(
          `🏁 [AUTO-CHECKIN] Batch check-in thành công, txHash=${txHash}`
        );
      } catch (error) {
        console.error(
          `❌ [AUTO-CHECKIN] Lỗi khi thực hiện batch check-in on-chain: ${error.message}`
        );
        // Cho phép BullMQ retry theo config mặc định
        throw error;
      }

      // 4. Gọi webhook về Backend để update status = checkin trong DB
      try {
        const payload = {
          ticketIds: needCheckInTicketIds,
          // Có thể truyền thêm showId nếu BE gửi trong job.data
          showId: job.data.showId,
          // Đánh dấu thời điểm worker xử lý
          processedAt: new Date().toISOString(),
          txHash,
        };

        console.log(
          `📞 [AUTO-CHECKIN] Gọi webhook: ${
            config.backend.url
          }/webhooks/tickets-auto-checkin với payload: ${JSON.stringify(
            payload
          )}`
        );

        const resp = await axios.post(
          `${config.backend.url}/webhooks/tickets-auto-checkin`,
          payload
        );

        console.log(
          `✅ [AUTO-CHECKIN] BE xác nhận cập nhật status checkin thành công: ${
            resp.data?.message || "OK"
          }`
        );
      } catch (error) {
        console.error(
          `❌ [AUTO-CHECKIN] Lỗi khi gọi webhook cập nhật status checkin: ${error.message}`
        );
        if (error.response) {
          console.error("Response Data:", error.response.data);
        }
        // Cho phép BullMQ retry theo config mặc định
        throw error;
      }

      return {
        processed: true,
        checkedInCount: needCheckInTicketIds.length,
        txHash,
      };
    },
    {
      connection: config.redis,
      concurrency: 20,
      skipConfigValidation: true,
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

  expireWorker.on("ready", () =>
    console.log(`✅ Expire Worker Ready: ${config.expireStrategy.queueName}`)
  );
  expireWorker.on("failed", (job, err) =>
    console.error(`❌ Expire Job ${job.id} Failed: ${err.message}`)
  );
}

// Handle Graceful Shutdown
process.on("SIGINT", async () => {
  console.log("Đang tắt Worker...");
  process.exit(0);
});

// CHẠY
startWorkers();

// --- HEALTH CHECK SERVER (CHO RENDER / MONITOR) ---
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Worker is running!");
});

app.listen(port, () => {
  console.log(`Health check server listening on port ${port}`);
});
