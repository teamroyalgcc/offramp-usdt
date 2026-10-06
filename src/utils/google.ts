import { OAuth2Client, TokenPayload } from 'google-auth-library';

const googleClient = new OAuth2Client();

// GOOGLE_CLIENT_ID: comma-separated OAuth client IDs (web, android). Unset = Google sign-in off.
// Fail closed: google-auth-library skips the audience check when audience is undefined.
export function googleAudiences(env = process.env.GOOGLE_CLIENT_ID): string[] {
  return (env || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Only verified emails may sign in or link to an existing account.
export function acceptGooglePayload(p: TokenPayload | undefined): TokenPayload | null {
  return p && p.sub && p.email && p.email_verified === true ? p : null;
}

export async function verifyGoogleToken(idToken: string): Promise<TokenPayload | null> {
  const audience = googleAudiences();
  if (!audience.length) throw new Error('Google sign-in is not configured');
  const ticket = await googleClient.verifyIdToken({ idToken, audience });
  return acceptGooglePayload(ticket.getPayload());
}
