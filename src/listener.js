import { ethers } from "ethers";
import config from "./config.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const ticketArtifact = require("../abi/ShineTicket.json");

// Khoảng thời gian polling (ms) - 15 giây
const POLLING_INTERVAL_MS = 15000;

async function startListener() {
  console.log("👂 Đang khởi động Blockchain Listener (polling mode)...");

  const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl);
  const contractInterface = new ethers.Interface(ticketArtifact.abi);
  const contractAddress = config.blockchain.contractAddress;

  // Lấy block hiện tại để bắt đầu nghe từ đây (tránh xử lý lại giao dịch cũ)
  let lastBlock = await provider.getBlockNumber();
  console.log(`👂 [LISTENER] Bắt đầu polling từ block #${lastBlock}`);

  // Tạo bộ lọc topic cho event Transfer (ERC-721 chuẩn)
  const transferTopic = ethers.id("Transfer(address,address,uint256)");

  async function pollNewTransfers() {
    try {
      const currentBlock = await provider.getBlockNumber();

      if (currentBlock <= lastBlock) return; // Không có block mới

      // Lấy logs từ block cũ + 1 đến block mới nhất
      const logs = await provider.getLogs({
        address: contractAddress,
        topics: [transferTopic],
        fromBlock: lastBlock + 1,
        toBlock: currentBlock,
      });

      for (const log of logs) {
        try {
          const parsedLog = contractInterface.parseLog(log);
          if (!parsedLog) continue;

          const from = parsedLog.args[0];
          const to = parsedLog.args[1];
          const tokenId = parsedLog.args[2];

          console.log(`🚨 PHÁT HIỆN GIAO DỊCH: Vé #${tokenId} từ ${from} -> ${to}`);
          console.log(`👛 Ví nhận vé: ${to}`);

          // Bỏ qua trường hợp Mint (from = 0x0)
          if (from.toLowerCase() === ethers.ZeroAddress.toLowerCase()) continue;
        } catch (parseErr) {          // Bỏ qua log không parse được
        }
      }

      lastBlock = currentBlock;
    } catch (error) {
      // Bắt mọi lỗi RPC (kể cả filter not found) và bỏ qua, vòng tiếp theo sẽ tự retry
      console.warn(`⚠️ [LISTENER] Lỗi polling (sẽ tự thử lại): ${error.message}`);
    }
  }

  // Chạy lần đầu ngay, sau đó lặp lại mỗi POLLING_INTERVAL_MS
  pollNewTransfers();
  setInterval(pollNewTransfers, POLLING_INTERVAL_MS);
}

startListener();
