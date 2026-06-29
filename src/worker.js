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
  getBalanceOfAddress,
  transferGasToAddress,
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

function addToCheckInBuffer(ticketId) {
  return new Promise((resolve, reject) => {
    checkInBuffer.push({ ticketId, resolve, reject });
    totalCheckInTicketsQueued++;

    if (checkInBuffer.length >= config.checkInStrategy.maxBatchSize) {
      flushCheckInBatch();
    } else if (!checkInTimer) {
      checkInTimer = setTimeout(flushCheckInBatch, config.checkInStrategy.maxWaitTime);
    }
  });
}

// ==========================================
// PHẦN 3B: CLEANUP STALLED JOBS
// ==========================================

/**
 * Dọn dẹp các job bị kẹt (stalled jobs) từ Redis Queue
 * Nguyên nhân: Worker bị tắt đột ngột khi đang xử lý job
 */
async function cleanupStalledJobs() {
  // Giảm thiểu connections: tạo từng queue, đóng ngay sau khi xong
  const queueNames = [
    config.relayerStrategy.queueName,
    config.checkInStrategy.queueName,
    config.gasFundStrategy.queueName,
  ];

  console.log("🧹 Đang kiểm tra và dọn dẹp stalled jobs từ Redis...");

  for (const queueName of queueNames) {
    let queue = null;
    try {
      queue = new Queue(queueName, {
        connection: config.redis,
        skipConfigValidation: true,
      });

      const counts = await queue.getJobCounts();

      if (counts.active > 0) {
        console.log(
          `⚠️ [${queueName}] Tìm thấy ${counts.active} job đang active. Dọn dẹp...`,
        );

        const jobs = await queue.getJobs(["active"]);
        for (const job of jobs) {
          console.log(`  - Job ${job.id} (attempts: ${job.attemptsMade})`);
        }
      }
    } catch (error) {
      console.error(`⚠️ Lỗi kiểm tra queue [${queueName}]:`, error.message);
    } finally {
      // Đóng ngay để giải phóng connection
      if (queue) await queue.close().catch(() => {});
    }
  }

  console.log("✅ Hoàn tất kiểm tra stalled jobs.\n");
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

  // 1.2 Dọn dẹp stalled jobs
  await cleanupStalledJobs();

  // === LOG QUEUE NAMES ===
  console.log("\n📋 === QUEUE CONFIGURATION ===");
  console.log(`📨 Relayer Buy Queue: ${config.relayerStrategy.queueName}`);
  console.log(`📨 Check-in Queue: ${config.checkInStrategy.queueName}`);
  console.log(`📨 Gas-Fund Queue: ${config.gasFundStrategy.queueName}`);
  console.log("=============================\n");

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
      concurrency: 5, // Giảm từ 50 → 5 để tiết kiệm connections (free tier giới hạn 30)
      skipConfigValidation: true,
    },
  );

  // 4. Worker AUTO CHECK-IN (Đã vô hiệu hóa - BE tự update DB)
  // Logic expireWorker đã bị xóa vì Backend sẽ tự động xử lý trạng thái vé khi hết hạn.

  // 5. Worker GAS-FUND (Quỹ Gas - Cách ly & Thực thi)
  const gasFundWorker = new Worker(
    config.gasFundStrategy.queueName,
    async (job) => {
      console.log(`📨 [GAS-FUND] Raw job.data:`, JSON.stringify(job.data));

      const { walletAddress } = job.data || {};

      if (!walletAddress || !ethers.isAddress(walletAddress)) {
        throw new Error(
          `❌ [GAS-FUND] walletAddress không hợp lệ: ${walletAddress}. Job data: ${JSON.stringify(job.data)}`,
        );
      }

      console.log(
        `📨 [GAS-FUND] Nhận job từ Backend: jobId=${job.id}, walletAddress=${walletAddress}`,
      );

      try {
        // Bước 2: Kiểm tra kho hàng (Check Balance)
        const balance = await getBalanceOfAddress(walletAddress);

        // Bước 3: Ra quyết định logic
        if (balance >= config.gasFundStrategy.minBalance) {
          // Trường hợp 1 (Tiết kiệm): Số dư >= 0.01 POL
          console.log(
            `✅ [GAS-FUND] Số dư đủ (${ethers.formatEther(
              balance,
            )} POL >= ${ethers.formatEther(
              config.gasFundStrategy.minBalance,
            )} POL). Bỏ qua bơm tiền.`,
          );

          // Báo cáo hoàn tất (skip)
          try {
            await axios.post(
              `${config.backend.url}${config.gasFundStrategy.webhookPath}`,
              {
                jobId: job.id,
                status: "success",
              },
            );

            console.log(
              `📞 [GAS-FUND] Gọi webhook (skip): ${config.backend.url}${config.gasFundStrategy.webhookPath}`,
            );
          } catch (webhookError) {
            console.error(
              `⚠️ [GAS-FUND] Lỗi gọi webhook (skip): ${webhookError.message}`,
            );
            // Không throw - job vẫn thành công dù webhook fail
          }

          return {
            status: "skipped",
            reason: "balance_sufficient",
            walletAddress,
            currentBalance: ethers.formatEther(balance),
          };
        }

        // Trường hợp 2 (Bơm tiền): Số dư < 0.01 POL
        console.log(
          `💧 [GAS-FUND] Số dư không đủ (${ethers.formatEther(
            balance,
          )} POL < ${ethers.formatEther(
            config.gasFundStrategy.minBalance,
          )} POL). Sẽ bơm tiền.`,
        );

        // Bước 4: Chuyển gas tới khách
        const transferResult = await transferGasToAddress(
          walletAddress,
          config.gasFundStrategy.gasTransferAmount,
        );

        // Bước 5: Báo cáo hoàn tất
        try {
          await axios.post(
            `${config.backend.url}${config.gasFundStrategy.webhookPath}`,
            {
              jobId: job.id,
              status: "success",
              txHash: transferResult.txHash,
            },
          );

          console.log(
            `📞 [GAS-FUND] Gọi webhook (success): ${config.backend.url}${config.gasFundStrategy.webhookPath}`,
          );
        } catch (webhookError) {
          console.error(
            `⚠️ [GAS-FUND] Lỗi gọi webhook (success): ${webhookError.message}`,
          );
          // Không throw - gas đã chuyển thành công, chỉ webhook fail
        }

        return {
          status: "success",
          reason: "gas_transferred",
          walletAddress,
          txHash: transferResult.txHash,
          transferAmount: ethers.formatEther(
            config.gasFundStrategy.gasTransferAmount,
          ),
          previousBalance: ethers.formatEther(balance),
        };
      } catch (error) {
        console.error(
          `❌ [GAS-FUND] Lỗi xử lý job ${job.id}: ${error.message}`,
        );

        // Báo cáo lỗi về Backend
        try {
          await axios.post(
            `${config.backend.url}${config.gasFundStrategy.webhookPath}`,
            {
              jobId: job.id,
              status: "failed",
              errorMessage: error.message,
            },
          );
        } catch (webhookError) {
          console.error(
            `⚠️ [GAS-FUND] Lỗi gọi webhook (failed): ${webhookError.message}`,
          );
        }

        // Throw để BullMQ retry
        throw error;
      }
    },
    {
      connection: config.redis,
      concurrency: config.gasFundStrategy.concurrency,
      skipConfigValidation: true,
      stallInterval: 5000, // Kiểm tra stalled jobs mỗi 5 giây
      maxStalledCount: 2, // Nếu job bị kẹt quá 2 lần thì đưa vào DLQ
    },
  );

  // === PHÁT HIỆN VÀ XỬ LÝ STALLED JOBS ===
  gasFundWorker.on("stalled", (jobId) => {
    console.warn(
      `⚠️ [GAS-FUND] Phát hiện Job ${jobId} bị kẹt (stalled). Sẽ xử lý lại...`,
    );
  });

  gasFundWorker.on("error", (error) => {
    console.error(`❌ [GAS-FUND] Worker error:`, error.message);
  });

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


  gasFundWorker.on("ready", () =>
    console.log(
      `✅ Gas-Fund Worker Ready: ${config.gasFundStrategy.queueName}`,
    ),
  );
  gasFundWorker.on("failed", (job, err) =>
    console.error(`❌ Gas-Fund Job ${job.id} Failed: ${err.message}`),
  );
}

// Handle Graceful Shutdown
async function gracefulShutdown() {
  console.log("Đang tắt Worker...");
  try {
    if (typeof mintWorker !== 'undefined') await mintWorker.close();
    if (typeof checkInWorker !== 'undefined') await checkInWorker.close();
    if (typeof relayerBuyWorker !== 'undefined') await relayerBuyWorker.close();
    if (typeof gasFundWorker !== 'undefined') await gasFundWorker.close();
    console.log("Đã đóng các worker an toàn.");
  } catch (error) {
    console.error("Lỗi khi đóng worker:", error);
  }
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
process.on("SIGUSR2", gracefulShutdown); // Dành cho Nodemon

// CHẠY
startWorkers();

// --- HEALTH CHECK SERVER (CHO RENDER / MONITOR) ---
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Worker is running!");
});

// Endpoint dùng để chủ động "đánh thức" (wake up) worker
app.get("/api/wakeup", (req, res) => {
  console.log("⏰ Nhận request đánh thức Worker từ xa!");
  res.status(200).json({
    status: "success",
    message: "Worker đã được đánh thức và đang hoạt động!",
    timestamp: new Date().toISOString()
  });
});

app.listen(port, () => {
  console.log(`Health check server listening on port ${port}`);
});
