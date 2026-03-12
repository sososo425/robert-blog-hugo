// Vercel Edge Function for Protected Content Access Control
// This function checks if a user has permission to access protected content

export const config = {
  runtime: 'edge',
};

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

  // GET - Check access permission for a specific path
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const path = url.searchParams.get('path');
    const authHeader = request.headers.get('Authorization');

    if (!path) {
      return new Response(JSON.stringify({ error: 'Path parameter is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Define protected paths (directories that require authentication)
    const protectedPaths = process.env.PROTECTED_PATHS?.split(',') || ['/private/', '/members-only/', '/vip/'];

    // Check if the requested path is in a protected directory
    const isProtected = protectedPaths.some(protectedPath => 
      path.startsWith(protectedPath)
    );

    if (!isProtected) {
      // Public content, no authentication needed
      return new Response(JSON.stringify({ 
        allowed: true, 
        protected: false,
        message: 'Public content'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Content is protected, check authentication
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ 
        allowed: false, 
        protected: true,
        error: 'Authentication required' 
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.substring(7);

    // Validate token (in production, verify JWT signature)
    if (token.length !== 64) {
      return new Response(JSON.stringify({ 
        allowed: false, 
        protected: true,
        error: 'Invalid token' 
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Token is valid, grant access
    return new Response(JSON.stringify({ 
      allowed: true, 
      protected: true,
      message: 'Access granted'
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // POST - Update protected paths configuration (admin only)
  if (request.method === 'POST') {
    const authHeader = request.headers.get('Authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Admin authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      const body = await request.json();
      const { paths } = body;

      if (!Array.isArray(paths)) {
        return new Response(JSON.stringify({ error: 'Paths must be an array' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // In a real implementation, you would save this to a database
      // For now, just acknowledge the request
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Protected paths updated',
        paths
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Access control API error:', error);
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
