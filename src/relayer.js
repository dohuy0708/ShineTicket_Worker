import axios from "axios";
import { UnrecoverableError } from "bullmq";
import { ethers } from "ethers";
import config from "./config.js";
import {
  getRelayerPreflightSnapshot,
  getBlockchainContext,
  executeRelayerPurchase,
  parseMintedTokenIdsFromReceipt,
} from "./blockchain.js";

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function joinUrl(baseUrl, path) {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedPath = String(path || "").replace(/^\/+/, "");

  if (!normalizedBaseUrl) {
    return `/${normalizedPath}`;
  }

  if (normalizedBaseUrl.endsWith("/api") && normalizedPath.startsWith("api/")) {
    return `${normalizedBaseUrl.slice(0, -4)}/${normalizedPath}`;
  }

  return `${normalizedBaseUrl}/${normalizedPath}`;
}

function resolveCallbackUrl(callbackUrl) {
  const callbackPath = config.relayerApi?.resultPath || callbackUrl;

  if (!callbackPath) {
    throw new UnrecoverableError(
      "Thiếu callbackUrl trong payload relayer-buy-job",
    );
  }

  if (isAbsoluteUrl(callbackPath)) {
    return callbackPath;
  }

  return joinUrl(config.backend.beApiUrl || config.backend.url, callbackPath);
}

function resolveCallbackSecret(callbackSecret) {
  const resolvedSecret =
    callbackSecret ||
    config.backend?.internalWebhookSecret ||
    config.webhook?.internalWebhookSecret;

  if (!resolvedSecret) {
    throw new UnrecoverableError(
      "Thiếu callbackSecret trong payload relayer-buy-job và config worker",
    );
  }

  return resolvedSecret;
}

function normalizeQuantity(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UnrecoverableError("Payload quantity không hợp lệ");
  }
  return parsed;
}

function normalizeIntegerArray(values, fieldName) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new UnrecoverableError(
      `Thiếu ${fieldName} hợp lệ trong payload relayer-buy-job`,
    );
  }

  return values.map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new UnrecoverableError(`${fieldName} chứa giá trị không hợp lệ`);
    }
    return parsed;
  });
}

function normalizeTotalPrice(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  try {
    return BigInt(value);
  } catch (error) {
    throw new UnrecoverableError(
      "totalPrice không hợp lệ hoặc chưa được quy đổi về decimals",
    );
  }
}

function resolveContractCall(contractCall = {}) {
  const args = contractCall.args;
  let eventIds;
  let quantities;
  let buyerAddress;
  let method = contractCall.method;

  if (Array.isArray(args)) {
    if (Array.isArray(args[0]) && Array.isArray(args[1])) {
      eventIds = normalizeIntegerArray(args[0], "eventIds");
      quantities = normalizeIntegerArray(args[1], "quantities");
      buyerAddress = args[2];
      method = method || "batchRelayerBuyTicket";
    } else {
      eventIds = normalizeIntegerArray([args[0]], "eventIds");
      quantities = normalizeIntegerArray([args[1]], "quantities");
      buyerAddress = args[2];
      method = method || "relayerBuyTicket";
    }
  } else if (args && typeof args === "object") {
    const eventId = args.eventId ?? args.onChainId ?? args[0];
    const quantity = args.quantity ?? args[1];
    buyerAddress = args.buyerAddress ?? args[2];
    eventIds = normalizeIntegerArray([eventId], "eventIds");
    quantities = normalizeIntegerArray([quantity], "quantities");
    method = method || "relayerBuyTicket";
  }

  return {
    method,
    eventIds,
    quantities,
    buyerAddress,
  };
}

function resolveJobPayload(jobData = {}) {
  const contractCall = jobData.contractCall || {};
  const contractArgs = resolveContractCall(contractCall);

  const orderId = jobData.orderId;
  const orderCode = jobData.orderCode;
  const eventIds = jobData.eventIds ||
    contractArgs.eventIds || [jobData.eventId ?? jobData.onChainId];
  const showId = jobData.showId;
  const quantities = jobData.quantities ||
    contractArgs.quantities || [normalizeQuantity(jobData.quantity)];
  const buyerAddress = jobData.buyerAddress || contractArgs.buyerAddress;
  const recipient = jobData.recipient;
  const price = jobData.price;
  const totalPrice = normalizeTotalPrice(
    jobData.totalPrice ??
      jobData.totalPriceUsdt ??
      jobData.totalPriceVnd ??
      jobData.order?.totalPrice,
  );
  if (totalPrice === undefined) {
    console.warn(
      `[RELAYER] Job ${orderId || orderCode || "unknown"} không có totalPrice. Sẽ bỏ qua kiểm tra số dư USDT preflight và chỉ kiểm tra gas native.`,
    );
  }
  const totalPriceVnd = jobData.totalPriceVnd;
  const exchangeRateVndPerUsdt = jobData.exchangeRateVndPerUsdt;
  const callbackUrl = resolveCallbackUrl(jobData.callbackUrl);
  const callbackSecret = resolveCallbackSecret(jobData.callbackSecret);

  if (!orderId) {
    throw new UnrecoverableError("Thiếu orderId trong payload relayer-buy-job");
  }

  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    throw new UnrecoverableError(
      "Thiếu eventIds/onChainIds trong payload relayer-buy-job",
    );
  }

  if (!Array.isArray(quantities) || quantities.length === 0) {
    throw new UnrecoverableError(
      "Thiếu quantities trong payload relayer-buy-job",
    );
  }

  if (eventIds.length !== quantities.length) {
    throw new UnrecoverableError(
      "eventIds và quantities phải có cùng số lượng phần tử",
    );
  }

  if (!buyerAddress || !ethers.isAddress(buyerAddress)) {
    throw new UnrecoverableError("buyerAddress không hợp lệ");
  }

  if (
    contractCall.method &&
    !["relayerBuyTicket", "batchRelayerBuyTicket"].includes(contractCall.method)
  ) {
    throw new UnrecoverableError(
      `contractCall.method không hợp lệ: ${contractCall.method}`,
    );
  }

  // Ép phương thức xử lý của queue này luôn là mua gộp (Batch)
  const resolvedMethod = "batchRelayerBuyTicket";

  return {
    orderId: String(orderId),
    orderCode,
    method: resolvedMethod,
    eventIds,
    quantities,
    showId,
    buyerAddress,
    recipient,
    price,
    totalPrice,
    totalPriceVnd,
    exchangeRateVndPerUsdt,
    callbackUrl,
    callbackSecret,
    contractCall,
  };
}

function buildRelayerCallArgs(context) {
  if (context.method === "batchRelayerBuyTicket") {
    return [context.eventIds, context.quantities, context.buyerAddress];
  }

  return [context.eventIds[0], context.quantities[0], context.buyerAddress];
}

function serializeReceipt(receipt) {
  return JSON.parse(
    JSON.stringify(receipt, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
}

async function sendRelayerCallback(callbackUrl, callbackSecret, payload) {
  await axios.post(callbackUrl, payload, {
    headers: {
      "x-relayer-callback-secret": callbackSecret,
    },
    timeout: 15000,
  });
}

async function notifyRelayerCallback(context, payload) {
  await sendRelayerCallback(
    context.callbackUrl,
    context.callbackSecret,
    payload,
  );
}

async function processRelayerBuyJob(job) {
  const context = resolveJobPayload(job.data || {});

  console.log(
    `[RELAYER] Job ${job.id} -> orderId=${context.orderId}, method=${context.method}, eventIds=${JSON.stringify(context.eventIds)}, quantities=${JSON.stringify(context.quantities)}, buyer=${context.buyerAddress}`,
  );

  const relayerContext = await getBlockchainContext();

  try {
    const preflight = await getRelayerPreflightSnapshot(
      context.method,
      buildRelayerCallArgs(context),
      context.totalPrice,
    );

    if (
      !preflight.enoughNative ||
      (preflight.requiredUsdt !== null && !preflight.enoughUsdt)
    ) {
      const balanceMessage = [
        !preflight.enoughNative
          ? `native balance=${ethers.formatEther(preflight.nativeBalance)}`
          : null,
        preflight.requiredUsdt !== null && !preflight.enoughUsdt
          ? `usdt balance=${preflight.usdtBalance.toString()}`
          : null,
      ]
        .filter(Boolean)
        .join(", ");

      const errorMessage = `Ví relayer chưa đủ tài chính cho order ${context.orderId}: ${balanceMessage}`;
      await notifyRelayerCallback(context, {
        orderId: context.orderId,
        orderCode: context.orderCode,
        eventIds: context.eventIds,
        showId: context.showId,
        quantities: context.quantities,
        buyerAddress: context.buyerAddress,
        status: "failed",
        errorMessage,
      });

      throw new Error(errorMessage);
    }

    console.log(
      `[RELAYER] Preflight OK cho order ${context.orderId}. Đang gửi relayerBuyTicket...`,
    );

    const callArgs = buildRelayerCallArgs(context);

    const tx = await executeRelayerPurchase(context.method, callArgs);

    console.log(`[RELAYER] Đã gửi tx ${tx.hash}. Đang chờ receipt...`);

    const receipt = await tx.wait();

    if (!receipt) {
      throw new Error(`Không nhận được receipt cho txHash ${tx.hash}`);
    }

    if (receipt.status === 0) {
      const errorMessage = `Giao dịch ${tx.hash} đã revert trên chain`;
      await notifyRelayerCallback(context, {
        orderId: context.orderId,
        orderCode: context.orderCode,
        eventIds: context.eventIds,
        showId: context.showId,
        quantities: context.quantities,
        buyerAddress: context.buyerAddress,
        status: "failed",
        txHash: tx.hash,
        errorMessage,
      });
      throw new UnrecoverableError(errorMessage);
    }

    const tokenIds = parseMintedTokenIdsFromReceipt(receipt);

    const successPayload = {
      orderId: context.orderId,
      orderCode: context.orderCode,
      eventIds: context.eventIds,
      showId: context.showId,
      quantities: context.quantities,
      buyerAddress: context.buyerAddress,
      recipient: context.recipient,
      price: context.price,
      totalPrice:
        context.totalPrice !== undefined
          ? context.totalPrice.toString()
          : undefined,
      totalPriceVnd: context.totalPriceVnd,
      exchangeRateVndPerUsdt: context.exchangeRateVndPerUsdt,
      status: "success",
      txHash: tx.hash,
      chainId: relayerContext.chainId,
      contractAddress: relayerContext.contractAddress,
      blockNumber: receipt.blockNumber,
      relayerAddress: relayerContext.relayerAddress,
      tokenIds,
      receipt: serializeReceipt(receipt),
    };

    try {
      console.log(
        `[RELAYER] Gọi callback cho order ${context.orderId} với ví nhận vé: ${context.buyerAddress}${context.recipient ? `, recipient=${context.recipient}` : ""}`,
      );
      await notifyRelayerCallback(context, successPayload);
    } catch (callbackError) {
      console.error(
        `[RELAYER] Callback success thất bại cho order ${context.orderId}:`,
        callbackError.message,
      );
      throw new UnrecoverableError(
        `Đã mint on-chain thành công nhưng callback BE thất bại: ${callbackError.message}`,
      );
    }

    console.log(
      `[RELAYER] Hoàn thành order ${context.orderId}. Minted tokenIds=${tokenIds.join(", ")}`,
    );

    return {
      orderId: context.orderId,
      txHash: tx.hash,
      tokenIds,
    };
  } catch (error) {
    if (error instanceof UnrecoverableError) {
      throw error;
    }

    console.error(
      `[RELAYER] Lỗi xử lý order ${context.orderId}:`,
      error.message,
    );

    try {
      await notifyRelayerCallback(context, {
        orderId: context.orderId,
        orderCode: context.orderCode,
        eventIds: context.eventIds,
        showId: context.showId,
        quantities: context.quantities,
        buyerAddress: context.buyerAddress,
        status: "failed",
        errorMessage: error.message,
      });
    } catch (callbackError) {
      console.error(
        `[RELAYER] Callback failed thất bại cho order ${context.orderId}:`,
        callbackError.message,
      );
    }

    throw error;
  }
}

function isRelayerFatalFailure(error) {
  return error instanceof UnrecoverableError;
}

export {
  processRelayerBuyJob,
  isRelayerFatalFailure,
  resolveJobPayload,
  notifyRelayerCallback,
};
