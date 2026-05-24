import { ethers } from "ethers";
import config from "./config.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ticketArtifact = require("../abi/ShineTicket.json");
const usdtArtifact = require("../abi/MockUSDT.json");

// --- 1. KHỞI TẠO KẾT NỐI ---
const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl);
const wallet = new ethers.Wallet(config.blockchain.privateKey, provider);
const contract = new ethers.Contract(
  config.blockchain.contractAddress,
  ticketArtifact.abi,
  wallet,
);
const ticketInterface = new ethers.Interface(ticketArtifact.abi);

const usdtContract = new ethers.Contract(
  config.blockchain.usdtAddress,
  usdtArtifact.abi,
  wallet,
);

/**
 * INIT (Khởi động)
 * Kiểm tra allowance và duyệt USDT cho Smart Contract
 */
async function initUSDTApproval() {
  console.log("[WORKER] Đang kiểm tra Allowance USDT...");
  try {
    const maxApproval = ethers.MaxUint256;
    const allowance = await usdtContract.allowance(
      wallet.address,
      config.blockchain.contractAddress,
    );

    if (allowance < ethers.parseUnits("1000", 6)) {
      console.log(
        "[WORKER] Tiến hành cấp quyền (Approve) USDT cho Smart Contract...",
      );
      const tx = await usdtContract.approve(
        config.blockchain.contractAddress,
        maxApproval,
      );
      await tx.wait();
      console.log("[WORKER] Approve USDT thành công!");
    } else {
      console.log("[WORKER] USDT Allowance đã đủ, sẵn sàng chạy.");
    }
  } catch (error) {
    console.error("❌ Lỗi khi kiểm tra hoặc approve USDT:", error.message);
  }
}

/**
 * Đợi 1 giao dịch được xác nhận (dùng cho Kịch bản A)
 */
async function waitForTransaction(txHash) {
  // Timeout tự định nghĩa hoặc dùng mặc định của ethers
  return await provider.waitForTransaction(txHash, 1, 60000);
}

/**
 * Mua vé hộ khách (VND) (Kịch bản B)
 */
async function relayerBuyTicket(eventId, quantity, buyerAddress) {
  try {
    const tx = await contract.relayerBuyTicket(eventId, quantity, buyerAddress);
    return tx;
  } catch (error) {
    console.error(`❌ Lỗi gọi relayerBuyTicket trên SC:`, error.message);
    throw error;
  }
}

async function executeRelayerPurchase(methodName, callArgs) {
  if (typeof contract[methodName] !== "function") {
    throw new Error(`Contract không có method ${methodName}`);
  }

  try {
    const tx = await contract[methodName](...callArgs);
    return tx;
  } catch (error) {
    console.error(`❌ Lỗi gọi ${methodName} trên SC:`, error.message);
    throw error;
  }
}

/**
 * Kiểm tra pre-flight cho relayer buy: đủ gas, và nếu có totalPrice thì kiểm tra đủ USDT.
 */
async function getRelayerPreflightSnapshot(methodName, callArgs, totalPrice) {
  if (typeof contract[methodName] !== "function") {
    throw new Error(`Contract không có method ${methodName}`);
  }

  const gasEstimate = await contract[methodName].estimateGas(...callArgs);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;

  if (!gasPrice) {
    throw new Error("Không lấy được fee data của mạng để kiểm tra gas");
  }

  const nativeBalance = await provider.getBalance(wallet.address);
  const usdtBalance = await usdtContract.balanceOf(wallet.address);
  const hasRequiredUsdt =
    totalPrice !== undefined && totalPrice !== null && totalPrice !== "";
  const requiredUsdt = hasRequiredUsdt ? BigInt(totalPrice) : null;
  const estimatedGasCost = gasEstimate * gasPrice;

  return {
    nativeBalance,
    usdtBalance,
    hasRequiredUsdt,
    requiredUsdt,
    gasEstimate,
    gasPrice,
    estimatedGasCost,
    enoughNative: nativeBalance >= estimatedGasCost,
    enoughUsdt: requiredUsdt === null ? true : usdtBalance >= requiredUsdt,
  };
}

/**
 * Bóc tách tokenId từ receipt của giao dịch mint.
 */
function parseMintedTokenIdsFromReceipt(receipt) {
  const mintedTokenIds = [];

  if (!receipt?.logs?.length) {
    return mintedTokenIds;
  }

  for (const log of receipt.logs) {
    try {
      const parsedLog = ticketInterface.parseLog(log);
      if (
        parsedLog?.name === "Transfer" &&
        parsedLog.args?.from?.toLowerCase() === ethers.ZeroAddress.toLowerCase()
      ) {
        mintedTokenIds.push(parsedLog.args.tokenId.toString());
      }
    } catch (error) {
      continue;
    }
  }

  return mintedTokenIds;
}

/**
 * Hàm gọi Smart Contract để Check-in HÀNG LOẠT
 * Thay vì tokenId lẻ, ta nhận vào mảng tokenIds
 * @param {number[]} tokenIds - Danh sách ID vé [1, 2, 5...]
 */
async function executeBatchCheckInOnChain(tokenIds) {
  try {
    console.log(
      `🔗 [CHECK-IN] Đang đồng bộ ${tokenIds.length} vé lên Blockchain...`,
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
 * Hàm đọc trạng thái đã check-in của danh sách vé trên Blockchain
 * @param {number[]|string[]} tokenIds - Danh sách ID vé [1, 2, 5...]
 * @returns {Promise<boolean[]>} - Mảng bool tương ứng: true = đã check-in, false = chưa check-in
 */
async function getBatchTicketStatusOnChain(tokenIds) {
  try {
    if (!tokenIds || tokenIds.length === 0) return [];

    console.log(
      `🔍 [STATUS] Đang đọc trạng thái ${tokenIds.length} vé trên Blockchain...`,
    );

    // Ethers v6 có thể nhận string/number/BigInt, để rõ ràng ta cast về BigInt
    const normalizedIds = tokenIds.map((id) => BigInt(id));

    const statuses = await contract.getBatchTicketStatus(normalizedIds);

    // statuses là mảng boolean (ethers v6 giữ nguyên kiểu bool[])
    console.log(
      `✅ [STATUS] Đã lấy trạng thái vé: ${statuses
        .map((s, idx) => `${tokenIds[idx]}=${s ? "checked-in" : "not-used"}`)
        .join(", ")}`,
    );

    return statuses;
  } catch (error) {
    console.error("❌ Lỗi đọc trạng thái vé trên Blockchain:", error.message);
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
      `🌐 Đã kết nối mạng: ${network.name} (Chain ID: ${network.chainId})`,
    );

    const balance = await provider.getBalance(wallet.address);
    console.log(`💰 Số dư ví Worker: ${ethers.formatEther(balance)} POL/MATIC`);
    // Một số phiên bản contract dùng Ownable (owner()), một số khác dùng AccessControl (DEFAULT_ADMIN_ROLE + hasRole)
    try {
      if (typeof contract.owner === "function") {
        const owner = await contract.owner();
        if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
          console.warn(
            "⚠️ CẢNH BÁO: Ví Worker KHÔNG PHẢI là chủ Contract! Một vài thao tác có thể bị từ chối.",
          );
        } else {
          console.log("👑 Quyền Admin: OK (owner)");
        }
      } else if (
        typeof contract.DEFAULT_ADMIN_ROLE === "function" &&
        typeof contract.hasRole === "function"
      ) {
        const adminRole = await contract.DEFAULT_ADMIN_ROLE();
        const isAdmin = await contract.hasRole(adminRole, wallet.address);
        if (!isAdmin) {
          console.warn(
            "⚠️ CẢNH BÁO: Ví Worker KHÔNG có DEFAULT_ADMIN_ROLE trên Contract! Một vài thao tác có thể bị từ chối.",
          );
        } else {
          console.log("👑 Quyền Admin: OK (DEFAULT_ADMIN_ROLE)");
        }
      } else {
        console.warn(
          "⚠️ Không tìm thấy method kiểm tra quyền trên ABI (owner/hasRole). Bỏ qua kiểm tra quyền và tiếp tục khởi động.",
        );
      }

      return true;
    } catch (innerErr) {
      console.error(
        "❌ Lỗi khi kiểm tra quyền trên Contract:",
        innerErr.message,
      );
      return false;
    }
  } catch (error) {
    console.error("❌ Lỗi kết nối Blockchain:", error.message);
    return false;
  }
}

async function getBlockchainContext() {
  const network = await provider.getNetwork();

  return {
    chainId: Number(network.chainId),
    relayerAddress: wallet.address,
    contractAddress: config.blockchain.contractAddress,
  };
}

export {
  initUSDTApproval,
  waitForTransaction,
  relayerBuyTicket,
  executeRelayerPurchase,
  getRelayerPreflightSnapshot,
  parseMintedTokenIdsFromReceipt,
  getBlockchainContext,
  ticketInterface,
  executeBatchCheckInOnChain,
  getBatchTicketStatusOnChain,
  verifyConnection,
};
