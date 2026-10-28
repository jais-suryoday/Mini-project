/* ============================================================
   AI Library Seat Occupancy Tracker — JavaScript
   All frontend logic in plain JS (no frameworks).
   ============================================================ */

// ── DOM Element References ────────────────────────────────────
var clockEl         = document.getElementById("clock");
var badgeEl         = document.getElementById("connection-badge");
var videoFeed       = document.getElementById("video-feed");
var videoPlaceholder= document.getElementById("video-placeholder");
var videoTitle      = document.getElementById("video-title");
var setupBtn        = document.getElementById("setup-btn");
var recDot          = document.getElementById("rec-dot");
var calCanvas       = document.getElementById("cal-canvas");
var calToolbar      = document.getElementById("cal-toolbar");
var calInfo         = document.getElementById("cal-info");

var zoneNameEl      = document.getElementById("zone-name");
var dateEl          = document.getElementById("date-display");
var ringFill        = document.getElementById("ring-fill");
var ringNumber      = document.getElementById("ring-number");
var ringLabel       = document.getElementById("ring-label");
var occCount        = document.getElementById("occ-count");
var totalCount      = document.getElementById("total-count");
var personCount     = document.getElementById("person-count");
var personWord      = document.getElementById("person-word");
var statusPill      = document.getElementById("status-pill");
var capPercent       = document.getElementById("cap-percent");
var capFill         = document.getElementById("cap-fill");
var seatGridEl      = document.getElementById("seat-grid");

// ── State Variables ───────────────────────────────────────────
var isCalibrating = false;   // Is the seat calibration mode active?
var seats         = [];      // Array of seat definitions: { id, label, x1, y1, x2, y2 }
var isDrawing     = false;   // Is the user currently dragging to draw a seat?
var drawStart     = null;    // Starting point of the drag: { x, y }
var drawCurrent   = null;    // Current mouse position during drag: { x, y }
var ws            = null;    // WebSocket connection object
var reconnectTimer= null;    // Timer for auto-reconnect


// ============================================================
// 1. CLOCK — Update every second
// ============================================================

function updateClock() {
  var now = new Date();

  // Time: "02:30:15 PM"
  clockEl.textContent = now.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
  });

  // Date: "Monday, October 27, 2026"
  dateEl.textContent = now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });
}

updateClock();
setInterval(updateClock, 1000);


// ============================================================
// 2. WEBSOCKET — Real-time occupancy updates
// ============================================================

function connectWebSocket() {
  // Build WebSocket URL from current page host
  var wsUrl = "ws://" + window.location.host + "/ws";

  badgeEl.textContent = "● Connecting…";
  badgeEl.className = "badge badge-offline";

  ws = new WebSocket(wsUrl);

  // Called when connection is established
  ws.onopen = function () {
    console.log("[WS] Connected");
    badgeEl.textContent = "● Live";
    badgeEl.className = "badge badge-online";
  };

  // Called when a message (JSON data) is received from the server
  ws.onmessage = function (event) {
    try {
      var data = JSON.parse(event.data);
      updateDashboard(data);
    } catch (e) {
      console.warn("[WS] Failed to parse message:", event.data);
    }
  };

  // Called when connection is closed — auto-reconnect after 3 seconds
  ws.onclose = function () {
    console.log("[WS] Disconnected — reconnecting in 3s");
    badgeEl.textContent = "● Offline";
    badgeEl.className = "badge badge-offline";
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  // Called on error — close and let onclose handle reconnect
  ws.onerror = function () {
    ws.close();
  };
}

connectWebSocket();


// ============================================================
// 3. DASHBOARD UPDATE — Process incoming occupancy data
// ============================================================

function updateDashboard(data) {
  var occupied = data.occupied_seats || 0;
  var total    = data.total_seats || 0;
  var zone     = data.zone || "Main Lab";
  var people   = data.person_count || 0;
  var seatList = data.seats || [];

  // Zone name
  zoneNameEl.textContent = "📍 " + zone;

  // Counts
  occCount.textContent   = occupied;
  totalCount.textContent = total;
  personCount.textContent = people;
  personWord.textContent = (people === 1) ? "person" : "people";

  // Ring progress
  updateRing(occupied, total);

  // Status pill
  updateStatusPill(occupied, total);

  // Capacity bar
  var percent = total > 0 ? Math.round((occupied / total) * 100) : 0;
  capPercent.textContent = percent + "%";
  capFill.style.width = Math.min(percent, 100) + "%";

  // Color the capacity bar based on status
  var statusInfo = getStatus(occupied, total);
  capFill.style.background = statusInfo.color;

  // Seat grid
  renderSeatGrid(seatList);
}


// ── Get occupancy status (color + label) ──────────────────────
function getStatus(occupied, total) {
  if (total === 0) return { label: "No Seats Defined", color: "#6b7280" };
  var ratio = occupied / total;
  if (ratio >= 1)   return { label: "Full",              color: "#dc2626" };
  if (ratio >= 0.8) return { label: "Nearing Capacity",  color: "#d97706" };
  return               { label: "Available",           color: "#16a34a" };
}


// ── Update the SVG ring progress ──────────────────────────────
function updateRing(occupied, total) {
  var circumference = 2 * Math.PI * 75;  // radius = 75
  var ratio = total > 0 ? Math.min(occupied / total, 1) : 0;
  var offset = circumference * (1 - ratio);
  var statusInfo = getStatus(occupied, total);

  ringFill.style.strokeDashoffset = offset;
  ringFill.style.stroke = statusInfo.color;

  ringNumber.textContent = occupied;
  ringLabel.textContent = "of " + total + " seats";
}


// ── Update the status pill ────────────────────────────────────
function updateStatusPill(occupied, total) {
  var statusInfo = getStatus(occupied, total);
  statusPill.textContent = statusInfo.label;
  statusPill.style.color = statusInfo.color;
  statusPill.style.borderColor = statusInfo.color + "40";
  statusPill.style.background = statusInfo.color + "15";
}


// ── Render the seat grid (individual seat chips) ──────────────
function renderSeatGrid(seatList) {
  if (!seatList || seatList.length === 0) {
    seatGridEl.innerHTML =
      '<p class="no-seats">🪑 No seats configured<br><small>Click "Setup Seats" to define seat zones</small></p>';
    return;
  }

  var html = "";
  for (var i = 0; i < seatList.length; i++) {
    var s = seatList[i];
    var cls = s.occupied ? "occupied" : "vacant";
    var dotColor = s.occupied ? "#dc2626" : "#16a34a";
    html +=
      '<div class="seat-chip ' + cls + '" title="' + s.label + ": " + (s.occupied ? "Occupied" : "Vacant") + '">' +
        "🪑 " +
        '<span>' + s.label + '</span>' +
        '<span class="chip-dot" style="background:' + dotColor + '"></span>' +
      "</div>";
  }
  seatGridEl.innerHTML = html;
}


// ============================================================
// 4. VIDEO FEED — Handle load and error states
// ============================================================

function onVideoLoad() {
  videoPlaceholder.classList.add("hidden");
  recDot.textContent = "● Recording";
  recDot.style.color = "#16a34a";
}

function onVideoError() {
  videoPlaceholder.classList.remove("hidden");
  videoPlaceholder.innerHTML =
    '<span class="placeholder-icon">📵</span>' +
    '<span>Camera feed unavailable</span>' +
    '<button class="btn btn-green" onclick="retryVideo()" style="margin-top:6px">Retry</button>';
  recDot.textContent = "● Offline";
  recDot.style.color = "#dc2626";
}

function retryVideo() {
  videoPlaceholder.innerHTML =
    '<span class="placeholder-icon">📹</span><span>Connecting to camera…</span>';
  // Reload the MJPEG stream by resetting the src
  videoFeed.src = "/video_feed?" + Date.now();
}


// ============================================================
// 5. SEAT CALIBRATION — Draw seat zones on the video
// ============================================================

// ── Toggle calibration mode on/off ────────────────────────────
function toggleCalibration() {
  isCalibrating = !isCalibrating;

  if (isCalibrating) {
    // Enter calibration mode
    calCanvas.style.display = "block";
    calToolbar.style.display = "flex";
    setupBtn.textContent = "✕ Exit Setup";
    setupBtn.className = "btn btn-red";
    videoTitle.textContent = "🎯 Seat Calibration Mode";
    resizeCanvas();
    redrawCanvas();
  } else {
    // Exit calibration mode
    calCanvas.style.display = "none";
    calToolbar.style.display = "none";
    setupBtn.textContent = "⚙ Setup Seats";
    setupBtn.className = "btn btn-green";
    videoTitle.textContent = "📹 Live Camera Feed";
  }
}


// ── Resize the canvas to match the video frame ────────────────
function resizeCanvas() {
  var frame = document.getElementById("video-frame");
  calCanvas.width = frame.offsetWidth;
  calCanvas.height = frame.offsetHeight;
}

window.addEventListener("resize", function () {
  if (isCalibrating) {
    resizeCanvas();
    redrawCanvas();
  }
});


// ── Get mouse position relative to canvas (normalized 0-1) ───
function getCanvasPos(event) {
  var rect = calCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height
  };
}


// ── Mouse event handlers for drawing seats ────────────────────

calCanvas.addEventListener("mousedown", function (e) {
  var pos = getCanvasPos(e);

  // Check if clicking a delete button on an existing seat
  var w = calCanvas.width;
  var h = calCanvas.height;

  for (var i = 0; i < seats.length; i++) {
    var s = seats[i];
    var sx = s.x1 * w;
    var sy = s.y1 * h;
    var sw = (s.x2 - s.x1) * w;

    // Delete button position (top-right corner of seat)
    var delR = 8;
    var delCx = sx + sw - delR - 4;
    var delCy = sy + delR + 4;

    var dx = pos.x * w - delCx;
    var dy = pos.y * h - delCy;

    if (dx * dx + dy * dy <= delR * delR) {
      // Delete this seat
      seats.splice(i, 1);
      saveSeats();
      redrawCanvas();
      updateCalInfo();
      return;
    }
  }

  // Start drawing a new seat
  isDrawing = true;
  drawStart = pos;
  drawCurrent = pos;
});

calCanvas.addEventListener("mousemove", function (e) {
  if (!isDrawing) return;
  drawCurrent = getCanvasPos(e);
  redrawCanvas();
});

calCanvas.addEventListener("mouseup", function () {
  if (!isDrawing || !drawStart || !drawCurrent) {
    isDrawing = false;
    return;
  }

  // Check minimum size (at least 2% of frame in each direction)
  var dw = Math.abs(drawCurrent.x - drawStart.x);
  var dh = Math.abs(drawCurrent.y - drawStart.y);

  if (dw >= 0.02 && dh >= 0.02) {
    // Create the new seat
    var nextId = seats.length > 0
      ? Math.max.apply(null, seats.map(function (s) { return s.id; })) + 1
      : 1;

    var newSeat = {
      id: nextId,
      label: "Seat " + nextId,
      x1: Math.min(drawStart.x, drawCurrent.x),
      y1: Math.min(drawStart.y, drawCurrent.y),
      x2: Math.max(drawStart.x, drawCurrent.x),
      y2: Math.max(drawStart.y, drawCurrent.y)
    };

    seats.push(newSeat);
    saveSeats();
    updateCalInfo();
  }

  isDrawing = false;
  drawStart = null;
  drawCurrent = null;
  redrawCanvas();
});

calCanvas.addEventListener("mouseleave", function () {
  if (isDrawing) {
    isDrawing = false;
    drawStart = null;
    drawCurrent = null;
    redrawCanvas();
  }
});


// ── Redraw all seat rectangles on the canvas ──────────────────
function redrawCanvas() {
  var ctx = calCanvas.getContext("2d");
  var w = calCanvas.width;
  var h = calCanvas.height;

  ctx.clearRect(0, 0, w, h);

  // Draw each existing seat
  for (var i = 0; i < seats.length; i++) {
    var s = seats[i];
    var sx = s.x1 * w;
    var sy = s.y1 * h;
    var sw = (s.x2 - s.x1) * w;
    var sh = (s.y2 - s.y1) * h;

    // Green fill
    ctx.fillStyle = "rgba(22, 163, 74, 0.18)";
    ctx.fillRect(sx, sy, sw, sh);

    // Green border
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 2;
    ctx.strokeRect(sx, sy, sw, sh);

    // Label background
    ctx.font = "bold 12px sans-serif";
    var label = s.label;
    var tm = ctx.measureText(label);
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(sx, sy - 20, tm.width + 8, 20);

    // Label text
    ctx.fillStyle = "#fff";
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(label, sx + 4, sy - 5);

    // Delete button (red circle with ×)
    var delR = 8;
    var delCx = sx + sw - delR - 4;
    var delCy = sy + delR + 4;
    ctx.beginPath();
    ctx.arc(delCx, delCy, delR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(220, 38, 38, 0.85)";
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("×", delCx, delCy);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  // Draw the current drag rectangle (blue dashed)
  if (isDrawing && drawStart && drawCurrent) {
    var rx = drawStart.x * w;
    var ry = drawStart.y * h;
    var rw = (drawCurrent.x - drawStart.x) * w;
    var rh = (drawCurrent.y - drawStart.y) * h;

    ctx.fillStyle = "rgba(59, 130, 246, 0.2)";
    ctx.fillRect(rx, ry, rw, rh);

    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);
  }
}


// ── Undo last seat ────────────────────────────────────────────
function undoSeat() {
  if (seats.length === 0) return;
  seats.pop();
  saveSeats();
  updateCalInfo();
  redrawCanvas();
}


// ── Clear all seats ───────────────────────────────────────────
function clearAllSeats() {
  seats = [];
  saveSeats();
  updateCalInfo();
  redrawCanvas();
}


// ── Update the calibrator info text ───────────────────────────
function updateCalInfo() {
  calInfo.textContent =
    seats.length + " seat" + (seats.length !== 1 ? "s" : "") +
    " defined — Click & drag to draw seats";
}


// ============================================================
// 6. SEAT API — Save and load seat definitions from backend
// ============================================================

// ── Save all seats to the backend ─────────────────────────────
function saveSeats() {
  fetch("/seats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seats: seats })
  })
  .then(function (res) { return res.json(); })
  .then(function (data) {
    console.log("[Seats] Saved", data.count, "seats");
  })
  .catch(function (err) {
    console.error("[Seats] Failed to save:", err);
  });
}


// ── Load seats from the backend on page load ──────────────────
function loadSeats() {
  fetch("/seats")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.seats) {
        seats = data.seats;
        updateCalInfo();
        console.log("[Seats] Loaded", seats.length, "seats");
      }
    })
    .catch(function (err) {
      console.error("[Seats] Failed to load:", err);
    });
}

loadSeats();
