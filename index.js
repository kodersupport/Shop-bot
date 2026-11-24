
require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// =====================================================
// CONFIG
// =====================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const BIN_ID = process.env.JSONBIN_BIN_ID || process.env.BIN_ID;
const MASTER_KEY = process.env.JSONBIN_MASTER_KEY || process.env.MASTER_KEY;

const SHOP_NAME = process.env.SHOP_NAME || "SHOP";
const BANK_CODE = process.env.BANK_CODE || "";
const BANK_ACCOUNT = process.env.BANK_ACCOUNT || "";
const BANK_ACCOUNT_NAME = process.env.BANK_ACCOUNT_NAME || "";

if (!BOT_TOKEN) throw new Error("Thiếu biến BOT_TOKEN");
if (!BIN_ID) throw new Error("Thiếu JSONBIN_BIN_ID hoặc BIN_ID");
if (!MASTER_KEY) throw new Error("Thiếu JSONBIN_MASTER_KEY hoặc MASTER_KEY");

// =====================================================
// TELEGRAM
// Không bật polling tự động.
// Bot sẽ tự gọi getUpdates và xử lý retry_after.
// =====================================================

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false
});

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function getTelegramRetryAfter(err) {
  return (
    err?.response?.body?.parameters?.retry_after ||
    err?.response?.body?.parameters?.retryAfter ||
    err?.response?.data?.parameters?.retry_after ||
    err?.response?.data?.parameters?.retryAfter ||
    0
  );
}

function getTelegramErrorCode(err) {
  return (
    err?.response?.body?.error_code ||
    err?.response?.data?.error_code ||
    err?.code ||
    0
  );
}

// Gọi Telegram API có retry khi bị giới hạn 429.
async function telegramCall(fn, label = "Telegram API") {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;

      const code = getTelegramErrorCode(err);
      const retryAfter = Number(getTelegramRetryAfter(err)) || 0;

      if (code === 429 || retryAfter > 0) {
        const waitMs = Math.max(retryAfter * 1000, 1000) + 1000;

        console.warn(
          `${label}: Telegram 429, chờ ${Math.ceil(waitMs / 1000)} giây`
        );

        await sleep(waitMs);
        continue;
      }

      if (attempt < 4 && (code === 500 || code === 502 || code === 503)) {
        await sleep(attempt * 3000);
        continue;
      }

      throw err;
    }
  }
}

async function sendMessage(chatId, text, options = {}) {
  return telegramCall(
    () => bot.sendMessage(chatId, text, options),
    "sendMessage"
  );
}

async function answerCallback(callbackId, text = "") {
  return telegramCall(
    () =>
      bot.answerCallbackQuery(callbackId, {
        text: text || undefined,
        show_alert: false
      }),
    "answerCallbackQuery"
  );
}

async function sendPhoto(chatId, photo, options = {}) {
  return telegramCall(
    () => bot.sendPhoto(chatId, photo, options),
    "sendPhoto"
  );
}

// =====================================================
// JSONBIN
// =====================================================

const BIN_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

const binClient = axios.create({
  timeout: 20000,
  headers: {
    "Content-Type": "application/json",
    "X-Master-Key": MASTER_KEY
  }
});

function defaultData() {
  return {
    version: 1,
    products: [],
    adminTelegramIds: [],
    orders: [],
    settings: {}
  };
}

async function getData() {
  const response = await binClient.get(`${BIN_URL}/latest`);
  const data = response.data?.record;

  if (!data || typeof data !== "object") {
    throw new Error("JSONBin không trả về dữ liệu hợp lệ");
  }

  if (!Array.isArray(data.products)) data.products = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  if (!Array.isArray(data.adminTelegramIds)) {
    data.adminTelegramIds = [];
  }
  if (!data.settings || typeof data.settings !== "object") {
    data.settings = {};
  }

  return data;
}

// Xếp hàng các lần ghi để tránh ghi đè dữ liệu lẫn nhau.
let writeQueue = Promise.resolve();

function updateData(mutator) {
  const task = writeQueue.then(async () => {
    const data = await getData();

    await mutator(data);

    await binClient.put(BIN_URL, data);

    return data;
  });

  writeQueue = task.catch((err) => {
    console.error("Lỗi ghi JSONBin:", err.message);
  });

  return task;
}

// =====================================================
// HELPERS
// =====================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(value) {
  const number = Number(value) || 0;

  return number.toLocaleString("vi-VN") + "đ";
}

function getUserName(user) {
  if (user.username) return `@${user.username}`;

  const name = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ");

  return name || "Khách hàng";
}

function isAdmin(data, userId) {
  return (data.adminTelegramIds || []).some(
    (id) => String(id) === String(userId)
  );
}

function findProduct(data, productId) {
  return (data.products || []).find(
    (product) => String(product.id) === String(productId)
  );
}

function findType(product, typeId) {
  return (product?.types || []).find(
    (type) => String(type.id) === String(typeId)
  );
}

function getStock(type) {
  const stock = Number(type?.stock);

  if (!Number.isFinite(stock)) return 0;

  return Math.max(0, stock);
}

function getProductDescription(product) {
  return product.description || "Không có mô tả.";
}

function makeOrderId() {
  return (
    Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 6).toUpperCase()
  );
}

function getPaymentInfo(data, order) {
  const settings = data.settings || {};

  const bankCode =
    settings.bankCode ||
    settings.bank_code ||
    BANK_CODE;

  const bankAccount =
    settings.bankAccount ||
    settings.bank_account ||
    BANK_ACCOUNT;

  const bankAccountName =
    settings.bankAccountName ||
    settings.bank_account_name ||
    BANK_ACCOUNT_NAME;

  const amount = Number(order.price) || 0;

  const transferContent = `DH ${order.id}`;

  if (bankCode && bankAccount) {
    const qrUrl =
      "https://img.vietqr.io/image/" +
      `${encodeURIComponent(bankCode)}-${encodeURIComponent(bankAccount)}-compact2.png` +
      `?amount=${encodeURIComponent(amount)}` +
      `&addInfo=${encodeURIComponent(transferContent)}` +
      `&accountName=${encodeURIComponent(bankAccountName)}`;

    return {
      bankCode,
      bankAccount,
      bankAccountName,
      amount,
      transferContent,
      qrUrl
    };
  }

  return {
    bankCode: "",
    bankAccount: "",
    bankAccountName: "",
    amount,
    transferContent,
    qrUrl: ""
  };
}

// =====================================================
// ADMIN NOTIFICATION
// =====================================================

async function notifyAdmins(data, message) {
  const admins = data.adminTelegramIds || [];

  for (const adminId of admins) {
    try {
      await sendMessage(adminId, message);
    } catch (err) {
      console.error(
        "Không gửi được thông báo admin:",
        String(adminId),
        err.message
      );
    }

    // Tránh gửi tin quá dồn dập.
    await sleep(1200);
  }
}

// =====================================================
// COMMANDS
// =====================================================

bot.onText(/^\/start(?:@\w+)?(?:\s.*)?$/, async (msg) => {
  try {
    const chatId = msg.chat.id;

    const text =
      `👋 Xin chào ${msg.from.first_name || "bạn"}!\n\n` +
      `Chào mừng bạn đến với ${SHOP_NAME}.\n\n` +
      `🛍 Bấm nút bên dưới để xem sản phẩm.\n` +
      `📦 Dùng /orders để xem đơn hàng.\n` +
      `🆔 Dùng /checkid để xem Telegram ID.`;

    await sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🛍 XEM SẢN PHẨM",
              callback_data: "shop"
            }
          ],
          [
            {
              text: "📦 ĐƠN HÀNG CỦA TÔI",
              callback_data: "myorders"
            }
          ]
        ]
      }
    });
  } catch (err) {
    console.error("Lỗi /start:", err.message);
  }
});

bot.onText(/^\/checkid(?:@\w+)?$/, async (msg) => {
  try {
    await sendMessage(
      msg.chat.id,
      `🆔 Telegram ID của bạn:\n${msg.from.id}`
    );
  } catch (err) {
    console.error("Lỗi /checkid:", err.message);
  }
});

bot.onText(/^\/orders(?:@\w+)?$/, async (msg) => {
  await showMyOrders(msg.chat.id, msg.from.id);
});

// =====================================================
// SHOW PRODUCTS
// =====================================================

async function showProducts(chatId) {
  try {
    const data = await getData();

    const products = (data.products || []).filter(
      (product) => product.active !== false
    );

    if (!products.length) {
      await sendMessage(chatId, "Hiện chưa có sản phẩm nào.");
      return;
    }

    const keyboard = [];

    for (const product of products) {
      const types = product.types || [];

      const minPrice = types.length
        ? Math.min(...types.map((type) => Number(type.price) || 0))
        : 0;

      keyboard.push([
        {
          text: `${product.name} — từ ${money(minPrice)}`,
          callback_data: `product:${product.id}`
        }
      ]);
    }

    await sendMessage(
      chatId,
      `🛍 DANH SÁCH SẢN PHẨM\n\nChọn sản phẩm bạn muốn mua:`,
      {
        reply_markup: {
          inline_keyboard: keyboard
        }
      }
    );
  } catch (err) {
    console.error("Lỗi hiển thị sản phẩm:", err.message);

    await sendMessage(
      chatId,
      "⚠️ Không tải được sản phẩm. Vui lòng thử lại sau."
    );
  }
}

// =====================================================
// SHOW PRODUCT TYPES
// =====================================================

async function showProductTypes(chatId, productId) {
  try {
    const data = await getData();
    const product = findProduct(data, productId);

    if (!product || product.active === false) {
      await sendMessage(chatId, "Sản phẩm không tồn tại hoặc đã ngừng bán.");
      return;
    }

    const types = product.types || [];

    if (!types.length) {
      await sendMessage(chatId, "Sản phẩm này chưa có loại/gói bán.");
      return;
    }

    const keyboard = [];

    for (const type of types) {
      const stock = getStock(type);

      const label =
        `${type.name} — ${money(type.price)}` +
        ` (Kho: ${stock})`;

      keyboard.push([
        {
          text: label,
          callback_data: `type:${product.id}:${type.id}`
        }
      ]);
    }

    keyboard.push([
      {
        text: "⬅️ Quay lại sản phẩm",
        callback_data: "shop"
      }
    ]);

    const description =
      `📦 ${product.name}\n\n` +
      `${getProductDescription(product)}\n\n` +
      `Chọn loại/gói bạn muốn mua:`;

    await sendMessage(chatId, description, {
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
  } catch (err) {
    console.error("Lỗi hiển thị loại sản phẩm:", err.message);

    await sendMessage(
      chatId,
      "⚠️ Không tải được thông tin sản phẩm."
    );
  }
}

// =====================================================
// CREATE ORDER
// =====================================================

async function createOrder(chatId, user, productId, typeId) {
  try {
    let createdOrder = null;

    await updateData(async (data) => {
      const product = findProduct(data, productId);

      if (!product || product.active === false) {
        throw new Error("Sản phẩm không tồn tại hoặc đã ngừng bán.");
      }

      const type = findType(product, typeId);

      if (!type) {
        throw new Error("Loại sản phẩm không tồn tại.");
      }

      if (getStock(type) <= 0) {
        throw new Error("Loại sản phẩm này đã hết hàng.");
      }

      const orderId = makeOrderId();

      createdOrder = {
        id: orderId,
        userId: user.id,
        username: user.username || "",
        customerName: getUserName(user),
        productId: product.id,
        productName: product.name,
        typeId: type.id,
        typeName: type.name,
        price: Number(type.price) || 0,
        status: "pending",
        createdAt: new Date().toISOString()
      };

      data.orders.push(createdOrder);
    });

    const data = await getData();
    const payment = getPaymentInfo(data, createdOrder);

    let message =
      `🧾 ĐƠN HÀNG ĐÃ TẠO\n\n` +
      `Mã đơn: ${createdOrder.id}\n` +
      `Sản phẩm: ${createdOrder.productName}\n` +
      `Loại/gói: ${createdOrder.typeName}\n` +
      `Số tiền: ${money(createdOrder.price)}\n\n`;

    if (payment.bankAccount) {
      message +=
        `🏦 Ngân hàng: ${payment.bankCode}\n` +
        `💳 Số tài khoản: ${payment.bankAccount}\n` +
        `👤 Chủ tài khoản: ${payment.bankAccountName}\n` +
        `💰 Số tiền: ${money(payment.amount)}\n` +
        `📝 Nội dung chuyển khoản: ${payment.transferContent}\n\n` +
        `Vui lòng chuyển khoản đúng số tiền và nội dung.`;
    } else {
      message +=
        `Vui lòng liên hệ admin để nhận thông tin thanh toán.`;
    }

    if (payment.qrUrl) {
      await sendPhoto(chatId, payment.qrUrl, {
        caption: message,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ ĐÃ THANH TOÁN",
                callback_data: `paid:${createdOrder.id}`
              }
            ],
            [
              {
                text: "📦 ĐƠN HÀNG CỦA TÔI",
                callback_data: "myorders"
              }
            ]
          ]
        }
      });
    } else {
      await sendMessage(chatId, message, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ ĐÃ THANH TOÁN",
                callback_data: `paid:${createdOrder.id}`
              }
            ],
            [
              {
                text: "📦 ĐƠN HÀNG CỦA TÔI",
                callback_data: "myorders"
              }
            ]
          ]
        }
      });
    }

    const adminMessage =
      `🆕 ĐƠN HÀNG MỚI\n\n` +
      `Mã đơn: ${createdOrder.id}\n` +
      `Khách: ${createdOrder.customerName}\n` +
      `Telegram ID: ${createdOrder.userId}\n` +
      `Sản phẩm: ${createdOrder.productName}\n` +
      `Loại/gói: ${createdOrder.typeName}\n` +
      `Giá: ${money(createdOrder.price)}\n` +
      `Trạng thái: pending`;

    await notifyAdmins(data, adminMessage);
  } catch (err) {
    console.error("Lỗi tạo đơn:", err.message);

    await sendMessage(
      chatId,
      `⚠️ Không tạo được đơn hàng.\n${err.message}`
    );
  }
}

// =====================================================
// CUSTOMER MARKED PAID
// pending -> waiting_confirm
// =====================================================

async function markOrderPaid(chatId, userId, orderId) {
  try {
    let targetOrder = null;

    await updateData(async (data) => {
      const order = (data.orders || []).find(
        (item) => String(item.id) === String(orderId)
      );

      if (!order) throw new Error("Không tìm thấy đơn hàng.");

      if (String(order.userId) !== String(userId)) {
        throw new Error("Bạn không có quyền thao tác đơn hàng này.");
      }

      if (order.status !== "pending") {
        throw new Error("Đơn hàng không ở trạng thái chờ thanh toán.");
      }

      order.status = "waiting_confirm";
      order.paidRequestedAt = new Date().toISOString();

      targetOrder = order;
    });

    const data = await getData();

    await sendMessage(
      chatId,
      `✅ Đã gửi yêu cầu xác nhận thanh toán.\n\n` +
        `Mã đơn: ${targetOrder.id}\n\n` +
        `VUI LÒNG CHỜ ADMIN DUYỆT TRONG ÍT PHÚT….`
    );

    const adminMessage =
      `🔔 KHÁCH BÁO ĐÃ THANH TOÁN\n\n` +
      `Mã đơn: ${targetOrder.id}\n` +
      `Khách Telegram ID: ${targetOrder.userId}\n` +
      `Sản phẩm: ${targetOrder.productName}\n` +
      `Loại/gói: ${targetOrder.typeName}\n` +
      `Số tiền: ${money(targetOrder.price)}\n` +
      `Trạng thái: waiting_confirm\n\n` +
      `Vui lòng kiểm tra giao dịch và duyệt đơn trong trang Admin.`;

    await notifyAdmins(data, adminMessage);
  } catch (err) {
    console.error("Lỗi xác nhận thanh toán:", err.message);

    await sendMessage(chatId, `⚠️ ${err.message}`);
  }
}

// =====================================================
// CUSTOMER ORDERS
// =====================================================

async function showMyOrders(chatId, userId) {
  try {
    const data = await getData();

    const orders = (data.orders || [])
      .filter((order) => String(order.userId) === String(userId))
      .sort(
        (a, b) =>
          new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
      )
      .slice(0, 10);

    if (!orders.length) {
      await sendMessage(chatId, "Bạn chưa có đơn hàng nào.");
      return;
    }

    const statusNames = {
      pending: "Chờ thanh toán",
      waiting_confirm: "Chờ admin xác nhận",
      paid: "Đã thanh toán / hoàn tất",
      cancelled: "Đã hủy"
    };

    let message = "📦 ĐƠN HÀNG CỦA BẠN\n\n";

    for (const order of orders) {
      message +=
        `Mã đơn: ${order.id}\n` +
        `Sản phẩm: ${order.productName || ""}\n` +
        `Loại/gói: ${order.typeName || ""}\n` +
        `Giá: ${money(order.price)}\n` +
        `Trạng thái: ${statusNames[order.status] || order.status}\n\n`;
    }

    await sendMessage(chatId, message);
  } catch (err) {
    console.error("Lỗi xem đơn hàng:", err.message);

    await sendMessage(
      chatId,
      "⚠️ Không tải được đơn hàng. Vui lòng thử lại."
    );
  }
}

// =====================================================
// CALLBACK QUERY
// =====================================================

bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id;
  const userId = query.from.id;
  const data = query.data || "";

  try {
    await answerCallback(query.id);

    if (!chatId) return;

    if (data === "shop") {
      await showProducts(chatId);
      return;
    }

    if (data === "myorders") {
      await showMyOrders(chatId, userId);
      return;
    }

    if (data.startsWith("product:")) {
      const productId = data.slice("product:".length);

      await showProductTypes(chatId, productId);
      return;
    }

    if (data.startsWith("type:")) {
      const parts = data.split(":");

      const productId = parts[1];
      const typeId = parts[2];

      await createOrder(
        chatId,
        query.from,
        productId,
        typeId
      );

      return;
    }

    if (data.startsWith("paid:")) {
      const orderId = data.slice("paid:".length);

      await markOrderPaid(chatId, userId, orderId);
      return;
    }
  } catch (err) {
    console.error("Lỗi callback:", err.message);

    if (chatId) {
      await sendMessage(
        chatId,
        "⚠️ Có lỗi xảy ra. Vui lòng thử lại."
      ).catch(() => {});
    }
  }
});

// =====================================================
// MESSAGE ERROR HANDLING
// =====================================================

bot.on("polling_error", (err) => {
  console.error("Telegram polling error:", err.message);
});

bot.on("webhook_error", (err) => {
  console.error("Telegram webhook error:", err.message);
});

// =====================================================
// MANUAL POLLING LOOP
// - Chỉ một getUpdates chạy tại một thời điểm.
// - Tôn trọng retry_after khi Telegram trả 429.
// - Không tự gọi startPolling nhiều lần.
// =====================================================

let pollingStopped = false;
let updateOffset = 0;

async function pollingLoop() {
  console.log("Bot đang bắt đầu kết nối Telegram...");

  while (!pollingStopped) {
    try {
      const updates = await bot.getUpdates({
        offset: updateOffset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"]
      });

      if (!Array.isArray(updates)) {
        await sleep(1000);
        continue;
      }

      for (const update of updates) {
        updateOffset = update.update_id + 1;

        try {
          bot.processUpdate(update);
        } catch (err) {
          console.error("Lỗi xử lý update:", err.message);
        }
      }
    } catch (err) {
      const code = getTelegramErrorCode(err);
      const retryAfter = Number(getTelegramRetryAfter(err)) || 0;

      if (code === 429 || retryAfter > 0) {
        const waitMs = Math.max(retryAfter * 1000, 1000) + 1000;

        console.warn(
          `Telegram 429: chờ ${Math.ceil(waitMs / 1000)} giây rồi thử lại.`
        );

        await sleep(waitMs);
        continue;
      }

      if (code === 409) {
        console.error(
          "Telegram 409: Có tiến trình khác đang getUpdates bằng token này. " +
          "Hãy tắt bot chạy trùng."
        );

        await sleep(15000);
        continue;
      }

      console.error("Lỗi polling:", err.message);

      await sleep(5000);
    }
  }
}

// =====================================================
// START
// =====================================================

async function startBot() {
  try {
    // Kiểm tra JSONBin trước khi bắt đầu nhận update.
    await getData();

    console.log("JSONBin kết nối thành công.");
    console.log("Shop:", SHOP_NAME);
    console.log("Bot đã khởi động.");

    pollingLoop().catch((err) => {
      console.error("Polling loop bị dừng:", err.message);
    });
  } catch (err) {
    console.error("Không thể khởi động bot:", err.message);
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  console.log("Nhận SIGTERM, đang dừng bot...");
  pollingStopped = true;
});

process.on("SIGINT", () => {
  console.log("Nhận SIGINT, đang dừng bot...");
  pollingStopped = true;
});

startBot();
