let queuePollTimer = null;
let lastQueueSize = 0; // used by pollQueue to detect "a job just finished" (size decreased)
let allSpecies = [];        // full taxonomy from /api/species, INCLUDES zero-count entries
let speciesWithClips = [];  // allSpecies filtered to count > 0 — used for dropdowns
let modalTargetVideoId = null;
let lastRunningJobId = null; // tracks which job the log box is currently showing
let libraryActiveSpecies = null; // which species card was drilled into, or null = showing the group view
let hiddenGroups = JSON.parse(localStorage.getItem("hiddenGroups") || "[]"); // species labels hidden from the group view, persisted like the temperature unit setting

// ---- Random title emoji, picked fresh each page load ----
const TITLE_EMOJIS = ["🦝", "🦌", "🐇", "🐻", "🐰", "🐭", "🐸", "🦆", "🪿", "🐦‍⬛", "🦉", "🦇", "🐞", "🐍", "🦎", "🐊", "🐆", "🦃", "🐁", "🐀", "🐿️"];
document.getElementById("title-emoji").textContent =
  TITLE_EMOJIS[Math.floor(Math.random() * TITLE_EMOJIS.length)];
// ---- Tabs ----
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const previousTab = document.querySelector(".tab-btn.active")?.dataset.tab;
    if (previousTab === "review" && btn.dataset.tab !== "review") {
      await saveCurrentReviewFields(); // don't lose pending edits when navigating away
    }

    // Stop any video playing anywhere (a Library/Favorites card, the
    // Review tab's player, the Spreadsheet's popup) so switching tabs
    // never leaves something quietly playing in the background.
    document.querySelectorAll("video").forEach(v => v.pause());
    currentlyPlayingVideo = null;

    // Close any expanded card (notes panel) in either grid — leaving the
    // tab shouldn't leave one hanging open in the background.
    collapseCardInfoPanel("lib-grid", false);
    collapseCardInfoPanel("fav-grid", false);
    if (previousTab === "library" && btn.dataset.tab !== "library") {
      libraryCardOrder = null; // leaving the tab entirely — next visit sorts fresh
    }

    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");

    if (btn.dataset.tab === "upload") {
      pollQueue();
      loadUploadHistory();
      loadOcrConfigOptions();
      loadUploadLocationOptions();
    } else {
      clearTimeout(queuePollTimer);
    }
    if (btn.dataset.tab === "review") {
      loadReviewQueue();
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
    if (btn.dataset.tab === "track") {
      loadTrackTab();
    }
    if (btn.dataset.tab === "settings") {
      loadSettingsTab();
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
    updateRunBtnState();
  }
});

function updateRunBtnState() {
  const folder = folderInput.value;
  const location = document.getElementById("upload-location-select").value;
  runBtn.disabled = !folder || !location || location === ADD_LOCATION_VALUE;
}

runBtn.addEventListener("click", async () => {
  const folder = folderInput.value;
  const ocrConfig = document.getElementById("ocr-config-select").value;

  if (ocrConfig === CONFIGURE_NEW_VALUE && !ocrGloballyDisabled) {
    if (!folder) {
      alert('Select a folder first — the OCR wizard needs a sample video from that folder.');
      return;
    }
    // Wizard now opens from here rather than from the dropdown itself —
    // once it saves successfully, saveOcrWizardConfig submits the job
    // automatically (see its autoSubmitAfterSave handling).
    openOcrConfigWizard(folder, { autoSubmitAfterSave: true });
    return;
  }

  await submitProcessingJob(ocrConfig);
});

async function submitProcessingJob(ocrConfig) {
  const folder = folderInput.value;
  const location = document.getElementById("upload-location-select").value;
  const confirmationEl = document.getElementById("submit-confirmation");

  runBtn.disabled = true;
  confirmationEl.classList.remove("hidden");
  confirmationEl.textContent = "Submitting…";

  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, location, ocr_config: ocrConfig }),
  });
  const data = await res.json();
  updateRunBtnState();

  if (data.error) {
    confirmationEl.textContent = "Error: " + data.error;
    return;
  }

  confirmationEl.textContent = data.queue_position > 0
    ? `Submitted — you're #${data.queue_position} in the queue below.`
    : "Submitted — starting shortly.";

  pollQueue(); // refresh immediately rather than waiting for the next tick
  loadUploadHistory();
}

// ==================== Upload tab: Location field ====================
const ADD_LOCATION_VALUE = "__add_new_location__";
let uploadLocationPreviousValue = "";

async function loadUploadLocationOptions() {
  const res = await fetch("/api/locations");
  const allLocations = await res.json();
  const select = document.getElementById("upload-location-select");
  const previousValue = select.value; // preserve the selection across refreshes if it's still valid

  select.innerHTML = "";
  const placeholderOpt = document.createElement("option");
  placeholderOpt.value = "";
  placeholderOpt.textContent = "Select a location…";
  placeholderOpt.disabled = true;
  select.appendChild(placeholderOpt);

  Object.keys(allLocations).sort().forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });

  const addOpt = document.createElement("option");
  addOpt.value = ADD_LOCATION_VALUE;
  addOpt.textContent = "+ Add new location";
  select.appendChild(addOpt);

  select.value = (previousValue && Object.prototype.hasOwnProperty.call(allLocations, previousValue))
    ? previousValue
    : "";
  uploadLocationPreviousValue = select.value;
  updateRunBtnState();
}

document.getElementById("upload-location-select").addEventListener("change", (e) => {
  if (e.target.value === ADD_LOCATION_VALUE) {
    openAddLocationModal();
    return;
  }
  uploadLocationPreviousValue = e.target.value;
  updateRunBtnState();
});

function openAddLocationModal() {
  document.getElementById("add-location-modal-name").value = "";
  document.getElementById("add-location-modal-lat").value = "";
  document.getElementById("add-location-modal-lon").value = "";
  document.getElementById("add-location-modal").classList.remove("hidden");
}

document.getElementById("add-location-modal-close-btn").addEventListener("click", () => {
  document.getElementById("add-location-modal").classList.add("hidden");
  // Revert — "+ Add new location" itself is never a valid selection.
  document.getElementById("upload-location-select").value = uploadLocationPreviousValue;
  updateRunBtnState();
});

document.getElementById("add-location-modal-save-btn").addEventListener("click", async () => {
  const name = document.getElementById("add-location-modal-name").value.trim();
  const lat = document.getElementById("add-location-modal-lat").value;
  const lon = document.getElementById("add-location-modal-lon").value;

  if (!name) {
    alert("Name is required.");
    return;
  }
  if (lat === "" || lon === "") {
    alert("Latitude and longitude are required.");
    return;
  }

  const res = await fetch("/api/locations/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_names: [], // brand new — nothing to reassign videos from
      target_name: name,
      lat: parseFloat(lat),
      lon: parseFloat(lon),
    }),
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }

  document.getElementById("add-location-modal").classList.add("hidden");
  await loadUploadLocationOptions();
  document.getElementById("upload-location-select").value = name;
  uploadLocationPreviousValue = name;
  updateRunBtnState();
});

// ==================== OCR Settings (dropdown + configuration wizard) ====================
const SKIP_OCR_VALUE = "__skip_ocr__"; // still used internally when OCR is globally disabled — see loadOcrDisabledState
const CONFIGURE_NEW_VALUE = "__configure_new__";
const OCR_WIZARD_MAX_DISPLAY_WIDTH = 640;

let ocrPreviousSelectValue = null;
let ocrGloballyDisabled = false; // mirrors the Settings tab's Disable OCR toggle — guards runBtn against opening the wizard when the dropdown is hidden

function applyOcrDisabledUI(disabled) {
  ocrGloballyDisabled = disabled;
  document.getElementById("upload-ocr-field-wrap").classList.toggle("hidden", disabled);

  const toggle = document.getElementById("ocr-disable-toggle");
  toggle.classList.toggle("active", disabled);
  toggle.setAttribute("aria-checked", disabled ? "true" : "false");

  document.getElementById("ocr-presets-subsection").classList.toggle("disabled", disabled);
}

document.getElementById("ocr-disable-toggle").addEventListener("click", async () => {
  const newValue = !ocrGloballyDisabled;
  const res = await fetch("/api/ocr-configs/disabled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disabled: newValue }),
  });
  const data = await res.json();
  applyOcrDisabledUI(data.disabled);
});

async function loadOcrConfigOptions() {
  const res = await fetch("/api/ocr-configs");
  const data = await res.json();
  const select = document.getElementById("ocr-config-select");
  select.innerHTML = "";

  data.configs.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });

  const newOpt = document.createElement("option");
  newOpt.value = CONFIGURE_NEW_VALUE;
  newOpt.textContent = "+ Configure new";
  select.appendChild(newOpt);

  if (data.configs.length === 0) {
    // No presets configured at all yet — default straight to Configure New
    // rather than leaving the dropdown on an option that doesn't exist.
    select.value = CONFIGURE_NEW_VALUE;
  } else if (data.last_used && data.configs.includes(data.last_used)) {
    select.value = data.last_used;
  } else {
    // Last-used preset was removed or never set, but presets DO exist —
    // fall back to whichever sorts first rather than Configure New, since
    // there's already something usable to select.
    select.value = data.configs[0];
  }
  ocrPreviousSelectValue = select.value;

  await applyOcrDisabledUI(data.disabled);
}

document.getElementById("ocr-config-select").addEventListener("change", (e) => {
  ocrPreviousSelectValue = e.target.value;
});

// ---- Wizard state ----
// step 1: draw a box around the WHOLE info bar, on the full first frame.
// steps 2-4: draw a box for Date/Time/Location (each skippable), on the
// bar-region crop from step 1. step 5: confirm + name the config.
// Every box is stored in ORIGINAL FULL-FRAME pixel coordinates once
// confirmed, regardless of which cropped/scaled view it was drawn on —
// that's the coordinate space bar_ocr.ocr_field() needs on the backend.
let ocrWizardState = null;
let ocrRectSelection = null; // current rectangle, in CANVAS pixel coordinates
let ocrFirstClickPoint = null; // set after the first click, cleared once the second click completes the box
let ocrWizardDisplayScale = 1;

// Move/resize interaction on an already-completed box.
let ocrDragMode = null; // null | "moving" | "resizing"
let ocrDragCorner = null; // which corner is being resized, and which opposite corner stays fixed
let ocrDragStartMouse = null; // mouse pos when the current move drag started
let ocrDragStartRect = null; // copy of ocrRectSelection when the current move drag started
let ocrDocumentMouseMoveHandler = null; // tracked so we can remove the previous step's listener before adding a new one
let ocrDocumentMouseUpHandler = null;

const OCR_CORNER_HIT_RADIUS = 8;

function hasCompleteBox() {
  return !!(ocrRectSelection && !ocrFirstClickPoint && !rectIsTooSmall(ocrRectSelection));
}

function hitTestCorner(pos, rect) {
  const corners = [
    { x: rect.left, y: rect.top, fixedX: rect.right, fixedY: rect.bottom, cursor: "nwse-resize" },
    { x: rect.right, y: rect.top, fixedX: rect.left, fixedY: rect.bottom, cursor: "nesw-resize" },
    { x: rect.left, y: rect.bottom, fixedX: rect.right, fixedY: rect.top, cursor: "nesw-resize" },
    { x: rect.right, y: rect.bottom, fixedX: rect.left, fixedY: rect.top, cursor: "nwse-resize" },
  ];
  return corners.find(c => Math.abs(pos.x - c.x) <= OCR_CORNER_HIT_RADIUS && Math.abs(pos.y - c.y) <= OCR_CORNER_HIT_RADIUS) || null;
}

function isInsideRect(pos, rect) {
  return pos.x >= rect.left && pos.x <= rect.right && pos.y >= rect.top && pos.y <= rect.bottom;
}

function openOcrConfigWizard(folder, options = {}) {
  ocrWizardState = {
    folder,
    step: 1,
    fullFrameImg: null,
    barBox: null,
    croppedCanvas: null,
    sampleFilename: null, // which file the sample frame actually came from (backend may skip corrupted files)
    sampleObjectUrl: null,
    autoSubmitAfterSave: !!options.autoSubmitAfterSave,
  };
  document.getElementById("ocr-wizard-modal").classList.remove("hidden");
  loadOcrWizardFrame();
}

function closeOcrWizard(restoreSelect) {
  document.getElementById("ocr-wizard-modal").classList.add("hidden");
  if (ocrWizardState && ocrWizardState.sampleObjectUrl) {
    URL.revokeObjectURL(ocrWizardState.sampleObjectUrl);
  }
  ocrWizardState = null;
  ocrRectSelection = null;
  ocrFirstClickPoint = null;
  ocrDragMode = null;
  ocrDragCorner = null;
  ocrDragStartMouse = null;
  ocrDragStartRect = null;
  if (ocrDocumentMouseMoveHandler) {
    document.removeEventListener("mousemove", ocrDocumentMouseMoveHandler);
    ocrDocumentMouseMoveHandler = null;
  }
  if (ocrDocumentMouseUpHandler) {
    document.removeEventListener("mouseup", ocrDocumentMouseUpHandler);
    ocrDocumentMouseUpHandler = null;
  }
  if (restoreSelect) {
    document.getElementById("ocr-config-select").value = ocrPreviousSelectValue;
  }
}

document.getElementById("ocr-wizard-close-btn").addEventListener("click", () => closeOcrWizard(true));
document.getElementById("ocr-wizard-modal").addEventListener("click", (e) => {
  if (e.target.id === "ocr-wizard-modal") closeOcrWizard(true); // clicking the dim backdrop cancels
});

async function loadOcrWizardFrame() {
  const state = ocrWizardState;
  try {
    const res = await fetch(`/api/ocr-wizard/first-frame?folder=${encodeURIComponent(state.folder)}&t=${Date.now()}`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      alert(errData.error || "Could not load a preview frame from this folder.");
      closeOcrWizard(true);
      return;
    }

    // Remember exactly which file the backend actually used (it tries each
    // file in the folder until one is genuinely readable, skipping any
    // corrupted ones) — the review step needs to OCR this SAME file, not
    // independently re-derive "the first file" and risk landing on a
    // different one.
    state.sampleFilename = res.headers.get("X-Sample-Filename");

    const blob = await res.blob();
    if (state.sampleObjectUrl) URL.revokeObjectURL(state.sampleObjectUrl);
    state.sampleObjectUrl = URL.createObjectURL(blob);

    const img = new Image();
    img.onload = () => {
      state.fullFrameImg = img;
      renderOcrWizardStep();
    };
    img.onerror = () => {
      alert("Could not load the preview frame image.");
      closeOcrWizard(true);
    };
    img.src = state.sampleObjectUrl;
  } catch (e) {
    alert("Could not load a preview frame from this folder — make sure it contains a readable photo or video file.");
    closeOcrWizard(true);
  }
}

function fitScale(naturalWidth, maxWidth) {
  return naturalWidth > maxWidth ? maxWidth / naturalWidth : 1;
}

function rectIsTooSmall(rect) {
  return (rect.right - rect.left) < 5 || (rect.bottom - rect.top) < 5;
}

function getRectCorners(rect) {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.left, y: rect.bottom },
    { x: rect.right, y: rect.bottom },
  ];
}

function canvasRectToImageRect(rect, scale) {
  return {
    left: Math.round(rect.left / scale),
    top: Math.round(rect.top / scale),
    right: Math.round(rect.right / scale),
    bottom: Math.round(rect.bottom / scale),
  };
}


function drawWizardImageOnCanvas(canvas, imgSource, existingBoxInImageCoords) {
  const naturalWidth = imgSource.naturalWidth || imgSource.width;
  const naturalHeight = imgSource.naturalHeight || imgSource.height;
  const scale = fitScale(naturalWidth, OCR_WIZARD_MAX_DISPLAY_WIDTH);
  ocrWizardDisplayScale = scale;

  canvas.width = naturalWidth * scale;
  canvas.height = naturalHeight * scale;

  ocrRectSelection = existingBoxInImageCoords ? {
    left: existingBoxInImageCoords.left * scale,
    top: existingBoxInImageCoords.top * scale,
    right: existingBoxInImageCoords.right * scale,
    bottom: existingBoxInImageCoords.bottom * scale,
  } : null;
  ocrFirstClickPoint = null; // a pending click from a previous step (e.g. left mid-selection via Skip/Back) must never carry over
  ocrDragMode = null;
  ocrDragCorner = null;
  ocrDragStartMouse = null;
  ocrDragStartRect = null;

  setupCanvasRectSelector(canvas, imgSource);
}

function setupCanvasRectSelector(canvas, backgroundSource) {
  const ctx = canvas.getContext("2d");

  function drawDot(x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#2563eb";
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1.5;
    ctx.stroke(); // white outline keeps the dot visible against any background color
  }

  function drawCornerDots() {
    // All four corners are always blue — the box's own outline and live
    // resizing already make clear which corner is currently being placed;
    // a separate cursor-tracking dot isn't needed.
    if (ocrRectSelection) {
      getRectCorners(ocrRectSelection).forEach(c => drawDot(c.x, c.y));
    }
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(backgroundSource, 0, 0, canvas.width, canvas.height);
    if (ocrRectSelection) {
      const { left, top, right, bottom } = ocrRectSelection;
      ctx.fillStyle = "rgba(37, 99, 235, 0.15)";
      ctx.fillRect(left, top, right - left, bottom - top);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2;
      ctx.strokeRect(left, top, right - left, bottom - top);
    }
    drawCornerDots();
  }

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * (canvas.width / rect.width))),
      y: Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * (canvas.height / rect.height))),
    };
  }

  function updateCursorStyle(pos) {
    if (ocrDragMode === "resizing") { canvas.style.cursor = ocrDragCorner ? ocrDragCorner.cursor : "crosshair"; return; }
    if (ocrDragMode === "moving") { canvas.style.cursor = "grabbing"; return; }
    if (ocrFirstClickPoint) { canvas.style.cursor = "crosshair"; return; } // actively placing the second corner
    if (hasCompleteBox()) {
      const corner = hitTestCorner(pos, ocrRectSelection);
      if (corner) { canvas.style.cursor = corner.cursor; return; }
      canvas.style.cursor = isInsideRect(pos, ocrRectSelection) ? "grab" : "default";
      return;
    }
    canvas.style.cursor = "crosshair"; // nothing drawn yet — ready for the first click
  }

  canvas.onmousedown = (e) => {
    const pos = getPos(e);

    if (hasCompleteBox()) {
      const corner = hitTestCorner(pos, ocrRectSelection);
      if (corner) {
        ocrDragMode = "resizing";
        ocrDragCorner = corner;
        updateCursorStyle(pos);
        return;
      }
      if (isInsideRect(pos, ocrRectSelection)) {
        ocrDragMode = "moving";
        ocrDragStartMouse = pos;
        ocrDragStartRect = { ...ocrRectSelection };
        updateCursorStyle(pos);
        return;
      }
      // Outside the existing box entirely — ignored; use Reset selection instead.
      return;
    }

    if (!ocrFirstClickPoint) {
      // First click: set one corner, start a zero-size box that will
      // live-preview against the cursor on mousemove until the second click.
      ocrFirstClickPoint = pos;
      ocrRectSelection = { left: pos.x, top: pos.y, right: pos.x, bottom: pos.y };
    } else {
      // Second click: finalize the box using the first corner + this click.
      ocrRectSelection = {
        left: Math.min(ocrFirstClickPoint.x, pos.x),
        top: Math.min(ocrFirstClickPoint.y, pos.y),
        right: Math.max(ocrFirstClickPoint.x, pos.x),
        bottom: Math.max(ocrFirstClickPoint.y, pos.y),
      };
      ocrFirstClickPoint = null;
    }

    redraw();
    updateOcrMagnifier(canvas, pos, e.clientX, e.clientY);
    updateOcrWizardNextEnabled();
    updateCursorStyle(pos);
  };
  canvas.onmousemove = (e) => {
    const pos = getPos(e);
    // The magnifier and cursor icon only make sense while genuinely
    // hovering the canvas — live tracking during an active interaction
    // (second-corner placement, moving, resizing) is handled by the
    // document-level listener below instead, so it keeps working smoothly
    // even once the cursor drifts outside the canvas.
    updateOcrMagnifier(canvas, pos, e.clientX, e.clientY);
    if (!ocrFirstClickPoint && !ocrDragMode) updateCursorStyle(pos);
  };
  canvas.onmouseleave = () => {
    hideOcrMagnifier();
  };

  // Document-level tracking, active only during an in-progress interaction
  // (placing the second corner, or dragging to move/resize a completed
  // box) — keeps things reaching as close as possible to the cursor even
  // if it briefly moves off the canvas/image during a fast movement.
  // Deliberately NOT applied while placing the FIRST corner or just
  // hovering with nothing pinned yet.
  if (ocrDocumentMouseMoveHandler) document.removeEventListener("mousemove", ocrDocumentMouseMoveHandler);
  ocrDocumentMouseMoveHandler = (e) => {
    const pos = getPos(e);
    if (ocrFirstClickPoint) {
      ocrRectSelection = {
        left: Math.min(ocrFirstClickPoint.x, pos.x),
        top: Math.min(ocrFirstClickPoint.y, pos.y),
        right: Math.max(ocrFirstClickPoint.x, pos.x),
        bottom: Math.max(ocrFirstClickPoint.y, pos.y),
      };
      redraw();
    } else if (ocrDragMode === "resizing" && ocrDragCorner) {
      ocrRectSelection = {
        left: Math.min(pos.x, ocrDragCorner.fixedX),
        top: Math.min(pos.y, ocrDragCorner.fixedY),
        right: Math.max(pos.x, ocrDragCorner.fixedX),
        bottom: Math.max(pos.y, ocrDragCorner.fixedY),
      };
      redraw();
    } else if (ocrDragMode === "moving" && ocrDragStartRect && ocrDragStartMouse) {
      const width = ocrDragStartRect.right - ocrDragStartRect.left;
      const height = ocrDragStartRect.bottom - ocrDragStartRect.top;
      let newLeft = ocrDragStartRect.left + (pos.x - ocrDragStartMouse.x);
      let newTop = ocrDragStartRect.top + (pos.y - ocrDragStartMouse.y);
      newLeft = Math.max(0, Math.min(canvas.width - width, newLeft));
      newTop = Math.max(0, Math.min(canvas.height - height, newTop));
      ocrRectSelection = { left: newLeft, top: newTop, right: newLeft + width, bottom: newTop + height };
      redraw();
    }
  };
  document.addEventListener("mousemove", ocrDocumentMouseMoveHandler);

  if (ocrDocumentMouseUpHandler) document.removeEventListener("mouseup", ocrDocumentMouseUpHandler);
  ocrDocumentMouseUpHandler = (e) => {
    if (ocrDragMode) {
      ocrDragMode = null;
      ocrDragCorner = null;
      ocrDragStartMouse = null;
      ocrDragStartRect = null;
      updateOcrWizardNextEnabled();
      updateCursorStyle(getPos(e));
    }
  };
  document.addEventListener("mouseup", ocrDocumentMouseUpHandler);

  redraw();
  canvas.style.cursor = hasCompleteBox() ? "grab" : "crosshair";
}

/**
 * Floating zoomed-in view of the pixels around the cursor, shown while
 * drawing crop boxes — small text (a two-digit temperature reading, a
 * short location name) is easy to click a pixel or two off on a small
 * canvas, and that's exactly the class of mistake this whole feature exists
 * to prevent. Draws FROM the already-rendered main canvas (not the raw
 * source image), so the magnifier also shows the in-progress selection
 * rectangle, zoomed in — precise feedback on exactly where an edge lands.
 */
const OCR_MAGNIFIER_ZOOM = 4;
let ocrMagnifierEnabled = true;

document.getElementById("ocr-wizard-magnifier-toggle").addEventListener("change", (e) => {
  ocrMagnifierEnabled = e.target.checked;
  if (!ocrMagnifierEnabled) hideOcrMagnifier();
});

document.getElementById("ocr-wizard-reset-btn").addEventListener("click", () => {
  const state = ocrWizardState;
  if (!state) return;
  // Only step 1 (the bar region) has a canvas selection to reset now.
  if (state.step === 1) state.barBox = null;
  renderOcrWizardStep();
});

function updateOcrMagnifier(canvas, pos, clientX, clientY) {
  if (!ocrMagnifierEnabled) return;
  const magCanvas = document.getElementById("ocr-wizard-magnifier");
  const wrapEl = document.getElementById("ocr-wizard-canvas-wrap");
  if (!magCanvas || !wrapEl) return;

  // ---- draw the zoomed content ----
  const magCtx = magCanvas.getContext("2d");
  const sourceSize = magCanvas.width / OCR_MAGNIFIER_ZOOM;
  const sourceX = Math.max(0, Math.min(canvas.width - sourceSize, pos.x - sourceSize / 2));
  const sourceY = Math.max(0, Math.min(canvas.height - sourceSize, pos.y - sourceSize / 2));

  magCtx.imageSmoothingEnabled = false; // keep zoomed pixels crisp/blocky, not blurred — easier to see exact edges
  magCtx.clearRect(0, 0, magCanvas.width, magCanvas.height);
  magCtx.drawImage(canvas, sourceX, sourceY, sourceSize, sourceSize, 0, 0, magCanvas.width, magCanvas.height);

  // crosshair marking the exact cursor position within the zoomed view
  magCtx.strokeStyle = "#dc2626";
  magCtx.lineWidth = 1;
  const cx = magCanvas.width / 2, cy = magCanvas.height / 2;
  magCtx.beginPath();
  magCtx.moveTo(cx - 8, cy); magCtx.lineTo(cx + 8, cy);
  magCtx.moveTo(cx, cy - 8); magCtx.lineTo(cx, cy + 8);
  magCtx.stroke();

  // ---- follow the cursor, offset up-and-right so the cursor/hand doesn't
  // block the view of what's being magnified, clamped so it never renders
  // outside the wrap's own bounds at an edge ----
  const wrapRect = wrapEl.getBoundingClientRect();
  const OFFSET = 20;
  let left = clientX - wrapRect.left + OFFSET;
  let top = clientY - wrapRect.top - magCanvas.offsetHeight - OFFSET;
  left = Math.max(0, Math.min(wrapEl.clientWidth - magCanvas.offsetWidth, left));
  top = Math.max(0, Math.min(wrapEl.clientHeight - magCanvas.offsetHeight, top));
  magCanvas.style.left = `${left}px`;
  magCanvas.style.top = `${top}px`;

  magCanvas.classList.add("visible");
}

function hideOcrMagnifier() {
  const magCanvas = document.getElementById("ocr-wizard-magnifier");
  if (magCanvas) magCanvas.classList.remove("visible");
}

function updateOcrWizardNextEnabled() {
  const nextBtn = document.getElementById("ocr-wizard-next-btn");
  const resetBtn = document.getElementById("ocr-wizard-reset-btn");
  const state = ocrWizardState;
  if (!state) return;
  if (state.step === 1) {
    nextBtn.disabled = !ocrRectSelection || rectIsTooSmall(ocrRectSelection);
    resetBtn.disabled = !hasCompleteBox();
  } else {
    nextBtn.disabled = false;
    resetBtn.disabled = true; // the review step has no canvas selection to reset
  }
}

function renderOcrWizardStep() {
  const state = ocrWizardState;
  const canvas = document.getElementById("ocr-wizard-canvas");
  const title = document.getElementById("ocr-wizard-title");
  const instructions = document.getElementById("ocr-wizard-instructions");
  const backBtn = document.getElementById("ocr-wizard-back-btn");
  const nextBtn = document.getElementById("ocr-wizard-next-btn");
  const confirmStep = document.getElementById("ocr-wizard-confirm-step");
  const canvasWrap = document.getElementById("ocr-wizard-canvas-wrap");
  const toolbar = document.querySelector(".ocr-wizard-toolbar");

  nextBtn.textContent = "Next →";
  confirmStep.classList.add("hidden");
  canvasWrap.classList.remove("hidden");
  if (toolbar) toolbar.classList.remove("hidden");

  if (state.step === 1) {
    title.textContent = "Configure OCR — Step 1 of 2";
    instructions.textContent = "Click one corner of the ENTIRE information bar (date, time, location, etc. all together), then click the opposite corner.";
    backBtn.textContent = "Cancel";
    drawWizardImageOnCanvas(canvas, state.fullFrameImg, state.barBox);
  } else if (state.step === 2) {
    title.textContent = "Configure OCR — Step 2 of 2";
    instructions.textContent = "Review what this region actually reads, then name and save this configuration.";
    backBtn.textContent = "← Back";
    nextBtn.textContent = "Save";
    canvasWrap.classList.add("hidden");
    if (toolbar) toolbar.classList.add("hidden"); // no drawing tools needed on the review step
    confirmStep.classList.remove("hidden");
    renderOcrWizardReview();
  }

  updateOcrWizardNextEnabled();
}

function buildCroppedCanvasForBarRegion(state) {
  const box = state.barBox;
  const cropped = document.createElement("canvas");
  cropped.width = Math.max(1, box.right - box.left);
  cropped.height = Math.max(1, box.bottom - box.top);
  const ctx = cropped.getContext("2d");
  ctx.drawImage(
    state.fullFrameImg,
    box.left, box.top, box.right - box.left, box.bottom - box.top,
    0, 0, cropped.width, cropped.height
  );
  state.croppedCanvas = cropped;
}

async function renderOcrWizardReview() {
  const container = document.getElementById("ocr-wizard-previews");
  container.innerHTML = "";
  const state = ocrWizardState;

  // The bar-region crop itself, shown for visual reference alongside the readings.
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = state.croppedCanvas.width;
  cropCanvas.height = state.croppedCanvas.height;
  cropCanvas.className = "ocr-wizard-preview-canvas";
  cropCanvas.getContext("2d").drawImage(state.croppedCanvas, 0, 0);
  container.appendChild(cropCanvas);

  const readingEls = {};
  ["Date", "Time", "Temperature"].forEach(label => {
    const row = document.createElement("div");
    row.className = "ocr-wizard-preview-row";

    const labelEl = document.createElement("span");
    labelEl.className = "ocr-wizard-preview-label";
    labelEl.textContent = label + ":";
    row.appendChild(labelEl);

    const reading = document.createElement("span");
    reading.className = "ocr-wizard-preview-reading muted";
    reading.textContent = "Reading…";
    row.appendChild(reading);
    readingEls[label] = reading;

    container.appendChild(row);
  });

  document.getElementById("ocr-wizard-config-name").value = "";

  const toArray = (b) => b ? [b.left, b.top, b.right, b.bottom] : null;
  try {
    const res = await fetch("/api/ocr-wizard/preview-readings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder: state.folder,
        filename: state.sampleFilename,
        bar_box: toArray(state.barBox),
      }),
    });
    const data = await res.json();
    if (data.error) {
      Object.values(readingEls).forEach(el => { el.textContent = "Couldn't read: " + data.error; });
      return;
    }
    const setReading = (label, value) => {
      const el = readingEls[label];
      if (!el) return;
      el.textContent = value ? `Reads: "${value}"` : "Not found in this reading";
      el.classList.remove("muted");
      el.classList.toggle("ocr-wizard-reading-blank", !value);
    };
    setReading("Date", data.date);
    setReading("Time", data.time);
    setReading("Temperature", data.temperature);
  } catch (e) {
    Object.values(readingEls).forEach(el => { el.textContent = "Couldn't fetch OCR reading"; });
  }
}

document.getElementById("ocr-wizard-back-btn").addEventListener("click", () => {
  const state = ocrWizardState;
  if (!state) return;
  if (state.step === 1) {
    closeOcrWizard(true);
    return;
  }
  state.step -= 1;
  renderOcrWizardStep();
});

document.getElementById("ocr-wizard-next-btn").addEventListener("click", async () => {
  const state = ocrWizardState;
  if (!state) return;

  if (state.step === 1) {
    state.barBox = canvasRectToImageRect(ocrRectSelection, ocrWizardDisplayScale);
    buildCroppedCanvasForBarRegion(state);
    state.step += 1;
    renderOcrWizardStep();
    return;
  }

  if (state.step === 2) {
    await saveOcrWizardConfig();
  }
});

async function saveOcrWizardConfig() {
  const name = document.getElementById("ocr-wizard-config-name").value.trim();
  if (!name) {
    alert("Please give this configuration a name.");
    return;
  }
  const state = ocrWizardState;
  const autoSubmit = state.autoSubmitAfterSave;
  const toArray = (box) => box ? [box.left, box.top, box.right, box.bottom] : null;

  const res = await fetch("/api/ocr-configs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      bar_box: toArray(state.barBox),
      // The sample frame's actual size — lets the backend scale this box
      // correctly for any other video in a batch whose resolution differs.
      ref_width: state.fullFrameImg.naturalWidth,
      ref_height: state.fullFrameImg.naturalHeight,
    }),
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }

  closeOcrWizard(false);
  await loadOcrConfigOptions();
  document.getElementById("ocr-config-select").value = name;
  ocrPreviousSelectValue = name;

  if (autoSubmit) {
    await submitProcessingJob(name);
  }
}

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

// ---- Review tab ----
// One-at-a-time review queue: unreviewed videos (still on the AI's original
// guess), excluding hidden groups. The queue is a snapshot taken when the
// tab is opened — it doesn't shrink live as you confirm things, so
// Previous/Next stay stable mid-session; re-entering the tab (or reaching
// the end) re-fetches fresh to pick up anything newly uploaded or already
// reviewed elsewhere.
let reviewQueue = [];
let reviewIndex = 0;

async function loadReviewQueue() {
  const res = await fetch("/api/videos");
  const vids = await res.json();
  reviewQueue = vids.filter(v => v.marked_for_review && !hiddenGroups.includes(v.display_species));
  reviewIndex = 0;
  renderReviewCard();
}

function renderReviewCard() {
  const empty = document.getElementById("review-empty");
  const content = document.getElementById("review-content");
  const progress = document.getElementById("review-progress");
  const progressCard = document.getElementById("review-progress-card");

  if (reviewQueue.length === 0) {
    empty.classList.remove("hidden");
    content.classList.add("hidden");
    progress.textContent = "";
    // Hide the whole card, not just its text — clearing the text alone
    // left an empty bordered box sitting on the page.
    progressCard.classList.add("hidden");
    return;
  }

  empty.classList.add("hidden");
  content.classList.remove("hidden");
  progressCard.classList.remove("hidden");

  const v = reviewQueue[reviewIndex];
  progress.textContent = `Reviewing ${reviewIndex + 1} of ${reviewQueue.length}`;

  const player = document.getElementById("review-video-player");
  const photoPlayer = document.getElementById("review-photo-player");
  if (v.media_type === "photo") {
    photoPlayer.src = `/media/${v.id}`;
    photoPlayer.classList.remove("hidden");
    player.classList.add("hidden");
    player.pause();
    player.removeAttribute("src");
  } else {
    player.src = `/media/${v.id}`;
    player.classList.remove("hidden");
    photoPlayer.classList.add("hidden");
    photoPlayer.removeAttribute("src");
    player.play().catch(() => {}); // browser may block autoplay — not an error, just ignore
  }

  const cropImg = document.getElementById("review-bar-crop-img");
  if (v.has_bar_crop) {
    cropImg.src = `/api/videos/${v.id}/bar-crop`;
    cropImg.classList.remove("hidden");
  } else {
    cropImg.classList.add("hidden");
  }

  updateReviewSpeciesDisplay();

  document.getElementById("review-field-date").value = v.date || "";
  document.getElementById("review-field-time").value = v.time || "";
  document.getElementById("review-field-location").value = v.location || "";
  document.getElementById("review-field-diel_period").value = v.diel_period || "";
  document.getElementById("review-field-temperature").value = formatTemperatureForDisplay(v.temperature, temperatureDisplayUnit);
  document.getElementById("review-field-count").value = v.count ?? 1;
  document.getElementById("review-field-filename").value = stripExtension(v.display_filename || v.filename);
  document.getElementById("review-field-notes").value = v.notes || "";

  document.getElementById("review-prev-btn").disabled = reviewIndex === 0;
}

function updateReviewSpeciesDisplay() {
  const v = reviewQueue[reviewIndex];
  if (!v) return;
  const display = document.getElementById("review-species-display");
  display.textContent = v.display_species;
  display.classList.toggle("confirmed", !!v.corrected_species);
}

document.getElementById("review-confirm-species-btn").addEventListener("click", async () => {
  const v = reviewQueue[reviewIndex];
  if (!v) return;
  const data = await saveCorrection(v.id, v.ai_species || "blank");
  if (data.error) {
    alert(data.error);
    return;
  }
  Object.assign(v, data);
  updateReviewSpeciesDisplay();
});

document.getElementById("review-edit-species-btn").addEventListener("click", () => {
  const v = reviewQueue[reviewIndex];
  if (v) openSpeciesModal(v.id, "review");
});

async function saveCurrentReviewFields() {
  if (reviewQueue.length === 0 || reviewIndex >= reviewQueue.length) return;
  const v = reviewQueue[reviewIndex];

  const payload = {
    date: document.getElementById("review-field-date").value.trim(),
    time: document.getElementById("review-field-time").value.trim(),
    location: document.getElementById("review-field-location").value.trim(),
    diel_period: document.getElementById("review-field-diel_period").value.trim(),
    count: document.getElementById("review-field-count").value,
    notes: document.getElementById("review-field-notes").value,
    display_filename: document.getElementById("review-field-filename").value.trim(),
  };

  // Same "tag with the currently-displayed unit" treatment as the
  // Spreadsheet tab, so a plain typed number is interpreted correctly.
  const tempRaw = document.getElementById("review-field-temperature").value.trim();
  if (tempRaw !== "") {
    const num = parseFloat(tempRaw);
    payload.temperature = isNaN(num) ? tempRaw : `${num}°${temperatureDisplayUnit}`;
  } else {
    payload.temperature = "";
  }

  const res = await fetch(`/api/videos/${v.id}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.error) Object.assign(v, data);
}

async function reviewAdvance(delta) {
  await saveCurrentReviewFields();

  const content = document.getElementById("review-content");
  const noOp = delta < 0 && reviewIndex === 0; // Previous at the very start — nothing to animate
  if (!noOp) {
    content.classList.add(delta > 0 ? "review-swipe-exit-left" : "review-swipe-exit-right");
    await new Promise(r => setTimeout(r, 180)); // matches the CSS transition duration below
  }

  reviewIndex += delta;

  if (reviewIndex < 0) {
    reviewIndex = 0;
    renderReviewCard();
    content.classList.remove("review-swipe-exit-left", "review-swipe-exit-right");
    return;
  }
  if (reviewIndex >= reviewQueue.length) {
    await loadReviewQueue(); // reached the end — refetch for anything new
    content.classList.remove("review-swipe-exit-left", "review-swipe-exit-right");
    return;
  }

  renderReviewCard();

  // Position the new card off-screen on the side it should enter from,
  // instantly (transition disabled), then remove that offset so the normal
  // transition animates it back to center — the standard trick for a
  // directional re-entry without a JS animation library.
  content.classList.remove("review-swipe-exit-left", "review-swipe-exit-right");
  content.classList.add("review-swipe-instant", delta > 0 ? "review-swipe-exit-right" : "review-swipe-exit-left");
  void content.offsetWidth; // force a reflow so the instant position is actually applied first
  content.classList.remove("review-swipe-instant", "review-swipe-exit-left", "review-swipe-exit-right");
}

document.getElementById("review-next-btn").addEventListener("click", () => reviewAdvance(1));
document.getElementById("review-prev-btn").addEventListener("click", () => reviewAdvance(-1));

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (!document.getElementById("tab-review").classList.contains("active")) return;
  if (!document.getElementById("species-modal").classList.contains("hidden")) return; // let the species search modal use Enter normally
  e.preventDefault();
  reviewAdvance(1);
});

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
    if (v.marked_for_review && !hiddenGroups.includes(v.display_species)) {
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
  libraryCardOrder = null; // leaving the category — next time it's entered, sort fresh
  collapseCardInfoPanel("lib-grid", false); // close any expanded card without the "just closed" treatment (this isn't a user-initiated close)
  document.getElementById("lib-detail-view").classList.add("hidden");
  document.getElementById("lib-groups-view").classList.remove("hidden");
  renderLibraryGroupCards();
}

function renderLibraryGroupCards() {
  const container = document.getElementById("lib-group-cards");
  const empty = document.getElementById("lib-groups-empty");
  container.innerHTML = "";

  const visibleSpecies = speciesWithClips.filter(s => !hiddenGroups.includes(s.label));

  if (visibleSpecies.length === 0) {
    empty.classList.remove("hidden");
    empty.textContent = speciesWithClips.length > 0
      ? "All groups are hidden — check the Settings tab to unhide some."
      : "No videos processed yet.";
    return;
  }
  empty.classList.add("hidden");

  const sorted = [...visibleSpecies].sort((a, b) => {
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

// ---- Settings tab ----
function loadSettingsTab() {
  document.getElementById("hidden-groups-input").value = "";
  document.getElementById("hidden-groups-autofill").classList.add("hidden");
  renderHiddenGroupsList();
  renderOcrPresetsList();
  updateSettingsTempUnitButtons();
  resetClearAllMarksBtn();

  // Clear any leftover CSV-import result note (and a pending overwrite
  // confirmation) from a previous visit. Done here rather than in
  // loadLocationsSection, which also runs as a mid-flow refresh right
  // after an import — clearing there would wipe the note the moment it
  // was shown.
  const importResult = document.getElementById("locations-import-result");
  importResult.textContent = "";
  importResult.classList.add("hidden");
  importResult.classList.remove("error");
  document.getElementById("locations-import-confirm").classList.add("hidden");
  pendingImportRows = null;
  pendingImportSkipped = [];

  loadLocationsSection();
}

let clearAllMarksTimeout = null;

function resetClearAllMarksBtn() {
  clearTimeout(clearAllMarksTimeout);
  const btn = document.getElementById("clear-all-marks-btn");
  btn.classList.remove("confirming");
  btn.textContent = "Clear all marked for review";
}

document.getElementById("clear-all-marks-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (!btn.classList.contains("confirming")) {
    // First click: light warning, not an action yet — a second click
    // within a few seconds is required to actually confirm.
    btn.classList.add("confirming");
    btn.textContent = "Click again to confirm";
    clearAllMarksTimeout = setTimeout(() => resetClearAllMarksBtn(), 4000);
    return;
  }

  resetClearAllMarksBtn();
  btn.disabled = true;
  const res = await fetch("/api/videos/clear-all-marks", { method: "POST" });
  const data = await res.json();
  btn.disabled = false;
  if (data.error) { alert(data.error); return; }
  await refreshSpeciesData(); // badge counts reflect the clear immediately
});

const hiddenGroupsInput = document.getElementById("hidden-groups-input");

hiddenGroupsInput.addEventListener("input", () => {
  renderHiddenGroupsAutofill(hiddenGroupsInput.value);
});

hiddenGroupsInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const typed = hiddenGroupsInput.value.trim();
  if (!typed) return;
  // Only adds on an actual match — this is a validated "hide this known
  // group" action, not a free-text tag creator.
  const match = speciesWithClips.find(s => s.label.toLowerCase() === typed.toLowerCase());
  if (match) addHiddenGroup(match.label);
});

function renderHiddenGroupsAutofill(query) {
  const dropdown = document.getElementById("hidden-groups-autofill");
  const q = query.trim().toLowerCase();
  dropdown.innerHTML = "";

  if (!q) {
    dropdown.classList.add("hidden");
    return;
  }

  const matches = speciesWithClips
    .filter(s => s.label.toLowerCase().includes(q) && !hiddenGroups.includes(s.label))
    .slice(0, 8);

  if (matches.length === 0) {
    dropdown.classList.add("hidden");
    return;
  }

  matches.forEach(s => {
    const item = document.createElement("div");
    item.className = "autofill-item";
    item.textContent = s.label;
    // mousedown (not click) fires before the input's blur, so the click
    // registers before anything closes the dropdown out from under it.
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      addHiddenGroup(s.label);
    });
    dropdown.appendChild(item);
  });
  dropdown.classList.remove("hidden");
}

function addHiddenGroup(label) {
  if (!hiddenGroups.includes(label)) {
    hiddenGroups.push(label);
    localStorage.setItem("hiddenGroups", JSON.stringify(hiddenGroups));
  }
  hiddenGroupsInput.value = "";
  document.getElementById("hidden-groups-autofill").classList.add("hidden");
  renderHiddenGroupsList();
  // refreshSpeciesData recomputes the unreviewed-count badge excluding the
  // newly-hidden group, then renders the group cards with it applied.
  refreshSpeciesData().then(renderLibraryGroupCards);
}

function removeHiddenGroup(label) {
  hiddenGroups = hiddenGroups.filter(g => g !== label);
  localStorage.setItem("hiddenGroups", JSON.stringify(hiddenGroups));
  renderHiddenGroupsList();
  refreshSpeciesData().then(renderLibraryGroupCards);
}

function renderHiddenGroupsList() {
  const container = document.getElementById("hidden-groups-list");
  container.innerHTML = "";

  if (hiddenGroups.length === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "muted";
    emptyMsg.textContent = "No hidden groups.";
    container.appendChild(emptyMsg);
    return;
  }

  hiddenGroups.forEach(label => {
    const chip = document.createElement("span");
    chip.className = "hidden-group-chip";
    chip.textContent = label;

    const removeBtn = document.createElement("button");
    removeBtn.className = "hidden-group-remove";
    removeBtn.textContent = "✕";
    removeBtn.title = `Unhide ${label}`;
    removeBtn.addEventListener("click", () => removeHiddenGroup(label));
    chip.appendChild(removeBtn);

    container.appendChild(chip);
  });
}

// ---- OCR presets management (Library Settings) ----
async function renderOcrPresetsList() {
  const container = document.getElementById("ocr-presets-list");
  container.innerHTML = "";

  const res = await fetch("/api/ocr-configs");
  const data = await res.json();
  applyOcrDisabledUI(data.disabled);

  if (data.configs.length === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "muted";
    emptyMsg.textContent = "No saved OCR presets yet.";
    container.appendChild(emptyMsg);
    return;
  }

  data.configs.forEach(name => {
    const row = document.createElement("div");
    row.className = "ocr-preset-row";

    const label = document.createElement("span");
    label.className = "ocr-preset-name";
    label.textContent = name;
    row.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.className = "ocr-preset-remove-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      const ok = confirm(`Remove the OCR preset "${name}"? This can't be undone.`);
      if (!ok) return;
      const delRes = await fetch(`/api/ocr-configs/${encodeURIComponent(name)}`, { method: "DELETE" });
      const delData = await delRes.json();
      if (delData.error) {
        alert(delData.error);
        return;
      }
      renderOcrPresetsList();
      loadOcrConfigOptions(); // refresh the Upload tab dropdown too — it may have had this preset selected
    });
    row.appendChild(removeBtn);

    container.appendChild(row);
  });
}

// ---- Temperature unit (Library Settings) ----
// Shares the exact same state/localStorage key as the Spreadsheet tab's
// clickable "Temperature (F/C)" header — either control changes it, both
// stay in sync.
function setTemperatureUnit(unit) {
  temperatureDisplayUnit = unit;
  localStorage.setItem("temperatureDisplayUnit", unit);
  document.getElementById("temp-unit-label").textContent = unit;
  updateSettingsTempUnitButtons();
  applySpreadsheetView(); // re-render immediately if the Spreadsheet is already loaded
}

function updateSettingsTempUnitButtons() {
  document.getElementById("settings-temp-f-btn").classList.toggle("active", temperatureDisplayUnit === "F");
  document.getElementById("settings-temp-c-btn").classList.toggle("active", temperatureDisplayUnit === "C");
}

document.getElementById("settings-temp-f-btn").addEventListener("click", () => setTemperatureUnit("F"));
document.getElementById("settings-temp-c-btn").addEventListener("click", () => setTemperatureUnit("C"));

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
let libraryCardOrder = null; // frozen video-ID order for the CURRENT category-viewing session; null means "sort fresh"

// ---- Targeted single-card updates (avoids rebuilding the whole grid for a
// one-video change like favoriting or correcting a species) ----
function syncExpandedPanelReviewState(gridId, videoId, markedForReview) {
  // The notes panel is a separate DOM structure from the card, managed by
  // expandCardInfoPanel's own closure — a handler elsewhere (like
  // correcting a species) that changes marked_for_review has no direct
  // access to that closure's button, so it re-derives the button's state
  // fresh here instead, but only if this video is the one currently open.
  if (expandedCardByGrid[gridId] !== videoId) return;
  const panel = document.getElementById(gridId)?.querySelector(".card-info-panel");
  const reviewBtn = panel && panel.querySelector(".card-info-review-btn");
  if (!reviewBtn) return;
  reviewBtn.textContent = markedForReview ? "Marked for review" : "Mark for review";
  reviewBtn.classList.toggle("active", !!markedForReview);
}

function findLibraryCardEl(gridId, videoId) {
  const grid = document.getElementById(gridId);
  return grid.querySelector(`.video-card[data-video-id="${videoId}"]`);
}

function removeLibraryCard(gridId, videoId) {
  const cardEl = findLibraryCardEl(gridId, videoId);
  if (!cardEl) return;
  const wrapper = cardEl.closest(".expanded-row-wrapper");
  (wrapper || cardEl).remove();
  if (expandedCardByGrid[gridId] === videoId) {
    expandedCardByGrid[gridId] = null;
  }
  const grid = document.getElementById(gridId);
  const emptyId = gridId === "lib-grid" ? "lib-empty" : "fav-empty";
  if (!grid.querySelector(".video-card")) {
    document.getElementById(emptyId).classList.remove("hidden");
  }
}

function patchLibraryCardSpecies(gridId, videoId, newDisplaySpecies) {
  const cardEl = findLibraryCardEl(gridId, videoId);
  if (!cardEl) return;

  const badge = cardEl.querySelector(".species-badge");
  badge.textContent = newDisplaySpecies;
  badge.classList.toggle("blank", newDisplaySpecies === "blank");
  cardEl.querySelector(".verified-info").classList.remove("hidden");

  const select = cardEl.querySelector(".correction-select");
  if (select) select.value = newDisplaySpecies;
}

async function loadLibrary(preserveOrder = false) {
  const species = libraryActiveSpecies;
  const url = "/api/videos" + (species ? `?species=${encodeURIComponent(species)}` : "");
  const res = await fetch(url);
  const vids = await res.json();

  if (preserveOrder && libraryCardOrder) {
    // Keep the order from when this category was first opened — reviewing
    // or marking an entry mid-session shouldn't reshuffle the grid out from
    // under the user. Only leaving the category (or the tab) resets this.
    const orderIndex = new Map(libraryCardOrder.map((id, i) => [id, i]));
    vids.sort((a, b) => {
      const aIdx = orderIndex.has(a.id) ? orderIndex.get(a.id) : Infinity;
      const bIdx = orderIndex.has(b.id) ? orderIndex.get(b.id) : Infinity;
      return aIdx - bIdx;
    });
  } else {
    vids.sort((a, b) => {
      const aUnreviewed = !!a.marked_for_review;
      const bUnreviewed = !!b.marked_for_review;
      if (aUnreviewed === bUnreviewed) return 0; // stable sort preserves existing order within each group
      return aUnreviewed ? -1 : 1; // marked-for-review entries surface first
    });
    libraryCardOrder = vids.map(v => v.id); // freeze this order for the rest of the session
  }

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

let expandedCardByGrid = { "lib-grid": null, "fav-grid": null };

// Only one video across the whole Library/Favorites grid plays at a time —
// starting any one of them (native controls OR the notes-button's
// autoplay) pauses whichever other one was playing, so you never get
// overlapping audio from multiple cards.
let currentlyPlayingVideo = null;

function handleGridVideoPlay(e) {
  const videoEl = e.target;
  if (currentlyPlayingVideo && currentlyPlayingVideo !== videoEl) {
    currentlyPlayingVideo.pause();
  }
  currentlyPlayingVideo = videoEl;
}

function playExclusively(videoEl) {
  videoEl.play().catch(() => {}); // browser may block autoplay — not an error, just ignore
}

function toggleVideoPlayPauseOnClick(e) {
  const videoEl = e.currentTarget;
  if (videoEl.paused) {
    playExclusively(videoEl);
  } else {
    videoEl.pause();
  }
}

function scrollCardNearTop(cardEl, gridEl) {
  // Leaves a small gap above the card instead of jamming it flush against
  // the viewport's very top edge — matches the grid's own row gap so it
  // reads as "one card-spacing" rather than an arbitrary offset.
  const gapPx = parseFloat(getComputedStyle(gridEl).rowGap) || 16;
  const targetY = window.scrollY + cardEl.getBoundingClientRect().top - gapPx;
  window.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
}

function toggleCardInfoPanel(videoId, gridId, cardEl, v) {
  const currentlyExpanded = expandedCardByGrid[gridId];

  if (currentlyExpanded === videoId) {
    // Re-clicking the currently-expanded card's own button — a genuine
    // close, same treatment as the X button.
    collapseCardInfoPanel(gridId, true);
    return;
  }

  // Switching to a different card — collapse the previous one WITHOUT the
  // "just closed" treatment. The user's intent here is to see the NEW
  // card, not be shown where the old one went.
  collapseCardInfoPanel(gridId, false);

  expandedCardByGrid[gridId] = videoId;
  const wrapper = expandCardInfoPanel(videoId, gridId, cardEl, v);
  wrapper.scrollIntoView({ behavior: "smooth", block: "center" });

  // Autoplay only happens here (the genuine click path) — expandCardInfoPanel
  // is ALSO called when a background re-render re-applies a persisted
  // expansion (see renderGrid), where restarting the video from the
  // beginning would be an annoying side effect rather than a user action.
  if (v.media_type !== "photo") {
    const videoEl = cardEl.querySelector("video");
    if (videoEl) playExclusively(videoEl);
  }
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
    videoEl.addEventListener("play", handleGridVideoPlay);
    const photoEl = card.querySelector(".card-photo");
    const thumbWrap = card.querySelector(".card-video-thumb-wrap");
    const thumbImg = card.querySelector(".card-video-thumb");
    if (v.media_type === "photo") {
      photoEl.src = "/media/" + v.id;
      photoEl.classList.remove("hidden");
      videoEl.classList.add("hidden");
      thumbWrap.classList.add("hidden");
    } else if (v.has_thumbnail) {
      // Video with an extracted thumbnail — show that instead of the real
      // <video>, which only loads once the card is expanded (see
      // expandCardInfoPanel/collapseCardInfoPanel).
      thumbImg.src = "/api/videos/" + v.id + "/thumbnail";
      thumbWrap.classList.remove("hidden");
      photoEl.classList.add("hidden");
      videoEl.classList.add("hidden");
    } else {
      // No thumbnail available (an entry from before this feature existed,
      // not yet re-synced) — fall back to rendering the video directly, as
      // it always used to.
      videoEl.src = "/media/" + v.id;
      videoEl.classList.remove("hidden");
      photoEl.classList.add("hidden");
      thumbWrap.classList.add("hidden");
    }

    const zoomBtn = card.querySelector(".card-zoom-btn");
    if (v.media_type === "photo") {
      zoomBtn.classList.remove("hidden");
      zoomBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showVideoModal(v.id, "photo");
      });
    }

    card.querySelector(".video-filename").textContent = v.filename;
    card.querySelector(".video-filename").title = v.filename;

    const badge = card.querySelector(".species-badge");
    badge.textContent = v.display_species;
    if (v.display_species === "blank") badge.classList.add("blank");

    // "Verified by" is hardcoded for now (single-user assumption) — swap
    // for the actual editor's name once accounts/auth exist. Independent
    // from the review mark below — a video can be both verified AND
    // re-flagged for another look at the same time.
    if (v.corrected_species) {
      card.querySelector(".verified-info").classList.remove("hidden");
    }
    if (v.marked_for_review) {
      card.querySelector(".unreviewed-corner-bubble").classList.remove("hidden");
    }

    const whichTab = gridId === "lib-grid" ? "lib" : "fav";
    const cardEl = card.querySelector(".video-card"); // grab this now, while the fragment still has its children
    cardEl.dataset.videoId = v.id;

    function triggerExpand(e) {
      e.stopPropagation();
      // Already expanded — once expanded, a click on the video is handled
      // exclusively by the play/pause toggle that expandCardInfoPanel
      // attaches; without this guard, that same click would ALSO re-enter
      // toggleCardInfoPanel and immediately close the panel that was just
      // opened.
      if (expandedCardByGrid[gridId] === v.id) return;
      toggleCardInfoPanel(v.id, gridId, cardEl, v);
    }
    photoEl.addEventListener("click", triggerExpand);
    thumbWrap.addEventListener("click", triggerExpand);
    videoEl.addEventListener("click", triggerExpand);

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
      const data = await saveCorrection(v.id, correctionSelect.value);
      if (data.error) { alert(data.error); return; }
      v.corrected_species = data.corrected_species;
      v.display_species = data.display_species;
      v.marked_for_review = data.marked_for_review;
      await refreshSpeciesData(); // badge counts shift; doesn't touch the current grid

      const gridIdForTab = whichTab === "lib" ? "lib-grid" : "fav-grid";
      if (whichTab === "fav") populateFilterDropdown("fav-species-filter");
      const activeFilter = whichTab === "lib"
        ? libraryActiveSpecies
        : document.getElementById("fav-species-filter").value;

      // Correcting a species can change whether this video still belongs in
      // the category/filter currently being viewed — everything else in the
      // grid is untouched either way, avoiding the full-grid rebuild this
      // used to trigger.
      if (activeFilter && data.display_species !== activeFilter) {
        removeLibraryCard(gridIdForTab, v.id);
      } else {
        patchLibraryCardSpecies(gridIdForTab, v.id, data.display_species);
        if (!data.marked_for_review) {
          const cardEl = findLibraryCardEl(gridIdForTab, v.id);
          const bubble = cardEl && cardEl.querySelector(".unreviewed-corner-bubble");
          if (bubble) bubble.classList.add("hidden");
        }
        syncExpandedPanelReviewState(gridIdForTab, v.id, data.marked_for_review);
      }
    });

    grid.appendChild(card);
  });

  // A full re-render (e.g. from a background poll or a favorite/delete
  // action) rebuilds every card from scratch, which would otherwise
  // silently collapse whatever was expanded. Re-apply it here so the
  // expansion feels persistent rather than flickering shut.
  const expandedId = expandedCardByGrid[gridId];
  if (expandedId) {
    const stillPresent = videos.find(v => v.id === expandedId);
    if (stillPresent) {
      const cardEl = [...grid.querySelectorAll(".video-card")].find(
        c => c.dataset.videoId === expandedId
      );
      if (cardEl) expandCardInfoPanel(expandedId, gridId, cardEl, stillPresent);
    } else {
      expandedCardByGrid[gridId] = null;
    }
  }
}

function collapseCardInfoPanel(gridId, applyClosedTreatment = true) {
  // Always cleared unconditionally, even if there's nothing to visually
  // collapse below — a call site that expected this to close something but
  // hit the early-return would otherwise leave the tracker pointing at a
  // video that's no longer actually expanded, causing it to silently
  // re-expand the next time this grid re-renders (see the "re-apply
  // expansion" logic in renderGrid) — which is exactly the bug this
  // function centralizing the reset is meant to prevent.
  expandedCardByGrid[gridId] = null;

  const grid = document.getElementById(gridId);
  const wrapper = grid.querySelector(".expanded-row-wrapper");
  if (!wrapper) return;

  const cardEl = wrapper.querySelector(".video-card");
  if (cardEl) {
    cardEl.classList.remove("expanded");
    const videoEl = cardEl.querySelector("video");
    if (videoEl) {
      videoEl.pause();
      videoEl.controls = true;
      videoEl.loop = false;
      videoEl.classList.remove("clickable-video");
      videoEl.removeEventListener("click", toggleVideoPlayPauseOnClick);

      const thumbWrap = cardEl.querySelector(".card-video-thumb-wrap");
      const thumbImg = thumbWrap && thumbWrap.querySelector(".card-video-thumb");
      if (thumbImg && thumbImg.src) {
        // A thumbnail exists for this card — revert to showing it, and
        // fully release the loaded video (not just hide it) so it's
        // genuinely not held in memory/network while collapsed.
        videoEl.classList.add("hidden");
        videoEl.removeAttribute("src");
        videoEl.load();
        thumbWrap.classList.remove("hidden");
      }
    }
    wrapper.replaceWith(cardEl); // put the card back exactly where the wrapper was

    if (applyClosedTreatment) {
      scrollCardNearTop(cardEl, grid);
      cardEl.classList.add("just-closed");
      cardEl.addEventListener("animationend", () => {
        cardEl.classList.remove("just-closed");
      }, { once: true });
    }
  } else {
    wrapper.remove();
  }
}

function expandCardInfoPanel(videoId, gridId, cardEl, v) {
  const wrapper = document.createElement("div");
  wrapper.className = "expanded-row-wrapper";
  cardEl.replaceWith(wrapper); // wrapper takes the card's spot in the grid
  wrapper.appendChild(cardEl); // card moves inside the wrapper

  cardEl.classList.add("expanded");

  // Native browser controls sit directly over the burned-in info bar on
  // the video itself, obscuring it — for the enlarged view, replace them
  // with a minimal click-to-toggle + looping playback instead.
  const videoEl = cardEl.querySelector("video");
  if (videoEl && v.media_type !== "photo") {
    if (!videoEl.src) {
      videoEl.src = "/media/" + videoId; // lazy-load — only fetched now that it's actually being viewed
    }
    videoEl.controls = false;
    videoEl.loop = true;
    videoEl.classList.add("clickable-video");
    videoEl.classList.remove("hidden");
    cardEl.querySelector(".card-video-thumb-wrap")?.classList.add("hidden");
    videoEl.addEventListener("click", toggleVideoPlayPauseOnClick);
  }

  const template = document.getElementById("card-info-panel-template");
  const panelFragment = template.content.cloneNode(true);
  const panelEl = panelFragment.querySelector(".card-info-panel");
  const countInput = panelEl.querySelector(".card-info-count");
  const notesInput = panelEl.querySelector(".card-info-notes");
  countInput.value = v.count ?? 1;
  notesInput.value = v.notes || "";

  const reviewBtn = panelEl.querySelector(".card-info-review-btn");
  const favoriteBtn = panelEl.querySelector(".card-info-favorite-btn");

  function updateReviewBtnLabel() {
    reviewBtn.textContent = v.marked_for_review ? "Marked for review" : "Mark for review";
    reviewBtn.classList.toggle("active", !!v.marked_for_review);
  }
  function updateFavoriteBtnLabel() {
    favoriteBtn.textContent = v.favorited ? "Favorited" : "Favorite";
    favoriteBtn.classList.toggle("active", !!v.favorited);
  }
  updateReviewBtnLabel();
  updateFavoriteBtnLabel();

  reviewBtn.addEventListener("click", async () => {
    const newValue = !v.marked_for_review;
    const res = await fetch(`/api/videos/${videoId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marked_for_review: newValue }),
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    v.marked_for_review = newValue;
    updateReviewBtnLabel();
    // Updated in place, deliberately NOT a full grid reload — reviewing a
    // card mid-session shouldn't reshuffle the grid or disturb this open
    // panel (see loadLibrary's preserveOrder).
    const bubble = cardEl.querySelector(".unreviewed-corner-bubble");
    if (bubble) bubble.classList.toggle("hidden", !newValue);
    await refreshSpeciesData(); // badge counts shift; doesn't touch the current grid
  });

  favoriteBtn.addEventListener("click", async () => {
    const whichTab = gridId === "lib-grid" ? "lib" : "fav";
    const newValue = !v.favorited;
    v.favorited = newValue;
    updateFavoriteBtnLabel();
    await toggleFavorite(videoId, newValue, whichTab);
  });

  panelEl.querySelector(".card-info-close-btn").addEventListener("click", () => {
    collapseCardInfoPanel(gridId, true);
  });

  panelEl.querySelector(".card-info-delete-btn").addEventListener("click", async () => {
    const ok = confirm(
      `Delete "${v.filename}" from the library?\n\nThis only removes it from the library — the file on your computer is NOT deleted.`
    );
    if (!ok) return;
    await deleteVideo(videoId);
    await refreshSpeciesData(); // counts shift when a video disappears
    removeLibraryCard(gridId, videoId);
  });

  const saveField = async (field, value) => {
    const res = await fetch(`/api/videos/${videoId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return;
    }
    v[field] = value; // keep the in-memory record in sync for this render cycle
  };

  countInput.addEventListener("change", () => {
    const num = parseInt(countInput.value, 10);
    if (!isNaN(num) && num >= 0) saveField("count", num);
    else countInput.value = v.count ?? 1; // reject an invalid entry, restore the last known-good value
  });
  notesInput.addEventListener("blur", () => {
    saveField("notes", notesInput.value);
  });

  wrapper.appendChild(panelEl);
  return wrapper;
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
  // Library doesn't show favorited-status anywhere on the card itself
  // (only in the expanded notes panel, already updated in place by the
  // caller) — nothing else on screen depends on it, so no reload needed.
  if (whichTab === "fav" && !favorited) {
    // Un-favoriting on the Favorites tab means this card should disappear
    // from view — remove just this one card instead of reloading the
    // entire grid.
    removeLibraryCard("fav-grid", videoId);
  }
}

async function deleteVideo(videoId) {
  const res = await fetch(`/api/videos/${videoId}/delete`, { method: "POST" });
  const data = await res.json();
  if (data.error) alert(data.error);
}

async function saveCorrection(videoId, species) {
  const res = await fetch(`/api/videos/${videoId}/correct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ species }),
  });
  return res.json();
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
      const targetVideoId = modalTargetVideoId; // captured BEFORE closeSpeciesModal() clears it below
      const data = await saveCorrection(targetVideoId, s.label);
      const whichTab = modal.dataset.whichTab;
      closeSpeciesModal();

      if (whichTab === "review") {
        if (!data.error) {
          const v = reviewQueue[reviewIndex];
          if (v && v.id === targetVideoId) Object.assign(v, data);
          updateReviewSpeciesDisplay();
        } else {
          alert(data.error);
        }
        return;
      }

      await refreshSpeciesData();
      const gridIdForTab = whichTab === "lib" ? "lib-grid" : "fav-grid";
      if (whichTab === "fav") populateFilterDropdown("fav-species-filter");
      const activeFilter = whichTab === "lib"
        ? libraryActiveSpecies
        : document.getElementById("fav-species-filter").value;

      if (activeFilter && data.display_species !== activeFilter) {
        removeLibraryCard(gridIdForTab, targetVideoId);
      } else {
        patchLibraryCardSpecies(gridIdForTab, targetVideoId, data.display_species);
        if (!data.marked_for_review) {
          const cardEl = findLibraryCardEl(gridIdForTab, targetVideoId);
          const bubble = cardEl && cardEl.querySelector(".unreviewed-corner-bubble");
          if (bubble) bubble.classList.add("hidden");
        }
        syncExpandedPanelReviewState(gridIdForTab, targetVideoId, data.marked_for_review);
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
  loadOcrConfigOptions();
  loadUploadLocationOptions();
}
refreshSpeciesData(); // populates the Library tab's unreviewed-count badge immediately, not just after visiting the tab

// ---- Spreadsheet tab ----
const SPREADSHEET_FIELDS = ["date", "time", "location", "species", "count", "notes", "filename", "diel_period", "temperature"];
const SPREADSHEET_HEADERS = ["Date", "Time", "Location", "Species", "Count", "Notes", "File Name", "Diel Period", "Temp"];

// Persisted across refreshes and tab switches via localStorage — this is a
// real browser app (not a sandboxed artifact), so localStorage is fine here.
let temperatureDisplayUnit = localStorage.getItem("temperatureDisplayUnit") || "F";
document.getElementById("temp-unit-label").textContent = temperatureDisplayUnit;

document.getElementById("temperature-header").addEventListener("click", () => {
  setTemperatureUnit(temperatureDisplayUnit === "F" ? "C" : "F");
});

/**
 * Parses a raw OCR temperature reading like "72F", "68°F", or "20C" into a
 * {value, unit} pair. If no unit letter is present (a partial/garbled OCR
 * read can drop it), defaults to Fahrenheit — most US trail cams default to
 * that display setting, though this is an assumption, not a certainty, for
 * any given camera's actual configuration.
 */
function parseTemperatureReading(raw) {
  if (!raw) return null;
  const text = String(raw).trim();

  // Dual-unit format, e.g. "24C/75F" — many trail cams show both units
  // natively. Reading whichever one matches the display unit directly is
  // more accurate than converting one to the other (no rounding drift).
  const dualMatch = text.match(/^(-?\d+(?:\.\d+)?)\s*°?\s*C\s*\/\s*(-?\d+(?:\.\d+)?)\s*°?\s*F$/i);
  if (dualMatch) {
    return { c: parseFloat(dualMatch[1]), f: parseFloat(dualMatch[2]) };
  }

  // Single-unit format, e.g. "72F" or "68°F" or "20C" — anchored to match
  // the ENTIRE string, not just a substring. This is what actually catches
  // a garbled OCR read like "24C75F" (a dual-unit reading with a dropped
  // "/" separator): the old substring-matching regex would silently latch
  // onto "24C" and discard "75F", reporting a plausible-looking but wrong
  // value instead of admitting it couldn't be read cleanly.
  const singleMatch = text.match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([CF])$/i);
  if (singleMatch) {
    const value = parseFloat(singleMatch[1]);
    const unit = singleMatch[2].toUpperCase();
    return unit === "C" ? { c: value, f: null } : { c: null, f: value };
  }

  // Bare number, no unit letter at all (a partial OCR read can drop it) —
  // assume Fahrenheit, the common default for US trail cams.
  const bareMatch = text.match(/^(-?\d+(?:\.\d+)?)$/);
  if (bareMatch) {
    return { c: null, f: parseFloat(bareMatch[1]) };
  }

  return null; // genuinely unparseable — never guessed at
}

function convertTemperature(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;
  if (fromUnit === "F" && toUnit === "C") return (value - 32) * 5 / 9;
  if (fromUnit === "C" && toUnit === "F") return (value * 9 / 5) + 32;
  return value;
}

/** Converts a raw stored reading to whatever unit is currently toggled on, for display. */
function formatTemperatureForDisplay(raw, displayUnit) {
  if (!raw) return ""; // genuinely blank/skipped — not an error, just no data
  const parsed = parseTemperatureReading(raw);
  if (!parsed) return "Error"; // unparseable — never silently show the raw garbled text or a coincidental 0
  if (displayUnit === "C") {
    if (parsed.c !== null) return `${Math.round(parsed.c)}°C`;
    if (parsed.f !== null) return `${Math.round(convertTemperature(parsed.f, "F", "C"))}°C`;
  } else {
    if (parsed.f !== null) return `${Math.round(parsed.f)}°F`;
    if (parsed.c !== null) return `${Math.round(convertTemperature(parsed.c, "C", "F"))}°F`;
  }
  return "Error"; // defensive fallback — should be unreachable, but never defaults to a bare 0
}

function stripExtension(name) {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

function fileExtensionOf(name) {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx).toLowerCase() : "";
}

let spreadsheetVideos = [];        // raw data from the last /api/videos fetch
let spreadsheetLocationsCache = {}; // name -> {lat, lon}, for the location cell's coordinate tooltip
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
  temperature: "Temperature",
  verified: "Verified",
  media_type: "Media Type",
  missing_count: "Data Complete",
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
    temperature: formatTemperatureForDisplay(v.temperature, temperatureDisplayUnit),
    verified: v.corrected_species ? 1 : 0, // sort-only field, not a visible column — 0 (unverified) sorts before 1 (verified) ascending
    media_type: v.media_type || "video", // sort-only field — "photo" sorts before "video" alphabetically ascending
    // Sort-only field: how many of the OCR-derived fields are missing for
    // this entry (0-5). Species/Count/Notes/File Name are excluded — they
    // always have SOME value (an AI guess, a default of 1, etc.), so
    // "missing" only meaningfully applies to what OCR can genuinely fail
    // to read or that was deliberately skipped.
    missing_count: ["date", "time", "location", "diel_period", "temperature"].filter(f => !v[f]).length,
  };
}

async function loadSpreadsheet() {
  const [videosRes, locationsRes] = await Promise.all([
    fetch("/api/videos"),
    fetch("/api/locations"),
  ]);
  spreadsheetVideos = await videosRes.json();
  spreadsheetLocationsCache = await locationsRes.json();
  applySpreadsheetView();
}

function applySpreadsheetView() {
  let rows = spreadsheetVideos.filter(v => !hiddenGroups.includes(v.display_species));

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

        // Missing values always sort last, regardless of direction — decided
        // and returned/continued immediately, BEFORE the desc-flip below,
        // which would otherwise incorrectly send them to the front on a
        // descending sort (a pre-existing bug this restructure also fixes).
        if (aEmpty && bEmpty) continue; // tied at this level — let the next sort level decide
        if (aEmpty) return 1;
        if (bEmpty) return -1;

        let cmp;
        if (level.field === "count" || level.field === "verified" || level.field === "missing_count") {
          cmp = Number(av) - Number(bv);
        } else if (level.field === "temperature") {
          // Temperature is free-text OCR output like "72F" or "68°F", not a
          // clean number — sorting it as a plain string would put "100F"
          // before "72F" (wrong). Parse out the leading number instead; if
          // either side can't be parsed (garbled OCR), treat it the same as
          // a missing value — always last, regardless of direction.
          const aNum = parseFloat(av);
          const bNum = parseFloat(bv);
          const aNumEmpty = isNaN(aNum);
          const bNumEmpty = isNaN(bNum);
          if (aNumEmpty && bNumEmpty) continue;
          if (aNumEmpty) return 1;
          if (bNumEmpty) return -1;
          cmp = aNum - bNum;
        } else {
          cmp = String(av).localeCompare(String(bv));
        }

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

      if (field === "location" && v.location) {
        const coords = spreadsheetLocationsCache[v.location];
        if (coords && coords.lat !== null && coords.lat !== undefined) {
          td.dataset.tooltip = `${coords.lat}, ${coords.lon}`;
        } else {
          td.dataset.tooltip = "No coordinates yet";
        }
      }

      if (field === "species") {
        // Text truncation happens on this inner span, not the td itself —
        // the td needs overflow:visible so its tooltip (below) can escape
        // the cell's box; wrapping the text lets it truncate independently.
        const textSpan = document.createElement("span");
        textSpan.className = "species-cell-text";
        textSpan.textContent = td.textContent;
        td.textContent = "";
        td.appendChild(textSpan);

        td.classList.add(v.corrected_species ? "species-verified" : "species-unverified");
        // Rendered via CSS (::after, styled to match the Library view's
        // info-icon tooltip) rather than the native title attribute — a
        // real tooltip element here would pollute td.textContent, which
        // copyRowToClipboard/copyEntireTableToClipboard/startCellEdit all
        // read directly.
        td.dataset.tooltip = v.corrected_species ? "Verified by: Connor Sapp" : "Unverified";
      }

      if (field === "filename") {
        // The icon lives on an inner span (not a real text node itself —
        // it's a CSS ::before on that span) so it doesn't pollute
        // td.textContent — same reasoning as the species tooltip above.
        // Gives the Media Type sort a visible, verifiable effect. Tooltip
        // (::after on the td, see CSS) shows the actual file extension on
        // hover — derived from v.filename (the real file on disk), not
        // display_filename, since that's user-editable and may not
        // reliably reflect the true file type.
        //
        // Text truncation happens on this inner span, not the td itself —
        // the td needs overflow:visible so its tooltip can escape the
        // cell's box (same reasoning as the species cell above); wrapping
        // the text lets it truncate independently instead of spilling into
        // neighboring columns.
        td.classList.add(v.media_type === "photo" ? "filename-photo" : "filename-video");
        td.dataset.tooltip = fileExtensionOf(v.filename) || (v.media_type === "photo" ? "photo" : "video");

        const textSpan = document.createElement("span");
        textSpan.className = "filename-cell-text";
        textSpan.textContent = td.textContent;
        td.textContent = "";
        td.appendChild(textSpan);
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

  // date, time, location, count, diel_period, temperature — all plain fields on /update
  let valueToSend = newValue;
  if (field === "temperature" && newValue !== "") {
    // The cell displays (and you're typing) in whatever unit is currently
    // toggled — tag the typed number with that unit before storing it, so
    // the raw stored value stays self-describing regardless of which unit
    // was active when it was entered.
    const num = parseFloat(newValue);
    if (!isNaN(num)) valueToSend = `${num}°${temperatureDisplayUnit}`;
  }
  const payload = { [field]: valueToSend };
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
  if (field === "count") return String(data.count);
  if (field === "temperature") return formatTemperatureForDisplay(data.temperature, temperatureDisplayUnit);
  return data[field] || "";
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

function showVideoModal(videoId, mediaType) {
  const modal = document.getElementById("video-modal");
  const player = document.getElementById("video-modal-player");
  const photo = document.getElementById("video-modal-photo");

  if (!mediaType) {
    // Fallback for callers that don't already know it (the Spreadsheet's
    // own "Show media" menu option) — looks it up from its cache. Callers
    // that already have the record (Library/Favorites cards) should pass
    // mediaType directly instead, since spreadsheetVideos may be empty if
    // that tab hasn't been visited yet.
    const record = spreadsheetVideos.find(v => v.id === videoId);
    mediaType = record ? record.media_type : "video";
  }

  if (mediaType === "photo") {
    photo.src = "/media/" + videoId;
    photo.classList.remove("hidden");
    player.classList.add("hidden");
  } else {
    player.src = "/media/" + videoId;
    player.classList.remove("hidden");
    photo.classList.add("hidden");
    player.play().catch(() => {}); // browser may block autoplay — not an error, just ignore
  }
  modal.classList.remove("hidden");
}

function closeVideoModal() {
  const modal = document.getElementById("video-modal");
  const player = document.getElementById("video-modal-player");
  const photo = document.getElementById("video-modal-photo");
  player.pause();
  player.removeAttribute("src");
  player.load(); // fully releases the video, stops any buffering/playback
  photo.removeAttribute("src");
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

function exportSpreadsheetToCSV() {
  const tbody = document.getElementById("spreadsheet-body");
  const rows = tbody.querySelectorAll("tr");

  if (rows.length === 0) {
    alert("No data to export!");
    return;
  }

  // Build CSV Header
  let csvLines = [SPREADSHEET_HEADERS.join(",")];

  // Format and escape cell values for CSV formatting
  rows.forEach(tr => {
    const rowValues = SPREADSHEET_FIELDS.map(field => {
      const cell = tr.querySelector(`td[data-field="${field}"]`);
      let val = cell ? cell.textContent : "";
      
      // Escape inner double quotes
      val = val.replace(/"/g, '""');
      
      // Wrap in double quotes if string contains commas or newlines
      if (val.includes(",") || val.includes("\n") || val.includes('"')) {
        val = `"${val}"`;
      }
      return val;
    });
    csvLines.push(rowValues.join(","));
  });

  const csvString = csvLines.join("\n");

  // Create blob and trigger automatic browser download
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  
  link.setAttribute("href", url);
  link.setAttribute("download", `trail_cam_species_export_${today}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Bind button event listener
document.getElementById("export-csv-btn")?.addEventListener("click", exportSpreadsheetToCSV);

// ==== Track tab ====
let trackMap = null;
let trackMapMarkersByName = {}; // location name -> Leaflet marker, for hover-highlighting from the media list

async function loadTrackTab() {
  await refreshTrackMapAndBadge();
  await loadTrackMediaList();
}

async function refreshTrackMapAndBadge() {
  const missingRes = await fetch("/api/locations/missing");
  const missingData = await missingRes.json();
  const overlay = document.getElementById("track-missing-overlay");
  const count = (missingData.missing || []).length;
  if (count > 0) {
    overlay.textContent = `⚠ ${count} location${count === 1 ? "" : "s"} need coordinates`;
    overlay.classList.remove("hidden");
  } else {
    overlay.classList.add("hidden");
  }

  const locRes = await fetch("/api/locations");
  const allLocations = await locRes.json();
  renderTrackMap(allLocations);
}

function renderTrackMap(allLocations) {
  const entries = Object.entries(allLocations);
  const emptyMsg = document.getElementById("track-map-empty");
  const mediaList = document.getElementById("track-media-list");

  // The map itself always renders now, even with zero locations — only the
  // right-side panel (media list vs. this empty message) toggles based on
  // whether there's any location data yet.
  if (entries.length === 0) {
    emptyMsg.classList.remove("hidden");
    mediaList.classList.add("hidden");
  } else {
    emptyMsg.classList.add("hidden");
    mediaList.classList.remove("hidden");
  }

  if (!trackMap) {
    trackMap = L.map("track-map");
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(trackMap);
  }

  Object.values(trackMapMarkersByName).forEach(m => trackMap.removeLayer(m));
  trackMapMarkersByName = {};

  if (entries.length === 0) {
    // Nothing to fit bounds to yet — a reasonable generic world view rather
    // than an undefined viewport.
    trackMap.setView([20, 0], 2);
  } else {
    const bounds = [];
    entries.forEach(([name, coords]) => {
      const marker = L.marker([coords.lat, coords.lon]).addTo(trackMap);
      marker.bindPopup(name);
      trackMapMarkersByName[name] = marker;
      bounds.push([coords.lat, coords.lon]);
    });

    if (bounds.length === 1) {
      trackMap.setView(bounds[0], 15);
    } else {
      trackMap.fitBounds(bounds, { padding: [30, 30] });
    }
  }

  // Leaflet sizes itself off the container's CURRENT visible dimensions —
  // if the tab was hidden when the map was first created, this fixes any
  // stale sizing now that the container is actually visible.
  setTimeout(() => trackMap.invalidateSize(), 0);
}

function dielPeriodClass(period) {
  const known = { Day: "diel-day", Night: "diel-night", Dawn: "diel-dawn", Dusk: "diel-dusk" };
  return known[period] || "";
}

function highlightMapMarker(locationName) {
  const marker = trackMapMarkersByName[locationName];
  if (marker) marker.openPopup();
}

function unhighlightMapMarker(locationName) {
  const marker = trackMapMarkersByName[locationName];
  if (marker) marker.closePopup();
}

let trackMediaCache = { videos: [], knownLocations: {} };

async function loadTrackMediaList() {
  const [videosRes, locationsRes] = await Promise.all([
    fetch("/api/videos"),
    fetch("/api/locations"),
  ]);
  trackMediaCache.videos = await videosRes.json();
  trackMediaCache.knownLocations = await locationsRes.json();
  populateTrackSpeciesFilter(trackMediaCache.videos);
  applyTrackMediaFilters();
}

function populateTrackSpeciesFilter(allVideos) {
  const select = document.getElementById("track-filter-species");
  const currentValue = select.value;
  const speciesSet = new Set(
    allVideos.map(v => v.display_species).filter(s => s && !hiddenGroups.includes(s))
  );
  select.innerHTML = '<option value="">All animals</option>';
  [...speciesSet].sort().forEach(s => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    select.appendChild(opt);
  });
  if (speciesSet.has(currentValue)) select.value = currentValue; // keep the selection if it's still a valid option
}

function applyTrackMediaFilters() {
  const { videos: allVideos, knownLocations } = trackMediaCache;

  // Only entries whose location actually has a map point — nothing to
  // highlight otherwise, and chronological order sets this up naturally
  // for the planned species/timeframe path-following feature later.
  let relevant = allVideos.filter(v =>
    v.location && knownLocations[v.location] && !hiddenGroups.includes(v.display_species)
  );

  const speciesVal = document.getElementById("track-filter-species").value;
  if (speciesVal) {
    relevant = relevant.filter(v => v.display_species === speciesVal);
  }

  const startVal = document.getElementById("track-filter-start").value; // "" or "YYYY-MM-DDTHH:MM"
  const endVal = document.getElementById("track-filter-end").value;
  if (startVal || endVal) {
    const startDate = startVal ? new Date(startVal) : null;
    const endDate = endVal ? new Date(endVal) : null;
    relevant = relevant.filter(v => {
      if (!v.date) return false; // undated entries can't be placed within a chosen range
      const entryDate = new Date(`${v.date}T${v.time || "00:00:00"}`);
      if (startDate && entryDate < startDate) return false;
      if (endDate && entryDate > endDate) return false;
      return true;
    });
  }

  relevant.sort((a, b) => {
    const aKey = (a.date || "9999-99-99") + " " + (a.time || "99:99:99");
    const bKey = (b.date || "9999-99-99") + " " + (b.time || "99:99:99");
    return aKey.localeCompare(bKey);
  });

  renderTrackMediaCards(relevant);
}

function renderTrackMediaCards(relevant) {
  const listEl = document.getElementById("track-media-list");
  listEl.innerHTML = "";
  const template = document.getElementById("track-media-card-template");

  relevant.forEach(v => {
    const cardFragment = template.content.cloneNode(true);
    const cardEl = cardFragment.querySelector(".track-media-card");
    const dielClass = dielPeriodClass(v.diel_period);
    if (dielClass) cardEl.classList.add(dielClass);

    cardEl.querySelector(".track-media-card-species").textContent = v.display_species || "";
    cardEl.querySelector(".track-media-card-location").textContent = v.location;
    cardEl.querySelector(".track-media-card-date").textContent = v.date || "";
    cardEl.querySelector(".track-media-card-time").textContent = v.time || "";
    cardEl.querySelector(".track-media-card-temp").textContent = formatTemperatureForDisplay(v.temperature, temperatureDisplayUnit);

    cardEl.addEventListener("mouseenter", () => highlightMapMarker(v.location));
    cardEl.addEventListener("mouseleave", () => unhighlightMapMarker(v.location));

    cardEl.querySelector(".track-media-card-zoom-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      showVideoModal(v.id, v.media_type); // already autoplays for videos
    });

    listEl.appendChild(cardFragment);
  });
}

let locationsCache = [];

async function loadLocationsSection() {
  const [missingRes, allRes] = await Promise.all([
    fetch("/api/locations/missing"),
    fetch("/api/locations"),
  ]);
  const missingData = await missingRes.json();
  const allLocations = await allRes.json();

  const byName = new Map();
  Object.entries(allLocations).forEach(([name, coords]) => {
    byName.set(name, { name, lat: coords.lat, lon: coords.lon, needsCoords: false });
  });
  // Legacy names referenced by a video but never added to the curated list —
  // shown so they can be given coordinates rather than staying invisible.
  (missingData.missing || []).forEach(name => {
    if (!byName.has(name)) {
      byName.set(name, { name, lat: "", lon: "", needsCoords: true });
    }
  });
  const combined = [...byName.values()];
  combined.sort((a, b) => {
    if (a.needsCoords !== b.needsCoords) return a.needsCoords ? -1 : 1; // anything still needing coordinates floats to the top
    return a.name.localeCompare(b.name);
  });

  locationsCache = combined;
  renderLocationsList();
}

function renderLocationsList() {
  const listEl = document.getElementById("locations-list");
  listEl.innerHTML = "";
  const template = document.getElementById("location-row-template");

  locationsCache.forEach(loc => {
    const rowFragment = template.content.cloneNode(true);
    const rowEl = rowFragment.querySelector(".location-row");
    if (loc.needsCoords) rowEl.classList.add("needs-coords");
    rowEl.dataset.originalName = loc.name;

    rowEl.querySelector(".location-row-name").value = loc.name;
    rowEl.querySelector(".location-row-lat").value = loc.lat;
    rowEl.querySelector(".location-row-lon").value = loc.lon;
    rowEl.querySelector(".location-row-save-btn").addEventListener("click", () => saveLocationRow(rowEl));

    listEl.appendChild(rowFragment);
  });
}

document.getElementById("add-location-btn").addEventListener("click", () => {
  const listEl = document.getElementById("locations-list");
  const template = document.getElementById("location-row-template");
  const rowFragment = template.content.cloneNode(true);
  const rowEl = rowFragment.querySelector(".location-row");
  rowEl.dataset.originalName = ""; // brand new — nothing to reassign videos FROM, see saveLocationRow
  rowEl.classList.add("needs-coords");
  rowEl.querySelector(".location-row-name").placeholder = "New location name";
  rowEl.querySelector(".location-row-save-btn").addEventListener("click", () => saveLocationRow(rowEl));

  listEl.appendChild(rowFragment);
  listEl.lastElementChild.querySelector(".location-row-name").focus();
});

async function saveLocationRow(rowEl) {
  const originalName = rowEl.dataset.originalName;
  const name = rowEl.querySelector(".location-row-name").value.trim();
  const lat = rowEl.querySelector(".location-row-lat").value;
  const lon = rowEl.querySelector(".location-row-lon").value;

  if (!name) { alert("Name is required."); return; }
  if (lat === "" || lon === "") { alert("Latitude and longitude are required."); return; }

  const res = await fetch("/api/locations/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_names: originalName ? [originalName] : [], // empty = brand-new location, nothing to reassign videos FROM
      target_name: name,
      lat: parseFloat(lat),
      lon: parseFloat(lon),
    }),
  });
  const data = await res.json();
  if (data.error) { alert(data.error); return; }

  await loadLocationsSection();
  await refreshTrackMapAndBadge();
  await loadTrackMediaList();
  loadUploadLocationOptions(); // the Upload tab's dropdown may now be stale
}

document.getElementById("track-missing-overlay").addEventListener("click", () => {
  document.querySelector('.tab-btn[data-tab="settings"]').click();
});

document.getElementById("track-filter-start").addEventListener("change", applyTrackMediaFilters);
document.getElementById("track-filter-end").addEventListener("change", applyTrackMediaFilters);
document.getElementById("track-filter-species").addEventListener("change", applyTrackMediaFilters);

document.querySelectorAll(".track-filter-clear-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const target = document.getElementById(btn.dataset.target);
    target.value = "";
    applyTrackMediaFilters();
  });
});

document.getElementById("locations-csv-template-btn").addEventListener("click", () => {
  const csvContent = "name,lat,lon\nUCF30,28.6024,-81.1966\nNorth Trail,28.599,-81.201\n";
  const blob = new Blob([csvContent], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "locations_template.csv";
  a.click();
  URL.revokeObjectURL(url);
});

let pendingImportRows = null; // the full valid_rows list from the last preview, held until confirmed or cancelled
let pendingImportSkipped = [];

document.getElementById("locations-csv-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const resultEl = document.getElementById("locations-import-result");
  resultEl.classList.remove("error");
  resultEl.textContent = "Checking file…";
  resultEl.classList.remove("hidden");
  document.getElementById("locations-import-confirm").classList.add("hidden");

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/locations/import-csv/preview", { method: "POST", body: formData });
    const data = await res.json();
    e.target.value = ""; // reset so re-selecting the same file still fires a change event next time

    if (data.error) {
      resultEl.textContent = "Error: " + data.error;
      resultEl.classList.add("error");
      return;
    }

    if (data.conflicts.length === 0) {
      // Nothing would be overwritten — commit immediately, same low-friction
      // path as before for the common case (importing brand-new locations).
      resultEl.classList.add("hidden");
      await commitLocationsImport(data.valid_rows, data.skipped);
      return;
    }

    resultEl.classList.add("hidden");
    showImportConflicts(data.conflicts, data.new_count, data.skipped, data.valid_rows);
  } catch (err) {
    resultEl.textContent = "Import failed — check your connection and try again.";
    resultEl.classList.add("error");
  }
});

function showImportConflicts(conflicts, newCount, skipped, validRows) {
  pendingImportRows = validRows;
  pendingImportSkipped = skipped;

  const intro = document.getElementById("locations-import-confirm-intro");
  intro.textContent = `${conflicts.length} location${conflicts.length === 1 ? "" : "s"} already ${conflicts.length === 1 ? "has" : "have"} coordinates — importing will overwrite ${conflicts.length === 1 ? "it" : "them"} with the values below.` +
    (newCount > 0 ? ` ${newCount} other new location${newCount === 1 ? "" : "s"} will be added normally.` : "");

  const listEl = document.getElementById("locations-import-confirm-list");
  listEl.innerHTML = "";
  conflicts.forEach(c => {
    const row = document.createElement("div");
    row.className = "locations-import-confirm-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "name";
    nameSpan.textContent = c.name;

    const oldSpan = document.createElement("span");
    oldSpan.className = "old-value";
    oldSpan.textContent = `${c.existing.lat}, ${c.existing.lon}`;

    const newSpan = document.createElement("span");
    newSpan.className = "new-value";
    newSpan.textContent = `${c.new.lat}, ${c.new.lon}`;

    row.append(nameSpan, ": ", oldSpan, " → ", newSpan);
    listEl.appendChild(row);
  });

  document.getElementById("locations-import-confirm").classList.remove("hidden");
}

document.getElementById("locations-import-confirm-cancel-btn").addEventListener("click", () => {
  pendingImportRows = null;
  pendingImportSkipped = [];
  document.getElementById("locations-import-confirm").classList.add("hidden");
  const resultEl = document.getElementById("locations-import-result");
  resultEl.textContent = "Import cancelled — nothing was changed.";
  resultEl.classList.remove("error");
  resultEl.classList.remove("hidden");
});

document.getElementById("locations-import-confirm-btn").addEventListener("click", async () => {
  document.getElementById("locations-import-confirm").classList.add("hidden");
  const rows = pendingImportRows;
  const skipped = pendingImportSkipped;
  pendingImportRows = null;
  pendingImportSkipped = [];
  await commitLocationsImport(rows, skipped);
});

async function commitLocationsImport(rows, skippedFromPreview) {
  const resultEl = document.getElementById("locations-import-result");
  resultEl.classList.remove("error");
  resultEl.textContent = "Importing…";
  resultEl.classList.remove("hidden");

  try {
    const res = await fetch("/api/locations/import-csv/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const data = await res.json();

    if (data.error) {
      resultEl.textContent = "Error: " + data.error;
      resultEl.classList.add("error");
      return;
    }

    let summary = `Imported ${data.imported_count} location${data.imported_count === 1 ? "" : "s"}.`;
    const allSkipped = [...(skippedFromPreview || []), ...(data.skipped || [])];
    if (allSkipped.length > 0) {
      const details = allSkipped
        .map(s => `row ${s.row}${s.name ? ` (${s.name})` : ""}: ${s.reason}`)
        .join("; ");
      summary += ` Skipped ${allSkipped.length}: ${details}`;
    }
    resultEl.textContent = summary;
    resultEl.classList.toggle("error", data.imported_count === 0 && allSkipped.length > 0);

    await loadLocationsSection(); // refresh the list to show newly-imported entries
    await refreshTrackMapAndBadge();
    await loadTrackMediaList();
  } catch (err) {
    resultEl.textContent = "Import failed — check your connection and try again.";
    resultEl.classList.add("error");
  }
}