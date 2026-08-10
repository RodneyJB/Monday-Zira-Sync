# Monday-Zira-Sync

Monday board view app to choose a Jira account and project (space) per board, then use that mapping for sync operations.

## What this project does

- Adds a Monday board view tab UI called **Monday-Zira-Sync**.
- Lets you choose:
  - Jira account
  - Jira project/space
- Saves the mapping for each Monday board.
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

## Render deployment

This repo includes `render.yaml` for a web service.

1. Push code to GitHub.
2. In Render, create a **Blueprint** or **Web Service** from this repo.
3. Add env var:
   - `JIRA_ACCOUNTS_JSON` (required)
   - `MONDAY_SIGNING_SECRET` (optional now, useful for webhook hardening)
4. Deploy.

Health endpoint:

- `GET /health`

## API routes

- `GET /api/jira/accounts`
- `GET /api/jira/projects?accountId=main`
- `GET /api/mapping?boardId=<boardId>`
- `POST /api/mapping`
- `POST /api/monday/webhook`

## Important note

Current mapping persistence uses a local JSON file (`data/mappings.json`). On Render this is ephemeral across restarts/deployments. For production persistence, next step is to move mappings to a database (Render Postgres is a good fit).
