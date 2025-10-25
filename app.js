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
function initializeLineChannels() {
  const channels = [];
  const rawConfigs = process.env.LINE_CHANNEL_CONFIGS;

  if (rawConfigs) {
    try {
      const parsed = JSON.parse(rawConfigs);
      if (!Array.isArray(parsed)) {
        throw new Error('配列ではありません');
      }

      parsed.forEach((entry, index) => {
        if (!entry || !entry.channelAccessToken || !entry.channelSecret) {
          throw new Error(`index=${index} の設定に channelAccessToken または channelSecret がありません`);
        }

        const channelId = entry.id || entry.channelId || entry.destination || `channel-${index + 1}`;
        const channelLabel = entry.label || entry.name || channelId;
        channels.push({
          id: channelId,
          label: channelLabel,
          channelSecret: entry.channelSecret,
          destination: entry.destination || entry.botUserId || null,
          client: new line.Client({ channelAccessToken: entry.channelAccessToken })
        });
      });

      if (channels.length === 0) {
        throw new Error('有効なLINEチャンネル設定が見つかりませんでした');
      }
    } catch (error) {
      console.error('エラー: LINE_CHANNEL_CONFIGS の解析に失敗しました:', error.message);
      process.exit(1);
    }
  }

  if (channels.length === 0) {
    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const channelSecret = process.env.LINE_CHANNEL_SECRET;

    if (!channelAccessToken || !channelSecret) {
      console.error('エラー: LINE_CHANNEL_ACCESS_TOKEN または LINE_CHANNEL_SECRET が設定されていません');
      process.exit(1);
    }

    const channelId = process.env.LINE_PRIMARY_CHANNEL_ID || 'default';
    const channelLabel = process.env.LINE_CHANNEL_LABEL || process.env.LINE_CHANNEL_NAME || channelId;

    channels.push({
      id: channelId,
      label: channelLabel,
      channelSecret,
      destination: process.env.LINE_DESTINATION_ID || null,
      client: new line.Client({ channelAccessToken })
    });
  }

  return channels;
}

const lineChannels = initializeLineChannels();

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
if (!SLACK_WEBHOOK_URL) {
  console.warn('警告: SLACK_WEBHOOK_URL が設定されていません。Slack通知は無効になります');
}

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://line-reminder-bot-de113f80aa92.herokuapp.com';

console.log('環境変数の状態:');
console.log('LINE_CHANNEL_CONFIGS exists:', !!process.env.LINE_CHANNEL_CONFIGS);
console.log('LINE_CHANNEL_ACCESS_TOKEN exists:', !!process.env.LINE_CHANNEL_ACCESS_TOKEN);
console.log('LINE_CHANNEL_SECRET exists:', !!process.env.LINE_CHANNEL_SECRET);
console.log('SLACK_WEBHOOK_URL exists:', !!SLACK_WEBHOOK_URL);
console.log('APP_BASE_URL:', APP_BASE_URL);
console.log('登録済みLINEチャンネル:', lineChannels.map(channel => `${channel.id} (${channel.label})`));

// ---------------------------------------------------
// 2) 会話状態管理
// ---------------------------------------------------
// { "<channelId>:<userId>": {
//    channelId: string,
//    channelLabel: string,
//    lineUserId: string,
//    userMessage: { text, timestamp, id },
//    botReply: { text, timestamp, id },
//    needsReply: boolean,
//    displayName: string,
//    sourceType: string,
//    lastReminderTime: number, // 最後にリマインダーを送信した時間
//    reminderCount: number,    // リマインダーの送信回数
//    securityToken: string     // セキュリティトークン
// } }
const conversations = {};

function getConversationKey(channelId, userId) {
  return `${channelId}:${userId}`;
}

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
// 4) セキュリティトークン生成
// ---------------------------------------------------
function generateSecurityToken() {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------
// 5) ミドルウェア設定
// ---------------------------------------------------
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------
// 6) Slack通知用のヘルパー
// ---------------------------------------------------

// (A) 直接テキストメッセージとリンクを作成
function createSlackMessage(conversationKey, customText, isReminder = false, reminderCount = 0) {
  const conversation = conversations[conversationKey];
  if (!conversation) {
    throw new Error(`conversation not found for key=${conversationKey}`);
  }

  const securityToken = conversation.securityToken || generateSecurityToken();
  conversation.securityToken = securityToken;

  const markAsRepliedUrl = `${APP_BASE_URL}/api/mark-as-replied-confirm?channelId=${encodeURIComponent(conversation.channelId)}&userId=${encodeURIComponent(conversation.lineUserId)}&token=${encodeURIComponent(securityToken)}`;

  const titleParts = [];
  if (conversation.channelLabel) {
    titleParts.push(conversation.channelLabel);
  }
  if (isReminder) {
    titleParts.push(`リマインダー${reminderCount > 0 ? ` #${reminderCount}` : ''}`.trim());
  } else {
    titleParts.push('LINEからの新着メッセージ');
  }

  const prefix = `*【${titleParts.join(' / ')}】*`;

  return {
    text: `${prefix}\n${customText}\n\n返信済みにするには以下のリンクをクリックしてください:\n${markAsRepliedUrl}`,
    unfurl_links: false
  };
}

// (B) インタラクティブ通知を送る（修正版）
async function sendSlackInteractiveNotification(conversationKey, customText, isReminder = false, reminderCount = 0) {
  if (!SLACK_WEBHOOK_URL) {
    logDebug('Slack Webhook URLが未設定のため送信できません');
    return;
  }

  let message;
  try {
    message = createSlackMessage(conversationKey, customText, isReminder, reminderCount);
  } catch (error) {
    logDebug(`Slack通知用メッセージ作成に失敗: conversationKey=${conversationKey}, error=${error.message}`);
    return;
  }

  try {
    const response = await axios.post(SLACK_WEBHOOK_URL, message);
    logDebug(`Slack通知送信成功: ${response.status}`);
  } catch (error) {
    logDebug(`Slack通知送信失敗: ${error.message}`);
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
// 7) LINE Bot 用Webhookエンドポイント
// ---------------------------------------------------
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!signature) {
    logDebug('署名がありません');
    return res.status(400).send('署名がありません');
  }

  const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

  let matchedChannel = null;

  for (const channel of lineChannels) {
    const hmac = crypto.createHmac('SHA256', channel.channelSecret);
    const digest = hmac.update(bodyBuffer).digest('base64');
    if (digest === signature) {
      matchedChannel = channel;
      break;
    }
  }

  if (!matchedChannel) {
    logDebug(`署名不一致: Received=${signature}`);
    return res.status(400).send('署名が一致しません');
  }

  logDebug(`署名検証成功: channelId=${matchedChannel.id}`);

  const parsedBody = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
  if (!parsedBody || !parsedBody.events || !Array.isArray(parsedBody.events)) {
    logDebug('不正なリクエストボディ');
    return res.status(400).send('不正なリクエストボディ');
  }

  res.status(200).end(); // 先に200を返す

  Promise.all(parsedBody.events.map(event => handleLineEvent(event, matchedChannel)))
    .catch(err => {
      console.error('イベント処理エラー:', err);
    });
});

// ---------------------------------------------------
// 8) LINEイベントハンドラー
// ---------------------------------------------------
async function handleLineEvent(event, lineChannel) {
  logDebug(`イベント処理開始: channelId=${lineChannel.id}, type=${event.type}, webhookEventId=${event.webhookEventId || 'なし'}`);
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const client = lineChannel.client;
  const userId = event.source.userId;
  const messageText = event.message.text;
  const messageId = event.message.id;
  const timestamp = event.timestamp;
  const isFromUser = !!event.replyToken;
  const sourceType = event.source.type;
  const conversationKey = getConversationKey(lineChannel.id, userId);

  logDebug(`受信: channelId=${lineChannel.id}, userId=${userId}, sourceType=${sourceType}, text="${messageText}", isFromUser=${isFromUser}`);

  // グループからのメッセージは無視する（特定のコマンドは処理）
  if (sourceType === 'group' || sourceType === 'room') {
    // 特定のコマンドのみ処理
    if (['ステータス', 'status', 'デバッグログ', 'debuglog'].includes(messageText)) {
      logDebug(`グループ/ルームからのコマンド: ${messageText}`);
      // コマンド処理は続行
    } else {
      logDebug(`グループ/ルームからの通常メッセージのため処理をスキップ: ${sourceType}`);
      return;
    }
  }

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
    if (['ステータス', 'status'].includes(messageText)) {
      const c = conversations[conversationKey];
      let statusMessage = c && c.needsReply
        ? `未返信です。\n最後のメッセージ: "${c.userMessage.text}"\n時間: ${new Date(c.userMessage.timestamp).toLocaleString('ja-JP')}`
        : '返信済みです。';
      if (c && c.botReply) {
        statusMessage += `\n最後の返信: "${c.botReply.text}"\n時間: ${new Date(c.botReply.timestamp).toLocaleString('ja-JP')}`;
      }
      return client.replyMessage(event.replyToken, { type: 'text', text: statusMessage });
    }
    if (['デバッグログ', 'debuglog'].includes(messageText)) {
      const pendingCount = Object.values(conversations).filter(c => c.needsReply).length;
      const logPreview = debugLogs.slice(0, 5).join('\n');
      return client.replyMessage(event.replyToken, { type: 'text', text: `未返信ユーザー数: ${pendingCount}\n最新ログ:\n${logPreview}` });
    }
  }

  // 通常のメッセージの場合、会話状態を更新し新着メッセージ用のSlack通知を送信
  // グループメッセージは上で既にフィルターされているので、ここでの sourceType チェックは不要
  if (isFromUser) {
    // セキュリティトークンを生成
    const securityToken = generateSecurityToken();

    if (!conversations[conversationKey]) {
      conversations[conversationKey] = {
        channelId: lineChannel.id,
        channelLabel: lineChannel.label,
        lineUserId: userId,
        userMessage: { text: messageText, timestamp, id: messageId },
        botReply: null,
        needsReply: true,
        displayName,
        sourceType,
        lastReminderTime: 0,     // 最後にリマインダーを送信した時間（初期値：0）
        reminderCount: 0,        // リマインダーの送信回数（初期値：0）
        securityToken            // セキュリティトークン
      };
      logDebug(`新規会話作成: channelId=${lineChannel.id}, userId=${userId}, text="${messageText}"`);
    } else {
      conversations[conversationKey].userMessage = { text: messageText, timestamp, id: messageId };
      conversations[conversationKey].needsReply = true;
      conversations[conversationKey].lastReminderTime = 0; // 新しいメッセージでリセット
      conversations[conversationKey].reminderCount = 0;    // 新しいメッセージでリセット
      conversations[conversationKey].securityToken = securityToken; // セキュリティトークン更新
      conversations[conversationKey].channelLabel = lineChannel.label;
      logDebug(`既存会話更新: channelId=${lineChannel.id}, userId=${userId}, text="${messageText}"`);
    }
    // 新着メッセージ用のインタラクティブ通知（即時送信）
    const customText = `【${displayName}】からのメッセージ：「${messageText}」`;
    await sendSlackInteractiveNotification(conversationKey, customText);
  }
}

// ---------------------------------------------------
// 9) 確認ページ表示エンドポイント（新設）
// ---------------------------------------------------
app.get('/api/mark-as-replied-confirm', (req, res) => {
  let { userId, token, channelId } = req.query;
  if (!userId || !token) {
    return res.send('エラー: 必須パラメータが不足しています');
  }

  if (!channelId) {
    if (lineChannels.length === 1) {
      channelId = lineChannels[0].id;
    } else {
      return res.send('エラー: channelId が必要です');
    }
  }

  const conversationKey = getConversationKey(channelId, userId);
  const conversation = conversations[conversationKey];

  if (!conversation) {
    return res.send('エラー: 該当のユーザーが見つかりません');
  }

  // トークン検証
  if (conversation.securityToken !== token) {
    logDebug(`トークン不一致: channelId=${channelId}, userId=${userId}, expected=${conversation.securityToken}, received=${token}`);
    return res.send('エラー: セキュリティトークンが無効です');
  }

  const displayName = conversation.displayName || 'Unknown User';
  const messageText = conversation.userMessage ? conversation.userMessage.text : '';

  // 確認ページをレンダリング
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>返信済み確認</title>
      <style>
        body { font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; text-align: center; }
        .message { margin: 20px 0; padding: 15px; background: #f5f5f5; border-radius: 8px; }
        .confirm { margin: 30px 0; }
        .btn { display: inline-block; padding: 10px 20px; background: #4CAF50; color: white; text-decoration: none; border-radius: 4px; font-weight: bold; }
        .btn:hover { background: #45a049; }
        .back { margin-top: 20px; color: #666; }
      </style>
    </head>
    <body>
      <h2>返信済みにする確認</h2>
      <p>以下のメッセージを返信済みにしますか？</p>
      <div class="message">
        <p><strong>ユーザー:</strong> ${displayName}</p>
        ${conversation.channelLabel ? `<p><strong>受信先アカウント:</strong> ${conversation.channelLabel}</p>` : ''}
        <p><strong>メッセージ:</strong> ${messageText}</p>
      </div>
      <div class="confirm">
        <a href="/api/mark-as-replied-web?channelId=${encodeURIComponent(channelId)}&userId=${encodeURIComponent(userId)}&token=${encodeURIComponent(token)}" class="btn">はい、返信済みにする</a>
      </div>
      <div class="back">
        <a href="javascript:window.close()">キャンセル</a>
      </div>
    </body>
    </html>
  `);
});

// ---------------------------------------------------
// 10) Web用返信済みマーク設定エンドポイント（トークン検証付き）
// ---------------------------------------------------
app.get('/api/mark-as-replied-web', (req, res) => {
  let { userId, token, channelId } = req.query;
  if (!userId || !token) {
    return res.send('エラー: 必須パラメータが不足しています');
  }

  if (!channelId) {
    if (lineChannels.length === 1) {
      channelId = lineChannels[0].id;
    } else {
      return res.send('エラー: channelId が必要です');
    }
  }

  const conversationKey = getConversationKey(channelId, userId);
  const conversation = conversations[conversationKey];

  if (!conversation) {
    return res.send('エラー: 該当のユーザーが見つかりません');
  }

  // トークン検証
  if (conversation.securityToken !== token) {
    logDebug(`トークン不一致: channelId=${channelId}, userId=${userId}, expected=${conversation.securityToken}, received=${token}`);
    return res.send('エラー: セキュリティトークンが無効です');
  }

  try {
    conversation.needsReply = false;
    conversation.lastReminderTime = 0;  // リマインダー情報をリセット
    conversation.reminderCount = 0;     // リマインダー情報をリセット
    logDebug(`会話更新（Web経由）: channelId=${channelId}, userId=${userId} を返信済みに設定`);

    // 成功ページをレンダリング
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>返信済みに設定しました</title>
        <style>
          body { font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; text-align: center; }
          .success { color: #4CAF50; font-size: 24px; margin: 20px 0; }
          .info { margin: 20px 0; color: #555; }
        </style>
      </head>
      <body>
        <div class="success">✅ 返信済みに設定しました</div>
        <div class="info">このウィンドウは閉じて構いません</div>
      </body>
      </html>
    `);
  } catch (error) {
    logDebug(`Web経由の返信済み処理エラー: ${error.message}`);
    res.send('エラー: 処理中に問題が発生しました');
  }
});

// ---------------------------------------------------
// 11) 定期的な未返信チェック（15分ごと）
// ---------------------------------------------------
let isCheckingUnreplied = false;
// 毎時00分、15分、30分、45分に実行するようにスケジュールを変更
cron.schedule('0,15,30,45 * * * *', async () => {
  if (isCheckingUnreplied) {
    logDebug('前回の未返信チェック中のためスキップ');
    return;
  }
  isCheckingUnreplied = true;
  logDebug('未返信チェック開始');

  try {
    const now = Date.now();
    // 3時間をミリ秒に変換（3時間 × 60分 × 60秒 × 1000ミリ秒）
    const threeHoursMs = 3 * 60 * 60 * 1000;
    const unreplied = [];

    for (const conversationKey in conversations) {
      const c = conversations[conversationKey];
      // グループメッセージは未返信リマインダーから除外
      if (c.needsReply && c.userMessage && (c.sourceType !== 'group' && c.sourceType !== 'room')) {
        const timeSinceMessage = now - c.userMessage.timestamp;
        const timeSinceLastReminder = now - (c.lastReminderTime || 0);

        // 初回のリマインダー（3時間以上経過している、かつリマインダー未送信）
        // または、直近のリマインダーから3時間以上経過している場合
        if ((timeSinceMessage >= threeHoursMs && !c.lastReminderTime) ||
            (c.lastReminderTime && timeSinceLastReminder >= threeHoursMs)) {
          unreplied.push({
            conversationKey,
            channelId: c.channelId,
            channelLabel: c.channelLabel,
            lineUserId: c.lineUserId,
            displayName: c.displayName,
            text: c.userMessage.text,
            timestamp: c.userMessage.timestamp,
            timeSinceMessage,
            reminderCount: (c.reminderCount || 0) + 1
          });
        }
      }
    }

    logDebug(`リマインダーが必要なユーザー数: ${unreplied.length}`);

    // 各未返信ユーザーに対して、リマインダー通知を送信
    for (const entry of unreplied) {
      // 経過時間を時間と分で表示
      const hoursTotal = Math.floor(entry.timeSinceMessage / (60 * 60 * 1000));
      const minutesTotal = Math.floor((entry.timeSinceMessage % (60 * 60 * 1000)) / (60 * 1000));
      
      const elapsedTimeText = hoursTotal > 0 
        ? `${hoursTotal}時間${minutesTotal > 0 ? `${minutesTotal}分` : ''}`
        : `${minutesTotal}分`;
        
      const customText = `${entry.displayName}さんからのメッセージ「${entry.text}」に${elapsedTimeText}返信がありません。`;
      logDebug(`リマインダー#${entry.reminderCount}送信: channelId=${entry.channelId}, userId=${entry.lineUserId}, message="${entry.text}", 経過時間=${elapsedTimeText}`);

      await sendSlackInteractiveNotification(entry.conversationKey, customText, true, entry.reminderCount);

      // リマインダー情報を更新
      if (conversations[entry.conversationKey]) {
        conversations[entry.conversationKey].lastReminderTime = now;
        conversations[entry.conversationKey].reminderCount = entry.reminderCount;
      }
    }
  } catch (error) {
    logDebug(`未返信チェックエラー: ${error.message}`);
  } finally {
    isCheckingUnreplied = false;
  }
});

// ---------------------------------------------------
// 12) 6時間ごとの古いデータクリーンアップ
// ---------------------------------------------------
cron.schedule('0 */6 * * *', () => {
  logDebug('6時間ごとのクリーンアップ開始');
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const conversationKey in conversations) {
    const c = conversations[conversationKey];
    if (!c.needsReply && c.userMessage && (now - c.userMessage.timestamp > oneDayMs)) {
      delete conversations[conversationKey];
      cleaned++;
    }
  }

  logDebug(`クリーンアップ完了: ${cleaned} 件削除`);
});

// ---------------------------------------------------
// 13) デバッグ用エンドポイント
// ---------------------------------------------------
app.get('/api/conversations', (req, res) => {
  res.json({ success: true, conversations });
});

app.get('/api/debug-logs', (req, res) => {
  res.json({ success: true, logs: debugLogs });
});

// シンプルなpingエンドポイント
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// リマインダーの状態を診断するエンドポイント
app.get('/api/debug-reminder', (req, res) => {
  const now = Date.now();
  const threeHoursMs = 3 * 60 * 60 * 1000;
  const result = {
    currentTime: new Date(now).toISOString(),
    conversationStatus: [],
    unrepliedMessages: []
  };

  // 全ての会話の状態を確認
  for (const conversationKey in conversations) {
    const c = conversations[conversationKey];
    const status = {
      conversationKey,
      channelId: c.channelId,
      channelLabel: c.channelLabel,
      userId: c.lineUserId,
      displayName: c.displayName,
      sourceType: c.sourceType,
      needsReply: c.needsReply,
      userMessageTime: c.userMessage ? new Date(c.userMessage.timestamp).toISOString() : null,
      timeSinceMessage: c.userMessage ? now - c.userMessage.timestamp : null,
      timeSinceMessageHours: c.userMessage ? ((now - c.userMessage.timestamp) / (60 * 60 * 1000)).toFixed(2) : null,
      lastReminderTime: c.lastReminderTime ? new Date(c.lastReminderTime).toISOString() : null,
      reminderCount: c.reminderCount || 0,
      message: c.userMessage ? c.userMessage.text : null,
      securityToken: c.securityToken ? '**********' + c.securityToken.substring(c.securityToken.length - 4) : null
    };
    
    result.conversationStatus.push(status);

    // 未返信でグループ以外のメッセージを収集
    if (c.needsReply && c.userMessage && (c.sourceType !== 'group' && c.sourceType !== 'room')) {
      const timeSinceMessage = now - c.userMessage.timestamp;
      const timeSinceLastReminder = now - (c.lastReminderTime || 0);

      if ((timeSinceMessage >= threeHoursMs && !c.lastReminderTime) ||
          (c.lastReminderTime && timeSinceLastReminder >= threeHoursMs)) {
        result.unrepliedMessages.push({
          conversationKey,
          channelId: c.channelId,
          channelLabel: c.channelLabel,
          userId: c.lineUserId,
          displayName: c.displayName,
          text: c.userMessage.text,
          timestamp: new Date(c.userMessage.timestamp).toISOString(),
          hoursSinceMessage: (timeSinceMessage / (60 * 60 * 1000)).toFixed(2),
          lastReminderTime: c.lastReminderTime ? new Date(c.lastReminderTime).toISOString() : null,
          hoursSinceLastReminder: c.lastReminderTime ? (timeSinceLastReminder / (60 * 60 * 1000)).toFixed(2) : null,
          reminderCount: c.reminderCount || 0,
          shouldSendReminder: 'YES'
        });
      } else {
        let reason = '';
        if (timeSinceMessage < threeHoursMs) {
          reason = '3時間経過していません';
        } else if (c.lastReminderTime && timeSinceLastReminder < threeHoursMs) {
          reason = '前回のリマインドから3時間経過していません';
        }

        result.unrepliedMessages.push({
          conversationKey,
          channelId: c.channelId,
          channelLabel: c.channelLabel,
          userId: c.lineUserId,
          displayName: c.displayName,
          text: c.userMessage.text,
          timestamp: new Date(c.userMessage.timestamp).toISOString(),
          hoursSinceMessage: (timeSinceMessage / (60 * 60 * 1000)).toFixed(2),
          lastReminderTime: c.lastReminderTime ? new Date(c.lastReminderTime).toISOString() : null,
          hoursSinceLastReminder: c.lastReminderTime ? (timeSinceLastReminder / (60 * 60 * 1000)).toFixed(2) : null,
          reminderCount: c.reminderCount || 0,
          shouldSendReminder: 'NO',
          reason
        });
      }
    }
  }

  res.json(result);
});

// テストメッセージを作成するエンドポイント
app.post('/api/create-test-conversation', (req, res) => {
  if (lineChannels.length === 0) {
    return res.status(500).json({ success: false, error: 'LINEチャンネルが構成されていません' });
  }

  const targetChannel = lineChannels[0];
  const testUserId = 'U_TEST_USER_' + Date.now().toString().substring(8);
  const testMessage = 'これはテストメッセージです - ' + new Date().toISOString();

  // 3時間前の時間を作成
  const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000 + 5 * 60 * 1000); // 3時間5分前

  // セキュリティトークンを生成
  const securityToken = generateSecurityToken();
  const conversationKey = getConversationKey(targetChannel.id, testUserId);

  conversations[conversationKey] = {
    channelId: targetChannel.id,
    channelLabel: targetChannel.label,
    lineUserId: testUserId,
    userMessage: { text: testMessage, timestamp: threeHoursAgo, id: 'test_msg_' + Date.now() },
    botReply: null,
    needsReply: true,
    displayName: 'テストユーザー',
    sourceType: 'user',
    lastReminderTime: 0,
    reminderCount: 0,
    securityToken
  };

  return res.json({
    success: true,
    message: 'テスト会話を作成しました',
    conversation: {
      conversationKey,
      channelId: targetChannel.id,
      channelLabel: targetChannel.label,
      userId: testUserId,
      displayName: 'テストユーザー',
      text: testMessage,
      timestamp: new Date(threeHoursAgo).toISOString(),
      needsReply: true,
      securityToken
    },
    note: '次回のリマインダーチェック（15分ごと）で通知が送信されるはずです'
  });
});

// 強制的にリマインドを送信するエンドポイント
app.post('/api/force-remind', express.json(), async (req, res) => {
  let { userId, channelId } = req.body;

  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId は必須です' });
  }

  if (!channelId) {
    if (lineChannels.length === 1) {
      channelId = lineChannels[0].id;
    } else {
      return res.status(400).json({ success: false, error: 'channelId は必須です' });
    }
  }

  const conversationKey = getConversationKey(channelId, userId);
  const conversation = conversations[conversationKey];

  if (!conversation) {
    return res.status(404).json({ success: false, error: '該当の会話が見つかりません' });
  }

  try {
    if (!conversation.needsReply || !conversation.userMessage) {
      return res.status(400).json({ success: false, error: '未返信のメッセージがないか、返信不要の状態です' });
    }

    const now = Date.now();
    const reminderCount = (conversation.reminderCount || 0) + 1;
    const customText = `【強制送信】${conversation.displayName}さんからのメッセージ「${conversation.userMessage.text}」への返信が必要です。`;

    await sendSlackInteractiveNotification(conversationKey, customText, true, reminderCount);

    // リマインダー情報を更新
    conversation.lastReminderTime = now;
    conversation.reminderCount = reminderCount;

    return res.json({
      success: true,
      message: 'リマインダーを強制送信しました',
      conversation: {
        conversationKey,
        channelId: conversation.channelId,
        channelLabel: conversation.channelLabel,
        userId: conversation.lineUserId,
        displayName: conversation.displayName,
        text: conversation.userMessage.text,
        timestamp: new Date(conversation.userMessage.timestamp).toISOString(),
        lastReminderTime: new Date(now).toISOString(),
        reminderCount
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------
// 14) サーバー起動
// ---------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logDebug(`Server running on port ${PORT}`);
});
