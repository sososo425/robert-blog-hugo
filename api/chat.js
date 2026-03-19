// Vercel Edge Function for Kimi AI Chat with Blob logging
// This function acts as a proxy to avoid exposing API keys in the frontend

import { put } from '@vercel/blob';

export const config = {
  runtime: 'nodejs',
};

const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const BLOB_PATH_PREFIX = 'chat-conversations';

export default async function handler(request) {
  // Handle CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  let conversationData = null;

  try {
    const body = await request.json();
    const { message, articleTitle, articleContent, articleUrl, conversationId = crypto.randomUUID() } = body;

    if (!message) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const apiKey = process.env.KIMI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'API key not configured' }), {
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      });
    }

    // Build system prompt with article context
    const systemPrompt = `你是一位专业的技术博客 AI 助手，帮助读者理解文章内容。

当前文章信息：
- 标题：${articleTitle || '未知'}
- URL：${articleUrl || '未知'}

文章内容（部分）：
${articleContent?.substring(0, 6000) || '未提供文章内容'}

请基于以上文章内容回答读者的问题。如果问题与文章内容无关，请礼貌地引导读者回到文章主题。回答要简洁、专业、有帮助。如果文中涉及技术概念，请用通俗易懂的方式解释。使用 Markdown 格式输出，代码块用 \`\`\`language 标注。`;

    const startTime = Date.now();

    const response = await fetch(KIMI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'kimi-k2.5',
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: message,
          },
        ],
        temperature: 1,
        max_tokens: 3000,
      }),
    });

    const latency = Date.now() - startTime;

    if (!response.ok) {
      const error = await response.text();
      console.error('Kimi API error:', error);

      // Log failed request to Blob
      await logToBlob({
        conversationId,
        articleTitle,
        articleUrl,
        userMessage: message,
        assistantResponse: null,
        error: error,
        latency,
        timestamp: new Date().toISOString(),
        model: 'kimi-k2.5',
        success: false,
      });

      return new Response(JSON.stringify({ error: 'AI service error' }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const data = await response.json();

    // Log successful conversation to Blob (async, don't block response)
    conversationData = {
      conversationId,
      articleTitle,
      articleUrl,
      userMessage: message,
      assistantResponse: data.choices?.[0]?.message?.content || '',
      latency,
      timestamp: new Date().toISOString(),
      model: 'kimi-k2.5',
      tokenUsage: data.usage || {},
      success: true,
    };

    // Don't await Blob write to avoid slowing down response
    logToBlob(conversationData).catch(err => {
      console.error('Failed to log to Blob:', err);
    });

    return new Response(JSON.stringify({
      ...data,
      conversationId,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    console.error('Chat API error:', error);

    // Log error to Blob if we have conversation data
    if (conversationData) {
      logToBlob({
        ...conversationData,
        error: error.message,
        success: false,
      }).catch(() => {});
    }

    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

/**
 * Log conversation to Vercel Blob for analysis
 * Path: chat-conversations/{articleSlug}/{date}/{conversationId}.json
 *
 * Local development: Falls back to console output if BLOB_READ_WRITE_TOKEN is not set
 */
async function logToBlob(data) {
  try {
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const isLocalDev = !blobToken || process.env.VERCEL_ENV === 'development';

    // Extract article slug from URL for logging
    const articleUrl = data.articleUrl || 'unknown';
    const articleSlug = articleUrl.split('/').filter(Boolean).pop() || 'unknown';
    const date = new Date().toISOString().split('T')[0];
    const pathname = `${BLOB_PATH_PREFIX}/${articleSlug}/${date}/${data.conversationId}.json`;

    if (isLocalDev) {
      // Local development: log to console with clear formatting
      console.log('\n' + '='.repeat(60));
      console.log('📝 CHAT LOG (Local Development Mode)');
      console.log('='.repeat(60));
      console.log(`Path: ${pathname}`);
      console.log(`Time: ${data.timestamp}`);
      console.log(`Article: ${data.articleTitle}`);
      console.log(`Success: ${data.success}`);
      console.log('-'.repeat(60));
      console.log('User:', data.userMessage);
      console.log('-'.repeat(60));
      if (data.assistantResponse) {
        console.log('Assistant:', data.assistantResponse.substring(0, 200) + '...');
      }
      if (data.error) {
        console.log('Error:', data.error);
      }
      console.log('='.repeat(60) + '\n');

      // Also log full JSON for detailed inspection
      console.log('Full JSON (for copy-paste):');
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    // Production: Upload to Vercel Blob
    const blobData = JSON.stringify(data, null, 2);

    await put(pathname, blobData, {
      access: 'private',
      contentType: 'application/json',
    });

    console.log('Conversation logged to Blob:', pathname);
  } catch (error) {
    console.error('Blob logging error:', error);
    // Don't throw - logging should not break the chat functionality
  }
}
