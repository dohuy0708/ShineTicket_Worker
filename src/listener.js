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

      // Một số RPC (Infura, Alchemy, Geth cấu hình) giới hạn khoảng block cho eth_getLogs.
      // Chia nhỏ khoảng từ lastBlock+1 -> currentBlock thành từng chunk để tránh lỗi.
      const MAX_BLOCK_RANGE = config.blockRangeLimit ?? 500;
      const from = lastBlock + 1;
      const to = currentBlock;

      for (let start = from; start <= to; start += MAX_BLOCK_RANGE) {
        const end = Math.min(start + MAX_BLOCK_RANGE - 1, to);
        try {
          const logs = await provider.getLogs({
            address: contractAddress,
            topics: [transferTopic],
            fromBlock: start,
            toBlock: end,
          });

          for (const log of logs) {
            try {
              const parsedLog = contractInterface.parseLog(log);
              if (!parsedLog) continue;

              const from = parsedLog.args[0];
              const to = parsedLog.args[1];
              const tokenId = parsedLog.args[2];

              console.log(
                `🚨 PHÁT HIỆN GIAO DỊCH: Vé #${tokenId} từ ${from} -> ${to}`,
              );
              console.log(`👛 Ví nhận vé: ${to}`);

              // Bỏ qua trường hợp Mint (from = 0x0)
              if (from.toLowerCase() === ethers.ZeroAddress.toLowerCase())
                continue;
            } catch (parseErr) {
              // Bỏ qua log không parse được
            }
          }
        } catch (rangeErr) {
          console.warn(
            `⚠️ [LISTENER] Lỗi khi lấy logs block ${start}-${end} (sẽ thử tiếp): ${rangeErr.message}`,
          );
        }
      }

      lastBlock = currentBlock;
    } catch (error) {
      // Bắt mọi lỗi RPC (kể cả filter not found) và bỏ qua, vòng tiếp theo sẽ tự retry
      console.warn(
        `⚠️ [LISTENER] Lỗi polling (sẽ tự thử lại): ${error.message}`,
      );
    }
  }

  // Chạy lần đầu ngay, sau đó lặp lại mỗi POLLING_INTERVAL_MS
  pollNewTransfers();
  setInterval(pollNewTransfers, POLLING_INTERVAL_MS);
}

startListener();
