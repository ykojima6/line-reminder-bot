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

// Slack Webhook URL (環境変数として設定)
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// ログ出力
console.log('環境変数の状態:');
console.log('LINE_CHANNEL_ACCESS_TOKEN exists:', !!process.env.LINE_CHANNEL_ACCESS_TOKEN);
console.log('LINE_CHANNEL_SECRET exists:', !!process.env.LINE_CHANNEL_SECRET);
console.log('SLACK_WEBHOOK_URL exists:', !!process.env.SLACK_WEBHOOK_URL);

// LINEクライアントを初期化
const client = new line.Client(config);

// メッセージを保存するためのオブジェクト
const messageStore = {};

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
    console.log('Slack Webhook URLが設定されていないため、通知をスキップします');
    return;
  }

  try {
    console.log('Slack通知を送信します:', message.substring(0, 100) + (message.length > 100 ? '...' : ''));
    const response = await axios.post(SLACK_WEBHOOK_URL, { text: message });
    console.log('Slack通知を送信しました, ステータス:', response.status);
  } catch (error) {
    console.error('Slack通知の送信に失敗しました:', error.message);
    if (error.response) {
      console.error('レスポンス:', error.response.status, error.response.data);
    }
  }
}

// LINE Bot用Webhookルート - カスタム署名検証
app.post('/webhook', (req, res) => {
  // 署名検証
  const signature = req.headers['x-line-signature'];
  
  // 署名がなければ400エラー
  if (!signature) {
    console.log('署名がありません');
    return res.status(400).send('署名がありません');
  }
  
  // 署名の検証
  const body = req.body;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const hmac = crypto.createHmac('SHA256', channelSecret);
  const bodyStr = Buffer.isBuffer(body) ? body.toString() : JSON.stringify(body);
  const digestFromBody = hmac.update(bodyStr).digest('base64');
  
  if (digestFromBody !== signature) {
    console.log('署名が一致しません');
    console.log('Expected:', digestFromBody);
    console.log('Received:', signature);
    return res.status(400).send('署名が一致しません');
  }
  
  // リクエストボディをパース
  const parsedBody = Buffer.isBuffer(body) ? JSON.parse(body.toString()) : body;
  console.log('Webhook received:', JSON.stringify(parsedBody));
  
  // イベント処理
  if (!parsedBody || !parsedBody.events || !Array.isArray(parsedBody.events)) {
    console.log('不正なリクエストボディ:', parsedBody);
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
  console.log('イベント処理:', event.type);
  
  // メッセージイベントのみ処理
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  try {
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
      // プロフィールが取得できない場合はデフォルト値を設定
      senderProfile = { displayName: 'Unknown User' };
    }

    // メッセージを送信したユーザーID（自分自身のユーザーID）
    const myUserId = event.source.userId;
    
    // メッセージを保存（すべてのメッセージを対象にする）
    if (!messageStore[myUserId]) {
      messageStore[myUserId] = {};
    }
    
    messageStore[myUserId][event.message.id] = {
      text: event.message.text,
      sender: event.source.userId,
      senderName: senderProfile ? senderProfile.displayName : 'Unknown User',
      timestamp: event.timestamp,
      replied: false,
      messageId: event.message.id,
      sourceType: event.source.type  // room, group, or user
    };
    
    console.log(`メッセージを保存: ${event.message.text}`);
    
    // Slackに通知を送信
    const sourceTypeText = {
      'user': '個別チャット',
      'group': 'グループ',
      'room': 'ルーム'
    }[event.source.type] || '不明';
    
    await sendSlackNotification(`*新規メッセージ*\n*送信元*: ${sourceTypeText}\n*送信者*: ${senderProfile.displayName}\n*内容*: ${event.message.text}\n*メッセージID*: ${event.message.id}`);
    
    // 返信対象メッセージIDを識別するパターン
    const replyToPattern = /返信対象ID:(\w+)/;
    const match = event.message.text.match(replyToPattern);
    
    if (match && match[1]) {
      const messageId = match[1];
      let found = false;
      
      // すべてのユーザーのメッセージストアから該当IDを検索
      for (const userId in messageStore) {
        const userMessages = messageStore[userId];
        if (userMessages[messageId]) {
          userMessages[messageId].replied = true;
          found = true;
          console.log(`メッセージID:${messageId}に対する返信を記録しました`);
          
          // Slackに返信完了通知
          await sendSlackNotification(`*返信完了*\n*メッセージID*: ${messageId}\n*返信内容*: ${event.message.text}`);
          break;
        }
      }
      
      // 返信確認メッセージ
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: found 
          ? `返信を記録しました。メッセージID:${messageId}` 
          : `指定されたメッセージID:${messageId}が見つかりませんでした`
      });
    }
    
  } catch (error) {
    console.error('メッセージ処理エラー:', error);
  }

  return Promise.resolve(null);
}

// 1分ごとに未返信メッセージをチェックするスケジューラー
// cron式: '* * * * *' は1分ごとに実行
cron.schedule('* * * * *', async () => {
  console.log('1分間隔の未返信チェック実行中...', new Date().toISOString());
  const now = Date.now();
  const oneMinuteInMs = 1 * 60 * 1000;
  
  let totalUnrepliedCount = 0;
  let unrepliedMessagesAll = [];
  
  // 各ユーザーのメッセージをチェック
  for (const userId in messageStore) {
    const userMessages = messageStore[userId];
    
    // 未返信で1分経過したメッセージを抽出
    for (const messageId in userMessages) {
      const message = userMessages[messageId];
      const elapsedTime = now - message.timestamp;
      
      console.log(`メッセージID: ${messageId}, 返信済み: ${message.replied}, 経過時間: ${Math.floor(elapsedTime / (60 * 1000))}分`);
      
      // 1分以上経過した未返信メッセージをチェック
      if (!message.replied && elapsedTime >= oneMinuteInMs) {
        unrepliedMessagesAll.push(message);
        totalUnrepliedCount++;
      }
    }
  }
  
  // Slackにリマインダーを送信（すべてのメッセージをまとめて1つの通知にする）
  if (unrepliedMessagesAll.length > 0) {
    try {
      const reminderText = unrepliedMessagesAll.map(msg => 
        `*送信者*: ${msg.senderName}\n*送信元*: ${msg.sourceType || '不明'}\n*内容*: ${msg.text}\n*メッセージID*: ${msg.messageId}\n*経過時間*: ${Math.floor((now - msg.timestamp) / (60 * 1000))}分`
      ).join('\n\n');
      
      console.log('Slackにリマインダーを送信します:', reminderText);
      
      await sendSlackNotification(`*【未返信リマインダー】*\n以下のメッセージに返信がありません:\n\n${reminderText}`);
      
      console.log(`${unrepliedMessagesAll.length}件のリマインダーをSlackに送信しました`);
    } catch (error) {
      console.error('Slackリマインダー送信エラー:', error);
    }
  }
  
  console.log(`1分チェック完了: 合計${totalUnrepliedCount}件の未返信メッセージを検出`);
});

// 古いメッセージを定期的にクリーンアップする処理
cron.schedule('0 0 * * *', () => {
  console.log('古いメッセージのクリーンアップ実行中...');
  const now = Date.now();
  const threeDaysInMs = 3 * 24 * 60 * 60 * 1000;
  
  let cleanedCount = 0;
  for (const userId in messageStore) {
    const userMessages = messageStore[userId];
    
    for (const messageId in userMessages) {
      const message = userMessages[messageId];
      if ((now - message.timestamp) >= threeDaysInMs) {
        delete userMessages[messageId];
        cleanedCount++;
      }
    }
  }
  
  console.log(`クリーンアップ完了: ${cleanedCount}件のメッセージを削除しました`);
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
