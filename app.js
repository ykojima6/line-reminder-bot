const express = require('express');
const crypto = require('crypto');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const app = express();

// LINE API設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// 環境変数の検証
if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
  console.error('エラー: LINE_CHANNEL_ACCESS_TOKEN または LINE_CHANNEL_SECRET が設定されていません');
  process.exit(1);
}
if (!process.env.SLACK_WEBHOOK_URL) {
  console.warn('警告: SLACK_WEBHOOK_URL が設定されていません。Slack通知は無効になります');
}

// 環境変数ログ出力
console.log('環境変数の状態:');
console.log('LINE_CHANNEL_ACCESS_TOKEN exists:', !!process.env.LINE_CHANNEL_ACCESS_TOKEN);
console.log('LINE_CHANNEL_SECRET exists:', !!process.env.LINE_CHANNEL_SECRET);
console.log('SLACK_WEBHOOK_URL exists:', !!process.env.SLACK_WEBHOOK_URL);

// LINEクライアントの初期化
const client = new line.Client(config);

// 会話状態管理（各ユーザーの状態をオブジェクトで保持）
const conversations = {};

// デバッグ用ログ履歴
const debugLogs = [];
function logDebug(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `${timestamp}: ${message}`;
  console.log(logEntry);
  debugLogs.unshift(logEntry);
  if (debugLogs.length > 100) debugLogs.pop();
}

// ミドルウェア設定
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ルートパス（動作確認用）
app.get('/', (req, res) => {
  res.send('LINE Bot Server is running!');
});

// GET /webhook（デバッグ用）
app.get('/webhook', (req, res) => {
  res.send('LINE Bot Webhook is working. Please use POST method for actual webhook.');
});

// Slack通知用ペイロードを外部ファイルから読み込み、対象のLINEユーザーIDに置換する関数
function loadSlackPayload(lineUserId) {
  const filePath = './slack_payload.json';
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const payload = JSON.parse(raw);
    // 置換処理： attachments.actions の value が "Uxxxx" の場合、対象のユーザーIDに変更
    if (payload.attachments) {
      payload.attachments.forEach(attachment => {
        if (attachment.actions) {
          attachment.actions.forEach(action => {
            if (action.value === "Uxxxx") {
              action.value = lineUserId;
            }
          });
        }
      });
    }
    logDebug('slack_payload.json 読み込み成功');
    return payload;
  } catch (error) {
    console.error('slack_payload.json 読み込みエラー:', error);
    return null;
  }
}

// Slackインタラクティブ通知送信関数（対象ユーザーIDを渡す）
async function sendSlackInteractiveNotification(lineUserId) {
  const payload = loadSlackPayload(lineUserId);
  if (!payload) return;
  try {
    const response = await axios.post(SLACK_WEBHOOK_URL, payload);
    logDebug('Slack インタラクティブ通知送信成功, ステータス: ' + response.status);
  } catch (error) {
    console.error('Slack インタラクティブ通知送信エラー:', error.message);
  }
}

// 通常のテキスト通知用Slack送信関数
async function sendSlackNotification(message) {
  if (!SLACK_WEBHOOK_URL) {
    logDebug('Slack Webhook URLが設定されていないため、通知をスキップします');
    return;
  }
  try {
    logDebug('Slack通知送信中: ' + message.substring(0, 100));
    const response = await axios.post(SLACK_WEBHOOK_URL, { text: message });
    logDebug('Slack通知送信成功, ステータス: ' + response.status);
  } catch (error) {
    console.error('Slack通知送信エラー:', error.message);
    if (error.response) {
      console.error('レスポンス:', error.response.status, error.response.data);
    }
  }
}

// LINEへの返信送信（独自IDを生成して会話状態に記録）
async function sendReplyAndRecord(event, messageText) {
  try {
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: messageText
    });
    const botMessageId = crypto.randomBytes(16).toString('hex');
    const userId = event.source.userId;
    logDebug(`ユーザー ${userId} へ返信送信。生成ID: ${botMessageId}`);
    if (conversations[userId]) {
      conversations[userId].botReply = {
        text: messageText,
        timestamp: Date.now(),
        id: botMessageId
      };
      conversations[userId].needsReply = false;
      logDebug(`会話状態更新: ユーザー ${userId} 返信済みに設定`);
    }
    return true;
  } catch (error) {
    console.error('返信送信エラー:', error);
    return false;
  }
}

// プッシュメッセージ送信（独自IDを生成して記録）
async function sendPushMessageAndRecord(userId, messageText) {
  try {
    await client.pushMessage(userId, {
      type: 'text',
      text: messageText
    });
    const botMessageId = crypto.randomBytes(16).toString('hex');
    logDebug(`ユーザー ${userId} へプッシュ送信。生成ID: ${botMessageId}`);
    if (conversations[userId]) {
      conversations[userId].botReply = {
        text: messageText,
        timestamp: Date.now(),
        id: botMessageId
      };
      conversations[userId].needsReply = false;
      logDebug(`会話状態更新: ユーザー ${userId} 返信済みに設定`);
    }
    return botMessageId;
  } catch (error) {
    console.error('プッシュ送信エラー:', error);
    return null;
  }
}

// LINE Webhook エンドポイント
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!signature) {
    logDebug('署名が存在しません');
    return res.status(400).send('署名がありません');
  }
  const body = req.body;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const hmac = crypto.createHmac('SHA256', channelSecret);
  const bodyStr = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const digestFromBody = hmac.update(bodyStr).digest('base64');
  if (digestFromBody !== signature) {
    logDebug('署名不一致。Expected: ' + digestFromBody + ', Received: ' + signature);
    return res.status(400).send('署名が一致しません');
  }
  const parsedBody = Buffer.isBuffer(body) ? JSON.parse(body.toString()) : body;
  logDebug('Webhook受信: ' + JSON.stringify(parsedBody).substring(0, 500));
  if (!parsedBody || !parsedBody.events || !Array.isArray(parsedBody.events)) {
    logDebug('不正なリクエストボディ: ' + JSON.stringify(parsedBody));
    return res.status(400).send('不正なリクエストボディ');
  }
  res.status(200).end();
  Promise.all(parsedBody.events.map(handleEvent))
    .catch(err => {
      console.error('イベント処理エラー:', err);
    });
});

// LINEイベントハンドラー
async function handleEvent(event) {
  logDebug('イベント処理開始: ' + event.type + ' (ID: ' + (event.webhookEventId || 'なし') + ')');
  if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);
  try {
    const userId = event.source.userId;
    const messageText = event.message.text;
    const messageId = event.message.id;
    const timestamp = event.timestamp;
    const isFromUser = !!event.replyToken;
    logDebug(`受信メッセージ: userId=${userId}, isFromUser=${isFromUser}, messageId=${messageId}, text="${messageText}"`);
    
    // プロフィール取得（エラー発生時は Unknown User とする）
    let senderProfile;
    try {
      if (event.source.type === 'room') {
        senderProfile = await client.getRoomMemberProfile(event.source.roomId, userId);
      } else if (event.source.type === 'group') {
        senderProfile = await client.getGroupMemberProfile(event.source.groupId, userId);
      } else {
        senderProfile = await client.getProfile(userId);
      }
    } catch (error) {
      logDebug('プロフィール取得エラー: ' + error.message);
      senderProfile = { displayName: 'Unknown User' };
    }
    const userDisplayName = senderProfile.displayName || 'Unknown User';
    const sourceType = event.source.type;
    
    // コマンド処理（リセット、返信済み、ステータス、デバッグログなど）
    if (isFromUser) {
      if (messageText === 'リセット') {
        Object.keys(conversations).forEach(uid => { conversations[uid].needsReply = false; });
        await sendSlackNotification(`*システムリセット*\n*ユーザー*: ${userDisplayName}\n全ての未返信状態をリセットしました。`);
        return sendReplyAndRecord(event, "システムリセット完了。未返信状態をクリアしました。");
      }
      if (messageText === '全部返信済み' || messageText === 'すべて返信済み' || messageText === '返信済み') {
        if (conversations[userId]) conversations[userId].needsReply = false;
        await sendSlackNotification(`*返信済み*\n*ユーザー*: ${userDisplayName}\n未返信状態をクリアしました。`);
        return sendReplyAndRecord(event, "返信済みにしました。");
      }
      if (messageText === 'ステータス' || messageText === 'status') {
        const needsReply = conversations[userId] && conversations[userId].needsReply;
        let statusMessage = needsReply
          ? `未返信です。\n最後のメッセージ: "${conversations[userId].userMessage.text}"\n時間: ${new Date(conversations[userId].userMessage.timestamp).toLocaleString('ja-JP')}`
          : "返信済みです。";
        if (conversations[userId] && conversations[userId].botReply) {
          statusMessage += `\n最後の返信: "${conversations[userId].botReply.text}"\n時間: ${new Date(conversations[userId].botReply.timestamp).toLocaleString('ja-JP')}`;
        }
        logDebug(`ステータス確認: ユーザー ${userId} → ${statusMessage}`);
        return sendReplyAndRecord(event, statusMessage);
      }
      if (messageText === 'デバッグログ' || messageText === 'debuglog') {
        let pendingCount = Object.keys(conversations).reduce((acc, uid) => acc + (conversations[uid].needsReply ? 1 : 0), 0);
        const logMessage = `未返信ユーザー数: ${pendingCount}\n最新ログ:\n${debugLogs.slice(0, 10).join('\n')}`;
        return sendReplyAndRecord(event, logMessage);
      }
    }
    
    // 通常メッセージの場合、会話状態を更新
    if (isFromUser) {
      if (!conversations[userId]) {
        conversations[userId] = {
          userMessage: { text: messageText, timestamp, id: messageId },
          botReply: null,
          needsReply: true,
          displayName: userDisplayName,
          sourceType
        };
        logDebug(`新規会話作成: ユーザー ${userId}, テキスト: ${messageText}`);
      } else {
        conversations[userId].userMessage = { text: messageText, timestamp, id: messageId };
        conversations[userId].needsReply = true;
        logDebug(`既存会話更新: ユーザー ${userId}, テキスト: ${messageText}`);
      }
      const sourceTypeText = { 'user': '個別チャット', 'group': 'グループ', 'room': 'ルーム' }[sourceType] || '不明';
      await sendSlackNotification(`*新規メッセージ*\n*送信元*: ${sourceTypeText}\n*送信者*: ${userDisplayName}\n*内容*: ${messageText}\n*メッセージID*: ${messageId}`);
    }
  } catch (error) {
    console.error('イベント処理エラー:', error);
  }
  return Promise.resolve(null);
}

// Slackインタラクティブアクション受信用エンドポイント
app.post('/slack/actions', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload);
    logDebug('Slackアクション受信: ' + JSON.stringify(payload));
    if (payload.callback_id === "mark_as_replied") {
      const action = payload.actions[0];
      // ボタンの value に対象のLINEユーザーIDがセットされている前提
      const lineUserId = action.value;
      logDebug(`Slackボタン押下: 対象ユーザー ${lineUserId}`);
      if (conversations[lineUserId]) {
        conversations[lineUserId].needsReply = false;
        logDebug(`会話更新: ユーザー ${lineUserId} を返信済みに設定`);
        return res.json({ text: "未返信リマインダーを停止しました。" });
      } else {
        return res.json({ text: "該当する会話が見つかりませんでした。" });
      }
    } else {
      res.status(400).send('不明なコールバックIDです');
    }
  } catch (error) {
    console.error('Slackアクション処理エラー:', error);
    res.status(500).send('内部エラー');
  }
});

// 外部から返信送信用エンドポイント
app.post('/api/send-reply', express.json(), async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) {
    return res.status(400).json({ success: false, error: 'ユーザーIDとメッセージは必須です' });
  }
  try {
    const botMessageId = await sendPushMessageAndRecord(userId, message);
    if (botMessageId) {
      res.status(200).json({ success: true, message: `ユーザー ${userId} にメッセージ送信`, messageId: botMessageId });
    } else {
      res.status(500).json({ success: false, message: `送信失敗: ユーザー ${userId}` });
    }
  } catch (error) {
    console.error('送信エラー:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 手動で返信済みマーク用エンドポイント
app.post('/api/mark-as-replied', express.json(), async (req, res) => {
  const { userId, message } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: 'ユーザーIDは必須です' });
  }
  try {
    if (!conversations[userId]) {
      return res.status(404).json({ success: false, message: `ユーザー ${userId} の会話が見つかりません` });
    }
    if (message) {
      const botMessageId = await sendPushMessageAndRecord(userId, message);
      if (botMessageId) {
        res.status(200).json({ success: true, message: `ユーザー ${userId} に送信し、返信済みに設定`, messageId: botMessageId });
      } else {
        res.status(500).json({ success: false, message: `送信失敗: ユーザー ${userId}` });
      }
    } else {
      conversations[userId].needsReply = false;
      logDebug(`手動更新: ユーザー ${userId} を返信済みに設定`);
      res.status(200).json({ success: true, message: `ユーザー ${userId} を返信済みに更新` });
    }
  } catch (error) {
    console.error('返信済み更新エラー:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ボット返信ID検証エンドポイント
app.post('/api/verify-bot-reply', express.json(), async (req, res) => {
  const { userId, botMessageId } = req.body;
  if (!userId || !botMessageId) {
    return res.status(400).json({ success: false, error: 'ユーザーIDとbotMessageIdは必須です' });
  }
  if (!conversations[userId]) {
    return res.status(404).json({ success: false, error: `ユーザー ${userId} の会話が見つかりません` });
  }
  if (conversations[userId].botReply && conversations[userId].botReply.id === botMessageId) {
    conversations[userId].needsReply = false;
    logDebug(`検証成功: ユーザー ${userId} を返信済みに設定`);
    return res.status(200).json({ success: true, message: `ユーザー ${userId} を返信済みに更新` });
  } else {
    return res.status(400).json({ success: false, error: 'botMessageIdが一致しません' });
  }
});

// 1分ごとの未返信チェック（各ユーザーへSlackインタラクティブ通知送信）
let isCheckingUnreplied = false;
cron.schedule('* * * * *', async () => {
  if (isCheckingUnreplied) {
    logDebug('前回の未返信チェック中のためスキップ');
    return;
  }
  isCheckingUnreplied = true;
  logDebug('1分ごとの未返信チェック開始');
  try {
    const now = Date.now();
    const oneMinute = 60 * 1000;
    let unrepliedUsers = [];
    for (const userId in conversations) {
      const convo = conversations[userId];
      if (convo.needsReply && convo.userMessage) {
        const elapsed = now - convo.userMessage.timestamp;
        const minutes = Math.floor(elapsed / oneMinute);
        if (elapsed >= oneMinute) {
          unrepliedUsers.push({ userId, minutes });
        }
      }
    }
    logDebug(`未返信ユーザー数: ${unrepliedUsers.length}`);
    // 各未返信ユーザーに対してSlackインタラクティブ通知を送信
    for (const user of unrepliedUsers) {
      logDebug(`Slack通知送信対象: ユーザー ${user.userId}（未返信 ${user.minutes} 分）`);
      await sendSlackInteractiveNotification(user.userId);
    }
  } catch (error) {
    console.error('未返信チェックエラー:', error);
  } finally {
    isCheckingUnreplied = false;
  }
});

// 6時間ごとに古いデータをクリーンアップ
cron.schedule('0 */6 * * *', () => {
  logDebug('6時間ごとのクリーンアップ開始');
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const userId in conversations) {
    const convo = conversations[userId];
    if (!convo.needsReply && convo.userMessage && (now - convo.userMessage.timestamp > oneDay)) {
      delete conversations[userId];
      removed++;
    }
  }
  logDebug(`クリーンアップ完了: ${removed} 件削除`);
});

// 会話状態確認エンドポイント
app.get('/api/conversations', (req, res) => {
  res.json({ success: true, conversations });
});

// デバッグログ確認エンドポイント
app.get('/api/debug-logs', (req, res) => {
  res.json({ success: true, logs: debugLogs });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logDebug(`Server running on port ${PORT}`);
});
