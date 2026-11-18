# SprintPilot

SprintPilot is a fast planning layer that runs on top of your Jira board. Jira stays the source of truth: every change you make here is written straight to Jira.

| View | What it does |
|---|---|
| **Epic planner** (`1`) | You drag stories onto epics to link them. Typing a one-liner at the bottom of an epic creates a story there, with its description and acceptance criteria already drafted. You can also create new epics here. |
| **Sprint planner** (`2`) | You drag stories between the backlog and sprints. It shows a capacity bar for each sprint (red when over capacity). One click spills unfinished work over to the next sprint, adding a label and a comment. |
| **Quick create** (`3`) | You describe the work in plain English, or paste rows from Excel. It drafts the stories with title, user-story description, Given/When/Then acceptance criteria, points, testable flag and suggested epic. You review them and create all of them at once. |
| **Story sizing** (`4`) | Shows one story at a time with big buttons for 1, 2, 3, 5, 8, 13 and 21. Keys `1`–`7` size the story and move on automatically, so a backlog can be sized in minutes. |
| **Who's on what** (`5`) | Shows people × To do / In progress / Done for the sprint. Dragging a card reassigns it or moves its status. One button copies a stand-up summary you can paste into Teams or email. |
| **Story drawer** | Click any card to edit everything inline. **Clone & rewrite** creates a copy with a fresh description (for example "for the Android app") and links it back to the original. |

Other shortcuts: `/` search, `N` new stories, `R` refresh, `Esc` close, and Ctrl-click to select several cards and drag them together.

---

## 1. Requirements

- **Node.js 18 or newer** (`node --version`). There is no `npm install` and there are no dependencies.
  - If you can't install software, download the Windows **.zip** build from nodejs.org, unzip it, and run `path\to\node.exe server.js`.
- Network access from the laptop to your Jira (the same access your browser has).

## 2. Try it first, without Jira

Run `start.bat` (or `node server.js --demo`) and open <http://localhost:4300>.
Demo mode uses sample data stored in `data/demo-db.json`. Delete that file to reset it.

## 3. Connect to your Jira

1. Copy `config.example.json` to `config.json`.
2. Fill in the `<PLACEHOLDERS>`:

| Setting | Jira Cloud (`*.atlassian.net`) | Jira Server / Data Center (self-hosted) |
|---|---|---|
| `deployment` | `"cloud"` | `"server"` |
| `baseUrl` | `https://yourcompany.atlassian.net` | e.g. `https://jira.yourcompany.com` (include any context path, such as `/jira`) |
| `email` | Your Atlassian login email | Leave empty |
| `apiToken` | API token, created at <https://id.atlassian.com/manage-profile/security/api-tokens> | Personal Access Token: Jira → your avatar → **Profile → Personal Access Tokens** (Jira 8.14+) |
| `projectKey` | e.g. `ABC` (the prefix of issue keys like ABC-123) | same |
| `boardId` | The number in the board URL: `.../boards/42` | The number in `...RapidBoard.jspa?rapidView=42` |

   > Older Server versions without PATs: set `"authType": "basic"`, `"email": "<your username>"` and `"apiToken": "<your password>"`.

   If you'd rather keep the token out of the file, set it as an environment variable instead: `set JIRA_API_TOKEN=...` (others: `JIRA_EMAIL`, `JIRA_BASE_URL`).

3. **Check the connection** before you start:

   ```
   node server.js --check
   ```

   This prints the fields it discovered (story points, sprint, epic link, acceptance criteria, testable) and a sample story. Check that the sample's points, epic and sprint match what you see in Jira.

4. Start it with `start.bat` or `node server.js`, then open <http://localhost:4300>.

## 4. How fields are mapped (and how to override)

On startup, SprintPilot looks up your Jira's custom fields automatically:

| Concept | Auto-detection | Override in `config.json` |
|---|---|---|
| Story points | Your board's estimation field, then fields named "Story Points" / "Story point estimate" | `jira.fields.storyPoints: "customfield_10016"` |
| Sprint | The Jira Software sprint field | `jira.fields.sprint` |
| Epic link | Cloud: the `parent` field. Server/DC: the "Epic Link" field | `jira.epicLinkStyle: "parent"` or `"epicLink"` |
| Acceptance criteria | A field whose name contains "Acceptance Criteria"; **otherwise** a `h3. Acceptance Criteria` section inside the Description | `jira.fields.acceptanceCriteria`, `jira.acceptanceCriteriaMode: "field"` or `"description"` |
| Testable yes/no | A field whose name contains "Testable" (select, checkbox or text); **otherwise** the labels `testable` / `not-testable` | `jira.fields.testable`, `jira.testable.yesValue`/`noValue` (the option text in your field) |

To find a field ID, open `https://<your-jira>/rest/api/2/field` in your browser while logged in and search the page for the field's name.

Other settings:
- `pointScale`: the sizing buttons (default `[1,2,3,5,8,13,21]`).
- `jira.spilloverLabel`: the label added on spill-over (default `spillover`).
- `jira.storyJql`: replaces which issues are loaded. `{project}` is replaced with your project key. By default it loads all non-epic, non-subtask issues that aren't Done, plus anything updated in the last 21 days.
- `jira.storyIssueType` / `epicIssueType`: change these if your issue types have different names (e.g. "User Story").

**"Field cannot be set / not on the appropriate screen"**: SprintPilot does not fail when this happens. It saves everything else, retries the field on the Edit screen, and shows a yellow note if Jira still refuses. To fix it permanently, ask your Jira admin to add the field to the Create/Edit screens of your project.

## 5. Story drafting: offline by default, AI optional

The built-in drafter works completely offline and sends no data anywhere. It:
- splits notes into stories
- writes "As a … I want … so that …" descriptions
- generates Given/When/Then acceptance criteria
- marks spikes and research as not testable
- suggests an epic by matching words in the epic names
- guesses points as a starting point

For much better drafts and rewrites you can turn on Claude (Anthropic's AI). **Check your company's policy first:** this sends the story text you type to Anthropic's API.

```
npm install @anthropic-ai/sdk
```

Then set this in `config.json`:

```json
"ai": { "enabled": true, "apiKey": "<ANTHROPIC API KEY>", "model": "claude-opus-5-5" }
```

You can use the `ANTHROPIC_API_KEY` env var instead of `apiKey`. If the AI call fails for any reason, the app falls back to the offline drafter automatically.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `401` on start | Wrong email/token. Cloud needs **email + API token** (not your password). Server/DC needs a **PAT**. |
| `403` on start | Your account lacks permission, or Jira's CAPTCHA was triggered by failed logins. Log in once in the browser, then retry. |
| `fetch failed`, `ENOTFOUND`, `ECONNREFUSED` | Not on VPN, or Jira is only reachable through a proxy. |
| `self-signed certificate` / `unable to verify` | Your company uses its own certificate authority. Export the root certificate (ask IT, or export it from the browser's padlock) as a `.pem`, then run `set NODE_EXTRA_CA_CERTS=C:\path\corp-root.pem` before starting. |
| Corporate HTTP proxy | Recent Node (24+): `set NODE_USE_ENV_PROXY=1` and `set HTTPS_PROXY=http://proxy:8080`. Older Node can't use a proxy for these calls, so upgrade Node or ask IT for a direct route to Jira. Usually Jira is internal and needs no proxy. |
| Story points show "–" everywhere | Wrong points field. Run `--check` and set `jira.fields.storyPoints`. |
| Epics not showing / linking fails on Server | Set `"epicLinkStyle": "epicLink"`. |
| Status drag in "Who's on what" says no transition | Your workflow doesn't allow that move directly. Open the story and pick the transition from the Status dropdown. |
| Port 4300 in use | Set `"port": 4400` in config, or `set PORT=4400`. |

## Security notes

- The server listens on **127.0.0.1 only**, so other machines on the network can't reach it.
- Your token stays on your laptop and is only sent to your Jira (and to Anthropic if you turn AI on).
- `config.json` is in `.gitignore`. Don't commit it or share it.

## Project layout

```
server.js            local web server + API routes
lib/jira.js          Jira Cloud + Server/DC adapter (field discovery, tolerant writes)
lib/mock.js          demo-mode adapter
lib/storyText.js     offline story drafter, acceptance-criteria helpers, Excel paste parser
lib/ai.js            optional Claude drafting/rewriting
lib/config.js        config loading + env overrides
public/              the UI (plain HTML/CSS/JS, no build step)
```
