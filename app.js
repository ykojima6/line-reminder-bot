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

// Slack Webhook URLのチェック
if (!SLACK_WEBHOOK_URL) {
  console.warn('⚠️ SLACK_WEBHOOK_URLが設定されていません。Slack通知は機能しません。');
} else {
  console.log('Slack Webhook URL:', SLACK_WEBHOOK_URL.substring(0, 30) + '...');
}

// 指定された返信済みとみなすユーザーID
const REPLY_USER_ID = process.env.REPLY_USER_ID || 'Ubf54091c82026dcfb8ede187814fdb9b';

// ログ出力
console.log('環境変数の状態:');
console.log('LINE_CHANNEL_ACCESS_TOKEN exists:', !!process.env.LINE_CHANNEL_ACCESS_TOKEN);
console.log('LINE_CHANNEL_SECRET exists:', !!process.env.LINE_CHANNEL_SECRET);
console.log('SLACK_WEBHOOK_URL exists:', !!process.env.SLACK_WEBHOOK_URL);
console.log('REPLY_USER_ID:', safeUserId(REPLY_USER_ID));

// LINEクライアントを初期化
const client = new line.Client(config);

// メッセージ履歴 - シンプルな配列として保存
const messageHistory = [];

// ログやデバッグ出力でユーザーIDを安全に表示する関数
function safeUserId(userId) {
  if (!userId) return 'unknown';
  // ユーザーIDの先頭と末尾だけを表示し、中間は*で置き換える
  const length = userId.length;
  if (length <= 6) return '***'; // 短すぎる場合は全て隠す
  return userId.substring(0, 3) + '***' + userId.substring(length - 3);
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

// Slack通知のテスト用エンドポイント
app.get('/test-slack', async (req, res) => {
  try {
    const result = await sendSlackNotification('これはSlack通知のテストメッセージです。時刻: ' + new Date().toLocaleString('ja-JP'));
    res.json({
      success: result,
      message: result ? 'Slack通知を送信しました' : 'Slack通知の送信に失敗しました',
      webhook_url_set: !!SLACK_WEBHOOK_URL,
      webhook_url_preview: SLACK_WEBHOOK_URL ? SLACK_WEBHOOK_URL.substring(0, 30) + '...' : 'Not set'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      webhook_url_set: !!SLACK_WEBHOOK_URL
    });
  }
});

// デバッグ用ルート
app.get('/debug', (req, res) => {
  // 安全なバージョンのメッセージ履歴を作成（ユーザーIDを隠す）
  const safeHistory = messageHistory.map(msg => ({
    ...msg,
    userId: safeUserId(msg.userId),
    chatId: safeUserId(msg.chatId)
  }));
  
  const debugInfo = {
    messageCount: messageHistory.length,
    unrepliedCount: messageHistory.filter(msg => !msg.replied && msg.userId !== REPLY_USER_ID).length,
    recentMessages: safeHistory.slice(-5), // 最新5件のメッセージ
    slack_webhook_url_set: !!SLACK_WEBHOOK_URL,
    slack_webhook_url_preview: SLACK_WEBHOOK_URL ? SLACK_WEBHOOK_URL.substring(0, 30) + '...' : 'Not set'
  };
  res.json(debugInfo);
});

// Slackに通知を送信する関数 (直接フェッチ使用)
async function sendSlackNotification(message) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('❌ Slack Webhook URLが設定されていないため、通知をスキップします');
    return false;
  }

  try {
    console.log('📤 Slack通知を送信します:', message.substring(0, 100) + (message.length > 100 ? '...' : ''));
    
    // Axiosでリクエスト
    const payload = JSON.stringify({ text: message });
    console.log('送信するペイロード:', payload);
    
    // 詳細なリクエスト情報を表示
    console.log('POST先URL:', SLACK_WEBHOOK_URL);
    
    const response = await axios({
      method: 'post',
      url: SLACK_WEBHOOK_URL,
      data: { text: message },
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000 // 10秒タイムアウト
    });
    
    console.log('📬 Slack APIレスポンス:', {
      status: response.status,
      statusText: response.statusText,
      data: response.data
    });
    
    if (response.status >= 200 && response.status < 300) {
      console.log('✅ Slack通知を送信しました, ステータス:', response.status);
      return true;
    } else {
      console.error('❌ Slack通知送信エラー - 不正なステータスコード:', response.status);
      return false;
    }
  } catch (error) {
    console.error('❌ Slack通知の送信に失敗しました:', error.message);
    
    if (error.response) {
      // サーバーからのレスポンスがあった場合
      console.error('🔍 レスポンス詳細:', {
        status: error.response.status,
        headers: error.response.headers,
        data: error.response.data
      });
    } else if (error.request) {
      // リクエストは送信されたがレスポンスがなかった場合
      console.error('🔍 リクエストは送信されましたが、レスポンスがありませんでした:', error.request);
    } else {
      // リクエスト作成時にエラーが発生した場合
      console.error('🔍 リクエスト作成中にエラーが発生しました:', error.message);
    }
    
    // 別の方法でも試してみる（フェールバック）
    try {
      console.log('🔄 別の方法でSlack通知を試みます...');
      const fetchResponse = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message })
      });
      
      console.log('🔄 代替方法の結果:', {
        status: fetchResponse.status,
        ok: fetchResponse.ok
      });
      
      return fetchResponse.ok;
    } catch (fetchError) {
      console.error('❌ 代替方法も失敗しました:', fetchError.message);
      return false;
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
  console.log('イベント処理:', event.type, 'イベントタイプ:', event.source?.type);
  
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
      console.log('送信者プロフィール取得成功:', JSON.stringify(senderProfile));
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
    
    // チャットID (グループ、ルーム、または個別チャットのID)
    const chatId = event.source.groupId || event.source.roomId || userId;
    
    console.log(`メッセージ情報: userId=${safeUserId(userId)}, displayName=${userDisplayName}, ` +
                `sourceType=${sourceType}, chatId=${safeUserId(chatId)}, text=${messageText}`);
    
    // 特別コマンド処理: すべて返信済みにする
    if (messageText === '全部返信済み' || messageText === 'すべて返信済み') {
      // メッセージ履歴からこのチャットの未返信メッセージをすべて削除
      const messageCount = messageHistory.length;
      for (let i = 0; i < messageHistory.length; i++) {
        if (messageHistory[i].chatId === chatId) {
          messageHistory[i].replied = true;
        }
      }
      
      const message = `*すべて返信済みにしました*\n*ユーザー*: ${userDisplayName}\nこのチャットのすべてのメッセージを返信済みとしてマークしました。`;
      await sendSlackNotification(message);
      
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `未返信状態をクリアしました。`
      });
    }
    
    // 特別コマンド: Slack通知テスト
    if (messageText === 'slack-test' || messageText === 'slackテスト') {
      const testResult = await sendSlackNotification(`*これはSlack通知のテストです*\n送信者: ${userDisplayName}\n時刻: ${new Date().toLocaleString('ja-JP')}`);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: testResult ? 'Slackへの通知テストが成功しました！' : 'Slackへの通知テストが失敗しました。ログを確認してください。'
      });
    }
    
    // 新しいメッセージを保存
    const newMessage = {
      chatId,
      userId,
      userDisplayName,
      sourceType,
      messageId,
      messageText,
      timestamp,
      replied: userId === REPLY_USER_ID  // 特定のユーザーからのメッセージは自動的に「返信済み」とマーク
    };
    
    // メッセージ履歴に追加
    messageHistory.push(newMessage);
    
    console.log(`新しいメッセージを保存しました:`, JSON.stringify({...newMessage, userId: safeUserId(userId), chatId: safeUserId(chatId)}));
    console.log(`現在のメッセージ履歴数: ${messageHistory.length}`);
    
    // 特定ユーザー以外からのメッセージに対してSlack通知
    if (userId !== REPLY_USER_ID) {
      const sourceTypeText = {
        'user': '個別チャット',
        'group': 'グループ',
        'room': 'ルーム'
      }[sourceType] || '不明';
      
      const notificationText = `*新規メッセージ*\n*送信元*: ${sourceTypeText}\n*送信者*: ${userDisplayName}\n*内容*: ${messageText}\n*送信時刻*: ${new Date(timestamp).toLocaleString('ja-JP')}`;
      
      try {
        console.log('🔔 新規メッセージ通知を送信します...');
        const notificationSent = await sendSlackNotification(notificationText);
        console.log('🔔 新規メッセージの通知状態:', notificationSent ? '成功' : '失敗');
      } catch (error) {
        console.error('❌ 通知送信中にエラーが発生しました:', error);
      }
    } else {
      console.log(`自分からのメッセージを記録しました: ${messageText}`);
      
      // 自分からのメッセージは、同じチャットの直前のメッセージに「返信済み」としてマーク
      for (let i = messageHistory.length - 2; i >= 0; i--) {
        const prevMsg = messageHistory[i];
        if (prevMsg.chatId === chatId && prevMsg.userId !== REPLY_USER_ID && !prevMsg.replied) {
          prevMsg.replied = true;
          console.log(`ID:${prevMsg.messageId}のメッセージを返信済みとしてマーク`);
          break;
        }
      }
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
  
  // 未返信メッセージのフィルタリング
  const unrepliedMessages = messageHistory.filter(msg => {
    // 「返信済み」でないかつ、送信者が特定ユーザーでないかつ、1分以上経過
    return !msg.replied && 
           msg.userId !== REPLY_USER_ID && 
           (now - msg.timestamp) >= oneMinuteInMs;
  });
  
  console.log(`未返信メッセージ数: ${unrepliedMessages.length}/${messageHistory.length}`);
  
  // Slackにリマインダーを送信
  if (unrepliedMessages.length > 0) {
    try {
      const reminderText = unrepliedMessages.map(msg => {
        const sourceTypeText = {
          'user': '個別チャット',
          'group': 'グループ',
          'room': 'ルーム'
        }[msg.sourceType] || '不明';
        
        const elapsedMinutes = Math.floor((now - msg.timestamp) / (60 * 1000));
        const time = new Date(msg.timestamp).toLocaleString('ja-JP');
        
        return `*送信者*: ${msg.userDisplayName}\n*送信元*: ${sourceTypeText}\n*内容*: ${msg.messageText}\n*送信時刻*: ${time}\n*経過時間*: ${elapsedMinutes}分`;
      }).join('\n\n');
      
      const notificationText = `*【1分以上未返信リマインダー】*\n以下のメッセージに返信がありません:\n\n${reminderText}`;
      
      console.log('⏰ リマインダー通知を送信します...');
      const notificationSent = await sendSlackNotification(notificationText);
      
      console.log(`⏰ ${unrepliedMessages.length}件のリマインダーをSlackに送信しました: ${notificationSent ? '成功' : '失敗'}`);
    } catch (error) {
      console.error('❌ Slackリマインダー送信エラー:', error);
    }
  }
  
  // 古いメッセージをクリーンアップ（オプション - 3日以上経過したメッセージを削除）
  const threeDaysInMs = 3 * 24 * 60 * 60 * 1000;
  const currentLength = messageHistory.length;
  const filteredMessages = messageHistory.filter(msg => (now - msg.timestamp) < threeDaysInMs);
  
  if (currentLength !== filteredMessages.length) {
    messageHistory.length = 0;
    messageHistory.push(...filteredMessages);
    console.log(`古いメッセージをクリーンアップしました: ${currentLength - messageHistory.length}件削除`);
  }
});

// エラーハンドリング
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
