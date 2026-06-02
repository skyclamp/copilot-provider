export type RequestContext = {
  req: Request;
  body: unknown;
  apiKeyId: string;
};

export type EndpointHandler = (ctx: RequestContext) => Promise<Response>;

export type CopilotTokenResponse = {
  token: string;
  expires_at: number;
  endpoints?: { api?: string };
};

export type ProxyContext = {
  apiBase: string;
  headers: Record<string, string>;
};
