# Monday-Zira-Sync

Monday board view app to choose a Jira account and project (space) per board, then use that mapping for sync operations.

## What this project does

- Adds a Monday board view tab UI called **Monday-Zira-Sync**.
- Lets you choose:
  - Jira account
  - Jira project/space
- Lets you configure sync rules per board:
   - Manual mode
   - Status-change trigger mode
   - Optional trigger status label (e.g. Done)
   - Keep synced mode for updates after first issue creation
- Saves the mapping for each Monday board.
- Syncs Monday item name to Jira issue summary.
- Syncs Monday item images/files to Jira issue attachments.
- Exposes webhook and API routes for future item-to-issue sync logic.

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Copy env template:

```bash
copy .env.example .env
```

3. Edit `.env` and configure Jira accounts:

```env
MONDAY_API_TOKEN=your-monday-token
MONDAY_API_VERSION=2025-04
JIRA_ACCOUNTS_JSON=[{"id":"main","name":"Rodney Jira","baseUrl":"https://your-domain.atlassian.net","email":"jira-user@company.com","apiToken":"your-jira-api-token"}]
```

4. Run in dev mode:

```bash
npm run dev
```

5. Open `http://localhost:3000`.

## Monday app setup

1. In Monday Developers, create/open your app.
2. Add feature: **Board View**.
3. Set Board View URL to your deployed URL, for example:

```text
https://monday-zira-sync.onrender.com/
```

4. Install the app to your account/workspace.
5. Open a board, add/select the view named **Monday-Zira-Sync**.
6. In the view UI:
   - Choose Jira account
   - Choose Jira project (space)
   - Click **Save board mapping**

7. Add board automation webhook in Monday:
   - Recipe: **When Issues AXO changes to anything, send a webhook**
   - URL: `https://monday-zira-sync.onrender.com/api/monday/webhook`
   - First create uses status label `Sync Jira`; once synced, later status changes continue updates.

## Render deployment

This repo includes `render.yaml` for a web service.

1. Push code to GitHub.
2. In Render, create a **Blueprint** or **Web Service** from this repo.
3. Add env var:
   - `MONDAY_API_TOKEN` (required for backend Monday API calls)
   - `MONDAY_API_VERSION` (optional, default is `2025-04`)
   - `MONDAY_ACCOUNT_BASE_URL` (optional, set to your account URL for Jira backlinks, e.g. `https://bootepolch.monday.com`)
   - `JIRA_ACCOUNTS_JSON` (required)
   - `MONDAY_SIGNING_SECRET` (optional now, useful for webhook hardening)
4. Deploy.

Health endpoint:

- `GET /health`

## API routes

- `GET /api/monday/me`
- `GET /api/monday/board?boardId=<boardId>`
- `GET /api/monday/status-columns?boardId=<boardId>`
- `GET /api/monday/sync-columns?boardId=<boardId>`
- `GET /api/monday/webhook-events?limit=20`
- `GET /api/jira/accounts`
- `GET /api/jira/projects?accountId=main`
- `GET /api/mapping?boardId=<boardId>`
- `POST /api/mapping`
- `POST /api/sync/item`
- `POST /api/monday/webhook`

Mapping payload rule fields:

- `syncTrigger`: `manual` or `status_change`
- `statusColumnId`: Monday status column ID (for status_change mode)
- `triggerStatusLabel`: Optional status value filter (for example `Done`)
- `keepSynced`: if true, existing Jira issue keeps updating when the rule matches

Mapping payload field-mapping options:

- `targetLanguage`: language code for Jira title translation (`none`, `en`, `de`, `fr`, ...)
- `nameSource`: `item_name` or `text_column`
- `nameColumnId`: Monday text/name column id (used when `nameSource=text_column`)
- `attachmentSource`: `item_assets` or `file_column`
- `attachmentColumnId`: Monday file column id (used when `attachmentSource=file_column`)
- `nameTranslations`: optional JSON object for replacements, example: `{"AX":"Axopar","NB":"Neuboot"}`

Manual sync payload example:

```json
{
   "boardId": "509766020",
   "itemId": "123456789"
}
```

## Monday API hookup in developer center

1. In Monday Developers, open your app.
2. Enable the Board View feature and point the URL to your Render app URL.
3. Create a Monday API token with access to the boards you want to sync.
4. Set that token as `MONDAY_API_TOKEN` in Render environment variables.
5. Redeploy.
6. Verify connection:
   - `GET /api/monday/me`
   - `GET /api/monday/board?boardId=<your_board_id>`

## Important note

Current mapping persistence uses a local JSON file (`data/mappings.json`). On Render this is ephemeral across restarts/deployments. For production persistence, next step is to move mappings to a database (Render Postgres is a good fit).
