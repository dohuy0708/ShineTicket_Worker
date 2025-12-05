import { ethers } from "ethers";
import config from "./config.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ticketArtifact = require("../abi/ShineTicket.json");

// --- 1. KHỞI TẠO KẾT NỐI ---
const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl);
const wallet = new ethers.Wallet(config.blockchain.privateKey, provider);
const contract = new ethers.Contract(
  config.blockchain.contractAddress,
  ticketArtifact.abi,
  wallet
);

/**
 * Hàm gọi Smart Contract để Mint Batch (Gom nhiều người)
 * @param {string[]} recipients - Danh sách địa chỉ ví
 * @param {number[]} quantities - Danh sách số lượng
 */
async function mintBatchOnChain(recipients, quantities) {
  try {
    console.log(`🔗 [MINT] Đang gửi giao dịch cho ${recipients.length} ví...`);

    // Gọi hàm mintBatchUsers của Smart Contract
    const tx = await contract.mintBatchUsers(recipients, quantities);

    console.log(`⏳ Tx Hash: ${tx.hash}`);
    console.log(`   Đang đợi xác nhận...`);

    const receipt = await tx.wait(1);

    console.log(
      `✅ Mint thành công! Block: ${receipt.blockNumber}, Gas Used: ${receipt.gasUsed}`
    );
    return {
      success: true,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
    };
  } catch (error) {
    console.error("❌ Lỗi Mint:", error.message);
    throw error;
  }
}

/**
 * [ĐÃ SỬA] Hàm gọi Smart Contract để Check-in HÀNG LOẠT
 * Thay vì tokenId lẻ, ta nhận vào mảng tokenIds
 * @param {number[]} tokenIds - Danh sách ID vé [1, 2, 5...]
 */
async function executeBatchCheckInOnChain(tokenIds) {
  try {
    console.log(
      `🔗 [CHECK-IN] Đang đồng bộ ${tokenIds.length} vé lên Blockchain...`
    );

    // Gọi hàm batchCheckIn (lưu ý tên hàm trong Contract V2)
    const tx = await contract.batchCheckIn(tokenIds);

    console.log(`⏳ Tx Hash: ${tx.hash}`);

    const receipt = await tx.wait(1);

    console.log(`✅ Đồng bộ Check-in thành công! Gas Used: ${receipt.gasUsed}`);
    return {
      success: true,
      txHash: tx.hash,
    };
  } catch (error) {
    // Xử lý lỗi logic (VD: Vé đã check-in rồi mà check-in lại)
    if (error.reason) {
      console.error(`❌ Lỗi Contract (Revert): ${error.reason}`);
    } else {
      console.error("❌ Lỗi hệ thống Check-in:", error.message);
    }
    throw error;
  }
}

/**
 * Hàm kiểm tra kết nối khi khởi động Worker
 */
async function verifyConnection() {
  try {
    const network = await provider.getNetwork();
    console.log(
      `🌐 Đã kết nối mạng: ${network.name} (Chain ID: ${network.chainId})`
    );

    const balance = await provider.getBalance(wallet.address);
    console.log(`💰 Số dư ví Worker: ${ethers.formatEther(balance)} POL/MATIC`);

    // Hàm owner() có sẵn do kế thừa Ownable
    const owner = await contract.owner();

    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.warn(
        "⚠️ CẢNH BÁO: Ví Worker KHÔNG PHẢI là chủ Contract! Lệnh Mint/Check-in sẽ thất bại."
      );
    } else {
      console.log("👑 Quyền Admin: OK");
    }
    return true;
  } catch (error) {
    console.error("❌ Lỗi kết nối Blockchain:", error.message);
    return false;
  }
}

export { mintBatchOnChain, executeBatchCheckInOnChain, verifyConnection };
