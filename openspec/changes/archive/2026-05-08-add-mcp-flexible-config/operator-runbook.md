# MCP Flexible Config — Operator Runbook

## 1. OAuth Credentials Naming Convention

### Rule

Platform-level OAuth app credentials are stored in **Cloudflare Workers Secrets**. The secret name is derived from the `providerType` field in `server_config_json` using this rule:

1. Convert `providerType` to **SCREAMING_SNAKE_CASE**.
2. Append the credential suffix:
   - `_CLIENT_ID`
   - `_CLIENT_SECRET`
   - `_TENANT_ID` (Microsoft Graph only, optional but recommended)

### Examples

| `providerType` | Secret Names |
|----------------|--------------|
| `google-contacts` | `GOOGLE_CONTACTS_CLIENT_ID`<br>`GOOGLE_CONTACTS_CLIENT_SECRET` |
| `microsoft-graph` | `MICROSOFT_GRAPH_CLIENT_ID`<br>`MICROSOFT_GRAPH_CLIENT_SECRET`<br>`MICROSOFT_GRAPH_TENANT_ID` |

### How to Register

Use `wrangler secret put` to add each secret to the Workers environment:

```bash
# Google Contacts example
wrangler secret put GOOGLE_CONTACTS_CLIENT_ID
# (paste the Client ID when prompted)

wrangler secret put GOOGLE_CONTACTS_CLIENT_SECRET
# (paste the Client Secret when prompted)
```

For Microsoft Graph:

```bash
wrangler secret put MICROSOFT_GRAPH_CLIENT_ID
wrangler secret put MICROSOFT_GRAPH_CLIENT_SECRET
wrangler secret put MICROSOFT_GRAPH_TENANT_ID
```

> **Note**: These secrets are platform-level — every mailbox connection of the same `providerType` shares them unless the connection overrides with BYOC (`enterprise_credentials_encrypted_json`).

---

## 2. Google People API MCP Server Setup

This section walks through connecting the Google People API MCP server (`https://people.googleapis.com/mcp/v1`) to the agentic-inbox platform.

### Step 1: Enable the People API in Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Select the project you want to use (or create a new one).
3. Navigate to **APIs & Services > Library**.
4. Search for **People API** and click **Enable**.

### Step 2: Configure the OAuth Consent Screen

1. Go to **APIs & Services > OAuth consent screen**.
2. Select the **User Type** (usually **External** for public apps).
3. Fill in the required app information:
   - **App name**
   - **User support email**
   - **Developer contact information**
4. Under **Scopes**, add:
   - `https://www.googleapis.com/auth/contacts.readonly`
5. Add the authorized domain(s) where the app is hosted.
6. Save and continue.

> **Important**: If you change scopes later, you must re-publish the app to production.

### Step 3: Create Web Application OAuth Credentials

1. Go to **APIs & Services > Credentials**.
2. Click **+ Create Credentials > OAuth client ID**.
3. Select **Application type: Web application**.
4. Fill in the name (e.g., `agentic-inbox-google-contacts`).
5. Under **Authorized redirect URIs**, add the OAuth callback URL used by the Cloudflare Agents SDK MCP flow:
   - Format: `https://<your-worker-domain>/mcp/oauth/callback`
   - (The exact path may vary based on your deployment; check `workers/lib/mcp-oauth-provider.ts` or the Agents SDK docs for the configured callback route.)
6. Click **Create**.
7. Copy the **Client ID** and **Client Secret**.

### Step 4: Store Credentials in Cloudflare Workers Secrets

Run the following commands in your terminal (from the project root):

```bash
wrangler secret put GOOGLE_CONTACTS_CLIENT_ID
# Paste the Client ID from Step 3

wrangler secret put GOOGLE_CONTACTS_CLIENT_SECRET
# Paste the Client Secret from Step 3
```

Verify the secrets are set:

```bash
wrangler secret list
```

You should see `GOOGLE_CONTACTS_CLIENT_ID` and `GOOGLE_CONTACTS_CLIENT_SECRET` in the output.

### Step 5: Create the MCP Connection

Use the API or UI to create a connection with the following `serverConfig`:

```json
{
  "providerType": "google-contacts",
  "scopes": ["https://www.googleapis.com/auth/contacts.readonly"]
}
```

The OAuth flow will automatically resolve platform credentials from Workers Secrets (`GOOGLE_CONTACTS_CLIENT_ID` / `GOOGLE_CONTACTS_CLIENT_SECRET`) and initiate MCP Authorization via the Cloudflare Agents SDK.

### Verification

1. Open the agentic-inbox UI.
2. Navigate to the MCP connections / Connected Apps section.
3. Start the OAuth flow for the Google Contacts provider.
4. You should be redirected to Google for consent.
5. After consent, the connection status should show as **connected**.
6. Test a tool call (e.g., `searchContacts`) to confirm the integration works.

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `ProviderCredentialsNotConfiguredError` | Secrets missing or misnamed | Verify `GOOGLE_CONTACTS_CLIENT_ID` and `GOOGLE_CONTACTS_CLIENT_SECRET` via `wrangler secret list` |
| OAuth consent screen shows "unverified app" | App not published | Publish the OAuth consent screen in Google Cloud Console |
| Redirect URI mismatch | Callback URL not in credentials | Add the exact redirect URI to the Web app credentials in Google Cloud Console |
| Scope errors | Scope not enabled in consent screen | Add `contacts.readonly` to the OAuth consent screen scopes and re-publish |
