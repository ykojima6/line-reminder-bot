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
// { userId: { messageText, timestamp, messageId, displayName, sourceType, needsReply } }
const messageLog = {};

// メッセージの自動返信応答パターン
const autoReplyPatterns = [
  {
    keywords: ['ありがと', 'thanks', 'thank you', 'サンキュ'],
    reply: "どういたしまして！何かあればいつでもご連絡ください。"
  },
  {
    keywords: ['了解', 'わかりました', 'わかった', 'OK', 'ok'],
    reply: null // 自動返信なし、ただし自動的に返信済みとしてマーク
  }
];

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

// 返信済みとしてマークする関数
function markAsReplied(userId) {
  if (messageLog[userId] && messageLog[userId].needsReply) {
    logDebug(`ユーザー ${userId} の会話を返信済みとしてマークします`);
    messageLog[userId].needsReply = false;
    // 返信が行われた時間を記録
    messageLog[userId].repliedAt = Date.now();
    return true;
  }
  return false;
}

// Slackにボタン付き通知を送信する関数
async function sendSlackInteractiveNotification(userId, userInfo) {
  try {
    const sourceTypeText = {
      'user': '個別チャット',
      'group': 'グループ',
      'room': 'ルーム'
    }[userInfo.sourceType] || '不明';
    
    // Slackに通知を送信する - シンプルなテキストメッセージに変更
    const message = {
      text: `*新規メッセージ*\n*送信元*: ${sourceTypeText}\n*送信者*: ${userInfo.displayName}\n*内容*: ${userInfo.messageText}\n*メッセージID*: ${userInfo.messageId}\n\n返信済みにするには: \`/mark-replied ${userId}\` と入力してください。`
    };
    
    const response = await axios.post(SLACK_WEBHOOK_URL, message);
    logDebug(`Slackにインタラクティブ通知を送信しました, ステータス: ${response.status}`);
  } catch (error) {
    console.error('Slackインタラクティブ通知の送信に失敗しました:', error.message);
    // 通常の通知にフォールバック
    await sendSlackNotification(`*新規メッセージ*\n*送信元*: ${userInfo.sourceType}\n*送信者*: ${userInfo.displayName}\n*内容*: ${userInfo.messageText}\n*メッセージID*: ${userInfo.messageId}`);
  }
}

// 自動応答機能
async function sendAutoReply(userId, replyText) {
  try {
    await client.pushMessage(userId, {
      type: 'text',
      text: replyText
    });
    
    logDebug(`ユーザー ${userId} に自動応答を送信しました: ${replyText}`);
    markAsReplied(userId);
    
    // Slackに通知
    await sendSlackNotification(`*自動応答送信*\n*ユーザー*: ${messageLog[userId].displayName}\n*内容*: ${replyText}`);
    
    return true;
  } catch (error) {
    console.error('自動応答送信エラー:', error);
    return false;
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
  
  // メッセージ以外のイベントも記録（既読イベントなどを確認するため）
  if (event.type !== 'message') {
    logDebug(`非メッセージイベント: ${event.type}`);
    return Promise.resolve(null);
  }
  
  // テキストメッセージ以外は無視
  if (event.message.type !== 'text') {
    logDebug(`非テキストメッセージ: ${event.message.type}`);
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
    
    logDebug(`メッセージ送信者判定: userId=${userId}, isFromUser=${isFromUser}, replyToken=${!!event.replyToken}`);
    
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
      Object.keys(messageLog).forEach(uid => {
        messageLog[uid].needsReply = false;
      });
      
      await sendSlackNotification(`*システムリセット*\n*ユーザー*: ${userDisplayName}\nすべてのユーザーの未返信状態をリセットしました。`);
      
      // 返信を送信
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: "システムをリセットしました。すべての未返信状態がクリアされました。"
      });
    }

    // 特別コマンド処理: すべて返信済みにする
    if (isFromUser && (messageText === '全部返信済み' || messageText === 'すべて返信済み' || messageText === '返信済み')) {
      markAsReplied(userId);
      
      await sendSlackNotification(`*すべて返信済みにしました*\n*ユーザー*: ${userDisplayName}\nこのユーザーへの未返信状態をクリアしました。`);
      
      // 返信を送信
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: "未返信状態をクリアしました。"
      });
    }
    
    // 特別コマンド処理: ステータスチェック
    if (isFromUser && (messageText === 'ステータス' || messageText === 'status')) {
      const needsReply = messageLog[userId] && messageLog[userId].needsReply;
      let statusMessage;
      
      if (needsReply) {
        const lastMessageTime = new Date(messageLog[userId].timestamp).toLocaleString('ja-JP');
        statusMessage = `現在、あなたの未返信メッセージがあります。\n\n最後のメッセージ: "${messageLog[userId].messageText}"\n時間: ${lastMessageTime}`;
      } else {
        statusMessage = "現在、あなたへの未返信メッセージはありません。";
      }
      
      logDebug(`ステータスチェック: ユーザー ${userId} の返信状態: ${needsReply ? '未返信あり' : '未返信なし'}`);
      
      // 返信を送信
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: statusMessage
      });
    }
    
    // 特別コマンド処理: デバッグログ
    if (isFromUser && (messageText === 'デバッグログ' || messageText === 'debuglog')) {
      // 未返信メッセージの数を数える
      let pendingCount = 0;
      for (const uid in messageLog) {
        if (messageLog[uid].needsReply) {
          pendingCount++;
        }
      }
      
      const logMessage = `*デバッグ情報*\n未返信ユーザー数: ${pendingCount}\n\n最新のログ（最大10件）:\n${debugLogs.slice(0, 10).join('\n')}`;
      
      // 返信を送信
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: logMessage
      });
    }
    
    // ユーザーからのメッセージのみ記録して処理
    if (isFromUser) {
      // メッセージを記録
      messageLog[userId] = {
        messageText: messageText,
        timestamp: timestamp,
        messageId: messageId,
        displayName: userDisplayName,
        sourceType: sourceType,
        needsReply: true // ユーザーからのメッセージは返信が必要
      };
      
      logDebug(`ユーザー${userId}のメッセージを記録しました: ${messageText}, 返信必要=true`);
      
      // 自動返信/マーク対象かチェック
      let isAutoHandled = false;
      
      // パターンとマッチするか確認
      for (const pattern of autoReplyPatterns) {
        if (pattern.keywords.some(keyword => messageText.toLowerCase().includes(keyword.toLowerCase()))) {
          if (pattern.reply) {
            // 自動返信あり
            await sendAutoReply(userId, pattern.reply);
          } else {
            // 自動返信なし、ただし返信済みとしてマーク
            markAsReplied(userId);
            logDebug(`ユーザー ${userId} のメッセージを自動的に返信済みとしてマークしました (キーワードマッチ)`);
          }
          isAutoHandled = true;
          break;
        }
      }
      
      // 自動処理されなかった場合はSlack通知
      if (!isAutoHandled) {
        await sendSlackInteractiveNotification(userId, messageLog[userId]);
      }
    }
    
  } catch (error) {
    console.error('メッセージ処理エラー:', error);
  }

  return Promise.resolve(null);
}

// Slack対話用エンドポイント
app.post('/slack/actions', express.urlencoded({ extended: true }), async (req, res) => {
  // Slackからのペイロードを取得
  const payload = JSON.parse(req.body.payload);
  
  logDebug(`Slackアクション受信: ${payload.callback_id}`);
  
  // アクションタイプに応じて処理
  if (payload.callback_id === 'message_actions') {
    const action = payload.actions[0];
    
    if (action.name === 'mark_replied') {
      const userId = action.value;
      const success = markAsReplied(userId);
      
      // Slackに応答
      if (success) {
        logDebug(`Slack経由で ${userId} のメッセージを返信済みとしてマークしました`);
        res.json({
          text: `✅ ユーザー ${messageLog[userId].displayName} へのメッセージを返信済みとしてマークしました。`,
          replace_original: false
        });
      } else {
        res.json({
          text: `⚠️ ユーザー ID: ${userId} の未返信メッセージは見つかりませんでした。`,
          replace_original: false
        });
      }
    }
  } else {
    res.status(200).end(); // 不明なアクションの場合は単に応答する
  }
});

// 外部からの返信マーク用エンドポイント
app.post('/api/mark-as-replied', express.json(), (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, error: 'ユーザーIDが必要です' });
  }
  
  const success = markAsReplied(userId);
  
  if (success) {
    logDebug(`API経由で ${userId} のメッセージを返信済みとしてマークしました`);
    res.status(200).json({ success: true, message: `ユーザー ${userId} のメッセージを返信済みとしてマークしました` });
  } else {
    res.status(404).json({ success: false, message: `ユーザー ${userId} の未返信メッセージは見つかりませんでした` });
  }
});

// Slackスラッシュコマンド用エンドポイント
app.post('/slack/commands', express.urlencoded({ extended: true }), (req, res) => {
  const { command, text, token, user_name } = req.body;
  
  logDebug(`Slackコマンド受信: ${command} ${text} from ${user_name}`);
  
  // /mark-replied コマンド
  if (command === '/mark-replied') {
    const userId = text.trim();
    
    if (!userId) {
      return res.json({
        response_type: 'ephemeral',
        text: '⚠️ ユーザーIDが必要です。例: `/mark-replied USER_ID_HERE`'
      });
    }
    
    const success = markAsReplied(userId);
    
    if (success) {
      logDebug(`Slackコマンド経由で ${userId} のメッセージを返信済みとしてマークしました`);
      return res.json({
        response_type: 'ephemeral',
        text: `✅ ユーザー ${messageLog[userId].displayName} へのメッセージを返信済みとしてマークしました。`
      });
    } else {
      return res.json({
        response_type: 'ephemeral',
        text: `⚠️ ユーザー ID: ${userId} の未返信メッセージは見つかりませんでした。`
      });
    }
  }
  
  // 不明なコマンド
  res.json({
    response_type: 'ephemeral',
    text: `不明なコマンドです: ${command}`
  });
});

// 外部から返信を送信するエンドポイント
app.post('/api/send-reply', express.json(), async (req, res) => {
  const { userId, message } = req.body;
  
  if (!userId || !message) {
    return res.status(400).json({ success: false, error: 'ユーザーIDとメッセージが必要です' });
  }
  
  try {
    // メッセージを送信
    await client.pushMessage(userId, {
      type: 'text',
      text: message
    });
    
    // 返信済みとしてマーク
    const marked = markAsReplied(userId);
    
    logDebug(`API経由でユーザー ${userId} にメッセージを送信し、返信済みとしてマークしました`);
    
    res.status(200).json({ 
      success: true, 
      messageSent: true,
      markedAsReplied: marked,
      message: `ユーザー ${userId} にメッセージを送信しました` 
    });
  } catch (error) {
    console.error('メッセージ送信エラー:', error);
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
    
    // すべてのメッセージをチェック
    for (const userId in messageLog) {
      const userInfo = messageLog[userId];
      
      // 返信が必要なメッセージのみ処理
      if (userInfo.needsReply) {
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
          
          // ボタン形式ではなく、テキスト指示形式に変更
          const markRepliedText = `\n\n返信済みにするには: \`/mark-replied ${user.userId}\` と入力してください。`;
          
          return `*送信者*: ${user.name}\n*送信元*: ${sourceTypeText}\n*内容*: ${user.message.text}\n*メッセージID*: ${user.message.id}\n*経過時間*: ${user.elapsedMinutes}分${markRepliedText}`;
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
  
  // 返信済みで1日以上経過したメッセージをクリーンアップ
  for (const userId in messageLog) {
    const message = messageLog[userId];
    
    // 返信済みで1日以上経過
    if (!message.needsReply && message.repliedAt && (now - message.repliedAt > oneDayInMs)) {
      delete messageLog[userId];
      cleanupCount++;
    }
  }
  
  logDebug(`${cleanupCount}件の古いメッセージをクリーンアップしました`);
});

// 現在のメッセージ状態を表示するエンドポイント
app.get('/api/messages', (req, res) => {
  // 未返信メッセージの数を数える
  let pendingCount = 0;
  for (const uid in messageLog) {
    if (messageLog[uid].needsReply) {
      pendingCount++;
    }
  }
  
  res.json({
    success: true,
    totalCount: Object.keys(messageLog).length,
    pendingCount,
    messages: messageLog
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

// GET形式による返信済みマーク
app.get('/api/mark-as-replied', (req, res) => {
  const userId = req.query.userId;
  
  if (!userId) {
    return res.status(400).send('ユーザーIDが必要です');
  }
  
  const success = markAsReplied(userId);
  
  if (success) {
    const userName = messageLog[userId] ? messageLog[userId].displayName : 'Unknown User';
    logDebug(`Web経由で ${userId} (${userName}) のメッセージを返信済みとしてマークしました`);
    res.send(`<html><body><h1>✅ 成功</h1><p>ユーザー ${userName} へのメッセージを返信済みとしてマークしました。</p><p><a href="javascript:window.close();">このウィンドウを閉じる</a></p></body></html>`);
  } else {
    res.send(`<html><body><h1>⚠️ エラー</h1><p>ユーザー ID: ${userId} の未返信メッセージは見つかりませんでした。</p><p><a href="javascript:window.close();">このウィンドウを閉じる</a></p></body></html>`);
  }
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logDebug(`Server running on port ${PORT}`);
});
