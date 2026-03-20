// Vercel Serverless Function for Kimi AI Chat
// Node.js runtime - supports @vercel/blob

import { put, get } from '@vercel/blob';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'your-secret-key-change-in-production');
const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const LOG_PREFIX = 'chat-conversations';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, articleTitle, articleContent, articleUrl, articleSlug, history = [] } = req.body;

    if (!message) return res.status(400).json({ error: 'Message is required' });
    if (!articleSlug) return res.status(400).json({ error: 'Article slug is required' });

    const apiKey = process.env.KIMI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    // Get user from token (optional)
    const authHeader = req.headers.authorization;
    let userId = 'guest';
    let username = 'guest';

    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7);
        const { payload } = await jwtVerify(token, JWT_SECRET);
        userId = payload.userId;
        username = payload.username;
      } catch {
        // Invalid token, treat as guest
      }
    }

    const conversationId = crypto.randomUUID();
    const startTime = Date.now();

    // Build messages array with history
    const systemPrompt = `你是一位专业的技术博客 AI 助手，帮助读者理解文章内容。

当前文章信息：
- 标题：${articleTitle || '未知'}
- URL：${articleUrl || '未知'}

文章内容（部分）：
${articleContent?.substring(0, 6000) || '未提供文章内容'}

请基于以上文章内容回答读者的问题。如果问题与文章内容无关，请礼貌地引导读者回到文章主题。回答要简洁、专业、有帮助。如果文中涉及技术概念，请用通俗易懂的方式解释。使用 Markdown 格式输出，代码块用 \`\`\`language 标注。`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message },
    ];

    const response = await fetch(KIMI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'kimi-k2.5',
        messages,
        temperature: 1,
        max_tokens: 3000,
      }),
    });

    const latency = Date.now() - startTime;

    if (!response.ok) {
      const error = await response.text();
      console.error('Kimi API error:', error);
      await logToBlob({ conversationId, articleTitle, articleUrl, username, userMessage: message, error, latency, success: false });
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const assistantMessage = data.choices?.[0]?.message?.content || '';

    // Save conversation if user is logged in
    if (userId !== 'guest') {
      try {
        await saveConversation(userId, articleSlug, articleTitle, articleUrl, [
          ...history,
          { role: 'user', content: message, timestamp: new Date().toISOString() },
          { role: 'assistant', content: assistantMessage, timestamp: new Date().toISOString() },
        ]);
      } catch (saveError) {
        console.error('Save conversation error:', saveError);
      }
    }

    // Log to analytics blob
    try {
      await logToBlob({
        conversationId,
        articleTitle,
        articleUrl,
        username,
        userMessage: message,
        assistantResponse: assistantMessage,
        latency,
        timestamp: new Date().toISOString(),
        model: 'kimi-k2.5',
        tokenUsage: data.usage || {},
        success: true,
      });
    } catch (logError) {
      console.error('Blob log error:', logError);
    }

    res.status(200).json({
      ...data,
      conversationId,
      userId,
    });
  } catch (error) {
    console.error('Chat API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function saveConversation(userId, articleSlug, articleTitle, articleUrl, messages) {
  const conversationPath = `conversations/${userId}/${articleSlug}.json`;

  const conversation = {
    userId,
    articleSlug,
    articleTitle,
    articleUrl,
    messages,
    updatedAt: new Date().toISOString(),
  };

  // If this is first save, add createdAt
  try {
    const existing = await get(conversationPath);
    const existingData = JSON.parse(await existing.text());
    conversation.createdAt = existingData.createdAt;
  } catch {
    conversation.createdAt = new Date().toISOString();
  }

  await put(conversationPath, JSON.stringify(conversation), {
    access: 'private',
    contentType: 'application/json',
  });
}

async function logToBlob(data) {
  try {
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      console.log('CHAT LOG (no token):', JSON.stringify(data, null, 2));
      return;
    }

    const articleSlug = (data.articleUrl || 'unknown').split('/').filter(Boolean).pop() || 'unknown';
    const date = new Date().toISOString().split('T')[0];
    const pathname = `${LOG_PREFIX}/${articleSlug}/${date}/${data.conversationId}.json`;

    await put(pathname, JSON.stringify(data, null, 2), {
      access: 'private',
      contentType: 'application/json',
    });
  } catch (error) {
    console.error('Blob logging error:', error.message);
  }
}
