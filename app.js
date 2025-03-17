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
// ユーザーごとに未返信メッセージを追跡
// { userId: { replyRequired: boolean, lastMessage: {text, timestamp, id}, displayName, sourceType } }
const pendingReplies = {};

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

// ユーザーへの返信をマークする関数
function markAsReplied(userId) {
  if (pendingReplies[userId]) {
    console.log(`ユーザー ${userId} の会話を返信済みとしてマークします`);
    // ユーザーを未返信リストから削除
    delete pendingReplies[userId];
    return true;
  }
  return false;
}

// メッセージを送信し、返信済みとしてマークする関数
async function replyToUser(event, message) {
  try {
    // LINE APIを使ってメッセージを返信
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: message
    });
    
    // 返信後、そのユーザーを未返信リストから削除
    markAsReplied(event.source.userId);
    
    return true;
  } catch (error) {
    console.error('返信エラー:', error);
    return false;
  }
}

// ユーザーにプッシュメッセージを送信し、返信済みとしてマークする関数
async function pushMessageToUser(userId, message) {
  try {
    // LINE APIを使ってメッセージを送信
    await client.pushMessage(userId, {
      type: 'text',
      text: message
    });
    
    // 送信後、そのユーザーを未返信リストから削除
    markAsReplied(userId);
    
    return true;
  } catch (error) {
    console.error('メッセージ送信エラー:', error);
    return false;
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
  // バッファをそのまま使用して署名計算（バイナリセーフ）
  const bodyStr = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const digestFromBody = hmac.update(bodyStr).digest('base64');
  
  if (digestFromBody !== signature) {
    console.log('署名が一致しません');
    console.log('Expected:', digestFromBody);
    console.log('Received:', signature);
    return res.status(400).send('署名が一致しません');
  }
  
  // リクエストボディをパース
  const parsedBody = Buffer.isBuffer(body) ? JSON.parse(body.toString()) : body;
  console.log('Webhook received:', JSON.stringify(parsedBody).substring(0, 500) + '...');
  
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
  
  // メッセージイベント以外は無視
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
    
    // 特別コマンド処理: すべて返信済みにする
    if (messageText === '全部返信済み' || messageText === 'すべて返信済み') {
      markAsReplied(userId);
      
      await sendSlackNotification(`*すべて返信済みにしました*\n*ユーザー*: ${userDisplayName}\nこのユーザーへの未返信状態をクリアしました。`);
      
      // 返信を送信し、送信後に返信済みとマーク
      return replyToUser(event, "未返信状態をクリアしました。");
    }
    
    // 特別コマンド処理: ステータスチェック
    if (messageText === 'ステータス' || messageText === 'status') {
      const needsReply = userId in pendingReplies;
      const statusMessage = needsReply 
        ? "現在、あなたへの返信が必要なメッセージがあります。"
        : "現在、あなたへの未返信メッセージはありません。";
        
      // 返信を送信し、送信後に返信済みとマーク
      return replyToUser(event, statusMessage);
    }
    
    // ユーザーからのメッセージを記録
    pendingReplies[userId] = {
      messageText: messageText,
      timestamp: timestamp,
      messageId: messageId,
      displayName: userDisplayName,
      sourceType: sourceType
    };
    
    console.log(`ユーザー${userId}からのメッセージを未返信として記録しました:`, messageText);
    
    // Slackに通知を送信
    const sourceTypeText = {
      'user': '個別チャット',
      'group': 'グループ',
      'room': 'ルーム'
    }[sourceType] || '不明';
    
    // ユーザーからのメッセージを通知
    await sendSlackNotification(`*新規メッセージ*\n*送信元*: ${sourceTypeText}\n*送信者*: ${userDisplayName}\n*内容*: ${messageText}\n*メッセージID*: ${messageId}`);
    
  } catch (error) {
    console.error('メッセージ処理エラー:', error);
  }

  return Promise.resolve(null);
}

// 外部からの返信マーク用エンドポイント
app.post('/api/mark-as-replied', express.json(), (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, error: 'ユーザーIDが必要です' });
  }
  
  const success = markAsReplied(userId);
  
  if (success) {
    res.status(200).json({ success: true, message: `ユーザー ${userId} のメッセージを返信済みとしてマークしました` });
  } else {
    res.status(404).json({ success: false, message: `ユーザー ${userId} の未返信メッセージは見つかりませんでした` });
  }
});

// 外部から返信を送信するエンドポイント
app.post('/api/send-reply', express.json(), async (req, res) => {
  const { userId, message } = req.body;
  
  if (!userId || !message) {
    return res.status(400).json({ success: false, error: 'ユーザーIDとメッセージが必要です' });
  }
  
  try {
    const success = await pushMessageToUser(userId, message);
    
    if (success) {
      res.status(200).json({ success: true, message: `ユーザー ${userId} にメッセージを送信しました` });
    } else {
      res.status(500).json({ success: false, message: `ユーザー ${userId} へのメッセージ送信に失敗しました` });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 1分ごとに未返信メッセージをチェックするスケジューラー
let isCheckingUnreplied = false; // 実行中フラグ

cron.schedule('* * * * *', async () => {
  // 前回の実行が完了していない場合はスキップ
  if (isCheckingUnreplied) {
    console.log('前回の未返信チェックが進行中のためスキップします');
    return;
  }
  
  isCheckingUnreplied = true;
  console.log('1分間隔の未返信チェック実行中...', new Date().toISOString());
  
  try {
    const now = Date.now();
    const oneMinuteInMs = 1 * 60 * 1000;  // 1分をミリ秒に変換
    
    let unrepliedUsers = [];
    
    // すべての未返信メッセージをチェック
    for (const userId in pendingReplies) {
      const userInfo = pendingReplies[userId];
      const elapsedTime = now - userInfo.timestamp;
      const elapsedMinutes = Math.floor(elapsedTime / (60 * 1000));
      
      if (elapsedTime >= oneMinuteInMs) {
        unrepliedUsers.push({
          userId,
          name: userInfo.displayName,
          message: {
            text: userInfo.messageText,
            id: userInfo.messageId
          },
          elapsedMinutes,
          sourceType: userInfo.sourceType
        });
      }
    }
    
    console.log(`未返信ユーザー数: ${unrepliedUsers.length}`);
    
    // Slackにリマインダーを送信
    if (unrepliedUsers.length > 0) {
      try {
        const reminderText = unrepliedUsers.map(user => {
          const sourceTypeText = {
            'user': '個別チャット',
            'group': 'グループ',
            'room': 'ルーム'
          }[user.sourceType] || '不明';
          
          return `*送信者*: ${user.name}\n*送信元*: ${sourceTypeText}\n*内容*: ${user.message.text}\n*メッセージID*: ${user.message.id}\n*経過時間*: ${user.elapsedMinutes}分`;
        }).join('\n\n');
        
        await sendSlackNotification(`*【1分以上未返信リマインダー】*\n以下のメッセージに返信がありません:\n\n${reminderText}`);
        
        console.log(`${unrepliedUsers.length}件のリマインダーをSlackに送信しました`);
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

// 現在の未返信メッセージ状態を表示するエンドポイント
app.get('/api/pending-replies', (req, res) => {
  const count = Object.keys(pendingReplies).length;
  res.json({
    success: true,
    count,
    pendingReplies
  });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
