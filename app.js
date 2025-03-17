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

// 指定された返信済みとみなすユーザーID
const REPLY_USER_ID = 'Ubf54091c82026dcfb8ede187814fdb9b';

// ログ出力
console.log('環境変数の状態:');
console.log('LINE_CHANNEL_ACCESS_TOKEN exists:', !!process.env.LINE_CHANNEL_ACCESS_TOKEN);
console.log('LINE_CHANNEL_SECRET exists:', !!process.env.LINE_CHANNEL_SECRET);
console.log('SLACK_WEBHOOK_URL exists:', !!process.env.SLACK_WEBHOOK_URL);
console.log('返信済みとみなすユーザーID:', REPLY_USER_ID);

// LINEクライアントを初期化
const client = new line.Client(config);

// 会話状態管理: ユーザーごとに最後のメッセージ送信者のIDを保存
// { chatId: { lastMessageUserId, lastTimestamp, lastMessage } }
const conversations = {};

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
      senderProfile = { displayName: 'Unknown User' };
    }

    const userId = event.source.userId;
    const userDisplayName = senderProfile ? senderProfile.displayName : 'Unknown User';
    const sourceType = event.source.type;
    const messageId = event.message.id;
    const messageText = event.message.text;
    const timestamp = event.timestamp;
    
    // チャットIDを取得（個別チャットの場合はユーザーID、グループやルームの場合はそのID）
    const chatId = event.source.groupId || event.source.roomId || userId;
    
    // 特別コマンド処理: すべて返信済みにする
    if (messageText === '全部返信済み' || messageText === 'すべて返信済み') {
      if (conversations[chatId]) {
        // 最後のメッセージが「返信済み」とみなすユーザーからのメッセージとしてマーク
        conversations[chatId].lastMessageUserId = REPLY_USER_ID;
      }
      
      await sendSlackNotification(`*すべて返信済みにしました*\n*ユーザー*: ${userDisplayName}\nこのチャットの未返信状態をクリアしました。`);
      
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `未返信状態をクリアしました。`
      });
    }
    
    // 会話状態を更新
    if (!conversations[chatId]) {
      // 初めてのメッセージ
      conversations[chatId] = {
        lastMessageUserId: userId,
        lastTimestamp: timestamp,
        lastMessage: {
          text: messageText,
          id: messageId
        },
        lastUserName: userDisplayName,
        sourceType: sourceType
      };
    } else {
      // 会話状態を更新
      conversations[chatId] = {
        lastMessageUserId: userId,
        lastTimestamp: timestamp,
        lastMessage: {
          text: messageText,
          id: messageId
        },
        lastUserName: userDisplayName,
        sourceType: sourceType
      };
    }
    
    console.log(`チャット${chatId}の会話状態:`, JSON.stringify(conversations[chatId]));
    
    // メッセージが「返信済み」とみなすユーザーからのものではない場合に通知
    if (userId !== REPLY_USER_ID) {
      const sourceTypeText = {
        'user': '個別チャット',
        'group': 'グループ',
        'room': 'ルーム'
      }[sourceType] || '不明';
      
      await sendSlackNotification(`*新規メッセージ*\n*送信元*: ${sourceTypeText}\n*送信者*: ${userDisplayName}\n*内容*: ${messageText}\n*メッセージID*: ${messageId}`);
    } else {
      console.log(`返信済みユーザーからのメッセージを記録しました: ${messageText}`);
    }
    
  } catch (error) {
    console.error('メッセージ処理エラー:', error);
  }

  return Promise.resolve(null);
}

// 1分ごとに未返信メッセージをチェックするスケジューラー
cron.schedule('* * * * *', async () => {
  console.log('1分間隔の未返信チェック実行中...', new Date().toISOString());
  
  const now = Date.now();
  const oneMinuteInMs = 1 * 60 * 1000;  // 1分をミリ秒に変換
  
  let unrepliedChats = [];
  
  // すべてのチャットの状態をチェック
  for (const chatId in conversations) {
    const convo = conversations[chatId];
    
    // 最後のメッセージが「返信済み」とみなすユーザー以外からのもので、1分以上経過している場合
    if (convo.lastMessageUserId !== REPLY_USER_ID) {
      const elapsedTime = now - convo.lastTimestamp;
      const elapsedMinutes = Math.floor(elapsedTime / (60 * 1000));
      
      if (elapsedTime >= oneMinuteInMs) {
        unrepliedChats.push({
          chatId,
          name: convo.lastUserName,
          message: convo.lastMessage,
          elapsedMinutes,
          sourceType: convo.sourceType
        });
      }
    }
  }
  
  console.log(`未返信チャット数: ${unrepliedChats.length}`);
  
  // Slackにリマインダーを送信
  if (unrepliedChats.length > 0) {
    try {
      const reminderText = unrepliedChats.map(chat => {
        const sourceTypeText = {
          'user': '個別チャット',
          'group': 'グループ',
          'room': 'ルーム'
        }[chat.sourceType] || '不明';
        
        return `*送信者*: ${chat.name}\n*送信元*: ${sourceTypeText}\n*内容*: ${chat.message.text}\n*メッセージID*: ${chat.message.id}\n*経過時間*: ${chat.elapsedMinutes}分`;
      }).join('\n\n');
      
      await sendSlackNotification(`*【1分以上未返信リマインダー】*\n以下のメッセージに返信がありません:\n\n${reminderText}`);
      
      console.log(`${unrepliedChats.length}件のリマインダーをSlackに送信しました`);
    } catch (error) {
      console.error('Slackリマインダー送信エラー:', error);
    }
  }
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
