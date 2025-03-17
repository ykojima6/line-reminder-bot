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

// 会話履歴を保存する構造
// { userId: { lastMessage: { id, text, timestamp, userName }, needsResponse: true/false } }
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
    
    // 会話状態を取得または初期化
    if (!conversations[userId]) {
      conversations[userId] = {
        lastMessage: null,
        needsResponse: false
      };
    }
    
    // 特別コマンド処理：すべて返信済みにする
    if (messageText === '全部返信済み' || messageText === 'すべて返信済み') {
      conversations[userId].needsResponse = false;
      
      await sendSlackNotification(`*すべて返信済みにしました*\n*ユーザー*: ${userDisplayName}\nこのユーザーの未返信状態をクリアしました。`);
      
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `未返信状態をクリアしました。`
      });
    }
    
    // ユーザーからの新しいメッセージとして記録
    const prevMessage = conversations[userId].lastMessage;
    
    // 新しいメッセージを記録
    conversations[userId].lastMessage = {
      id: messageId,
      text: messageText,
      timestamp: timestamp,
      userName: userDisplayName,
      sourceType: sourceType
    };
    
    // 応答待ちの場合は、前のメッセージの「応答待ち」フラグをクリア
    if (conversations[userId].needsResponse) {
      conversations[userId].needsResponse = false;
      
      // 前回のメッセージに対する返信としてマーク
      if (prevMessage) {
        await sendSlackNotification(`*返信完了*\n*ユーザー*: ${userDisplayName}\n*元のメッセージ*: ${prevMessage.text}\n*返信内容*: ${messageText}`);
        console.log(`ユーザー${userId}の前回のメッセージに対する返信を記録しました`);
      }
    } else {
      // 前回が応答待ちでない場合は、新しいメッセージを応答待ちとしてマーク
      conversations[userId].needsResponse = true;
    }
    
    // 現在の会話状態をデバッグ出力
    console.log(`ユーザー${userId}の会話状態:`, JSON.stringify(conversations[userId]));
    
    // Slackに通知を送信
    const sourceTypeText = {
      'user': '個別チャット',
      'group': 'グループ',
      'room': 'ルーム'
    }[sourceType] || '不明';
    
    await sendSlackNotification(`*新規メッセージ*\n*送信元*: ${sourceTypeText}\n*送信者*: ${userDisplayName}\n*内容*: ${messageText}\n*メッセージID*: ${messageId}`);
    
    console.log(`ユーザー${userId}からの新規メッセージを記録しました: ${messageText}`);
    
    // 1分後にリマインダーチェックを実行（デバッグ用）
    setTimeout(() => {
      console.log('1分後のデバッグチェック - 現在の会話状態:');
      for (const uid in conversations) {
        console.log(`ユーザー${uid}:`, JSON.stringify(conversations[uid]));
      }
    }, 60000);
    
  } catch (error) {
    console.error('メッセージ処理エラー:', error);
  }

  return Promise.resolve(null);
}
// 1分ごとにリマインダーチェックを実行
cron.schedule('* * * * *', async () => {
  console.log('1分間隔の未返信チェック実行中...', new Date().toISOString());
  await checkUnrepliedMessages();
});

// 10分ごとのチェックは必要なければ削除または無効化可能
// cron.schedule('*/10 * * * *', async () => {
//   console.log('デバッグ用10分チェック実行中...', new Date().toISOString());
//   await checkUnrepliedMessages();
// });
// 未返信メッセージをチェックして通知する関数
async function checkUnrepliedMessages() {
  const now = Date.now();
  const oneMinuteInMs = 1 * 60 * 1000;  // 1分をミリ秒に変換
  
  console.log('現在の会話状態全体:', JSON.stringify(conversations));
  
  let unrepliedMessagesAll = [];
  
  // すべてのユーザーの会話をチェック
  for (const userId in conversations) {
    const convo = conversations[userId];
    
    console.log(`ユーザー${userId}のチェック:`, JSON.stringify(convo));
    
    // 応答待ちのメッセージがあり、1分以上経過していれば未返信としてマーク
    if (convo.needsResponse && convo.lastMessage) {
      const elapsedTime = now - convo.lastMessage.timestamp;
      const elapsedMinutes = Math.floor(elapsedTime / (60 * 1000));
      
      console.log(`ユーザー${userId}の最後のメッセージ:`, 
                 `ID=${convo.lastMessage.id}`, 
                 `経過時間=${elapsedMinutes}分`, 
                 `応答待ち=${convo.needsResponse}`);
      
      if (elapsedTime >= oneMinuteInMs) {
        unrepliedMessagesAll.push({
          userId: userId,
          userName: convo.lastMessage.userName || 'Unknown User',
          message: convo.lastMessage,
          elapsedMinutes: elapsedMinutes,
          sourceType: convo.lastMessage.sourceType || 'unknown'
        });
      }
    }
  }
  
  console.log(`検出された未返信メッセージ: ${unrepliedMessagesAll.length}件`);
  
  // Slackにリマインダーを送信
  if (unrepliedMessagesAll.length > 0) {
    try {
      const reminderText = unrepliedMessagesAll.map(item => {
        const sourceTypeText = {
          'user': '個別チャット',
          'group': 'グループ',
          'room': 'ルーム'
        }[item.sourceType] || '不明';
        
        return `*送信者*: ${item.userName}\n*送信元*: ${sourceTypeText}\n*内容*: ${item.message.text}\n*メッセージID*: ${item.message.id}\n*経過時間*: ${item.elapsedMinutes}分`;
      }).join('\n\n');
      
      console.log('Slackにリマインダーを送信します:', reminderText);
      
      await sendSlackNotification(`*【1分以上未返信リマインダー】*\n以下のメッセージに返信がありません:\n\n${reminderText}`);
      
      console.log(`${unrepliedMessagesAll.length}件のリマインダーをSlackに送信しました`);
    } catch (error) {
      console.error('Slackリマインダー送信エラー:', error);
    }
  } else {
    console.log('未返信メッセージはありません');
  }
}

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
