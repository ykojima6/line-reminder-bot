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

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://line-reminder-bot-de113f80aa92.herokuapp.com';

console.log('環境変数の状態:');
console.log('LINE_CHANNEL_ACCESS_TOKEN exists:', !!config.channelAccessToken);
console.log('LINE_CHANNEL_SECRET exists:', !!config.channelSecret);
console.log('SLACK_WEBHOOK_URL exists:', !!SLACK_WEBHOOK_URL);
console.log('APP_BASE_URL:', APP_BASE_URL);

const client = new line.Client(config);

// ---------------------------------------------------
// 2) 会話状態管理
// ---------------------------------------------------
// { userId: {
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
function createSlackMessage(lineUserId, customText, isReminder = false, reminderCount = 0) {
  const securityToken = conversations[lineUserId].securityToken || generateSecurityToken();
  
  // トークンを保存
  if (conversations[lineUserId]) {
    conversations[lineUserId].securityToken = securityToken;
  }
  
  const markAsRepliedUrl = `${APP_BASE_URL}/api/mark-as-replied-confirm?userId=${lineUserId}&token=${securityToken}`;
  
  let prefix = isReminder ? `*【リマインダー ${reminderCount > 0 ? `#${reminderCount}` : ''}】*\n` : '*【LINEからの新着メッセージ】*\n';
  
  return {
    text: `${prefix}${customText}\n\n返信済みにするには以下のリンクをクリックしてください:\n${markAsRepliedUrl}`,
    unfurl_links: false
  };
}

// (B) インタラクティブ通知を送る（修正版）
async function sendSlackInteractiveNotification(lineUserId, customText, isReminder = false, reminderCount = 0) {
  if (!SLACK_WEBHOOK_URL) {
    logDebug('Slack Webhook URLが未設定のため送信できません');
    return;
  }
  
  const message = createSlackMessage(lineUserId, customText, isReminder, reminderCount);
  
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
// 8) LINEイベントハンドラー
// ---------------------------------------------------
async function handleLineEvent(event) {
  logDebug(`イベント処理開始: type=${event.type}, webhookEventId=${event.webhookEventId || 'なし'}`);
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const messageText = event.message.text;
  const messageId = event.message.id;
  const timestamp = event.timestamp;
  const isFromUser = !!event.replyToken;
  const sourceType = event.source.type;

  logDebug(`受信: userId=${userId}, sourceType=${sourceType}, text="${messageText}", isFromUser=${isFromUser}`);

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
      const c = conversations[userId];
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
    
    if (!conversations[userId]) {
      conversations[userId] = {
        userMessage: { text: messageText, timestamp, id: messageId },
        botReply: null,
        needsReply: true,
        displayName,
        sourceType,
        lastReminderTime: 0,     // 最後にリマインダーを送信した時間（初期値：0）
        reminderCount: 0,        // リマインダーの送信回数（初期値：0）
        securityToken            // セキュリティトークン
      };
      logDebug(`新規会話作成: userId=${userId}, text="${messageText}"`);
    } else {
      conversations[userId].userMessage = { text: messageText, timestamp, id: messageId };
      conversations[userId].needsReply = true;
      conversations[userId].lastReminderTime = 0; // 新しいメッセージでリセット
      conversations[userId].reminderCount = 0;    // 新しいメッセージでリセット
      conversations[userId].securityToken = securityToken; // セキュリティトークン更新
      logDebug(`既存会話更新: userId=${userId}, text="${messageText}"`);
    }
    // 新着メッセージ用のインタラクティブ通知（即時送信）
    const customText = `【${displayName}】からのメッセージ：「${messageText}」`;
    await sendSlackInteractiveNotification(userId, customText);
  }
}

// ---------------------------------------------------
// 9) 確認ページ表示エンドポイント（新設）
// ---------------------------------------------------
app.get('/api/mark-as-replied-confirm', (req, res) => {
  const { userId, token } = req.query;
  if (!userId || !token) {
    return res.send('エラー: 必須パラメータが不足しています');
  }
  
  if (!conversations[userId]) {
    return res.send('エラー: 該当のユーザーが見つかりません');
  }
  
  // トークン検証
  if (conversations[userId].securityToken !== token) {
    logDebug(`トークン不一致: userId=${userId}, expected=${conversations[userId].securityToken}, received=${token}`);
    return res.send('エラー: セキュリティトークンが無効です');
  }
  
  const displayName = conversations[userId].displayName || 'Unknown User';
  const messageText = conversations[userId].userMessage ? conversations[userId].userMessage.text : '';
  
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
        <p><strong>メッセージ:</strong> ${messageText}</p>
      </div>
      <div class="confirm">
        <a href="/api/mark-as-replied-web?userId=${userId}&token=${token}" class="btn">はい、返信済みにする</a>
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
  const { userId, token } = req.query;
  if (!userId || !token) {
    return res.send('エラー: 必須パラメータが不足しています');
  }
  
  if (!conversations[userId]) {
    return res.send('エラー: 該当のユーザーが見つかりません');
  }
  
  // トークン検証
  if (conversations[userId].securityToken !== token) {
    logDebug(`トークン不一致: userId=${userId}, expected=${conversations[userId].securityToken}, received=${token}`);
    return res.send('エラー: セキュリティトークンが無効です');
  }
  
  try {
    conversations[userId].needsReply = false;
    conversations[userId].lastReminderTime = 0;  // リマインダー情報をリセット
    conversations[userId].reminderCount = 0;     // リマインダー情報をリセット
    logDebug(`会話更新（Web経由）: userId=${userId} を返信済みに設定`);
    
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

    for (const userId in conversations) {
      const c = conversations[userId];
      // グループメッセージは未返信リマインダーから除外
      if (c.needsReply && c.userMessage && (c.sourceType !== 'group' && c.sourceType !== 'room')) {
        const timeSinceMessage = now - c.userMessage.timestamp;
        const timeSinceLastReminder = now - (c.lastReminderTime || 0);
        
        // 初回のリマインダー（3時間以上経過している、かつリマインダー未送信）
        // または、直近のリマインダーから3時間以上経過している場合
        if ((timeSinceMessage >= threeHoursMs && !c.lastReminderTime) || 
            (c.lastReminderTime && timeSinceLastReminder >= threeHoursMs)) {
          unreplied.push({
            userId,
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
      logDebug(`リマインダー#${entry.reminderCount}送信: userId=${entry.userId}, message="${entry.text}", 経過時間=${elapsedTimeText}`);
      
      await sendSlackInteractiveNotification(entry.userId, customText, true, entry.reminderCount);
      
      // リマインダー情報を更新
      if (conversations[entry.userId]) {
        conversations[entry.userId].lastReminderTime = now;
        conversations[entry.userId].reminderCount = entry.reminderCount;
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
  for (const userId in conversations) {
    const c = conversations[userId];
    const status = {
      userId,
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
          userId,
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
          userId,
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
  const testUserId = 'U_TEST_USER_' + Date.now().toString().substring(8);
  const testMessage = 'これはテストメッセージです - ' + new Date().toISOString();
  
  // 3時間前の時間を作成
  const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000 + 5 * 60 * 1000); // 3時間5分前
  
  // セキュリティトークンを生成
  const securityToken = generateSecurityToken();
  
  conversations[testUserId] = {
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
      userId: testUserId,
      displayName: 'テストユーザー',
      text: testMessage,
      timestamp: new Date(threeHoursAgo).toISOString(),
      needsReply: true,
      securityToken: securityToken
    },
    note: '次回のリマインダーチェック（15分ごと）で通知が送信されるはずです'
  });
});

// 強制的にリマインドを送信するエンドポイント
app.post('/api/force-remind', express.json(), async (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId は必須です' });
  }
  
  if (!conversations[userId]) {
    return res.status(404).json({ success: false, error: '該当の会話が見つかりません' });
  }
  
  try {
    const c = conversations[userId];
    if (!c.needsReply || !c.userMessage) {
      return res.status(400).json({ success: false, error: '未返信のメッセージがないか、返信不要の状態です' });
    }
    
    const now = Date.now();
    const reminderCount = (c.reminderCount || 0) + 1;
    const customText = `【強制送信】${c.displayName}さんからのメッセージ「${c.userMessage.text}」への返信が必要です。`;
    
    await sendSlackInteractiveNotification(userId, customText, true, reminderCount);
    
    // リマインダー情報を更新
    conversations[userId].lastReminderTime = now;
    conversations[userId].reminderCount = reminderCount;
    
    return res.json({ 
      success: true, 
      message: 'リマインダーを強制送信しました',
      conversation: {
        userId,
        displayName: c.displayName,
        text: c.userMessage.text,
        timestamp: new Date(c.userMessage.timestamp).toISOString(),
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
