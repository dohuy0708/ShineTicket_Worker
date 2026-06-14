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

  // First try to parse from EventTicketsMinted (Primary Mechanism)
  for (const log of receipt.logs) {
    try {
      const parsedLog = ticketInterface.parseLog(log);
      if (parsedLog?.name === "EventTicketsMinted") {
        const startTokenId = Number(parsedLog.args.startTokenId);
        const quantity = Number(parsedLog.args.quantity);
        for (let i = 0; i < quantity; i++) {
          mintedTokenIds.push((startTokenId + i).toString());
        }
        return mintedTokenIds; // Early return if primary mechanism succeeds
      }
    } catch (error) {
      continue;
    }
  }

  // Fallback to parsing from Transfer events
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

    // Kiểm tra quyền trên Contract (AccessControl)
    try {
      if (
        typeof contract.DEFAULT_ADMIN_ROLE === "function" &&
        typeof contract.hasRole === "function" &&
        typeof contract.OPERATOR_ROLE === "function"
      ) {
        const adminRole = await contract.DEFAULT_ADMIN_ROLE();
        const operatorRole = await contract.OPERATOR_ROLE();

        const isAdmin = await contract.hasRole(adminRole, wallet.address);
        const isOperator = await contract.hasRole(operatorRole, wallet.address);

        if (!isAdmin && !isOperator) {
          console.error(
            "❌ CRITICAL: Ví Worker KHÔNG có DEFAULT_ADMIN_ROLE và OPERATOR_ROLE trên Contract!\n" +
            "   → batchCheckIn() và mintBatchUsers() sẽ bị REVERT.\n" +
            "   → Hãy chạy script: node scripts/grantOperatorRole.js để cấp quyền.",
          );
          return false;
        }

        if (isAdmin) {
          console.log("👑 Quyền DEFAULT_ADMIN_ROLE: ✅ OK");
        } else {
          console.warn(
            "⚠️  Ví Worker KHÔNG có DEFAULT_ADMIN_ROLE (mintBatchUsers/relayerBuyTicket sẽ thất bại)",
          );
        }

        if (isOperator) {
          console.log("🔑 Quyền OPERATOR_ROLE: ✅ OK (batchCheckIn hoạt động)");
        } else {
          console.error(
            "❌ Ví Worker KHÔNG có OPERATOR_ROLE → batchCheckIn() sẽ REVERT!\n" +
            "   → Hãy chạy: node scripts/grantOperatorRole.js",
          );
          // Không dừng Worker hoàn toàn, nhưng báo lỗi rõ ràng
        }
      } else if (typeof contract.owner === "function") {
        // Fallback: Ownable pattern
        const owner = await contract.owner();
        if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
          console.warn(
            "⚠️ CẢNH BÁO: Ví Worker KHÔNG PHẢI là chủ Contract! Một vài thao tác có thể bị từ chối.",
          );
        } else {
          console.log("👑 Quyền Admin: OK (owner)");
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

/**
 * Kiểm tra số dư POL của một địa chỉ bất kỳ
 * @param {string} address - Địa chỉ cần kiểm tra
 * @returns {Promise<BigInt>} - Số dư POL (trong Wei)
 */
async function getBalanceOfAddress(address) {
  try {
    const balance = await provider.getBalance(address);
    console.log(
      `💰 [GAS-FUND] Số dư ${address}: ${ethers.formatEther(balance)} POL`,
    );
    return balance;
  } catch (error) {
    console.error(
      `❌ [GAS-FUND] Lỗi khi lấy số dư của ${address}: ${error.message}`,
    );
    throw error;
  }
}

/**
 * Gửi POL (gas) tới một địa chỉ khách
 * @param {string} toAddress - Địa chỉ nhận
 * @param {BigInt|string} amountInWei - Số tiền gửi (tính bằng Wei)
 * @returns {Promise<Object>} - {txHash, success}
 */
async function transferGasToAddress(toAddress, amountInWei) {
  try {
    console.log(
      `🔄 [GAS-FUND] Đang chuyển ${ethers.formatEther(
        amountInWei,
      )} POL tới ${toAddress}...`,
    );

    // Kiểm tra số dư ví Worker trước khi chuyển
    const walletBalance = await provider.getBalance(wallet.address);
    const amountBigInt = BigInt(amountInWei);

    if (walletBalance < amountBigInt) {
      throw new Error(
        `Số dư ví Worker (${ethers.formatEther(
          walletBalance,
        )} POL) không đủ để chuyển ${ethers.formatEther(amountBigInt)} POL`,
      );
    }

    // Gửi giao dịch
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: amountBigInt,
    });

    console.log(`⏳ [GAS-FUND] Tx Hash: ${tx.hash}`);

    // Chờ xác nhận (1 block)
    const receipt = await tx.wait(1);

    console.log(
      `✅ [GAS-FUND] Chuyển gas thành công! Tx: ${tx.hash}, Gas Used: ${receipt.gasUsed}`,
    );

    return {
      success: true,
      txHash: tx.hash,
      amount: ethers.formatEther(amountBigInt),
      toAddress,
    };
  } catch (error) {
    console.error(
      `❌ [GAS-FUND] Lỗi khi chuyển gas tới ${toAddress}: ${error.message}`,
    );
    throw error;
  }
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
  getBalanceOfAddress,
  transferGasToAddress,
};
