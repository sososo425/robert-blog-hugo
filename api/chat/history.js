// Get chat history for a specific article
import { list } from '@vercel/blob';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'your-secret-key-change-in-production');

async function getBlobJson(pathname) {
  const { blobs } = await list({ prefix: pathname });
  const blob = blobs.find(b => b.pathname === pathname);
  if (!blob) return null;
  const res = await fetch(blob.url);
  if (!res.ok) return null;
  return res.json();
}

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
    const conversation = await getBlobJson(conversationPath);

    res.status(200).json({
      success: true,
      messages: conversation?.messages || [],
      userId,
    });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
