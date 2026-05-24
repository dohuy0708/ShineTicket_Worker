import { Queue, Worker } from "bullmq";
import config from "./config.js";
import axios from "axios";
import express from "express";
import { ethers } from "ethers";
import {
  initUSDTApproval,
  waitForTransaction,
  relayerBuyTicket,
  ticketInterface,
  executeBatchCheckInOnChain,
  getBatchTicketStatusOnChain,
  verifyConnection,
} from "./blockchain.js";
import { isRelayerFatalFailure, processRelayerBuyJob } from "./relayer.js";

console.log("🚀 Đang khởi động ShineTicket Worker...");

// ==========================================
// PHẦN 1: QUẢN LÝ BUFFER (HỒ CHỨA)
// ==========================================

// --- Buffer cho CHECK-IN ---
let checkInBuffer = [];
let checkInTimer = null;

// Counters cho CHECK-IN
let totalCheckInTicketsQueued = 0; // Tổng vé vào hàng chờ check-in
let totalCheckInTicketsSynced = 0; // Tổng vé đã sync lên chain

// --- Không dùng buffer cho EXPIRE, vì BE sẽ gửi sẵn list token ---

// ==========================================
// PHẦN 2: LOGIC XẢ BATCH (FLUSH) CHO CHECK-IN
// ==========================================
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
    `🎟️ [CHECK-IN] Batch hiện tại: ${tokenIds.length} vé. Tổng vé đang trong buffer (check-in): ${totalCheckInTicketsQueued}`,
  );

  try {
    // Gọi Blockchain
    console.log(
      `🔗 [CHECK-IN] Gửi batch lên Blockchain với ${
        tokenIds.length
      } vé: ${tokenIds.join(", ")}`,
    );
    const result = await executeBatchCheckInOnChain(tokenIds);

    console.log(
      `✅ [CHECK-IN] Blockchain trả kết quả thành công, txHash: ${result.txHash}`,
    );

    totalCheckInTicketsSynced += tokenIds.length;
    totalCheckInTicketsQueued -= tokenIds.length;

    console.log(
      `📊 [CHECK-IN] Tổng đã sync: ${totalCheckInTicketsSynced} vé, còn trong buffer: ${totalCheckInTicketsQueued} vé`,
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
 * Thêm vào hàng chờ CHECK-IN
 */
function addToCheckInBuffer(ticketId) {
  return new Promise((resolve, reject) => {
    checkInBuffer.push({ ticketId, resolve, reject });

    totalCheckInTicketsQueued += 1;

    console.log(
      `📥 [CHECK-IN] Buffer: ${checkInBuffer.length}/${config.checkInStrategy.batchSize} job, tổng vé đang chờ sync: ${totalCheckInTicketsQueued}`,
    );

    if (checkInBuffer.length >= config.checkInStrategy.batchSize) {
      flushCheckInBatch();
    } else if (!checkInTimer) {
      checkInTimer = setTimeout(
        flushCheckInBatch,
        config.checkInStrategy.batchTimeout,
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

  // 1.1 Kiểm tra cấp quyền USDT cho Smart Contract
  await initUSDTApproval();

  const relayerDlqQueue = new Queue(config.relayerStrategy.dlqQueueName, {
    connection: config.redis,
    skipConfigValidation: true,
  });

  const relayerBuyWorker = new Worker(
    config.relayerStrategy.queueName,
    processRelayerBuyJob,
    {
      connection: config.redis,
      concurrency: config.relayerStrategy.concurrency,
      skipConfigValidation: true,
    },
  );

  relayerBuyWorker.on("ready", () =>
    console.log(
      `✅ Relayer Buy Worker Ready: ${config.relayerStrategy.queueName}`,
    ),
  );

  relayerBuyWorker.on("failed", async (job, err) => {
    const maxAttempts = job?.opts?.attempts || config.relayerStrategy.attempts;
    const isFinalFailure =
      isRelayerFatalFailure(err) || job.attemptsMade >= maxAttempts;

    console.error(
      `❌ [RELAYER] Job ${job?.id} failed (attemptsMade=${job?.attemptsMade}/${maxAttempts}): ${err.message}`,
    );

    if (!isFinalFailure) {
      return;
    }

    try {
      await relayerDlqQueue.add(
        "relayer-buy-ticket-job-dlq",
        {
          jobId: job?.id,
          originalJobName: job?.name,
          payload: job?.data,
          failedReason: err.message,
          attemptsMade: job?.attemptsMade,
          failedAt: new Date().toISOString(),
        },
        {
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      console.error(
        `🚨 [RELAYER][DLQ] Job ${job?.id} được đẩy sang ${config.relayerStrategy.dlqQueueName} để xử lý thủ công.`,
      );
    } catch (dlqError) {
      console.error(
        `❌ [RELAYER][DLQ] Không đẩy được job ${job?.id} sang DLQ: ${dlqError.message}`,
      );
    }
  });

  // 2. Kịch bản A: Giám sát tạo sự kiện (Watcher)
  const verifyEventMintWorker = new Worker(
    "verifyEventMintQueue",
    async (job) => {
      const { eventId, txHash } = job.data;
      console.log(
        `[WATCHER] Đang chờ xác nhận txHash: ${txHash} (Event: ${eventId})`,
      );

      try {
        await waitForTransaction(txHash);

        const txStatus = "SUCCESS";

        await axios.post(
          `${config.webhook.beApiUrl}/api/v1/webhooks/internal/event-mint-result`,
          {
            eventId,
            txHash,
            status: txStatus,
          },
          {
            headers: {
              "x-webhook-secret": config.webhook.internalWebhookSecret,
            },
          },
        );

        console.log(
          `[WATCHER] Xử lý xong txHash: ${txHash}. Trạng thái: ${txStatus}`,
        );
        return txStatus;
      } catch (error) {
        console.error(
          `[WATCHER] Lỗi khi theo dõi txHash ${txHash}:`,
          error.message,
        );
        throw error;
      }
    },
    {
      connection: config.redis,
      skipConfigValidation: true,
    },
  );

  // 3. Worker CHECK-IN
  const checkInWorker = new Worker(
    config.checkInStrategy.queueName,
    async (job) => {
      const { ticketId } = job.data;

      console.log(
        `📨 [CHECK-IN] Nhận job từ Backend: jobId=${job.id}, ticketId=${ticketId}`,
      );
      await addToCheckInBuffer(ticketId);
      return { processed: true };
    },
    {
      connection: config.redis,
      concurrency: 50,
      skipConfigValidation: true,
    },
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
          job.data,
        );
        return { processed: false };
      }

      console.log(
        `📨 [AUTO-CHECKIN] Nhận job: jobId=${job.id}, tickets=${ticketIds.join(
          ",",
        )}`,
      );

      // 1. Đọc trạng thái vé trên Blockchain (đã check-in hay chưa)
      const statuses = await getBatchTicketStatusOnChain(ticketIds);

      if (!statuses || statuses.length !== ticketIds.length) {
        console.warn(
          `⚠️ [AUTO-CHECKIN] Số lượng trạng thái trả về không khớp danh sách tokenIds.`,
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
          `✅ [AUTO-CHECKIN] Tất cả vé trong job ${job.id} đều đã check-in trên chain, không cần thực hiện batch check-in.`,
        );
        return { processed: true, checkedInCount: 0 };
      }

      console.log(
        `✅ [AUTO-CHECKIN] Có ${
          needCheckInTicketIds.length
        } vé chưa check-in, sẽ thực hiện batch check-in on-chain: ${needCheckInTicketIds.join(
          ",",
        )}`,
      );

      // 3. Thực hiện batch check-in on-chain cho các vé chưa dùng
      let txHash = null;
      try {
        const result = await executeBatchCheckInOnChain(needCheckInTicketIds);
        txHash = result.txHash;
        console.log(
          `🏁 [AUTO-CHECKIN] Batch check-in thành công, txHash=${txHash}`,
        );
      } catch (error) {
        console.error(
          `❌ [AUTO-CHECKIN] Lỗi khi thực hiện batch check-in on-chain: ${error.message}`,
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
            payload,
          )}`,
        );

        const resp = await axios.post(
          `${config.backend.url}/webhooks/tickets-auto-checkin`,
          payload,
        );

        console.log(
          `✅ [AUTO-CHECKIN] BE xác nhận cập nhật status checkin thành công: ${
            resp.data?.message || "OK"
          }`,
        );
      } catch (error) {
        console.error(
          `❌ [AUTO-CHECKIN] Lỗi khi gọi webhook cập nhật status checkin: ${error.message}`,
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
    },
  );

  // Log trạng thái
  relayerBuyWorker.on("ready", () =>
    console.log(
      `✅ Relayer Buy Worker Ready: ${config.relayerStrategy.queueName}`,
    ),
  );
  relayerBuyWorker.on("failed", (job, err) =>
    console.error(`❌ Relayer Buy Job ${job.id} Failed: ${err.message}`),
  );

  checkInWorker.on("ready", () =>
    console.log(
      `✅ Check-in Worker Ready: ${config.checkInStrategy.queueName}`,
    ),
  );
  checkInWorker.on("failed", (job, err) =>
    console.error(`❌ Check-in Job ${job.id} Failed: ${err.message}`),
  );

  expireWorker.on("ready", () =>
    console.log(`✅ Expire Worker Ready: ${config.expireStrategy.queueName}`),
  );
  expireWorker.on("failed", (job, err) =>
    console.error(`❌ Expire Job ${job.id} Failed: ${err.message}`),
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
