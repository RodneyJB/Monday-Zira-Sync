const accountSelect = document.getElementById("accountSelect");
const projectSelect = document.getElementById("projectSelect");
const targetLanguageSelect = document.getElementById("targetLanguageSelect");
const syncTriggerSelect = document.getElementById("syncTriggerSelect");
const statusColumnIdInput = document.getElementById("statusColumnIdInput");
const triggerStatusLabelInput = document.getElementById("triggerStatusLabelInput");
const keepSyncedCheckbox = document.getElementById("keepSyncedCheckbox");
const nameSourceSelect = document.getElementById("nameSourceSelect");
const nameColumnIdSelect = document.getElementById("nameColumnIdSelect");
const nameTranslationsInput = document.getElementById("nameTranslationsInput");
const attachmentSourceSelect = document.getElementById("attachmentSourceSelect");
const attachmentColumnIdSelect = document.getElementById("attachmentColumnIdSelect");
const saveButton = document.getElementById("saveButton");
const boardIdLabel = document.getElementById("boardIdLabel");
const statusEl = document.getElementById("status");

let boardId = "";
let boardViewId = "";
let accounts = [];
let statusColumns = [];
let syncColumns = { nameColumns: [], fileColumns: [] };

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function setSaveEnabled() {
  saveButton.disabled = !(boardId && accountSelect.value && projectSelect.value);
}

function refreshRuleFieldState() {
  const statusMode = syncTriggerSelect.value === "status_change";
  const nameColumnMode = nameSourceSelect.value === "text_column";
  const fileColumnMode = attachmentSourceSelect.value === "file_column";

  statusColumnIdInput.disabled = !statusMode;
  triggerStatusLabelInput.disabled = !statusMode;
  nameColumnIdSelect.disabled = !nameColumnMode;
  attachmentColumnIdSelect.disabled = !fileColumnMode;
}

function populateStatusColumnOptions(selectedColumnId = "") {
  statusColumnIdInput.innerHTML = "";

  if (statusColumns.length === 0) {
    statusColumnIdInput.append(new Option("No status columns found", ""));
    return;
  }

  statusColumnIdInput.append(new Option("Select status column", ""));
  for (const column of statusColumns) {
    statusColumnIdInput.append(new Option(`${column.title} (${column.id})`, column.id));
  }

  if (selectedColumnId) {
    statusColumnIdInput.value = selectedColumnId;
  }
}

function populateStatusLabelOptions(columnId, selectedLabel = "") {
  triggerStatusLabelInput.innerHTML = "";
  triggerStatusLabelInput.append(new Option("Any status label", ""));

  const selectedColumn = statusColumns.find((entry) => entry.id === columnId);
  for (const label of selectedColumn?.labels || []) {
    triggerStatusLabelInput.append(new Option(label, label));
  }

  if (selectedLabel) {
    triggerStatusLabelInput.value = selectedLabel;
  }
}

function populateNameColumnOptions(selectedColumnId = "") {
  nameColumnIdSelect.innerHTML = "";

  if (syncColumns.nameColumns.length === 0) {
    nameColumnIdSelect.append(new Option("No text columns found", ""));
    return;
  }

  nameColumnIdSelect.append(new Option("Select name column", ""));
  for (const column of syncColumns.nameColumns) {
    nameColumnIdSelect.append(new Option(`${column.title} (${column.id})`, column.id));
  }

  if (selectedColumnId) {
    nameColumnIdSelect.value = selectedColumnId;
  }
}

function populateAttachmentColumnOptions(selectedColumnId = "") {
  attachmentColumnIdSelect.innerHTML = "";

  if (syncColumns.fileColumns.length === 0) {
    attachmentColumnIdSelect.append(new Option("No file columns found", ""));
    return;
  }

  attachmentColumnIdSelect.append(new Option("Select file column", ""));
  for (const column of syncColumns.fileColumns) {
    attachmentColumnIdSelect.append(new Option(`${column.title} (${column.id})`, column.id));
  }

  if (selectedColumnId) {
    attachmentColumnIdSelect.value = selectedColumnId;
  }
}

async function loadStatusColumns() {
  if (!boardId) {
    return;
  }

  const data = await fetchJson(`/api/monday/status-columns?boardId=${encodeURIComponent(boardId)}`);
  statusColumns = data.columns || [];
  populateStatusColumnOptions();
  populateStatusLabelOptions("");
}

async function loadSyncColumns() {
  if (!boardId) {
    return;
  }

  const data = await fetchJson(`/api/monday/sync-columns?boardId=${encodeURIComponent(boardId)}`);
  syncColumns = data.columns || { nameColumns: [], fileColumns: [] };
  populateNameColumnOptions();
  populateAttachmentColumnOptions();
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

function extractBoardViewId(context) {
  if (!context) {
    return "";
  }

  if (context.boardViewId) {
    return String(context.boardViewId);
  }

  if (context.viewId) {
    return String(context.viewId);
  }

  if (Array.isArray(context.boardViewIds) && context.boardViewIds.length > 0) {
    return String(context.boardViewIds[0]);
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
  boardViewId = mapping.boardViewId || boardViewId;
  targetLanguageSelect.value = mapping.targetLanguage || "none";
  syncTriggerSelect.value = mapping.syncTrigger || "manual";
  populateStatusColumnOptions(mapping.statusColumnId || "");
  populateStatusLabelOptions(mapping.statusColumnId || "", mapping.triggerStatusLabel || "");
  keepSyncedCheckbox.checked = mapping.keepSynced !== false;
  nameSourceSelect.value = mapping.nameSource || "item_name";
  populateNameColumnOptions(mapping.nameColumnId || "");
  attachmentSourceSelect.value = mapping.attachmentSource || "item_assets";
  populateAttachmentColumnOptions(mapping.attachmentColumnId || "");
  nameTranslationsInput.value =
    mapping.nameTranslations && Object.keys(mapping.nameTranslations).length > 0
      ? JSON.stringify(mapping.nameTranslations, null, 2)
      : "";
  refreshRuleFieldState();
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
syncTriggerSelect.addEventListener("change", refreshRuleFieldState);
nameSourceSelect.addEventListener("change", refreshRuleFieldState);
attachmentSourceSelect.addEventListener("change", refreshRuleFieldState);
statusColumnIdInput.addEventListener("change", () => {
  populateStatusLabelOptions(statusColumnIdInput.value);
});

saveButton.addEventListener("click", async () => {
  const accountId = accountSelect.value;
  const projectKey = projectSelect.value;
  const projectName = projectSelect.options[projectSelect.selectedIndex]?.text || "";
  const targetLanguage = targetLanguageSelect.value;
  const syncTrigger = syncTriggerSelect.value;
  const statusColumnId = statusColumnIdInput.value.trim();
  const triggerStatusLabel = triggerStatusLabelInput.value.trim();
  const keepSynced = keepSyncedCheckbox.checked;
  const nameSource = nameSourceSelect.value;
  const nameColumnId = nameColumnIdSelect.value.trim();
  const attachmentSource = attachmentSourceSelect.value;
  const attachmentColumnId = attachmentColumnIdSelect.value.trim();

  let nameTranslations = {};
  const translationInput = nameTranslationsInput.value.trim();
  if (translationInput) {
    try {
      const parsed = JSON.parse(translationInput);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Translation rules must be a JSON object.");
      }

      nameTranslations = Object.fromEntries(
        Object.entries(parsed).map(([from, to]) => [String(from), String(to)])
      );
    } catch {
      setStatus("Name translation rules must be valid JSON object text.", "error");
      return;
    }
  }

  if (!(boardId && accountId && projectKey)) {
    setStatus("Please select account and project.", "error");
    return;
  }

  saveButton.disabled = true;

  try {
    await fetchJson("/api/mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        boardId,
        boardViewId,
        accountId,
        projectKey,
        projectName,
        targetLanguage,
        syncTrigger,
        statusColumnId: syncTrigger === "status_change" ? statusColumnId : "",
        triggerStatusLabel: syncTrigger === "status_change" ? triggerStatusLabel : "",
        keepSynced,
        nameSource,
        nameColumnId: nameSource === "text_column" ? nameColumnId : "",
        attachmentSource,
        attachmentColumnId: attachmentSource === "file_column" ? attachmentColumnId : "",
        nameTranslations
      })
    });

    setStatus("Saved. Sync project, rule, and field mapping are now active.", "ok");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not save mapping", "error");
  } finally {
    setSaveEnabled();
  }
});

(async function init() {
  try {
    await loadAccounts();
    refreshRuleFieldState();

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
        boardViewId = extractBoardViewId(res?.data);
        boardIdLabel.textContent = boardId;
        setSaveEnabled();

        try {
          await loadStatusColumns();
          await loadSyncColumns();
          await loadExistingMapping();
        } catch {
          setStatus("Could not load board columns or existing mapping.", "error");
        }
      });

      monday.get("context").then(async (res) => {
        const nextBoardId = extractBoardId(res?.data);
        if (!nextBoardId) {
          return;
        }

        boardId = nextBoardId;
        boardViewId = extractBoardViewId(res?.data);
        boardIdLabel.textContent = boardId;
        setSaveEnabled();

        try {
          await loadStatusColumns();
          await loadSyncColumns();
          await loadExistingMapping();
        } catch {
          setStatus("Could not load board columns or existing mapping.", "error");
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
