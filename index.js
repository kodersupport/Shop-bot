require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const BIN_ID = process.env.BIN_ID;
const MASTER_KEY = process.env.MASTER_KEY;

if (!BOT_TOKEN || !BIN_ID || !MASTER_KEY) {
  console.error('Thiếu BOT_TOKEN, BIN_ID hoặc MASTER_KEY trong Railway Variables.');
  process.exit(1);
}

// Chỉ chạy một tiến trình polling cho mỗi BOT_TOKEN.
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 1000,
    autoStart: true,
    params: {
      timeout: 10
    },
    retryTimeout: 5000
  }
});

const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

const headers = {
  'Content-Type': 'application/json',
  'X-Master-Key': MASTER_KEY
};

// ==================== JSONBIN ====================

async function getData() {
  try {
    const res = await axios.get(`${JSONBIN_URL}/latest`, {
      headers,
      timeout: 15000
    });

    const data = res.data.record || {};

    if (!Array.isArray(data.products)) {
      data.products = [];
    }

    if (!Array.isArray(data.orders)) {
      data.orders = [];
    }

    if (!Array.isArray(data.adminIds)) {
      data.adminIds = [];
    }

    return data;
  } catch (err) {
    console.error(
      'Lỗi đọc JSONBin:',
      err.response?.status || err.message
    );

    return null;
  }
}

async function saveData(data) {
  try {
    await axios.put(JSONBIN_URL, data, {
      headers,
      timeout: 15000
    });

    return true;
  } catch (err) {
    console.error(
      'Lỗi ghi JSONBin:',
      err.response?.status || err.message
    );

    return false;
  }
}

// ==================== TIỆN ÍCH ====================

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString('vi-VN') + 'đ';
}

function generateOrderId() {
  return (
    'ORD' +
    Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 6).toUpperCase()
  );
}

function getTypes(product) {
  return Array.isArray(product?.types) ? product.types : [];
}

function getTotalStock(product) {
  return getTypes(product).reduce(
    (sum, type) => sum + Number(type.stock || 0),
    0
  );
}

function createVietQRUrl(bank, amount, addInfo) {
  const base =
    `https://img.vietqr.io/image/` +
    `${encodeURIComponent(bank.bin)}-` +
    `${encodeURIComponent(bank.accountNo)}-compact2.png`;

  const params = new URLSearchParams({
    amount: String(amount),
    addInfo: addInfo,
    accountName: bank.accountName || ''
  });

  return `${base}?${params.toString()}`;
}

function createProductList(data) {
  let text = '🛒 *DANH SÁCH SẢN PHẨM*\n\n';
  const keyboard = [];

  data.products.forEach((product) => {
    const stock = getTotalStock(product);

    text += `• *${product.name}* (còn ${stock})\n`;

    keyboard.push([
      {
        text: `${product.name} (còn ${stock})`,
        callback_data: `prod|${product.id}`
      }
    ]);
  });

  return {
    text,
    keyboard
  };
}

async function answerCallback(query, options = {}) {
  try {
    await bot.answerCallbackQuery(query.id, options);
  } catch (err) {
    console.error('Lỗi callback:', err.message);
  }
}

// ==================== /START ====================

bot.onText(/^\/start(?:@\w+)?(?:\s|$)/, async (msg) => {
  const chatId = msg.chat.id;

  const data = await getData();

  if (!data) {
    await bot.sendMessage(
      chatId,
      'Hệ thống đang bảo trì, vui lòng thử lại sau.'
    );

    return;
  }

  if (data.products.length === 0) {
    await bot.sendMessage(
      chatId,
      'Hiện chưa có sản phẩm nào.'
    );

    return;
  }

  const list = createProductList(data);

  await bot.sendMessage(chatId, list.text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: list.keyboard
    }
  });
});

// ==================== /CHECKID ====================

bot.onText(/^\/checkid(?:@\w+)?(?:\s|$)/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `🆔 Telegram User ID của bạn là:\n\n\`${msg.from.id}\``,
    {
      parse_mode: 'Markdown'
    }
  );
});

// ==================== /ORDERS ====================

bot.onText(/^\/orders(?:@\w+)?(?:\s|$)/, async (msg) => {
  const data = await getData();

  if (!data) {
    await bot.sendMessage(
      msg.chat.id,
      'Không đọc được dữ liệu shop.'
    );

    return;
  }

  const adminIds = data.adminIds.map(String);

  if (!adminIds.includes(String(msg.from.id))) {
    await bot.sendMessage(
      msg.chat.id,
      'Bạn không phải Admin.'
    );

    return;
  }

  const pending = data.orders.filter(
    order => order.status === 'waiting_confirm'
  );

  if (pending.length === 0) {
    await bot.sendMessage(
      msg.chat.id,
      'Không có đơn nào đang chờ admin duyệt.'
    );

    return;
  }

  let text = `📋 *Đơn chờ duyệt (${pending.length})*\n\n`;

  pending.slice(0, 10).forEach((order, index) => {
    text +=
      `${index + 1}. ${order.id}\n` +
      `${order.productName} - ${order.typeName}\n` +
      `${formatMoney(order.price)}\n\n`;
  });

  await bot.sendMessage(msg.chat.id, text, {
    parse_mode: 'Markdown'
  });
});

// ==================== CALLBACK BUTTONS ====================

bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const userId = query.from.id;
    const callbackData = query.data || '';

    if (!chatId || !messageId) {
      await answerCallback(query, {
        text: 'Không tìm thấy tin nhắn.'
      });

      return;
    }

    // Nút hết hàng
    if (callbackData === 'noop') {
      await answerCallback(query, {
        text: 'Gói này đã hết hàng.'
      });

      return;
    }

    // Quay lại danh sách sản phẩm
    if (callbackData === 'back') {
      const data = await getData();

      if (!data) {
        await answerCallback(query, {
          text: 'Không đọc được dữ liệu shop.'
        });

        return;
      }

      const list = createProductList(data);

      await bot.editMessageText(list.text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: list.keyboard
        }
      });

      await answerCallback(query);
      return;
    }

    const data = await getData();

    if (!data) {
      await answerCallback(query, {
        text: 'Lỗi hệ thống, vui lòng thử lại.'
      });

      return;
    }

    // ==================== CHỌN SẢN PHẨM ====================

    if (callbackData.startsWith('prod|')) {
      const productId = callbackData.slice('prod|'.length);

      const product = data.products.find(
        item => String(item.id) === productId
      );

      if (!product) {
        await answerCallback(query, {
          text: 'Sản phẩm không tồn tại.'
        });

        return;
      }

      const types = getTypes(product);

      let text =
        `📦 *${product.name}*\n\n` +
        `Chọn loại:\n\n`;

      const keyboard = [];

      types.forEach((type) => {
        const stock = Number(type.stock || 0);

        text +=
          `• ${type.name}: ${formatMoney(type.price)} ` +
          `(còn ${stock})\n`;

        keyboard.push([
          {
            text: stock > 0
              ? `${type.name} - ${formatMoney(type.price)}`
              : `${type.name} (Hết hàng)`,

            callback_data: stock > 0
              ? `type|${product.id}|${type.id}`
              : 'noop'
          }
        ]);
      });

      keyboard.push([
        {
          text: '« Quay lại',
          callback_data: 'back'
        }
      ]);

      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: keyboard
        }
      });

      await answerCallback(query);
      return;
    }

    // ==================== CHỌN LOẠI SẢN PHẨM ====================

    if (callbackData.startsWith('type|')) {
      const parts = callbackData.split('|');

      const productId = parts[1];
      const typeId = parts.slice(2).join('|');

      const product = data.products.find(
        item => String(item.id) === productId
      );

      const type = product
        ? getTypes(product).find(
            item => String(item.id) === typeId
          )
        : null;

      if (!product || !type || Number(type.stock || 0) <= 0) {
        await answerCallback(query, {
          text: 'Sản phẩm hoặc gói đã hết hàng.'
        });

        return;
      }

      const bank = data.bank || {};

      if (!bank.bin || !bank.accountNo) {
        await answerCallback(query, {
          text: 'Shop chưa cấu hình ngân hàng.'
        });

        return;
      }

      const orderId = generateOrderId();
      const addInfo = `DH ${orderId}`;

      const qrUrl = createVietQRUrl(
        bank,
        type.price,
        addInfo
      );

      // Trạng thái pending = chờ thanh toán
      const newOrder = {
        id: orderId,
        userId: userId,
        username: query.from.username || '',
        firstName: query.from.first_name || '',
        fullName: [
          query.from.first_name,
          query.from.last_name
        ].filter(Boolean).join(' '),

        productId: product.id,
        typeId: type.id,

        productName: product.name,
        typeName: type.name,

        price: Number(type.price),
        status: 'pending',

        key: null,
        createdAt: new Date().toISOString()
      };

      data.orders.push(newOrder);

      const saved = await saveData(data);

      if (!saved) {
        await answerCallback(query, {
          text: 'Không lưu được đơn hàng. Vui lòng thử lại.'
        });

        return;
      }

      const caption =
        `💳 *THANH TOÁN ĐƠN HÀNG*\n\n` +
        `📦 Sản phẩm: *${product.name} - ${type.name}*\n` +
        `💰 Số tiền: *${formatMoney(type.price)}*\n` +
        `🆔 Mã đơn: \`${orderId}\`\n\n` +
        `Ngân hàng: ${bank.bankName || ''}\n` +
        `STK: \`${bank.accountNo}\`\n` +
        `Chủ TK: ${bank.accountName || ''}\n\n` +
        `Nội dung CK: \`${addInfo}\`\n\n` +
        `Quét mã QR, chuyển khoản đúng nội dung ` +
        `rồi bấm *Đã thanh toán*.`;

      await bot.sendPhoto(chatId, qrUrl, {
        caption: caption,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Đã thanh toán',
                callback_data: `paid|${orderId}`
              }
            ]
          ]
        }
      });

      await answerCallback(query);
      return;
    }

    // ==================== KHÁCH BẤM ĐÃ THANH TOÁN ====================

    if (callbackData.startsWith('paid|')) {
      const orderId = callbackData.slice('paid|'.length);

      const order = data.orders.find(
        item => String(item.id) === orderId
      );

      // Chỉ cho phép đơn pending chuyển sang waiting_confirm
      if (!order || order.status !== 'pending') {
        await answerCallback(query, {
          text: 'Đơn đã được xử lý hoặc không tồn tại.'
        });

        return;
      }

      // Admin Shop đang dùng waiting_confirm để duyệt đơn
      order.status = 'waiting_confirm';
      order.paidAt = new Date().toISOString();

      const saved = await saveData(data);

      if (!saved) {
        await answerCallback(query, {
          text: 'Không cập nhật được đơn. Vui lòng thử lại.'
        });

        return;
      }

      const adminIds = data.adminIds || [];

      const notifyText =
        `🔔 *ĐƠN HÀNG MỚI CẦN DUYỆT*\n\n` +
        `🆔 Mã: \`${order.id}\`\n` +
        `👤 ${order.fullName || order.username || 'Khách'} ` +
        `(@${order.username || 'none'})\n` +
        `ID: ${order.userId}\n` +
        `📦 ${order.productName} - ${order.typeName}\n` +
        `💰 ${formatMoney(order.price)}`;

      // Gửi thông báo cho admin
      for (const adminId of adminIds) {
        try {
          await bot.sendMessage(
            adminId,
            notifyText,
            {
              parse_mode: 'Markdown'
            }
          );
        } catch (err) {
          console.error(
            `Không gửi được thông báo admin ${adminId}:`,
            err.message
          );
        }
      }

      // Cập nhật caption tin nhắn khách
      try {
        await bot.editMessageCaption(
          `⏳ *YÊU CẦU ĐÃ GỬI ADMIN*\n\n` +
          `Mã đơn: \`${orderId}\`\n` +
          `Sản phẩm: ${order.productName} - ${order.typeName}\n` +
          `Số tiền: ${formatMoney(order.price)}`,

          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
          }
        );
      } catch (err) {
        console.error(
          'Không sửa được caption:',
          err.message
        );
      }

      await answerCallback(query, {
        text: 'Đã gửi yêu cầu duyệt cho admin.'
      });

      return;
    }

    await answerCallback(query, {
      text: 'Nút không hợp lệ hoặc đã hết hạn.'
    });

  } catch (err) {
    console.error(
      'Lỗi callback_query:',
      err.message
    );

    await answerCallback(query, {
      text: 'Có lỗi xảy ra, vui lòng thử lại.'
    });
  }
});

// ==================== POLLING ERROR ====================

bot.on('polling_error', (err) => {
  const status =
    err.response?.statusCode ||
    err.response?.status;

  const retryAfter =
    err.response?.body?.parameters?.retry_after;

  console.error(
    'Polling error:',
    status || '',
    err.message,
    retryAfter
      ? `| Telegram yêu cầu chờ ${retryAfter} giây`
      : ''
  );
});

bot.on('error', (err) => {
  console.error(
    'Telegram bot error:',
    err.message
  );
});

console.log('Bot đã khởi động. Đang kết nối Telegram...');
