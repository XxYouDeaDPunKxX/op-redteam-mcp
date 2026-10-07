export interface RuntimeOrigin {
  publicOrigin: string;
  mcpResource: string;
  mcpEndpoint: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  registerEndpoint: string;
  callbackEndpoint: string;
}

export function resolveRuntimeOrigin(publicOrigin: string, allowLocalHttp = false, mcpResource = publicOrigin): RuntimeOrigin {
  const parsed = new URL(publicOrigin);
  if (parsed.origin !== publicOrigin || parsed.pathname !== "/" || parsed.search || parsed.hash || publicOrigin.endsWith("/")) {
    throw new TypeError("invalid_public_origin");
  }
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(allowLocalHttp && isLocal && parsed.protocol === "http:")) {
    throw new TypeError("invalid_public_origin");
  }
  const resource = new URL(mcpResource);
  if (resource.origin !== mcpResource || resource.pathname !== "/" || resource.search || resource.hash || mcpResource.endsWith("/")) {
    throw new TypeError("invalid_mcp_resource");
  }
  if (mcpResource !== publicOrigin) throw new TypeError("resource_origin_mismatch");
  return {
    publicOrigin,
    mcpResource,
    mcpEndpoint: `${publicOrigin}/mcp`,
    authorizeEndpoint: `${publicOrigin}/authorize`,
    tokenEndpoint: `${publicOrigin}/token`,
    registerEndpoint: `${publicOrigin}/register`,
    callbackEndpoint: `${publicOrigin}/callback`,
  };
}

export function isLocalRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
