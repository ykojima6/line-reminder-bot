const express = require('express');
const crypto = require('crypto');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const axios = require('axios');
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
  debugLogs.unshift(logEntry); // 最新のログを先頭に
  // 最大100件まで保存
  if (debugLogs.length > 100) {
    debugLogs.pop();
  }
}

// 生のリクエストボディを取得するためのミドルウェア
app.use('/webhook', express.raw({ type: 'application/json' }));

// 他のルートにはJSON解析を使用
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ルートパスへのハンドラーを追加
app.get('/', (req, res) => {
  res.send('LINE Bot Server is running!');
});

// GETリクエスト用のハンドラーを追加
app.get('/webhook', (req, res) => {
  res.send('LINE Bot Webhook is working. Please use POST method for actual webhook.');
});

// Slackに通知を送信する関数
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

// 返信を送信し、その返信IDを会話状態に記録する関数
async function sendReplyAndRecord(event, messageText) {
  try {
    // LINE API を使ってメッセージを返信
    const result = await client.replyMessage(event.replyToken, {
      type: 'text',
      text: messageText
    });
    
    // 返信のメッセージIDを取得
    const botMessageId = result.messageId;
    const userId = event.source.userId;
    
    logDebug(`ユーザー ${userId} に返信を送信しました。メッセージID: ${botMessageId}`);
    
    // 会話状態を更新
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

// プッシュメッセージを送信し、そのIDを会話状態に記録する関数
async function sendPushMessageAndRecord(userId, messageText) {
  try {
    // LINE API を使ってプッシュメッセージを送信
    const result = await client.pushMessage(userId, {
      type: 'text',
      text: messageText
    });
    
    // 送信したメッセージIDを取得
    const botMessageId = result.messageId;
    
    logDebug(`ユーザー ${userId} にプッシュメッセージを送信しました。メッセージID: ${botMessageId}`);
    
    // 会話状態を更新
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

// LINE Bot用Webhookルート - カスタム署名検証
app.post('/webhook', (req, res) => {
  // 署名検証
  const signature = req.headers['x-line-signature'];
  
  // 署名がなければ400エラー
  if (!signature) {
    logDebug('署名がありません');
    return res.status(400).send('署名がありません');
  }
  
  // 署名の検証
  const body = req.body;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const hmac = crypto.createHmac('SHA256', channelSecret);
  // バッファをそのまま使用して署名計算（バイナリセーフ）
  const bodyStr = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const digestFromBody = hmac.update(bodyStr).digest('base64');
  
  if (digestFromBody !== signature) {
    logDebug('署名が一致しません');
    logDebug('Expected: ' + digestFromBody);
    logDebug('Received: ' + signature);
    return res.status(400).send('署名が一致しません');
  }
  
  // リクエストボディをパース
  const parsedBody = Buffer.isBuffer(body) ? JSON.parse(body.toString()) : body;
  logDebug('Webhook received: ' + JSON.stringify(parsedBody).substring(0, 500) + '...');
  
  // イベント処理
  if (!parsedBody || !parsedBody.events || !Array.isArray(parsedBody.events)) {
    logDebug('不正なリクエストボディ: ' + JSON.stringify(parsedBody));
    return res.status(400).send('不正なリクエストボディ');
  }
  
  // 常に200 OKを返す（LINE Messaging APIの要件）
  res.status(200).end();
  
  // イベントを非同期で処理
  Promise.all(parsedBody.events.map(handleEvent))
    .catch(err => {
      console.error('イベント処理エラー:', err);
    });
});

// イベントハンドラー
async function handleEvent(event) {
  logDebug('イベント処理: ' + event.type + ' - イベントID: ' + (event.webhookEventId || 'なし'));
  
  // テキストメッセージ以外は無視
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  try {
    const userId = event.source.userId;
    const messageText = event.message.text;
    const messageId = event.message.id;
    const timestamp = event.timestamp;
    
    // replyTokenの有無でユーザーからの送信かを判断
    // webhookイベントはユーザーからの送信を表し、replyTokenが付与される
    const isFromUser = !!event.replyToken;
    
    logDebug(`メッセージ送信者判定: userId=${userId}, isFromUser=${isFromUser}, replyToken=${!!event.replyToken}, messageId=${messageId}`);
    
    // 送信者情報を取得
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
    
    // 緊急事態コマンド: すべてリセット
    if (isFromUser && messageText === 'リセット') {
      // 全ユーザーの状態をリセット
      Object.keys(conversations).forEach(uid => {
        conversations[uid].needsReply = false;
      });
      
      await sendSlackNotification(`*システムリセット*\n*ユーザー*: ${userDisplayName}\nすべてのユーザーの未返信状態をリセットしました。`);
      
      // 返信を送信
      return sendReplyAndRecord(event, "システムをリセットしました。すべての未返信状態がクリアされました。");
    }

    // 特別コマンド処理: すべて返信済みにする
    if (isFromUser && (messageText === '全部返信済み' || messageText === 'すべて返信済み' || messageText === '返信済み')) {
      if (conversations[userId]) {
        conversations[userId].needsReply = false;
      }
      
      await sendSlackNotification(`*すべて返信済みにしました*\n*ユーザー*: ${userDisplayName}\nこのユーザーへの未返信状態をクリアしました。`);
      
      // 返信を送信して記録
      return sendReplyAndRecord(event, "未返信状態をクリアしました。");
    }
    
    // 特別コマンド処理: ステータスチェック
    if (isFromUser && (messageText === 'ステータス' || messageText === 'status')) {
      const needsReply = conversations[userId] && conversations[userId].needsReply;
      let statusMessage;
      
      if (needsReply) {
        const lastMessageTime = new Date(conversations[userId].userMessage.timestamp).toLocaleString('ja-JP');
        statusMessage = `現在、あなたの未返信メッセージがあります。\n\n最後のメッセージ: "${conversations[userId].userMessage.text}"\n時間: ${lastMessageTime}`;
      } else {
        statusMessage = "現在、あなたへの未返信メッセージはありません。";
        
        // ボットからの最後の返信がある場合はそれも表示
        if (conversations[userId] && conversations[userId].botReply) {
          const lastReplyTime = new Date(conversations[userId].botReply.timestamp).toLocaleString('ja-JP');
          statusMessage += `\n\n最後の返信: "${conversations[userId].botReply.text}"\n時間: ${lastReplyTime}`;
        }
      }
      
      logDebug(`ステータスチェック: ユーザー ${userId} の返信状態: ${needsReply ? '未返信あり' : '未返信なし'}`);
      
      // 返信を送信して記録
      return sendReplyAndRecord(event, statusMessage);
    }
    
    // 特別コマンド処理: デバッグログ
    if (isFromUser && (messageText === 'デバッグログ' || messageText === 'debuglog')) {
      // 未返信メッセージの数を数える
      let pendingCount = 0;
      for (const uid in conversations) {
        if (conversations[uid].needsReply) {
          pendingCount++;
        }
      }
      
      const logMessage = `*デバッグ情報*\n未返信ユーザー数: ${pendingCount}\n\n最新のログ（最大10件）:\n${debugLogs.slice(0, 10).join('\n')}`;
      
      // 返信を送信して記録
      return sendReplyAndRecord(event, logMessage);
    }
    
    // 会話状態のチェック
    if (isFromUser) {
      // 新しい会話を開始するか既存の会話を更新
      if (!conversations[userId]) {
        // 新規の会話
        conversations[userId] = {
          userMessage: {
            text: messageText,
            timestamp: timestamp,
            id: messageId
          },
          botReply: null,
          needsReply: true,
          displayName: userDisplayName,
          sourceType: sourceType
        };
        
        logDebug(`新規会話を作成: ユーザー ${userId}, メッセージ: ${messageText}`);
      } else {
        // 既存の会話に新しいユーザーメッセージを記録
        conversations[userId].userMessage = {
          text: messageText,
          timestamp: timestamp,
          id: messageId
        };
        conversations[userId].needsReply = true;
        
        logDebug(`既存会話を更新: ユーザー ${userId}, メッセージ: ${messageText}`);
      }
      
      // Slackに通知を送信
      const sourceTypeText = {
        'user': '個別チャット',
        'group': 'グループ',
        'room': 'ルーム'
      }[sourceType] || '不明';
      
      // ユーザーからのメッセージを通知
      await sendSlackNotification(`*新規メッセージ*\n*送信元*: ${sourceTypeText}\n*送信者*: ${userDisplayName}\n*内容*: ${messageText}\n*メッセージID*: ${messageId}`);
    }
    
  } catch (error) {
    console.error('メッセージ処理エラー:', error);
  }

  return Promise.resolve(null);
}

// 外部から返信を送信するエンドポイント
app.post('/api/send-reply', express.json(), async (req, res) => {
  const { userId, message } = req.body;
  
  if (!userId || !message) {
    return res.status(400).json({ success: false, error: 'ユーザーIDとメッセージが必要です' });
  }
  
  try {
    // メッセージを送信して返信IDを記録
    const botMessageId = await sendPushMessageAndRecord(userId, message);
    
    if (botMessageId) {
      res.status(200).json({ 
        success: true, 
        message: `ユーザー ${userId} にメッセージを送信しました`,
        messageId: botMessageId
      });
    } else {
      res.status(500).json({ success: false, message: `ユーザー ${userId} へのメッセージ送信に失敗しました` });
    }
  } catch (error) {
    console.error('メッセージ送信エラー:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 手動での返信済みマーク用エンドポイント
app.post('/api/mark-as-replied', express.json(), async (req, res) => {
  const { userId, message } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, error: 'ユーザーIDが必要です' });
  }
  
  try {
    if (!conversations[userId]) {
      return res.status(404).json({ success: false, message: `ユーザー ${userId} の会話が見つかりません` });
    }
    
    // メッセージが指定されている場合はそれも送信して記録
    if (message) {
      const botMessageId = await sendPushMessageAndRecord(userId, message);
      
      if (botMessageId) {
        res.status(200).json({ 
          success: true, 
          message: `ユーザー ${userId} にメッセージを送信し、返信済みとしてマークしました`,
          messageId: botMessageId
        });
      } else {
        res.status(500).json({ success: false, message: `ユーザー ${userId} へのメッセージ送信に失敗しました` });
      }
    } else {
      // メッセージなしで単に返信済みとしてマーク
      conversations[userId].needsReply = false;
      logDebug(`ユーザー ${userId} の会話を手動で返信済みとしてマークしました`);
      
      res.status(200).json({ 
        success: true, 
        message: `ユーザー ${userId} の会話を返信済みとしてマークしました`
      });
    }
  } catch (error) {
    console.error('返信済みマークエラー:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 1分ごとに未返信メッセージをチェックするスケジューラー
let isCheckingUnreplied = false; // 実行中フラグ

cron.schedule('* * * * *', async () => {
  // 前回の実行が完了していない場合はスキップ
  if (isCheckingUnreplied) {
    logDebug('前回の未返信チェックが進行中のためスキップします');
    return;
  }
  
  isCheckingUnreplied = true;
  logDebug('1分間隔の未返信チェック実行中...');
  
  try {
    const now = Date.now();
    const oneMinuteInMs = 1 * 60 * 1000;  // 1分をミリ秒に変換
    
    let unrepliedUsers = [];
    
    // すべての会話をチェック
    for (const userId in conversations) {
      const convo = conversations[userId];
      
      // 返信が必要なメッセージのみ処理
      if (convo.needsReply && convo.userMessage) {
        const elapsedTime = now - convo.userMessage.timestamp;
        const elapsedMinutes = Math.floor(elapsedTime / (60 * 1000));
        
        if (elapsedTime >= oneMinuteInMs) {
          unrepliedUsers.push({
            userId,
            name: convo.displayName,
            message: {
              text: convo.userMessage.text,
              id: convo.userMessage.id
            },
            elapsedMinutes,
            sourceType: convo.sourceType
          });
        }
      }
    }
    
    logDebug(`未返信ユーザー数: ${unrepliedUsers.length}`);
    
    // Slackにリマインダーを送信
    if (unrepliedUsers.length > 0) {
      try {
        const reminderText = unrepliedUsers.map(user => {
          const sourceTypeText = {
            'user': '個別チャット',
            'group': 'グループ',
            'room': 'ルーム'
          }[user.sourceType] || '不明';
          
          return `*送信者*: ${user.name}\n*送信元*: ${sourceTypeText}\n*内容*: ${user.message.text}\n*メッセージID*: ${user.message.id}\n*経過時間*: ${user.elapsedMinutes}分\n*ユーザーID*: ${user.userId}`;
        }).join('\n\n');
        
        await sendSlackNotification(`*【1分以上未返信リマインダー】*\n以下のメッセージに返信がありません:\n\n${reminderText}`);
        
        logDebug(`${unrepliedUsers.length}件のリマインダーをSlackに送信しました`);
      } catch (error) {
        console.error('Slackリマインダー送信エラー:', error);
      }
    }
  } catch (error) {
    console.error('未返信チェックエラー:', error);
  } finally {
    isCheckingUnreplied = false; // 処理完了フラグ
  }
});

// 古いデータをクリーンアップするスケジューラー（6時間ごと）
cron.schedule('0 */6 * * *', () => {
  logDebug('古いメッセージデータをクリーンアップしています...');
  
  const now = Date.now();
  const oneDayInMs = 24 * 60 * 60 * 1000; // 1日をミリ秒に変換
  
  let cleanupCount = 0;
  
  // 返信済みで1日以上経過した会話をクリーンアップ
  for (const userId in conversations) {
    const convo = conversations[userId];
    
    // 最後のメッセージが1日以上前で、返信も完了している場合
    if (!convo.needsReply && convo.userMessage && (now - convo.userMessage.timestamp > oneDayInMs)) {
      delete conversations[userId];
      cleanupCount++;
    }
  }
  
  logDebug(`${cleanupCount}件の古い会話をクリーンアップしました`);
});

// 現在の会話状態を表示するエンドポイント
app.get('/api/conversations', (req, res) => {
  // 未返信メッセージの数を数える
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

// デバッグログを表示するエンドポイント
app.get('/api/debug-logs', (req, res) => {
  res.json({
    success: true,
    count: debugLogs.length,
    logs: debugLogs
  });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logDebug(`Server running on port ${PORT}`);
});
