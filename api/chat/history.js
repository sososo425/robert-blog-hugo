// Get chat history for a specific article
import { get, put } from '@vercel/blob';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'your-secret-key-change-in-production');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { articleSlug } = req.query;

    if (!articleSlug) {
      return res.status(400).json({ error: 'Article slug is required' });
    }

    // Get user from token (optional - guest users don't have history)
    const authHeader = req.headers.authorization;
    let userId = 'guest';

    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7);
        const { payload } = await jwtVerify(token, JWT_SECRET);
        userId = payload.userId;
      } catch {
        // Invalid token, treat as guest
      }
    }

    const conversationPath = `conversations/${userId}/${articleSlug}.json`;

    try {
      const blob = await get(conversationPath);
      const text = await blob.text();
      const conversation = JSON.parse(text);

      res.status(200).json({
        success: true,
        messages: conversation.messages || [],
        userId,
      });
    } catch {
      // No history found
      res.status(200).json({
        success: true,
        messages: [],
        userId,
      });
    }
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
