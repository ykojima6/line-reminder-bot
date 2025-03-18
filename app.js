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

// Slack Webhook URL (環境変数として設定)
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
if (!SLACK_WEBHOOK_URL) {
  console.warn('警告: SLACK_WEBHOOK_URL が設定されていません。Slack通知は無効になります');
}

// ログ出力
console.log('環境変数の状態:');
console.log('LINE_CHANNEL_ACCESS_TOKEN exists:', !!process.env.LINE_CHANNEL_ACCESS_TOKEN);
console.log('LINE_CHANNEL_SECRET exists:', !!process.env.LINE_CHANNEL_SECRET);
console.log('SLACK_WEBHOOK_URL exists:', !!process.env.SLACK_WEBHOOK_URL);

// LINEクライアントを初期化
const client = new line.Client(config);

// 会話状態管理
// { userId: { 
//    userMessage: { text, timestamp, id }, 
//    botReply: { text, timestamp, id },
//    needsReply: boolean,
//    displayName: string,
//    sourceType: string 
// } }
const conversations = {};

// デバッグ用ログ履歴
const debugLogs = [];
function logDebug(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `${timestamp}: ${message}`;
  console.log(logEntry);
  debugLogs.unshift(logEntry);
  if (debugLogs.length > 100) {
    debugLogs.pop();
  }
}

// Slack通知用ペイロードをファイルから読み込み、対象のLINEユーザーIDで置換する関数
function loadSlackPayload(lineUserId) {
  const filePath = './slack_payload.json';
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const payload = JSON.parse(raw);
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
    return payload;
  } catch (error) {
    console.error('slack_payload.json 読み込みエラー:', error);
    return null;
  }
}

// Slackインタラクティブ通知送信関数
async function sendSlackInteractiveNotification(lineUserId) {
  const payload = loadSlackPayload(lineUserId);
  if (!payload) return;
  try {
    const response = await axios.post(SLACK_WEBHOOK_URL, payload);
    logDebug('Slack インタラクティブ通知送信しました, ステータス: ' + response.status);
  } catch (error) {
    console.error('Slack インタラクティブ通知送信エラー:', error.message);
  }
}

// ミドルウェア設定
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ルートパスへのハンドラー
app.get('/', (req, res) => {
  res.send('LINE Bot Server is running!');
});

// GET /webhook ハンドラー（デバッグ用）
app.get('/webhook', (req, res) => {
  res.send('LINE Bot Webhook is working. Please use POST method for actual webhook.');
});

// Slack通知送信関数（テキスト通知用）
async function sendSlackNotification(message) {
  if (!SLACK_WEBHOOK_URL) {
    logDebug('Slack Webhook URLが設定されていないため、通知をスキップします');
    return;
  }
  try {
    logDebug('Slack通知を送信します: ' + message.substring(0, 100) + (message.length > 100 ? '...' : ''));
    const response = await axios.post(SLACK_WEBHOOK_URL, { text: message });
    logDebug('Slack通知を送信しました, ステータス: ' + response.status);
  } catch (error) {
    console.error('Slack通知の送信に失敗しました:', error.message);
    if (error.response) {
      console.error('レスポンス:', error.response.status, error.response.data);
    }
  }
}

// 返信送信関数（独自ID生成を使用）
async function sendReplyAndRecord(event, messageText) {
  try {
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: messageText
    });
    // 公式APIからはメッセージIDが返らないため、独自にIDを生成
    const botMessageId = crypto.randomBytes(16).toString('hex');
    const userId = event.source.userId;
    logDebug(`ユーザー ${userId} に返信を送信しました。独自生成したメッセージID: ${botMessageId}`);
    if (conversations[userId]) {
      conversations[userId].botReply = {
        text: messageText,
        timestamp: Date.now(),
        id: botMessageId
      };
      conversations[userId].needsReply = false;
      logDebug(`ユーザー ${userId} の会話状態を更新しました - 返信済み`);
    }
    return true;
  } catch (error) {
    console.error('返信エラー:', error);
    return false;
  }
}

// プッシュメッセージ送信関数（独自ID生成）
async function sendPushMessageAndRecord(userId, messageText) {
  try {
    await client.pushMessage(userId, {
      type: 'text',
      text: messageText
    });
    const botMessageId = crypto.randomBytes(16).toString('hex');
    logDebug(`ユーザー ${userId} にプッシュメッセージを送信しました。独自生成したメッセージID: ${botMessageId}`);
    if (conversations[userId]) {
      conversations[userId].botReply = {
        text: messageText,
        timestamp: Date.now(),
        id: botMessageId
      };
      conversations[userId].needsReply = false;
      logDebug(`ユーザー ${userId} の会話状態を更新しました - 返信済み`);
    }
    return botMessageId;
  } catch (error) {
    console.error('メッセージ送信エラー:', error);
    return null;
  }
}

// LINE Bot Webhookエンドポイント（POST）
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!signature) {
    logDebug('署名がありません');
    return res.status(400).send('署名がありません');
  }
  const body = req.body;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const hmac = crypto.createHmac('SHA256', channelSecret);
  const bodyStr = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const digestFromBody = hmac.update(bodyStr).digest('base64');
  if (digestFromBody !== signature) {
    logDebug('署名が一致しません');
    logDebug('Expected: ' + digestFromBody);
    logDebug('Received: ' + signature);
    return res.status(400).send('署名が一致しません');
  }
  const parsedBody = Buffer.isBuffer(body) ? JSON.parse(body.toString()) : body;
  logDebug('Webhook received: ' + JSON.stringify(parsedBody).substring(0, 500) + '...');
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
  logDebug('イベント処理: ' + event.type + ' - イベントID: ' + (event.webhookEventId || 'なし'));
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }
  try {
    const userId = event.source.userId;
    const messageText = event.message.text;
    const messageId = event.message.id;
    const timestamp = event.timestamp;
    const isFromUser = !!event.replyToken;
    logDebug(`メッセージ送信者判定: userId=${userId}, isFromUser=${isFromUser}, replyToken=${!!event.replyToken}, messageId=${messageId}`);
    let senderProfile;
    try {
      if (event.source.type === 'room') {
        senderProfile = await client.getRoomMemberProfile(event.source.roomId, event.source.userId);
      } else if (event.source.type === 'group') {
        senderProfile = await client.getGroupMemberProfile(event.source.groupId, event.source.userId);
      } else if (event.source.type === 'user') {
        senderProfile = await client.getProfile(event.source.userId);
      }
    } catch (error) {
      console.log('プロフィール取得エラー:', error.message);
      senderProfile = { displayName: 'Unknown User' };
    }
    const userDisplayName = senderProfile ? senderProfile.displayName : 'Unknown User';
    const sourceType = event.source.type;
    
    // 緊急コマンド: "リセット"
    if (isFromUser && messageText === 'リセット') {
      Object.keys(conversations).forEach(uid => {
        conversations[uid].needsReply = false;
      });
      await sendSlackNotification(`*システムリセット*\n*ユーザー*: ${userDisplayName}\nすべての未返信状態をリセットしました。`);
      return sendReplyAndRecord(event, "システムをリセットしました。すべての未返信状態がクリアされました。");
    }
    
    // 特別コマンド: "全部返信済み" または "返信済み"
    if (isFromUser && (messageText === '全部返信済み' || messageText === 'すべて返信済み' || messageText === '返信済み')) {
      if (conversations[userId]) {
        conversations[userId].needsReply = false;
      }
      await sendSlackNotification(`*すべて返信済みにしました*\n*ユーザー*: ${userDisplayName}\nこのユーザーへの未返信状態をクリアしました。`);
      return sendReplyAndRecord(event, "未返信状態をクリアしました。");
    }
    
    // 特別コマンド: "ステータス" または "status"
    if (isFromUser && (messageText === 'ステータス' || messageText === 'status')) {
      const needsReply = conversations[userId] && conversations[userId].needsReply;
      let statusMessage;
      if (needsReply) {
        const lastMessageTime = new Date(conversations[userId].userMessage.timestamp).toLocaleString('ja-JP');
        statusMessage = `現在、あなたの未返信メッセージがあります。\n\n最後のメッセージ: "${conversations[userId].userMessage.text}"\n時間: ${lastMessageTime}`;
      } else {
        statusMessage = "現在、あなたへの未返信メッセージはありません。";
        if (conversations[userId] && conversations[userId].botReply) {
          const lastReplyTime = new Date(conversations[userId].botReply.timestamp).toLocaleString('ja-JP');
          statusMessage += `\n\n最後の返信: "${conversations[userId].botReply.text}"\n時間: ${lastReplyTime}`;
        }
      }
      logDebug(`ステータスチェック: ユーザー ${userId} の返信状態: ${needsReply ? '未返信あり' : '未返信なし'}`);
      return sendReplyAndRecord(event, statusMessage);
    }
    
    // 特別コマンド: "デバッグログ" または "debuglog"
    if (isFromUser && (messageText === 'デバッグログ' || messageText === 'debuglog')) {
      let pendingCount = 0;
      for (const uid in conversations) {
        if (conversations[uid].needsReply) {
          pendingCount++;
        }
      }
      const logMessage = `*デバッグ情報*\n未返信ユーザー数: ${pendingCount}\n\n最新のログ（最大10件）:\n${debugLogs.slice(0, 10).join('\n')}`;
      return sendReplyAndRecord(event, logMessage);
    }
    
    // 通常のメッセージの場合、会話状態を更新
    if (isFromUser) {
      if (!conversations[userId]) {
        conversations[userId] = {
          userMessage: { text: messageText, timestamp: timestamp, id: messageId },
          botReply: null,
          needsReply: true,
          displayName: userDisplayName,
          sourceType: sourceType
        };
        logDebug(`新規会話を作成: ユーザー ${userId}, メッセージ: ${messageText}`);
      } else {
        conversations[userId].userMessage = { text: messageText, timestamp: timestamp, id: messageId };
        conversations[userId].needsReply = true;
        logDebug(`既存会話を更新: ユーザー ${userId}, メッセージ: ${messageText}`);
      }
      const sourceTypeText = { 'user': '個別チャット', 'group': 'グループ', 'room': 'ルーム' }[sourceType] || '不明';
      await sendSlackNotification(`*新規メッセージ*\n*送信元*: ${sourceTypeText}\n*送信者*: ${userDisplayName}\n*内容*: ${messageText}\n*メッセージID*: ${messageId}`);
    }
    
  } catch (error) {
    console.error('メッセージ処理エラー:', error);
  }
  return Promise.resolve(null);
}

// Slackインタラクティブメッセージ処理用エンドポイント
// Slackからのリクエストは x-www-form-urlencoded 形式で、ペイロードは req.body.payload にJSON文字列として含まれます
app.post('/slack/actions', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload);
    logDebug('Slack interactive action payload: ' + JSON.stringify(payload));
    if (payload.callback_id === "mark_as_replied") {
      const action = payload.actions[0];
      // ボタンの value に対象のLINEユーザーIDがセットされている前提
      const lineUserId = action.value;
      logDebug(`Slackボタンが押されました。対象のLINEユーザーID: ${lineUserId}`);
      if (conversations[lineUserId]) {
        conversations[lineUserId].needsReply = false;
        logDebug(`ユーザー ${lineUserId} の会話をSlackアクションにより返信済みとマークしました`);
        return res.json({ text: "未返信リマインダーを停止しました。" });
      } else {
        return res.json({ text: "該当の会話が見つかりませんでした。" });
      }
    } else {
      res.status(400).send('不明なコールバックIDです');
    }
  } catch (error) {
    console.error('Slackアクション処理エラー:', error);
    res.status(500).send('内部エラー');
  }
});

// 外部から返信送信するエンドポイント
app.post('/api/send-reply', express.json(), async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) {
    return res.status(400).json({ success: false, error: 'ユーザーIDとメッセージが必要です' });
  }
  try {
    const botMessageId = await sendPushMessageAndRecord(userId, message);
    if (botMessageId) {
      res.status(200).json({ success: true, message: `ユーザー ${userId} にメッセージを送信しました`, messageId: botMessageId });
    } else {
      res.status(500).json({ success: false, message: `ユーザー ${userId} へのメッセージ送信に失敗しました` });
    }
  } catch (error) {
    console.error('メッセージ送信エラー:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 手動で返信済みマーク用エンドポイント
app.post('/api/mark-as-replied', express.json(), async (req, res) => {
  const { userId, message } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: 'ユーザーIDが必要です' });
  }
  try {
    if (!conversations[userId]) {
      return res.status(404).json({ success: false, message: `ユーザー ${userId} の会話が見つかりません` });
    }
    if (message) {
      const botMessageId = await sendPushMessageAndRecord(userId, message);
      if (botMessageId) {
        res.status(200).json({ success: true, message: `ユーザー ${userId} にメッセージを送信し、返信済みとしてマークしました`, messageId: botMessageId });
      } else {
        res.status(500).json({ success: false, message: `ユーザー ${userId} へのメッセージ送信に失敗しました` });
      }
    } else {
      conversations[userId].needsReply = false;
      logDebug(`ユーザー ${userId} の会話を手動で返信済みとしてマークしました`);
      res.status(200).json({ success: true, message: `ユーザー ${userId} の会話を返信済みとしてマークしました` });
    }
  } catch (error) {
    console.error('返信済みマークエラー:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ボットの返信IDを検証して返信済みとマークするエンドポイント
app.post('/api/verify-bot-reply', express.json(), async (req, res) => {
  const { userId, botMessageId } = req.body;
  if (!userId || !botMessageId) {
    return res.status(400).json({ success: false, error: 'userId と botMessageId は必須です' });
  }
  if (!conversations[userId]) {
    return res.status(404).json({ success: false, error: `ユーザー ${userId} の会話が見つかりません` });
  }
  if (conversations[userId].botReply && conversations[userId].botReply.id === botMessageId) {
    conversations[userId].needsReply = false;
    logDebug(`ユーザー ${userId} の会話を、botMessageId の検証により返信済みとマークしました`);
    return res.status(200).json({ success: true, message: `ユーザー ${userId} の会話を返信済みとマークしました` });
  } else {
    return res.status(400).json({ success: false, error: '指定された botMessageId は記録されている返信と一致しません' });
  }
});

// 1分ごとの未返信チェック（各ユーザーに対してインタラクティブ通知を送信）
let isCheckingUnreplied = false;
cron.schedule('* * * * *', async () => {
  if (isCheckingUnreplied) {
    logDebug('前回の未返信チェックが進行中のためスキップします');
    return;
  }
  isCheckingUnreplied = true;
  logDebug('1分間隔の未返信チェック実行中...');
  try {
    const now = Date.now();
    const oneMinuteInMs = 60 * 1000;
    let unrepliedUsers = [];
    for (const userId in conversations) {
      const convo = conversations[userId];
      if (convo.needsReply && convo.userMessage) {
        const elapsedTime = now - convo.userMessage.timestamp;
        const elapsedMinutes = Math.floor(elapsedTime / oneMinuteInMs);
        if (elapsedTime >= oneMinuteInMs) {
          unrepliedUsers.push({
            userId,
            name: convo.displayName,
            message: { text: convo.userMessage.text, id: convo.userMessage.id },
            elapsedMinutes,
            sourceType: convo.sourceType
          });
        }
      }
    }
    logDebug(`未返信ユーザー数: ${unrepliedUsers.length}`);
    // ここでは各未返信ユーザーに対して個別にSlackインタラクティブ通知を送信
    for (const user of unrepliedUsers) {
      await sendSlackInteractiveNotification(user.userId);
    }
  } catch (error) {
    console.error('未返信チェックエラー:', error);
  } finally {
    isCheckingUnreplied = false;
  }
});

// 6時間ごとの古いデータのクリーンアップ
cron.schedule('0 */6 * * *', () => {
  logDebug('古いメッセージデータをクリーンアップしています...');
  const now = Date.now();
  const oneDayInMs = 24 * 60 * 60 * 1000;
  let cleanupCount = 0;
  for (const userId in conversations) {
    const convo = conversations[userId];
    if (!convo.needsReply && convo.userMessage && (now - convo.userMessage.timestamp > oneDayInMs)) {
      delete conversations[userId];
      cleanupCount++;
    }
  }
  logDebug(`${cleanupCount}件の古い会話をクリーンアップしました`);
});

// 会話状態表示エンドポイント
app.get('/api/conversations', (req, res) => {
  let pendingCount = 0;
  for (const uid in conversations) {
    if (conversations[uid].needsReply) {
      pendingCount++;
    }
  }
  res.json({
    success: true,
    totalCount: Object.keys(conversations).length,
    pendingCount,
    conversations
  });
});

// デバッグログ表示エンドポイント
app.get('/api/debug-logs', (req, res) => {
  res.json({ success: true, count: debugLogs.length, logs: debugLogs });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logDebug(`Server running on port ${PORT}`);
});
