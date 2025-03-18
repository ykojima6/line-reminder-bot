const express = require('express');
const crypto = require('crypto');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const app = express();

// ---------------------------------------------------
// 1) LINE/Slackの設定＆初期化
// ---------------------------------------------------
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('エラー: LINE_CHANNEL_ACCESS_TOKEN または LINE_CHANNEL_SECRET が設定されていません');
  process.exit(1);
}

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
if (!SLACK_WEBHOOK_URL) {
  console.warn('警告: SLACK_WEBHOOK_URL が設定されていません。Slack通知は無効になります');
}

console.log('環境変数の状態:');
console.log('LINE_CHANNEL_ACCESS_TOKEN exists:', !!config.channelAccessToken);
console.log('LINE_CHANNEL_SECRET exists:', !!config.channelSecret);
console.log('SLACK_WEBHOOK_URL exists:', !!SLACK_WEBHOOK_URL);

const client = new line.Client(config);

// ---------------------------------------------------
// 2) 会話状態管理
// ---------------------------------------------------
// { userId: {
//    userMessage: { text, timestamp, id },
//    botReply: { text, timestamp, id },
//    needsReply: boolean,
//    displayName: string,
//    sourceType: string
// } }
const conversations = {};

// ---------------------------------------------------
// 3) デバッグログ管理
// ---------------------------------------------------
const debugLogs = [];
function logDebug(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `${timestamp}: ${message}`;
  console.log(logEntry);
  debugLogs.unshift(logEntry);
  if (debugLogs.length > 100) debugLogs.pop();
}

// ---------------------------------------------------
// 4) ミドルウェア設定
// ---------------------------------------------------
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------
// 5) Slack通知用のヘルパー
// ---------------------------------------------------

// (A) slack_payload.json を読み込み、"Uxxxx" を lineUserId に置換 & カスタムテキストを設定
function loadSlackPayload(lineUserId, customText) {
  try {
    const raw = fs.readFileSync('./slack_payload.json', 'utf8');
    const payload = JSON.parse(raw);
    // customText が渡されていれば本文を上書き
    if (customText) {
      payload.text = `*【LINEからの新着メッセージ】*\n${customText}`;
    }
    if (payload.attachments) {
      payload.attachments.forEach(attachment => {
        if (attachment.actions) {
          attachment.actions.forEach(action => {
            if (action.value === 'Uxxxx') {
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

// (B) インタラクティブ通知を送る
async function sendSlackInteractiveNotification(lineUserId, customText) {
  if (!SLACK_WEBHOOK_URL) {
    logDebug('Slack Webhook URLが未設定のため送信できません');
    return;
  }
  const payload = loadSlackPayload(lineUserId, customText);
  if (!payload) return;
  try {
    const response = await axios.post(SLACK_WEBHOOK_URL, payload);
    logDebug(`Slackインタラクティブ通知送信成功: ${response.status}`);
  } catch (error) {
    logDebug(`Slackインタラクティブ通知送信失敗: ${error.message}`);
  }
}

// (C) 単純なテキスト通知
async function sendSlackNotification(message) {
  if (!SLACK_WEBHOOK_URL) {
    logDebug('Slack Webhook URLが未設定のため送信できません');
    return;
  }
  try {
    const response = await axios.post(SLACK_WEBHOOK_URL, { text: message });
    logDebug(`Slackテキスト通知送信成功: ${response.status}`);
  } catch (error) {
    logDebug(`Slackテキスト通知送信失敗: ${error.message}`);
  }
}

// ---------------------------------------------------
// 6) LINE Bot 用Webhookエンドポイント
// ---------------------------------------------------
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!signature) {
    logDebug('署名がありません');
    return res.status(400).send('署名がありません');
  }

  const channelSecret = config.channelSecret;
  const hmac = crypto.createHmac('SHA256', channelSecret);
  const bodyStr = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  const digestFromBody = hmac.update(bodyStr).digest('base64');

  if (digestFromBody !== signature) {
    logDebug(`署名不一致: Expected=${digestFromBody}, Received=${signature}`);
    return res.status(400).send('署名が一致しません');
  }

  const parsedBody = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
  if (!parsedBody || !parsedBody.events || !Array.isArray(parsedBody.events)) {
    logDebug('不正なリクエストボディ');
    return res.status(400).send('不正なリクエストボディ');
  }

  res.status(200).end(); // 先に200を返す

  Promise.all(parsedBody.events.map(handleLineEvent))
    .catch(err => {
      console.error('イベント処理エラー:', err);
    });
});

// ---------------------------------------------------
// 7) LINEイベントハンドラー
// ---------------------------------------------------
async function handleLineEvent(event) {
  logDebug(`イベント処理開始: type=${event.type}, webhookEventId=${event.webhookEventId || 'なし'}`);
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const messageText = event.message.text;
  const messageId = event.message.id;
  const timestamp = event.timestamp;
  const isFromUser = !!event.replyToken;

  logDebug(`受信: userId=${userId}, text="${messageText}", isFromUser=${isFromUser}`);

  // プロフィール取得
  let displayName = 'Unknown User';
  try {
    if (event.source.type === 'room') {
      const profile = await client.getRoomMemberProfile(event.source.roomId, userId);
      displayName = profile.displayName || 'Unknown User';
    } else if (event.source.type === 'group') {
      const profile = await client.getGroupMemberProfile(event.source.groupId, userId);
      displayName = profile.displayName || 'Unknown User';
    } else {
      const profile = await client.getProfile(userId);
      displayName = profile.displayName || 'Unknown User';
    }
  } catch (error) {
    logDebug(`プロフィール取得失敗: ${error.message}`);
  }

  // 特殊コマンド判定
  if (isFromUser) {
    if (messageText === 'リセット') {
      Object.keys(conversations).forEach(uid => { conversations[uid].needsReply = false; });
      await sendSlackNotification(`「リセット」コマンド: ${displayName} の全未返信をクリア`);
      return replyAndRecord(event, '全ての未返信状態をリセットしました。');
    }
    if (['全部返信済み', 'すべて返信済み', '返信済み'].includes(messageText)) {
      if (conversations[userId]) conversations[userId].needsReply = false;
      await sendSlackNotification(`「返信済み」コマンド: ${displayName} の未返信をクリア`);
      return replyAndRecord(event, '未返信状態をクリアしました。');
    }
    if (['ステータス', 'status'].includes(messageText)) {
      const c = conversations[userId];
      let statusMessage = c && c.needsReply
        ? `未返信です。\n最後のメッセージ: "${c.userMessage.text}"\n時間: ${new Date(c.userMessage.timestamp).toLocaleString('ja-JP')}`
        : '返信済みです。';
      if (c && c.botReply) {
        statusMessage += `\n最後の返信: "${c.botReply.text}"\n時間: ${new Date(c.botReply.timestamp).toLocaleString('ja-JP')}`;
      }
      return replyAndRecord(event, statusMessage);
    }
    if (['デバッグログ', 'debuglog'].includes(messageText)) {
      const pendingCount = Object.values(conversations).filter(c => c.needsReply).length;
      const logPreview = debugLogs.slice(0, 5).join('\n');
      return replyAndRecord(event, `未返信ユーザー数: ${pendingCount}\n最新ログ:\n${logPreview}`);
    }
  }

  // 通常のメッセージの場合、会話状態を更新し新着メッセージ用のSlack通知を送信
  if (isFromUser) {
    if (!conversations[userId]) {
      conversations[userId] = {
        userMessage: { text: messageText, timestamp, id: messageId },
        botReply: null,
        needsReply: true,
        displayName,
        sourceType: event.source.type
      };
      logDebug(`新規会話作成: userId=${userId}, text="${messageText}"`);
    } else {
      conversations[userId].userMessage = { text: messageText, timestamp, id: messageId };
      conversations[userId].needsReply = true;
      logDebug(`既存会話更新: userId=${userId}, text="${messageText}"`);
    }
    // 新着メッセージ用のインタラクティブ通知（即時送信）
    const customText = `【${displayName}】からのメッセージ：「${messageText}」`;
    await sendSlackInteractiveNotification(userId, customText);
  }
}

// 返信して会話状態を更新するヘルパー
async function replyAndRecord(event, replyText) {
  try {
    await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
    const userId = event.source.userId;
    if (conversations[userId]) {
      const botMessageId = crypto.randomBytes(16).toString('hex');
      conversations[userId].botReply = {
        text: replyText,
        timestamp: Date.now(),
        id: botMessageId
      };
      conversations[userId].needsReply = false;
      logDebug(`replyAndRecord: userId=${userId}, reply="${replyText}"`);
    }
  } catch (error) {
    logDebug(`返信エラー: ${error.message}`);
  }
}

// ---------------------------------------------------
// 8) Slackアクション受信用エンドポイント（返事したボタン）
// ---------------------------------------------------
app.post('/slack/actions', express.urlencoded({ extended: true }), (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload);
    logDebug(`Slackアクション受信: ${JSON.stringify(payload)}`);

    if (payload.callback_id === 'mark_as_replied') {
      const action = payload.actions[0];
      const lineUserId = action.value;
      logDebug(`「返事した」ボタン押下: lineUserId=${lineUserId}`);
      if (conversations[lineUserId]) {
        conversations[lineUserId].needsReply = false;
        logDebug(`会話更新: userId=${lineUserId} を返信済みに設定`);
        return res.json({ text: "返信済みにしました。" });
      } else {
        logDebug(`該当会話なし: userId=${lineUserId}`);
        return res.json({ text: "該当の会話が見つかりませんでした。" });
      }
    } else {
      logDebug('不明な callback_id: ' + payload.callback_id);
      return res.status(400).send('不明なコールバックIDです');
    }
  } catch (error) {
    logDebug(`Slackアクション処理エラー: ${error.message}`);
    return res.status(500).send('内部エラー');
  }
});

// ---------------------------------------------------
// 9) 手動操作用API（返信送信、返信済みマークなど）
// ---------------------------------------------------
app.post('/api/send-reply', express.json(), async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) {
    return res.status(400).json({ success: false, error: 'userId と message は必須です' });
  }
  try {
    await client.pushMessage(userId, { type: 'text', text: message });
    const botMessageId = crypto.randomBytes(16).toString('hex');
    if (conversations[userId]) {
      conversations[userId].botReply = { text: message, timestamp: Date.now(), id: botMessageId };
      conversations[userId].needsReply = false;
    }
    return res.json({ success: true, message: '送信成功', botMessageId });
  } catch (error) {
    logDebug(`push送信エラー: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/mark-as-replied', express.json(), (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId は必須です' });
  }
  if (!conversations[userId]) {
    return res.status(404).json({ success: false, message: '該当の会話が見つかりません' });
  }
  conversations[userId].needsReply = false;
  return res.json({ success: true, message: '返信済みにしました' });
});

// ---------------------------------------------------
// 10) 定期的な未返信チェック（1分ごと）
// ---------------------------------------------------
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
    const oneMinuteMs = 60 * 1000;
    const unreplied = [];

    for (const userId in conversations) {
      const c = conversations[userId];
      if (c.needsReply && c.userMessage) {
        const diff = now - c.userMessage.timestamp;
        if (diff >= oneMinuteMs) {
          unreplied.push({
            userId,
            displayName: c.displayName,
            text: c.userMessage.text,
            timestamp: c.userMessage.timestamp
          });
        }
      }
    }

    logDebug(`未返信ユーザー数: ${unreplied.length}`);

    // 各未返信ユーザーに対して、詳細なリマインダー通知を送信
    for (const entry of unreplied) {
      const customText = `リマインダー: ${entry.displayName}さんからのメッセージ「${entry.text}」にまだ返信がありません。`;
      logDebug(`リマインダー送信: userId=${entry.userId}, message="${entry.text}"`);
      await sendSlackInteractiveNotification(entry.userId, customText);
    }
  } catch (error) {
    logDebug(`未返信チェックエラー: ${error.message}`);
  } finally {
    isCheckingUnreplied = false;
  }
});

// ---------------------------------------------------
// 11) 6時間ごとの古いデータクリーンアップ
// ---------------------------------------------------
cron.schedule('0 */6 * * *', () => {
  logDebug('6時間ごとのクリーンアップ開始');
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const userId in conversations) {
    const c = conversations[userId];
    if (!c.needsReply && c.userMessage && (now - c.userMessage.timestamp > oneDayMs)) {
      delete conversations[userId];
      cleaned++;
    }
  }

  logDebug(`クリーンアップ完了: ${cleaned} 件削除`);
});

// ---------------------------------------------------
// 12) デバッグ用エンドポイント
// ---------------------------------------------------
app.get('/api/conversations', (req, res) => {
  res.json({ success: true, conversations });
});

app.get('/api/debug-logs', (req, res) => {
  res.json({ success: true, logs: debugLogs });
});

// ---------------------------------------------------
// 13) サーバー起動
// ---------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logDebug(`Server running on port ${PORT}`);
});
