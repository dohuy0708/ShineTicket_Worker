import { Queue } from "bullmq";
import config from "./config.js";

// 1. Khởi tạo Queue cho MINT (Nhớ thêm skipConfigValidation)
const mintQueue = new Queue(config.mintStrategy.queueName, {
  connection: config.redis,
  skipConfigValidation: true,
});

// 2. Khởi tạo Queue cho CHECK-IN
const checkInQueue = new Queue(config.checkInStrategy.queueName, {
  connection: config.redis,
  skipConfigValidation: true,
});

async function addJobs() {
  console.log("🚀 Đang bắn job vào cả 2 hàng đợi (Mint & Check-in)...");

  // Thay bằng ví Metamask của bạn để nhận vé thật trên Testnet Amoy
  const myWallet = "0x4780bb7b0ab163b500c1aee612fae0a8de5c4355";

  // --- KỊCH BẢN 1: BẮN 5 ĐƠN MINT ---
  // Worker sẽ gom 5 đơn này lại (Buffer) và đợi Timeout hoặc đủ Batch Size mới xử lý
  console.log("👉 Đang gửi 5 yêu cầu Mint...");

  for (let i = 1; i <= 5; i++) {
    await mintQueue.add("test-mint", {
      recipients: myWallet, // Worker dùng biến 'recipient'
      quantities: 1, // Mỗi người mua 1 vé
    });
    console.log(`   + Đã bắn đơn Mint #${i}`);
  }

  // --- KỊCH BẢN 2: BẮN 3 YÊU CẦU CHECK-IN ---
  // Giả sử vé ID 1, 2, 3 cần check-in
  console.log("👉 Đang gửi 3 yêu cầu Check-in...");

  const ticketIds = [17, 18, 19];
  for (const id of ticketIds) {
    await checkInQueue.add("test-checkin", {
      ticketId: id,
    });
    console.log(`   + Đã bắn yêu cầu Check-in ID #${id}`);
  }

  console.log("\n✅ Đã bắn xong!");
  console.log("👀 Hãy quay sang màn hình Worker để xem nó:");
  console.log("   1. Nhận Job ngay lập tức.");
  console.log("   2. Đợi khoảng 10s (Mint) hoặc 60s (Check-in).");
  console.log("   3. Gom lại và gọi Blockchain 1 lần duy nhất.");

  process.exit(0);
}

addJobs();
