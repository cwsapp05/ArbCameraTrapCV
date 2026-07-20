let queuePollTimer = null;
let lastQueueSize = 0; // used by pollQueue to detect "a job just finished" (size decreased)
let allSpecies = [];        // full taxonomy from /api/species, INCLUDES zero-count entries
let speciesWithClips = [];  // allSpecies filtered to count > 0 — used for dropdowns
let modalTargetVideoId = null;
let lastRunningJobId = null; // tracks which job the log box is currently showing
let libraryActiveSpecies = null; // which species card was drilled into, or null = showing the group view

// ---- Random title emoji, picked fresh each page load ----
const TITLE_EMOJIS = ["🦝", "🦌", "🐇", "🐻", "🐰", "🐭", "🐸", "🦆", "🪿", "🐦‍⬛", "🦉", "🦇", "🐞", "🐍", "🦎", "🐊", "🐆", "🦃", "🐁", "🐀", "🐿️"];
document.getElementById("title-emoji").textContent =
  TITLE_EMOJIS[Math.floor(Math.random() * TITLE_EMOJIS.length)];
// ---- Tabs ----
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");

    if (btn.dataset.tab === "upload") {
      pollQueue();
      loadUploadHistory();
    } else {
      clearTimeout(queuePollTimer);
    }
    if (btn.dataset.tab === "library") {
      refreshSpeciesData().then(showLibraryGroups); // always start fresh at the group view
    }
    if (btn.dataset.tab === "favorites") {
      refreshSpeciesData().then(() => {
        populateFilterDropdown("fav-species-filter");
        loadFavorites();
      });
    }
    if (btn.dataset.tab === "spreadsheet") {
      loadSpreadsheet();
    }
  });
});

// ---- Upload tab: submitting a job ----
const folderInput = document.getElementById("folder-path");
const runBtn = document.getElementById("run-btn");

document.getElementById("browse-btn").addEventListener("click", async () => {
  const res = await fetch("/api/pick-folder", { method: "POST" });
  const data = await res.json();
  if (data.folder) {
    folderInput.value = data.folder;
    runBtn.disabled = false;
  }
});

runBtn.addEventListener("click", async () => {
  const folder = folderInput.value;
  const country = document.getElementById("country").value;
  const state = document.getElementById("state").value;
  const confirmationEl = document.getElementById("submit-confirmation");

  runBtn.disabled = true;
  confirmationEl.classList.remove("hidden");
  confirmationEl.textContent = "Submitting…";

  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, country, state }),
  });
  const data = await res.json();
  runBtn.disabled = false;

  if (data.error) {
    confirmationEl.textContent = "Error: " + data.error;
    return;
  }

  confirmationEl.textContent = data.queue_position > 0
    ? `Submitted — you're #${data.queue_position} in the queue below.`
    : "Submitted — starting shortly.";

  pollQueue(); // refresh immediately rather than waiting for the next tick
  loadUploadHistory();
});

// ---- Queue panel + live log (Upload tab) ----
// The log box always shows whatever job is CURRENTLY RUNNING, not "the job
// this browser tab happened to submit." That's the fix for the log
// disappearing when a second job gets queued — it only changes what's shown
// when the running job itself changes, never just because something new
// joined the queue.
function pollQueue() {
  clearTimeout(queuePollTimer);
  fetch("/api/queue")
    .then(r => r.json())
    .then(data => {
      const list = document.getElementById("queue-list");
      const empty = document.getElementById("queue-empty");
      list.innerHTML = "";

      const items = [...data.running, ...data.queued];
      if (items.length === 0) {
        empty.classList.remove("hidden");
      } else {
        empty.classList.add("hidden");
        data.running.forEach(job => list.appendChild(queueItem(job, "running")));
        data.queued.forEach((job, i) => list.appendChild(queueItem(job, "queued", i + 1)));
      }

      updateRunningLog(data.running);

      // A drop in total in-progress jobs (running + queued) means one just
      // finished — success, error, or cancelled all count. Refresh Library's
      // unreviewed counts/badges so they update live instead of staying
      // stale until the tab is revisited or the page is refreshed.
      const currentQueueSize = data.running.length + data.queued.length;
      if (currentQueueSize < lastQueueSize) {
        refreshSpeciesData();
        loadUploadHistory();
      }
      lastQueueSize = currentQueueSize;

      if (document.getElementById("tab-upload").classList.contains("active")) {
        queuePollTimer = setTimeout(pollQueue, 2000);
      }
    });
}

// ---- Upload History (Upload tab) ----
document.getElementById("upload-history-toggle").addEventListener("click", () => {
  const content = document.getElementById("upload-history-content");
  const arrow = document.querySelector("#upload-history-toggle .collapsible-arrow");
  content.classList.toggle("hidden");
  arrow.classList.toggle("expanded");
});

async function loadUploadHistory() {
  const res = await fetch("/api/jobs");
  const jobs = await res.json();
  renderUploadHistory(jobs);
}

function renderUploadHistory(jobs) {
  const list = document.getElementById("upload-history-list");
  const empty = document.getElementById("upload-history-empty");
  list.innerHTML = "";

  if (jobs.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  jobs.forEach(job => {
    const li = document.createElement("li");
    li.className = "history-item";

    const folder = document.createElement("span");
    folder.className = "history-folder";
    folder.textContent = job.folder;
    folder.title = job.folder;
    li.appendChild(folder);

    const meta = document.createElement("span");
    meta.className = "history-meta";

    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = job.started_at;
    meta.appendChild(time);

    const badge = document.createElement("span");
    badge.className = "history-status-badge status-" + job.status;
    badge.textContent = job.status;
    meta.appendChild(badge);

    li.appendChild(meta);
    list.appendChild(li);
  });
}

function updateRunningLog(runningJobs) {
  const box = document.getElementById("running-log-box");
  const label = document.getElementById("running-log-label");
  const tail = document.getElementById("running-log-tail");

  if (runningJobs.length === 0) {
    box.classList.add("hidden");
    lastRunningJobId = null;
    return;
  }

  const job = runningJobs[0]; // single worker thread — at most one running job
  box.classList.remove("hidden");
  label.textContent = (job.status === "cancelling" ? "Cancelling: " : "Processing: ") + job.folder;
  tail.textContent = job.log_tail || "";
  tail.scrollTop = tail.scrollHeight;
  lastRunningJobId = job.id;
}

function queueItem(job, kind, position) {
  const li = document.createElement("li");
  li.className = "queue-item" + (kind === "running" ? " running" : "");

  const folder = document.createElement("span");
  folder.className = "queue-folder";
  folder.textContent = job.folder;
  li.appendChild(folder);

  const right = document.createElement("div");
  right.className = "queue-right";

  const isCancelling = job.status === "cancelling";

  const badge = document.createElement("span");
  badge.className = "queue-badge " + (kind === "running" ? "badge-running" : "badge-queued");
  badge.textContent = isCancelling ? "Cancelling…" : (kind === "running" ? "Running" : `Queued #${position}`);
  right.appendChild(badge);

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "cancel-job-btn";
  cancelBtn.textContent = isCancelling ? "Cancelling…" : "Cancel";
  cancelBtn.disabled = isCancelling;
  cancelBtn.addEventListener("click", async () => {
    const ok = confirm(`Cancel processing for "${job.folder}"?`);
    if (!ok) return;
    cancelBtn.disabled = true;
    cancelBtn.textContent = "Cancelling…";
    const res = await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
    }
    pollQueue(); // refresh right away rather than waiting for the next tick
  });
  right.appendChild(cancelBtn);

  li.appendChild(right);

  return li;
}

// ---- Species data ----
let unreviewedCountsBySpecies = {}; // display_species -> count of videos still on the AI's original guess
let totalUnreviewedCount = 0;       // across the whole library, regardless of species

async function refreshSpeciesData() {
  const [speciesRes, videosRes] = await Promise.all([
    fetch("/api/species"),
    fetch("/api/videos"),
  ]);
  allSpecies = await speciesRes.json();
  speciesWithClips = allSpecies.filter(s => s.count > 0);

  const vids = await videosRes.json();
  unreviewedCountsBySpecies = {};
  totalUnreviewedCount = 0;
  vids.forEach(v => {
    if (!v.corrected_species) {
      unreviewedCountsBySpecies[v.display_species] = (unreviewedCountsBySpecies[v.display_species] || 0) + 1;
      totalUnreviewedCount++;
    }
  });
  updateLibraryTabBadge();
}

function updateLibraryTabBadge() {
  const tabBtn = document.querySelector('.tab-btn[data-tab="library"]');
  let badge = tabBtn.querySelector(".tab-badge");
  if (totalUnreviewedCount > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "tab-badge";
      tabBtn.appendChild(badge);
    }
    badge.textContent = totalUnreviewedCount;
  } else if (badge) {
    badge.remove();
  }
}

function populateFilterDropdown(selectId) {
  const select = document.getElementById(selectId);
  const previousValue = select.value;
  select.innerHTML = "";

  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All species";
  select.appendChild(allOpt);

  // Zero-clip species are hidden here — nothing to filter to yet.
  speciesWithClips.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.label;
    opt.textContent = `${s.label} (${s.count})`;
    select.appendChild(opt);
  });

  if ([...select.options].some(o => o.value === previousValue)) {
    select.value = previousValue;
  }
}

document.getElementById("fav-species-filter").addEventListener("change", loadFavorites);

// ---- Library tab: species group cards + drill-down detail view ----
function showLibraryGroups() {
  libraryActiveSpecies = null;
  document.getElementById("lib-detail-view").classList.add("hidden");
  document.getElementById("lib-groups-view").classList.remove("hidden");
  renderLibraryGroupCards();
}

function renderLibraryGroupCards() {
  const container = document.getElementById("lib-group-cards");
  const empty = document.getElementById("lib-groups-empty");
  container.innerHTML = "";

  if (speciesWithClips.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const sorted = [...speciesWithClips].sort((a, b) => {
    if (a.label === "blank") return 1;   // blank always last, regardless of count
    if (b.label === "blank") return -1;
    if (b.count !== a.count) return b.count - a.count; // most videos first
    return a.label.localeCompare(b.label); // tie-break alphabetically
  });

  sorted.forEach(s => {
    const unreviewedCount = unreviewedCountsBySpecies[s.label] || 0;

    const card = document.createElement("div");
    card.className = "species-group-card"
      + (s.label === "blank" ? " blank" : "")
      + (unreviewedCount > 0 ? " has-unreviewed" : "");

    if (unreviewedCount > 0) {
      const bubble = document.createElement("span");
      bubble.className = "unreviewed-bubble";
      bubble.textContent = unreviewedCount;
      bubble.title = `${unreviewedCount} unreviewed video${unreviewedCount === 1 ? "" : "s"}`;
      card.appendChild(bubble);
    }

    const label = document.createElement("div");
    label.className = "species-group-label";
    label.textContent = s.label;
    card.appendChild(label);

    const count = document.createElement("div");
    count.className = "species-group-count";
    count.textContent = `${s.count} clip${s.count === 1 ? "" : "s"}`;
    card.appendChild(count);

    card.addEventListener("click", () => openLibraryGroup(s.label));
    container.appendChild(card);
  });
}

function openLibraryGroup(label) {
  libraryActiveSpecies = label;
  document.getElementById("lib-groups-view").classList.add("hidden");
  document.getElementById("lib-detail-view").classList.remove("hidden");
  document.getElementById("lib-detail-heading").textContent = label;
  loadLibrary();
}

document.getElementById("lib-back-btn").addEventListener("click", () => {
  refreshSpeciesData().then(showLibraryGroups); // counts may have changed while drilled in
});

// ---- Library / Favorites video grids ----
async function loadLibrary() {
  const species = libraryActiveSpecies;
  const url = "/api/videos" + (species ? `?species=${encodeURIComponent(species)}` : "");
  const res = await fetch(url);
  const vids = await res.json();
  vids.sort((a, b) => {
    const aUnreviewed = !a.corrected_species;
    const bUnreviewed = !b.corrected_species;
    if (aUnreviewed === bUnreviewed) return 0; // stable sort preserves existing order within each group
    return aUnreviewed ? -1 : 1; // unreviewed (still on the AI's guess) surfaces first
  });
  renderGrid(vids, "lib-grid", "lib-empty");
}

async function loadFavorites() {
  const species = document.getElementById("fav-species-filter").value;
  let url = "/api/videos?favorites_only=1";
  if (species) url += `&species=${encodeURIComponent(species)}`;
  const res = await fetch(url);
  const vids = await res.json();
  renderGrid(vids, "fav-grid", "fav-empty");
}

function renderGrid(videos, gridId, emptyId) {
  const grid = document.getElementById(gridId);
  const empty = document.getElementById(emptyId);
  grid.innerHTML = "";

  if (videos.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const template = document.getElementById("video-card-template");
  videos.forEach(v => {
    const card = template.content.cloneNode(true);

    const videoEl = card.querySelector("video");
    videoEl.src = "/media/" + v.id;

    card.querySelector(".video-filename").textContent = v.filename;
    card.querySelector(".video-filename").title = v.filename;

    const badge = card.querySelector(".species-badge");
    badge.textContent = v.display_species;
    if (v.display_species === "blank") badge.classList.add("blank");

    // "Verified by" is hardcoded for now (single-user assumption) — swap
    // for the actual editor's name once accounts/auth exist.
    if (v.corrected_species) {
      card.querySelector(".verified-info").classList.remove("hidden");
    } else {
      card.querySelector(".unreviewed-corner-bubble").classList.remove("hidden");
    }

    const favBtn = card.querySelector(".favorite-btn");
    favBtn.textContent = v.favorited ? "★" : "☆";
    if (v.favorited) favBtn.classList.add("active");
    const whichTab = gridId === "lib-grid" ? "lib" : "fav";
    favBtn.addEventListener("click", () =>
      toggleFavorite(v.id, !v.favorited, whichTab)
    );

    const deleteBtn = card.querySelector(".delete-btn");
    deleteBtn.addEventListener("click", async () => {
      const ok = confirm(
        `Delete "${v.filename}" from the library?\n\nThis only removes it from the library — the file on your computer is NOT deleted.`
      );
      if (!ok) return;
      await deleteVideo(v.id);
      await refreshSpeciesData(); // counts shift when a video disappears
      if (whichTab === "lib") loadLibrary(); else loadFavorites();
    });

    const correctionSelect = card.querySelector(".correction-select");
    buildCorrectionOptions(correctionSelect, v);

    correctionSelect.addEventListener("change", () => {
      if (correctionSelect.value === "__add_new__") {
        openSpeciesModal(v.id, whichTab);
        correctionSelect.value = ""; // don't leave the sentinel selected
      }
    });

    card.querySelector(".save-correction-btn").addEventListener("click", async () => {
      if (correctionSelect.value === "__add_new__") return; // handled by modal instead
      await saveCorrection(v.id, correctionSelect.value);
      await refreshSpeciesData();
      if (whichTab === "lib") {
        loadLibrary(); // group counts refresh next time "Back to species" is clicked
      } else {
        populateFilterDropdown("fav-species-filter");
        loadFavorites();
      }
    });

    grid.appendChild(card);
  });
}

function buildCorrectionOptions(select, video) {
  select.innerHTML = "";

  const keepOpt = document.createElement("option");
  keepOpt.value = "";
  keepOpt.textContent = video.ai_species
    ? `Predicted: ${video.ai_species} (${video.ai_classifier_conf})`
    : "Predicted: blank";
  select.appendChild(keepOpt);

  // Only species with at least one existing clip show up in the quick list —
  // anything with zero clips so far is reachable via "+ Add new species"
  // instead, so the list doesn't get cluttered with the full ~30-label
  // taxonomy every time.
  speciesWithClips.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.label;
    opt.textContent = s.label;
    if (video.corrected_species === s.label) opt.selected = true;
    select.appendChild(opt);
  });

  const addNewOpt = document.createElement("option");
  addNewOpt.value = "__add_new__";
  addNewOpt.textContent = "+ Add new species";
  select.appendChild(addNewOpt);
}

async function toggleFavorite(videoId, favorited, whichTab) {
  await fetch(`/api/videos/${videoId}/favorite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorited }),
  });
  if (whichTab === "lib") loadLibrary(); else loadFavorites();
}

async function deleteVideo(videoId) {
  const res = await fetch(`/api/videos/${videoId}/delete`, { method: "POST" });
  const data = await res.json();
  if (data.error) alert(data.error);
}

async function saveCorrection(videoId, species) {
  await fetch(`/api/videos/${videoId}/correct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ species }),
  });
}

// ---- "Add new species" modal ----
const modal = document.getElementById("species-modal");
const modalSearch = document.getElementById("modal-search");
const modalList = document.getElementById("modal-species-list");

function openSpeciesModal(videoId, whichTab) {
  modalTargetVideoId = videoId;
  modal.dataset.whichTab = whichTab;
  modalSearch.value = "";
  renderModalList("");
  modal.classList.remove("hidden");
  modalSearch.focus();
}

function closeSpeciesModal() {
  modal.classList.add("hidden");
  modalTargetVideoId = null;
}

document.getElementById("modal-close-btn").addEventListener("click", closeSpeciesModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeSpeciesModal(); // click on the dim backdrop
});

modalSearch.addEventListener("input", () => renderModalList(modalSearch.value));

function renderModalList(query) {
  const q = query.trim().toLowerCase();
  const matches = allSpecies.filter(s => s.label.toLowerCase().includes(q));

  modalList.innerHTML = "";
  if (matches.length === 0) {
    const none = document.createElement("div");
    none.className = "muted";
    none.textContent = "No species match your search.";
    modalList.appendChild(none);
    return;
  }

  matches.forEach(s => {
    const item = document.createElement("div");
    item.className = "modal-species-item";

    const label = document.createElement("span");
    label.textContent = s.label;
    item.appendChild(label);

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = s.count > 0 ? `${s.count} clip${s.count === 1 ? "" : "s"}` : "no clips yet";
    item.appendChild(count);

    item.addEventListener("click", async () => {
      await saveCorrection(modalTargetVideoId, s.label);
      const whichTab = modal.dataset.whichTab;
      closeSpeciesModal();
      await refreshSpeciesData();
      if (whichTab === "lib") {
        loadLibrary(); // group counts refresh next time "Back to species" is clicked
      } else {
        populateFilterDropdown("fav-species-filter");
        loadFavorites();
      }
    });

    modalList.appendChild(item);
  });
}

// ---- Initial load ----
// The Upload tab is marked active in the HTML by default (no tab click fires
// on page load/refresh), so without this, the queue panel and running log
// stay empty until the user manually switches tabs and back.
if (document.getElementById("tab-upload").classList.contains("active")) {
  pollQueue();
  loadUploadHistory();
}
refreshSpeciesData(); // populates the Library tab's unreviewed-count badge immediately, not just after visiting the tab

// ---- Spreadsheet tab ----
const SPREADSHEET_FIELDS = ["date", "time", "location", "species", "count", "notes", "filename", "diel_period", "temperature"];

function stripExtension(name) {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

let spreadsheetVideos = [];        // raw data from the last /api/videos fetch
let spreadsheetSearch = "";
let spreadsheetSorts = [];         // stacked sort levels: [{field, dir}, ...] — applied in order, each a tie-break for the previous

const SORT_FIELD_LABELS = {
  date: "Date",
  time: "Time",
  location: "Location",
  species: "Species",
  count: "Count",
  notes: "Notes",
  filename: "File Name",
  diel_period: "Diel Period",
  verified: "Verified",
};

function spreadsheetRowValues(v) {
  return {
    date: v.date || "",
    time: v.time || "",
    location: v.location || "",
    species: v.display_species || "",
    count: v.count ?? 1,
    notes: v.notes || "",
    filename: stripExtension(v.display_filename || v.filename),
    diel_period: v.diel_period || "",
    temperature: v.temperature || "",
    verified: v.corrected_species ? 1 : 0, // sort-only field, not a visible column — 0 (unverified) sorts before 1 (verified) ascending
  };
}

async function loadSpreadsheet() {
  const res = await fetch("/api/videos");
  spreadsheetVideos = await res.json();
  applySpreadsheetView();
}

function applySpreadsheetView() {
  let rows = spreadsheetVideos;

  const query = spreadsheetSearch.trim().toLowerCase();
  if (query) {
    rows = rows.filter(v => {
      const values = spreadsheetRowValues(v);
      return SPREADSHEET_FIELDS.some(f => String(values[f]).toLowerCase().includes(query));
    });
  }

  if (spreadsheetSorts.length > 0) {
    rows = [...rows].sort((a, b) => {
      const av_all = spreadsheetRowValues(a);
      const bv_all = spreadsheetRowValues(b);
      for (const level of spreadsheetSorts) {
        const av = av_all[level.field];
        const bv = bv_all[level.field];
        const aEmpty = av === "" || av === null || av === undefined;
        const bEmpty = bv === "" || bv === null || bv === undefined;

        let cmp;
        if (aEmpty && bEmpty) cmp = 0;
        else if (aEmpty) cmp = 1;   // missing values always sort last, either direction
        else if (bEmpty) cmp = -1;
        else if (level.field === "count" || level.field === "verified") cmp = Number(av) - Number(bv);
        else cmp = String(av).localeCompare(String(bv));

        if (level.dir === "desc") cmp = -cmp;
        if (cmp !== 0) return cmp; // this level broke the tie — done
        // else: identical at this level, fall through to the next sort level
      }
      return 0; // tied across every sort level — leave relative order as-is (stable sort)
    });
  }

  renderSpreadsheet(rows);
}

document.getElementById("spreadsheet-search").addEventListener("input", (e) => {
  spreadsheetSearch = e.target.value;
  applySpreadsheetView();
});

function renderSortRows() {
  const container = document.getElementById("spreadsheet-sorts-list");
  const emptyMsg = document.getElementById("spreadsheet-sorts-empty");
  container.innerHTML = "";
  emptyMsg.classList.toggle("hidden", spreadsheetSorts.length > 0);

  spreadsheetSorts.forEach((level, index) => {
    const row = document.createElement("div");
    row.className = "sort-row";

    const label = document.createElement("span");
    label.className = "sort-row-label";
    label.textContent = `Sort ${index + 1}`;
    row.appendChild(label);

    const fieldSelect = document.createElement("select");
    fieldSelect.className = "sort-field-select";
    Object.entries(SORT_FIELD_LABELS).forEach(([value, text]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      if (value === level.field) opt.selected = true;
      fieldSelect.appendChild(opt);
    });
    fieldSelect.addEventListener("change", () => {
      level.field = fieldSelect.value;
      applySpreadsheetView();
    });
    row.appendChild(fieldSelect);

    const dirSelect = document.createElement("select");
    dirSelect.className = "sort-dir-select";
    [["asc", "Ascending"], ["desc", "Descending"]].forEach(([value, text]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      if (value === level.dir) opt.selected = true;
      dirSelect.appendChild(opt);
    });
    dirSelect.addEventListener("change", () => {
      level.dir = dirSelect.value;
      applySpreadsheetView();
    });
    row.appendChild(dirSelect);

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-sort-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove this sort level";
    removeBtn.addEventListener("click", () => {
      spreadsheetSorts.splice(index, 1);
      renderSortRows();
      applySpreadsheetView();
    });
    row.appendChild(removeBtn);

    container.appendChild(row);
  });
}

document.getElementById("add-sort-btn").addEventListener("click", () => {
  spreadsheetSorts.push({ field: "date", dir: "asc" });
  renderSortRows();
  applySpreadsheetView();
});

renderSortRows(); // draw the initial (empty) sort list on page load

function renderSpreadsheet(videos) {
  closeRowContextMenu();
  const tbody = document.getElementById("spreadsheet-body");
  const empty = document.getElementById("spreadsheet-empty");
  tbody.innerHTML = "";

  if (videos.length === 0) {
    empty.classList.remove("hidden");
    empty.textContent = spreadsheetSearch.trim() ? "No videos match your search." : "No videos yet.";
    return;
  }
  empty.classList.add("hidden");

  videos.forEach(v => {
    const tr = document.createElement("tr");
    tr.dataset.videoId = v.id;
    tr.dataset.favorited = v.favorited ? "1" : "0";

    const arrowTd = document.createElement("td");
    arrowTd.className = "arrow-cell";
    if (v.has_bar_crop) {
      const arrowBtn = document.createElement("button");
      arrowBtn.className = "bar-crop-btn";
      arrowBtn.textContent = "▸";
      arrowBtn.title = "Show cropped info bar";
      arrowBtn.addEventListener("click", () => toggleBarCropRow(tr, arrowBtn, v.id));
      arrowTd.appendChild(arrowBtn);
    }
    tr.appendChild(arrowTd);

    const values = spreadsheetRowValues(v);

    SPREADSHEET_FIELDS.forEach(field => {
      const td = document.createElement("td");
      td.className = "editable";
      td.dataset.field = field;
      td.textContent = values[field];

      if (field === "species") {
        td.classList.add(v.corrected_species ? "species-verified" : "species-unverified");
        td.title = v.corrected_species ? "Verified by: Connor Sapp" : "Unverified";
      }

      td.addEventListener("click", () => startCellEdit(td, v.id));
      tr.appendChild(td);
    });

    const menuTd = document.createElement("td");
    menuTd.className = "row-menu-cell";

    const menuBtn = document.createElement("button");
    menuBtn.className = "row-menu-btn";
    menuBtn.textContent = "⋮";
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (contextMenuVideoId === v.id) {
        closeRowContextMenu();
      } else {
        openRowContextMenu(menuBtn, tr, v.id);
      }
    });
    menuTd.appendChild(menuBtn);

    tr.appendChild(menuTd);
    tbody.appendChild(tr);
  });
}

// ---- Shared floating context menu (Spreadsheet row actions) ----
// One menu instance for the whole table, repositioned next to whichever
// row's "⋮" button was clicked and rendered fixed/on-top so it's never
// clipped by the table's own layout — see openRowContextMenu below.
let contextMenuVideoId = null;
let contextMenuRow = null;

function openRowContextMenu(button, tr, videoId) {
  contextMenuVideoId = videoId;
  contextMenuRow = tr;

  const isFavorited = tr.dataset.favorited === "1";
  document.getElementById("ctx-favorite-btn").textContent = isFavorited ? "★ Unfavorite" : "☆ Favorite";

  const menu = document.getElementById("row-context-menu");
  menu.classList.remove("hidden");

  const buttonRect = button.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();

  // Pop out to the LEFT of the button (it sits at the far right of the
  // table) and vertically aligned with it, so it reads as "popping out the
  // side" rather than dropping down below the row.
  let left = buttonRect.left - menuRect.width - 8;
  if (left < 8) left = buttonRect.right + 8; // not enough room on the left — flip to the right instead

  menu.style.left = `${left}px`;
  menu.style.top = `${buttonRect.top}px`;
}

function closeRowContextMenu() {
  document.getElementById("row-context-menu").classList.add("hidden");
  contextMenuVideoId = null;
  contextMenuRow = null;
}

document.getElementById("ctx-favorite-btn").addEventListener("click", async (e) => {
  e.stopPropagation();
  const videoId = contextMenuVideoId;
  const row = contextMenuRow;
  closeRowContextMenu();
  if (!videoId || !row) return;

  const newFavorited = row.dataset.favorited !== "1";
  await fetch(`/api/videos/${videoId}/favorite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorited: newFavorited }),
  });
  row.dataset.favorited = newFavorited ? "1" : "0";
  patchSpreadsheetVideo(videoId, { favorited: newFavorited });
});

document.getElementById("ctx-copy-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (contextMenuRow) copyRowToClipboard(contextMenuRow);
  closeRowContextMenu();
});

document.getElementById("ctx-copy-all-btn").addEventListener("click", (e) => {
  e.stopPropagation(); // Prevent the click from triggering window close logic
  copyEntireTableToClipboard();
  closeRowContextMenu(); // Hide the menu when done
});

document.getElementById("ctx-delete-btn").addEventListener("click", async (e) => {
  e.stopPropagation();
  const videoId = contextMenuVideoId;
  const row = contextMenuRow;
  closeRowContextMenu();
  if (!videoId || !row) return;

  const filenameText = row.querySelector('td[data-field="filename"]').textContent;
  const ok = confirm(
    `Delete "${filenameText}" from the library?\n\nThis only removes it from the library — the file on your computer is NOT deleted.`
  );
  if (!ok) return;
  await deleteVideo(videoId);
  loadSpreadsheet();
});

// Close the context menu when clicking anywhere else on the page.
document.addEventListener("click", (e) => {
  const menu = document.getElementById("row-context-menu");
  if (!menu.classList.contains("hidden") && !menu.contains(e.target)) {
    closeRowContextMenu();
  }
});

function copyRowToClipboard(tr) {
  const cells = SPREADSHEET_FIELDS.map(field =>
    tr.querySelector(`td[data-field="${field}"]`).textContent
  );
  // One empty column between File Name and Diel Period — reserved space for
  // the NR team's own "Bookmark" column in their Excel sheet, so a pasted
  // row lines up with their existing layout instead of shifting everything
  // after File Name over by one.
  cells.splice(cells.length - 1, 0, "");
  const line = cells.join("\t"); // real tab characters — Excel splits pasted
                                  // tab-separated text into columns automatically
  navigator.clipboard.writeText(line).catch(() => {
    alert("Couldn't copy to clipboard — your browser may be blocking clipboard access on this page.");
  });
}

function copyEntireTableToClipboard() {
  const tbody = document.getElementById("spreadsheet-body");
  const rows = tbody.querySelectorAll("tr");

  if (rows.length === 0) return;

  // Extract data from every row using the exact same cell mapping format
  const allLines = Array.from(rows).map(tr => {
    return SPREADSHEET_FIELDS.map(field =>
      tr.querySelector(`td[data-field="${field}"]`).textContent
    ).join("\t"); // Join individual cells with tabs
  });

  // Join all lines with newlines to form the complete table block
  const fullTableText = allLines.join("\n");

  // Write the structured block to the clipboard
  navigator.clipboard.writeText(fullTableText).catch(() => {
    alert("Couldn't copy to clipboard — your browser may be blocking clipboard access on this page.");
  });
}

function startCellEdit(td, videoId) {
  if (td.querySelector("input")) return; // already editing
  const field = td.dataset.field;
  const originalValue = td.textContent;
  const tr = td.closest("tr");

  autoOpenBarCropForRow(tr);

  td.classList.add("editing");
  td.textContent = "";
  const input = document.createElement("input");
  input.type = field === "count" ? "number" : "text";
  if (field === "count") input.min = "0";
  input.value = originalValue;
  td.appendChild(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (shouldSave) => {
    if (settled) return;
    settled = true;

    if (!shouldSave) {
      td.classList.remove("editing");
      td.textContent = originalValue;
      autoCloseBarCropForRow(tr);
      return;
    }

    const newValue = input.value.trim();
    const savedText = await saveCellEdit(videoId, field, newValue, originalValue);
    autoCloseBarCropForRow(tr); // decrements this row's active-edit count

    // Only do a full re-render once EVERY field in this row is done editing.
    // If Tab was just used to jump to another field in the same row, that
    // field's edit is still active here — rebuilding the table now would
    // yank its <input> out from under the user mid-keystroke. Once the row's
    // whole edit sequence ends, re-render through the current sort/search so
    // the change takes effect immediately (re-sorts the row, and recomputes
    // species verified/unverified styling from the real data) instead of
    // waiting for some unrelated action like changing the sort.
    const stillEditingThisRow = parseInt(tr.dataset.activeEdits || "0", 10) > 0;
    if (stillEditingThisRow) {
      td.classList.remove("editing");
      td.textContent = savedText;
    } else {
      applySpreadsheetView();
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
    if (e.key === "Tab") {
      const currentIndex = SPREADSHEET_FIELDS.indexOf(field);
      const targetIndex = e.shiftKey ? currentIndex - 1 : currentIndex + 1;
      const targetField = SPREADSHEET_FIELDS[targetIndex];
      const targetTd = targetField ? tr.querySelector(`td[data-field="${targetField}"]`) : null;

      if (targetTd) {
        e.preventDefault();
        // Deliberately NOT calling finish() ourselves here — starting the
        // edit on the next cell focuses its input, which naturally fires a
        // native blur on THIS input, which runs this cell's own finish(true)
        // via the listener below. Because the next cell's edit opens first
        // (bumping the row's active-edit count to 2 before this one's finish
        // drops it back to 1), the bar-crop dropdown never sees the count
        // hit 0 in between — no flicker, no reopen network request.
        startCellEdit(targetTd, videoId);
      }
      // else: no cell in that direction — let default Tab behavior run;
      // the existing blur listener below still saves and cleans up normally.
    }
  });
  input.addEventListener("blur", () => finish(true));
}

async function saveCellEdit(videoId, field, newValue, originalValue) {
  if (field === "species") {
    const res = await fetch(`/api/videos/${videoId}/correct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ species: newValue }),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return originalValue;
    }
    patchSpreadsheetVideo(videoId, data);
    await refreshSpeciesData(); // counts changed — keep filters in sync elsewhere
    return data.display_species;
  }

  if (field === "filename") {
    const res = await fetch(`/api/videos/${videoId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_filename: newValue }),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return originalValue;
    }
    patchSpreadsheetVideo(videoId, data);
    return stripExtension(data.display_filename);
  }

  // date, time, location, count, diel_period — all plain fields on /update
  const payload = { [field]: newValue };
  const res = await fetch(`/api/videos/${videoId}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return originalValue;
  }
  patchSpreadsheetVideo(videoId, data);
  return field === "count" ? String(data.count) : (data[field] || "");
}

// Every save endpoint (/correct, /update) returns the full updated record —
// merge it into our cached copy so subsequent re-renders (sorting,
// searching, a delete elsewhere in the row) reflect the edit instead of
// reverting to whatever was last fetched from the server. Without this, an
// edit only ever lived in the DOM cell itself, and any action that called
// renderSpreadsheet() again (like changing the sort) would rebuild the
// table from the stale in-memory array and silently discard it.
function patchSpreadsheetVideo(videoId, data) {
  const video = spreadsheetVideos.find(v => v.id === videoId);
  if (video) Object.assign(video, data);
}

// ---- Video popup modal (Spreadsheet "Show video") ----
document.getElementById("ctx-show-video-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const videoId = contextMenuVideoId;
  closeRowContextMenu();
  if (videoId) showVideoModal(videoId);
});

function showVideoModal(videoId) {
  const modal = document.getElementById("video-modal");
  const player = document.getElementById("video-modal-player");
  player.src = "/media/" + videoId;
  modal.classList.remove("hidden");
  player.play().catch(() => {}); // browser may block autoplay — not an error, just ignore
}

function closeVideoModal() {
  const modal = document.getElementById("video-modal");
  const player = document.getElementById("video-modal-player");
  player.pause();
  player.removeAttribute("src");
  player.load(); // fully releases the video, stops any buffering/playback
  modal.classList.add("hidden");
}

document.getElementById("video-modal-close-btn").addEventListener("click", closeVideoModal);
document.getElementById("video-modal").addEventListener("click", (e) => {
  if (e.target.id === "video-modal") closeVideoModal(); // clicking the dim backdrop also closes it
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("video-modal").classList.contains("hidden")) {
    closeVideoModal();
  }
});

// ---- Bar-crop dropdown row (Spreadsheet left-side arrow button) ----
// Expands a row directly beneath the clicked one, spanning the full table
// width, showing the saved info-bar crop image. Toggling the same row's
// arrow again collapses it; each row's dropdown is independent, so more
// than one can be open at a time for side-by-side comparison.
// ---- Bar-crop dropdown row (Spreadsheet left-side arrow button) ----
// Expands a row directly beneath the clicked one, spanning the full table
// width, showing the saved info-bar crop image. Each row's dropdown is
// independent, so more than one can be open at a time for side-by-side
// comparison.
//
// Two ways a dropdown opens, tracked via dataset.openedBy on the drop row:
//   "manual" — the user clicked the arrow button directly. Stays open until
//              they click it again, no matter what else happens in the row.
//   "auto"   — opened automatically because the user started editing a
//              field in that row. Closes automatically once they're done
//              editing EVERY field in that row (tracked via
//              tr.dataset.activeEdits) — but only if it's still "auto" at
//              that point; a manual open is never auto-closed.
function toggleBarCropRow(tr, arrowBtn, videoId) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("bar-crop-row")) {
    next.remove();
    arrowBtn.classList.remove("expanded");
    return;
  }
  openBarCropRow(tr, arrowBtn, videoId, "manual");
}

function openBarCropRow(tr, arrowBtn, videoId, openedBy) {
  const totalColumns = 2 + SPREADSHEET_FIELDS.length; // arrow column + fields + menu column
  const dropRow = document.createElement("tr");
  dropRow.className = "bar-crop-row";
  dropRow.dataset.openedBy = openedBy;

  const td = document.createElement("td");
  td.colSpan = totalColumns;

  const img = document.createElement("img");
  img.className = "bar-crop-inline-img";
  img.alt = "Cropped info bar";
  img.src = `/api/videos/${videoId}/bar-crop`;
  td.appendChild(img);

  dropRow.appendChild(td);
  tr.after(dropRow);
  arrowBtn.classList.add("expanded");
}

function autoOpenBarCropForRow(tr) {
  const activeEdits = parseInt(tr.dataset.activeEdits || "0", 10) + 1;
  tr.dataset.activeEdits = String(activeEdits);

  const arrowBtn = tr.querySelector(".bar-crop-btn");
  if (!arrowBtn) return; // this video has no saved crop to show

  const next = tr.nextElementSibling;
  const alreadyOpen = next && next.classList.contains("bar-crop-row");
  if (!alreadyOpen) {
    openBarCropRow(tr, arrowBtn, tr.dataset.videoId, "auto");
  }
  // if it's already open (manually or otherwise), leave it exactly as-is —
  // editing never "downgrades" a manual open.
}

function autoCloseBarCropForRow(tr) {
  let activeEdits = parseInt(tr.dataset.activeEdits || "0", 10) - 1;
  if (activeEdits < 0) activeEdits = 0;
  tr.dataset.activeEdits = String(activeEdits);

  if (activeEdits > 0) return; // still editing another field in this row

  const arrowBtn = tr.querySelector(".bar-crop-btn");
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("bar-crop-row") && next.dataset.openedBy === "auto") {
    next.remove();
    if (arrowBtn) arrowBtn.classList.remove("expanded");
  }
}
