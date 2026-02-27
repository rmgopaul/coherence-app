export interface OneNoteNotebook {
  id: string;
  displayName: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  links: {
    oneNoteWebUrl: {
      href: string;
    };
  };
}

export interface OneNotePage {
  id: string;
  title: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  contentUrl: string;
  links: {
    oneNoteWebUrl: {
      href: string;
    };
  };
}

export async function getOneNoteNotebooks(accessToken: string): Promise<OneNoteNotebook[]> {
  const response = await fetch("https://graph.microsoft.com/v1.0/me/onenote/notebooks", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`OneNote API error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.value || [];
}

export async function getOneNotePages(accessToken: string, top = 20): Promise<OneNotePage[]> {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/onenote/pages?$top=${top}&$orderby=lastModifiedDateTime desc`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`OneNote API error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.value || [];
}

export async function exchangeMicrosoftCode(
  code: string,
  redirectUri: string,
  clientId?: string,
  clientSecret?: string
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}> {
  const finalClientId = clientId || process.env.MICROSOFT_CLIENT_ID;
  const finalClientSecret = clientSecret || process.env.MICROSOFT_CLIENT_SECRET;

  if (!finalClientId || !finalClientSecret) {
    throw new Error("Microsoft OAuth credentials not configured");
  }

  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: finalClientId,
      client_secret: finalClientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to exchange Microsoft code: ${error}`);
  }

  return response.json();
}

export async function refreshMicrosoftToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Microsoft OAuth credentials not configured");
  }

  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to refresh Microsoft token");
  }

  return response.json();
}

