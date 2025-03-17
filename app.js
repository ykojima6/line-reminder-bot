const express = require('express');
const crypto = require('crypto');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const axios = require('axios'); // Slackへの通知に使用
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
    await axios.post(SLACK_WEBHOOK_URL, { text: message });
    console.log('Slack通知を送信しました');
  } catch (error) {
    console.error('Slack通知の送信に失敗しました:', error);
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

  // グループまたはルームからのメッセージの場合（公式アカウントからの可能性）
  if (event.source.type === 'room' || event.source.type === 'group') {
    try {
      // 送信者情報を取得（グループの場合）
      let senderProfile;
      if (event.source.type === 'room') {
        senderProfile = await client.getRoomMemberProfile(event.source.roomId, event.source.userId);
      } else if (event.source.type === 'group') {
        senderProfile = await client.getGroupMemberProfile(event.source.groupId, event.source.userId);
      }
      
      // 公式アカウントかどうかの判定（実際にはAPIで公式アカウントかを判断する必要があります）
      // ここでは例として、表示名に【公式】が含まれているかどうかで判断します
      const isOfficialAccount = senderProfile && senderProfile.displayName.includes('【公式】');
      
      if (isOfficialAccount) {
        // メッセージを送信したユーザーID（自分自身のユーザーID）
        const myUserId = event.source.userId;
        
        // メッセージを保存
        if (!messageStore[myUserId]) {
          messageStore[myUserId] = {};
        }
        
        messageStore[myUserId][event.message.id] = {
          text: event.message.text,
          sender: event.source.userId,
          senderName: senderProfile.displayName,
          timestamp: event.timestamp,
          replied: false,
          messageId: event.message.id
        };
        
        console.log(`公式アカウントからのメッセージを保存: ${event.message.text}`);
        
        // Slackに通知を送信
        await sendSlackNotification(`*新規メッセージ*\n*送信者*: ${senderProfile.displayName}\n*内容*: ${event.message.text}\n*メッセージID*: ${event.message.id}`);
        
        // 確認用の返信（オプション - 実際の運用では不要かもしれません）
        // return client.replyMessage(event.replyToken, {
        //   type: 'text',
        //   text: `${senderProfile.displayName}からのメッセージを記録しました。`
        // });
      }
    } catch (error) {
      console.error('メッセージ処理エラー:', error);
    }
  }
  
  // 個別のチャットからのメッセージの場合
  if (event.source.type === 'user') {
    try {
      // ユーザープロフィール取得
      const userProfile = await client.getProfile(event.source.userId);
      
      // Slackに通知
      await sendSlackNotification(`*個別チャットからのメッセージ*\n*送信者*: ${userProfile.displayName}\n*内容*: ${event.message.text}`);
      
      // 返信対象メッセージIDを識別するパターン
      const replyToPattern = /返信対象ID:(\w+)/;
      const match = event.message.text.match(replyToPattern);
      
      if (match && match[1]) {
        const messageId = match[1];
        let found = false;
        
        // 自分のメッセージストアから該当IDを検索
        const myUserId = event.source.userId;
        if (messageStore[myUserId] && messageStore[myUserId][messageId]) {
          messageStore[myUserId][messageId].replied = true;
          found = true;
          console.log(`メッセージID:${messageId}に対する返信を記録しました`);
          
          // Slackに返信完了通知
          await sendSlackNotification(`*返信完了*\n*メッセージID*: ${messageId}\n*返信内容*: ${event.message.text}`);
        }
        
        // 返信確認メッセージ
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: found 
            ? `返信を記録しました。メッセージID:${messageId}` 
            : `指定されたメッセージID:${messageId}が見つかりませんでした`
        });
      }
      
      // 自動返信を行わない（Slackで確認して手動で対応する）
      // 必要に応じてここにコードを追加
    } catch (error) {
      console.error('メッセージ処理エラー:', error);
    }
  }

  return Promise.resolve(null);
}

// 5分ごとに未返信メッセージをチェックするスケジューラー
// cron式: '*/5 * * * *' は5分ごとに実行
cron.schedule('*/5 * * * *', async () => {
  console.log('5分間隔の未返信チェック実行中...');
  const now = Date.now();
  const fiveMinutesInMs = 5 * 60 * 1000;
  
  // 各ユーザーのメッセージをチェック
  for (const userId in messageStore) {
    const userMessages = messageStore[userId];
    const unrepliedMessages = [];
    
    // 未返信で5分経過したメッセージを抽出
    for (const messageId in userMessages) {
      const message = userMessages[messageId];
      const elapsedTime = now - message.timestamp;
      
      // 5分以上12時間未満の未返信メッセージをチェック（12時間以上は別のスケジューラーで処理）
      if (!message.replied && elapsedTime >= fiveMinutesInMs && elapsedTime < 12 * 60 * 60 * 1000) {
        unrepliedMessages.push(message);
      }
    }
    
    // Slackにリマインダーを送信
    if (unrepliedMessages.length > 0) {
      try {
        const reminderText = unrepliedMessages.map(msg => 
          `*送信者*: ${msg.senderName}\n*内容*: ${msg.text}\n*メッセージID*: ${msg.messageId}\n*経過時間*: ${Math.floor((now - msg.timestamp) / (60 * 1000))}分`
        ).join('\n\n');
        
        await sendSlackNotification(`*【5分経過リマインダー】*\n以下のメッセージに返信がありません:\n\n${reminderText}`);
        
        console.log(`${unrepliedMessages.length}件の5分リマインダーをSlackに送信しました`);
      } catch (error) {
        console.error('Slackリマインダー送信エラー:', error);
      }
    }
  }
});

// 12時間ごとに未返信メッセージをチェックするスケジューラー
cron.schedule('0 */12 * * *', async () => {
  console.log('12時間間隔の未返信チェック実行中...');
  const now = Date.now();
  const twelveHoursInMs = 12 * 60 * 60 * 1000;
  
  // 各ユーザーのメッセージをチェック
  for (const userId in messageStore) {
    const userMessages = messageStore[userId];
    const unrepliedMessages = [];
    
    // 未返信で12時間経過したメッセージを抽出
    for (const messageId in userMessages) {
      const message = userMessages[messageId];
      if (!message.replied && (now - message.timestamp) >= twelveHoursInMs) {
        unrepliedMessages.push(message);
      }
    }
    
    // LINEとSlackの両方にリマインダーを送信
    if (unrepliedMessages.length > 0) {
      try {
        const reminderTextLine = unrepliedMessages.map(msg => 
          `${msg.senderName}からのメッセージ: ${msg.text.substring(0, 30)}... (返信対象ID:${msg.messageId})`
        ).join('\n\n');
        
        // LINEに通知
        await client.pushMessage(userId, {
          type: 'text',
          text: `【リマインダー】\n以下のメッセージに12時間以上返信がありません:\n\n${reminderTextLine}`
        });
        
        // Slackにも通知
        const reminderTextSlack = unrepliedMessages.map(msg => 
          `*送信者*: ${msg.senderName}\n*内容*: ${msg.text}\n*メッセージID*: ${msg.messageId}\n*経過時間*: 12時間以上`
        ).join('\n\n');
        
        await sendSlackNotification(`*【12時間経過リマインダー】*\n以下のメッセージに返信がありません:\n\n${reminderTextSlack}`);
        
        console.log(`ユーザー${userId}に${unrepliedMessages.length}件の12時間リマインダーを送信しました`);
      } catch (error) {
        console.error('リマインダー送信エラー:', error);
      }
    }
  }
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
