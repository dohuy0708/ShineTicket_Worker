import { ethers } from "ethers";
import config from "./config.js";
import { createRequire } from "module"; // Load ABI
import axios from "axios"; // Để gọi API Repo 1

const require = createRequire(import.meta.url);
const ticketArtifact = require("../abi/ShineTicket.json");

async function startListener() {
  console.log("👂 Đang khởi động Blockchain Listener...");

  // Lưu ý: Để nghe sự kiện tốt nhất nên dùng WebSocket Provider (wss://...)
  // Nhưng dùng JsonRpcProvider (https://...) cũng tạm được với polling.
  const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl);

  const contract = new ethers.Contract(
    config.blockchain.contractAddress,
    ticketArtifact.abi,
    provider,
  );

  // Lắng nghe sự kiện Transfer (theo chuẩn ERC721)
  // Sự kiện: Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
  contract.on("Transfer", async (from, to, tokenId, event) => {
    console.log(`🚨 PHÁT HIỆN GIAO DỊCH: Vé #${tokenId} từ ${from} -> ${to}`);
    console.log(`👛 Ví nhận vé: ${to}`);

    // Bỏ qua trường hợp Mint (from = 0x0) vì Worker đã xử lý rồi
    if (from === ethers.ZeroAddress) return;

    // Bỏ qua trường hợp Burn (to = 0x0) - Hoặc xử lý nếu muốn

    // GỌI WEBHOOK VỀ REPO 1 ĐỂ UPDATE DB
    try {
      const payload = {
        tokenId: tokenId.toString(),
        fromAddress: from,
        toAddress: to,
        txHash: event.log.transactionHash,
      };

      console.log(
        `📞 [LISTENER] Gọi webhook transfer: http://localhost:3000/api/webhook/transfer với payload: ${JSON.stringify(
          payload,
        )}`,
      );

      await axios.post("http://localhost:3000/api/webhook/transfer", payload);
      console.log("✅ Đã báo Backend cập nhật chủ sở hữu mới.");
    } catch (err) {
      console.error("❌ Lỗi gọi API Backend:", err.message);
    }
  });
}

startListener();
