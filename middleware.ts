import { NextRequest, NextResponse } from 'next/server';

/**
 * Checks HTTP Basic Auth header against ADMIN_USER (default: "admin") and ADMIN_PASSWORD.
 */
function verifyBasicAuth(req: NextRequest, expectedPassword: string): boolean {
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }

  try {
    const base64Credentials = authHeader.slice(6).trim();
    const decoded = atob(base64Credentials);
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return false;

    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);
    const expectedUser = process.env.ADMIN_USER || 'admin';

    return user === expectedUser && pass === expectedPassword;
  } catch {
    return false;
  }
}

/**
 * Checks Bearer token or Basic Auth for `/api/cron/predict` so:
 * 1. GitHub Actions / Vercel Cron can trigger it via `Authorization: Bearer <CRON_SECRET>`
 * 2. Logged-in Admin can also trigger it from `/admin`
 * 3. Same-origin public UI button can trigger it only if rate-limited or if CRON_SECRET is not enforced for same-origin
 */
function verifyCronAccess(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;

  // If neither secret is configured (e.g., local development), allow freely
  if (!cronSecret && !adminPassword) {
    return true;
  }

  const authHeader = req.headers.get('authorization') || '';

  // 1. Check Bearer CRON_SECRET (used by Vercel Cron & GitHub Actions)
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return true;
  }

  // 2. Check Admin Basic Auth (used when Admin clicks manual trigger on /admin)
  if (adminPassword && verifyBasicAuth(req, adminPassword)) {
    return true;
  }

  // 3. Allow same-origin UI requests from the app itself if CRON_ALLOW_PUBLIC_TRIGGER !== 'false'
  const secFetchSite = req.headers.get('sec-fetch-site');
  if (
    secFetchSite === 'same-origin' &&
    process.env.CRON_ALLOW_PUBLIC_TRIGGER !== 'false'
  ) {
    return true;
  }

  return false;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. Protect `/admin` and `/api/admin/*` with HTTP Basic Auth when ADMIN_PASSWORD is set
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (adminPassword) {
      const isValid = verifyBasicAuth(req, adminPassword);
      if (!isValid) {
        return new NextResponse('Hitelesítés szükséges az Admin Portál eléréséhez.', {
          status: 401,
          headers: {
            'WWW-Authenticate': 'Basic realm="Budapest H3 Risk Admin Portal", charset="UTF-8"',
          },
        });
      }
    }
  }

  // 2. Protect `/api/cron/*` against unauthorized external triggers
  if (pathname.startsWith('/api/cron')) {
    if (!verifyCronAccess(req)) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Jogosulatlan Cron hívás. Érvényes CRON_SECRET vagy Admin hitelesítés szükséges.',
        },
        { status: 401 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*', '/api/cron/:path*'],
};

