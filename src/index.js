import { verifyConnection } from "./blockchain.js";

// Import file worker để kích hoạt logic lắng nghe
import "./worker.js";

async function main() {
  console.log("--- SHINE TICKET WORKER SERVICE ---");

  // Kiểm tra kết nối Blockchain lần cuối trước khi chạy chính thức
  const isConnected = await verifyConnection();

  if (!isConnected) {
    console.error("❌ CRITICAL: Không thể kết nối Blockchain. Dừng Worker.");
    process.exit(1);
  }
}

main();
