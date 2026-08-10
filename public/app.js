const accountSelect = document.getElementById("accountSelect");
const projectSelect = document.getElementById("projectSelect");
const saveButton = document.getElementById("saveButton");
const boardIdLabel = document.getElementById("boardIdLabel");
const statusEl = document.getElementById("status");

let boardId = "";
let accounts = [];

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function setSaveEnabled() {
  saveButton.disabled = !(boardId && accountSelect.value && projectSelect.value);
}

function extractBoardId(context) {
  if (!context) {
    return "";
  }

  if (context.boardId) {
    return String(context.boardId);
  }

  if (Array.isArray(context.boardIds) && context.boardIds.length > 0) {
    return String(context.boardIds[0]);
  }

  if (context.boardViewId) {
    return String(context.boardViewId);
  }

  return "";
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error || `Request failed (${response.status})`;
    throw new Error(message);
  }

  return data;
}

async function loadAccounts() {
  const data = await fetchJson("/api/jira/accounts");
  accounts = data.accounts || [];

  accountSelect.innerHTML = "";
  if (accounts.length === 0) {
    accountSelect.innerHTML = '<option value="">No Jira accounts configured</option>';
    accountSelect.disabled = true;
    return;
  }

  accountSelect.append(new Option("Select a Jira account", ""));
  for (const account of accounts) {
    accountSelect.append(new Option(`${account.name} (${account.baseUrl})`, account.id));
  }

  accountSelect.disabled = false;
}

async function loadProjects(accountId) {
  projectSelect.disabled = true;
  projectSelect.innerHTML = '<option value="">Loading projects...</option>';

  const data = await fetchJson(`/api/jira/projects?accountId=${encodeURIComponent(accountId)}`);
  const projects = data.projects || [];

  projectSelect.innerHTML = "";
  if (projects.length === 0) {
    projectSelect.innerHTML = '<option value="">No projects found</option>';
    return;
  }

  projectSelect.append(new Option("Select a Jira project", ""));
  for (const project of projects) {
    projectSelect.append(new Option(`${project.name} (${project.key})`, project.key));
  }

  projectSelect.disabled = false;
}

async function loadExistingMapping() {
  if (!boardId) {
    return;
  }

  const data = await fetchJson(`/api/mapping?boardId=${encodeURIComponent(boardId)}`);
  const mapping = data.mapping;
  if (!mapping) {
    return;
  }

  accountSelect.value = mapping.accountId;
  await loadProjects(mapping.accountId);
  projectSelect.value = mapping.projectKey;
  setStatus(`Current mapping: ${mapping.projectName} (${mapping.projectKey})`, "ok");
  setSaveEnabled();
}

accountSelect.addEventListener("change", async () => {
  const accountId = accountSelect.value;
  projectSelect.innerHTML = '<option value="">Select an account first</option>';

  if (!accountId) {
    setSaveEnabled();
    return;
  }

  try {
    setStatus("Loading Jira projects...");
    await loadProjects(accountId);
    setStatus("Projects loaded.", "ok");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not load projects", "error");
  }

  setSaveEnabled();
});

projectSelect.addEventListener("change", setSaveEnabled);

saveButton.addEventListener("click", async () => {
  const accountId = accountSelect.value;
  const projectKey = projectSelect.value;
  const projectName = projectSelect.options[projectSelect.selectedIndex]?.text || "";

  if (!(boardId && accountId && projectKey)) {
    setStatus("Please select account and project.", "error");
    return;
  }

  saveButton.disabled = true;

  try {
    await fetchJson("/api/mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId, accountId, projectKey, projectName })
    });

    setStatus("Saved. This board now syncs to the selected Jira project.", "ok");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not save mapping", "error");
  } finally {
    setSaveEnabled();
  }
});

(async function init() {
  try {
    await loadAccounts();

    const monday = window.mondaySdk ? window.mondaySdk() : null;
    if (monday) {
      monday.listen("context", async (res) => {
        const nextBoardId = extractBoardId(res?.data);
        if (!nextBoardId) {
          boardIdLabel.textContent = "Not found";
          setStatus("Open this inside a Monday board view to bind mapping.", "error");
          return;
        }

        boardId = nextBoardId;
        boardIdLabel.textContent = boardId;
        setSaveEnabled();

        try {
          await loadExistingMapping();
        } catch {
          setStatus("No existing board mapping found yet.");
        }
      });

      monday.get("context").then(async (res) => {
        const nextBoardId = extractBoardId(res?.data);
        if (!nextBoardId) {
          return;
        }

        boardId = nextBoardId;
        boardIdLabel.textContent = boardId;
        setSaveEnabled();

        try {
          await loadExistingMapping();
        } catch {
          setStatus("No existing board mapping found yet.");
        }
      });
    } else {
      boardIdLabel.textContent = "Outside Monday";
      setStatus("Monday SDK not detected. Open this app from a Monday board.", "error");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "App initialization failed", "error");
  }
})();
