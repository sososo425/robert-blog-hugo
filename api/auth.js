// Vercel Edge Function for Admin Authentication
// This function handles user login, session validation, and token refresh

export const config = {
  runtime: 'edge',
};

// Simple in-memory store for demo (in production, use a database)
// For now, we'll use environment variables for admin credentials
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH; // SHA-256 hash of password

// JWT-like simple token generation (for demo purposes)
// In production, use a proper JWT library
async function generateToken(username) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${username}-${Date.now()}-${process.env.JWT_SECRET || 'default-secret'}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const token = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return {
    token,
    expires: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    username
  };
}

async function verifyPassword(password, hash) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const computedHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return computedHash === hash;
}

export default async function handler(request) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // GET - Validate token
  if (request.method === 'GET') {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ valid: false, error: 'No token provided' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.substring(7);
    
    // In a real implementation, you would validate the token structure and expiration
    // For this demo, we just check if it looks like a valid hash
    if (token.length !== 64) {
      return new Response(JSON.stringify({ valid: false, error: 'Invalid token format' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ valid: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // POST - Login
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const { username, password } = body;

      if (!username || !password) {
        return new Response(JSON.stringify({ error: 'Username and password are required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Check if admin password hash is configured
      if (!ADMIN_PASSWORD_HASH) {
        console.warn('ADMIN_PASSWORD_HASH not configured, using default credentials');
        // Default fallback (only for development!)
        if (username === ADMIN_USERNAME && password === 'admin123') {
          const tokenData = await generateToken(username);
          return new Response(JSON.stringify({ 
            success: true, 
            token: tokenData.token,
            expires: tokenData.expires,
            username: tokenData.username
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      } else {
        // Verify password against hash
        const isValid = await verifyPassword(password, ADMIN_PASSWORD_HASH);
        if (username === ADMIN_USERNAME && isValid) {
          const tokenData = await generateToken(username);
          return new Response(JSON.stringify({ 
            success: true, 
            token: tokenData.token,
            expires: tokenData.expires,
            username: tokenData.username
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Auth API error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
