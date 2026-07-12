let queuePollTimer = null;
let allSpecies = [];        // full taxonomy from /api/species, INCLUDES zero-count entries
let speciesWithClips = [];  // allSpecies filtered to count > 0 — used for dropdowns
let modalTargetVideoId = null;
let lastRunningJobId = null; // tracks which job the log box is currently showing

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
    } else {
      clearTimeout(queuePollTimer);
    }
    if (btn.dataset.tab === "library") {
      refreshSpeciesData().then(() => {
        populateFilterDropdown("lib-species-filter");
        loadLibrary();
      });
    }
    if (btn.dataset.tab === "favorites") {
      refreshSpeciesData().then(() => {
        populateFilterDropdown("fav-species-filter");
        loadFavorites();
      });
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

      if (document.getElementById("tab-upload").classList.contains("active")) {
        queuePollTimer = setTimeout(pollQueue, 2000);
      }
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
  label.textContent = "Processing: " + job.folder;
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

  const badge = document.createElement("span");
  badge.className = "queue-badge " + (kind === "running" ? "badge-running" : "badge-queued");
  badge.textContent = kind === "running" ? "Running" : `Queued #${position}`;
  li.appendChild(badge);

  return li;
}

// ---- Species data ----
async function refreshSpeciesData() {
  const res = await fetch("/api/species");
  allSpecies = await res.json();
  speciesWithClips = allSpecies.filter(s => s.count > 0);
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

document.getElementById("lib-species-filter").addEventListener("change", loadLibrary);
document.getElementById("fav-species-filter").addEventListener("change", loadFavorites);

// ---- Library / Favorites video grids ----
async function loadLibrary() {
  const species = document.getElementById("lib-species-filter").value;
  const url = "/api/videos" + (species ? `?species=${encodeURIComponent(species)}` : "");
  const res = await fetch(url);
  const vids = await res.json();
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
    if (v.corrected_species) badge.classList.add("corrected");

    const favBtn = card.querySelector(".favorite-btn");
    favBtn.textContent = v.favorited ? "★" : "☆";
    if (v.favorited) favBtn.classList.add("active");
    favBtn.addEventListener("click", () =>
      toggleFavorite(v.id, !v.favorited, gridId === "lib-grid" ? "lib" : "fav")
    );

    const correctionSelect = card.querySelector(".correction-select");
    buildCorrectionOptions(correctionSelect, v);

    const whichTab = gridId === "lib-grid" ? "lib" : "fav";

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
        populateFilterDropdown("lib-species-filter");
        loadLibrary();
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
        populateFilterDropdown("lib-species-filter");
        loadLibrary();
      } else {
        populateFilterDropdown("fav-species-filter");
        loadFavorites();
      }
    });

    modalList.appendChild(item);
  });
}
