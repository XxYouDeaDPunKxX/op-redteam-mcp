function hasTemplateMarker(value) {
  return typeof value !== "string" || value.includes("YOUR-") || value.includes(".invalid");
}

export function validateStagingTemplateValues(config) {
  const failures = [];
  const vars = config?.vars ?? {};
  const kvNamespaces = config?.kv_namespaces;

  if (!(typeof vars.PUBLIC_ORIGIN === "string" && vars.PUBLIC_ORIGIN.startsWith("https://") && !hasTemplateMarker(vars.PUBLIC_ORIGIN))) {
    failures.push("PUBLIC_ORIGIN must be replaced with the operator's HTTPS origin");
  }
  if (!(typeof vars.MCP_RESOURCE === "string" && vars.MCP_RESOURCE.startsWith("https://") && !hasTemplateMarker(vars.MCP_RESOURCE))) {
    failures.push("MCP_RESOURCE must be replaced with the operator's HTTPS resource URL");
  }
  if (vars.MCP_RESOURCE !== vars.PUBLIC_ORIGIN) {
    failures.push("MCP_RESOURCE must equal PUBLIC_ORIGIN");
  }
  if (!(typeof vars.ALLOWED_GITHUB_USER_IDS === "string" && vars.ALLOWED_GITHUB_USER_IDS.trim().length > 0)) {
    failures.push("ALLOWED_GITHUB_USER_IDS must contain at least one GitHub user ID");
  }
  if (!(typeof vars.ALLOWED_DCR_REDIRECT_URIS === "string" && vars.ALLOWED_DCR_REDIRECT_URIS.trim().length > 0)) {
    failures.push("ALLOWED_DCR_REDIRECT_URIS must contain at least one redirect URI");
  }
  if (!(
    Array.isArray(kvNamespaces) &&
    kvNamespaces.length === 1 &&
    kvNamespaces[0]?.binding === "OAUTH_KV" &&
    typeof kvNamespaces[0]?.id === "string" &&
    /^[0-9a-f]{32}$/i.test(kvNamespaces[0].id) &&
    !/^0{32}$/i.test(kvNamespaces[0].id)
  )) {
    failures.push("OAUTH_KV must use a provisioned non-zero Cloudflare namespace id");
  }

  return failures;
}
