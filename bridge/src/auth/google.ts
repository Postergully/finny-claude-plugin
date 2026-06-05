/**
 * Google OAuth helper — exchanges an authorization code for user profile info.
 */

export interface GoogleUserInfo {
  email: string;
  name?: string;
  picture?: string;
}

/**
 * Exchange Google OAuth authorization code for tokens, then extract user email.
 */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string
): Promise<GoogleUserInfo> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text();
    throw new Error(`Google token exchange failed (${tokenResponse.status}): ${errBody}`);
  }

  const tokenData = (await tokenResponse.json()) as { access_token: string; id_token?: string };

  const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userInfoResponse.ok) {
    throw new Error(`Google userinfo failed (${userInfoResponse.status})`);
  }

  const userInfo = (await userInfoResponse.json()) as {
    email: string;
    name?: string;
    picture?: string;
    verified_email?: boolean;
  };

  if (!userInfo.email) {
    throw new Error('Google did not return an email address');
  }

  return {
    email: userInfo.email,
    name: userInfo.name,
    picture: userInfo.picture,
  };
}
