const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const app = express();

// LINE API設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'Dmbv7fVtj/elO9ccW1QOCws7hQFeFHR/jJt0aZqH6jtbfh48T1ZDBvM9Nnxgg38Cwxmgf/h44mjRGJvStj7s1K1DN4OYz5g6RB3yfsThi9iBzGyP1t+bSxD8J//+5hdtkRXw17yLN88g/erAvWvlqQdB04t89/1O/w1cDnyilFU=',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '6b51d27e178d6daf1948fdaad22cde04'
};

// JSONボディパーサー
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ルートパスへのハンドラーを追加
app.get('/', (req, res) => {
  res.send('LINE Bot Server is running!');
});

// 単純なWebhookのテスト用ルート
app.post('/webhook-test', (req, res) => {
  console.log('Webhook test received');
  res.status(200).send('OK');
});

// LINE Bot用Webhookルート
app.post('/webhook', line.middleware(config), (req, res) => {
  console.log('Webhook received:', req.body);
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook error:', err);
      res.status(500).end();
    });
});

// イベントハンドラー
async function handleEvent(event) {
  // メッセージイベントのみ処理
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  // 公式アカウントからのメッセージを保存
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
      const isOfficialAccount = senderProfile && senderProfile.displayName.includes('【公式】');
      
      if (isOfficialAccount) {
        const userId = event.source.userId;
        
        // メッセージを保存
        if (!messageStore[userId]) {
          messageStore[userId] = {};
        }
        
        messageStore[userId][event.message.id] = {
          text: event.message.text,
          sender: userId,
          senderName: senderProfile.displayName,
          timestamp: event.timestamp,
          replied: false
        };
        
        // メッセージを受信したことを通知
        await client.pushMessage(userId, {
          type: 'text',
          text: `${senderProfile.displayName}からメッセージを受信しました: ${event.message.text.substring(0, 20)}...`
        });
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  }
  
  // ユーザーからの返信を処理
  if (event.source.type === 'user') {
    // 返信文から返信対象のメッセージIDを抽出する処理
    // （実際の実装では、LINEのリプライ機能を使うか、独自の形式で返信対象を指定する必要があります）
    const replyToPattern = /返信対象ID:(\w+)/;
    const match = event.message.text.match(replyToPattern);
    
    if (match && match[1]) {
      const messageId = match[1];
      // ユーザーのすべてのメッセージから該当するIDを探す
      Object.values(messageStore).forEach(userMessages => {
        if (userMessages[messageId]) {
          userMessages[messageId].replied = true;
        }
      });
      
      // 返信完了を通知
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '返信を記録しました。'
      });
    }
  }

  return Promise.resolve(null);
}

// 12時間ごとに未返信メッセージをチェックするスケジューラー
cron.schedule('0 */12 * * *', async () => {
  console.log('未返信チェック実行中...');
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
    
    // リマインダーを送信
    if (unrepliedMessages.length > 0) {
      try {
        const reminderText = unrepliedMessages.map(msg => 
          `${msg.senderName}からのメッセージ: ${msg.text.substring(0, 30)}... (返信対象ID:${msg.messageId})`
        ).join('\n\n');
        
        await client.pushMessage(userId, {
          type: 'text',
          text: `【リマインダー】\n以下のメッセージに12時間以上返信がありません:\n\n${reminderText}`
        });
      } catch (error) {
        console.error('Error sending reminder:', error);
      }
    }
  }
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// 古いメッセージを定期的にクリーンアップする処理（オプション）
cron.schedule('0 0 * * *', () => {
  console.log('古いメッセージのクリーンアップ実行中...');
  const now = Date.now();
  const threeDaysInMs = 3 * 24 * 60 * 60 * 1000;
  
  for (const userId in messageStore) {
    const userMessages = messageStore[userId];
    
    for (const messageId in userMessages) {
      const message = userMessages[messageId];
      if ((now - message.timestamp) >= threeDaysInMs) {
        delete userMessages[messageId];
      }
    }
  }
});
