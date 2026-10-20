export type RequestContext = {
  req: Request;
  apiKeyId: string;
};

export type CopilotTokenResponse = {
  token: string;
  expires_at: number;
  endpoints?: { api?: string };
};

export type ProxyContext = {
  apiBase: string;
  headers: Record<string, string>;
};
