"""
AI Library Seat Occupancy Tracker — Backend
============================================
FastAPI server with YOLOv8 inference, seat-zone occupancy detection,
WebSocket broadcasting, and MJPEG video streaming with overlays.

Run:  uvicorn main:app --reload --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import List, Set

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from ultralytics import YOLO

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ZONE_NAME = "Main Lab"

# Video source: use 0 for the default webcam.
VIDEO_SOURCE = 0

# How often (in seconds) to broadcast occupancy updates.
BROADCAST_INTERVAL = 1.0

# YOLO confidence threshold for pose detection.
CONFIDENCE_THRESHOLD = 0.45

# Segmentation model uses a lower threshold for better recall.
SEG_CONFIDENCE_THRESHOLD = 0.30

# NMS IoU threshold — lower = more aggressive overlap merging.
NMS_IOU_THRESHOLD = 0.4

# ── Head-keypoint verification ──────────────────────────────────
HEAD_KP_INDICES = [0, 1, 2, 3, 4]
HEAD_KP_CONFIDENCE = 0.3
MIN_HEAD_KPS = 2

# ── Seat-zone overlap settings ──────────────────────────────────
# A seat is "occupied" if a person polygon overlaps >= this fraction of the seat.
OVERLAP_THRESHOLD = 0.15

# ── Temporal smoothing ──────────────────────────────────────────
# Once a seat is detected as occupied, hold that status for this many
# seconds even if the detection briefly disappears (prevents flicker).
OCCUPANCY_HOLD_SECONDS = 2.0

# Persistence file for seat definitions.
SEATS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seats.json")

# ---------------------------------------------------------------------------
# Seat zone data model
# ---------------------------------------------------------------------------

class SeatZoneIn(BaseModel):
    """Schema for creating / updating a seat zone (from the frontend)."""
    id: int
    label: str
    # Normalised coordinates (0..1) relative to the video frame dimensions.
    x1: float
    y1: float
    x2: float
    y2: float


class SeatZoneState:
    """Runtime state for a single seat zone."""

    def __init__(self, defn: SeatZoneIn):
        self.id = defn.id
        self.label = defn.label
        self.x1 = defn.x1
        self.y1 = defn.y1
        self.x2 = defn.x2
        self.y2 = defn.y2
        self.occupied = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "x1": self.x1,
            "y1": self.y1,
            "x2": self.x2,
            "y2": self.y2,
            "occupied": self.occupied,
        }

    def to_defn(self) -> dict:
        """Serialisable definition (no runtime state)."""
        return {
            "id": self.id,
            "label": self.label,
            "x1": self.x1,
            "y1": self.y1,
            "x2": self.x2,
            "y2": self.y2,
        }


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------
def _load_seats() -> List[SeatZoneState]:
    """Load seat definitions from disk."""
    if not os.path.exists(SEATS_FILE):
        return []
    try:
        with open(SEATS_FILE, "r") as f:
            raw = json.load(f)
        return [SeatZoneState(SeatZoneIn(**s)) for s in raw]
    except Exception as exc:
        print(f"[WARN] Failed to load seats.json: {exc}")
        return []


def _save_seats(seats: List[SeatZoneState]) -> None:
    """Persist seat definitions to disk."""
    with open(SEATS_FILE, "w") as f:
        json.dump([s.to_defn() for s in seats], f, indent=2)


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
seat_zones: List[SeatZoneState] = _load_seats()
_seat_lock = threading.Lock()

latest_occupancy: dict = {
    "zone": ZONE_NAME,
    "occupied_seats": 0,
    "total_seats": len(seat_zones),
    "seats": [],
    "person_count": 0,
    "timestamp": 0.0,
}

connected_clients: Set[WebSocket] = set()
inference_task: asyncio.Task | None = None

# Latest annotated frame (JPEG bytes) for MJPEG streaming.
_frame_lock = threading.Lock()
_latest_jpeg: bytes | None = None


# ---------------------------------------------------------------------------
# Person-contour merging  (prevents double-counting split detections)
# ---------------------------------------------------------------------------
def _merge_person_contours(
    person_contours: list[tuple[np.ndarray, tuple[int, int, int, int], float]],
) -> list[tuple[np.ndarray, tuple[int, int, int, int], float]]:
    """
    Merge person detections whose bounding boxes overlap significantly.

    When a hand or limb extends away from the body, the seg model may split
    one person into two blobs.  This function groups overlapping detections
    using union-find and returns one merged contour per real person.
    """
    n = len(person_contours)
    if n <= 1:
        return person_contours

    # ── Union-Find ──────────────────────────────────────────────
    parent = list(range(n))

    def _find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def _union(a: int, b: int) -> None:
        ra, rb = _find(a), _find(b)
        if ra != rb:
            parent[ra] = rb

    for i in range(n):
        bi = person_contours[i][1]
        area_i = max((bi[2] - bi[0]) * (bi[3] - bi[1]), 1)
        for j in range(i + 1, n):
            bj = person_contours[j][1]
            area_j = max((bj[2] - bj[0]) * (bj[3] - bj[1]), 1)

            # Intersection
            ix1 = max(bi[0], bj[0])
            iy1 = max(bi[1], bj[1])
            ix2 = min(bi[2], bj[2])
            iy2 = min(bi[3], bj[3])
            if ix1 >= ix2 or iy1 >= iy2:
                continue

            inter = (ix2 - ix1) * (iy2 - iy1)
            union_area = area_i + area_j - inter

            iou = inter / max(union_area, 1)
            # Containment: how much of the *smaller* bbox is covered?
            containment = inter / min(area_i, area_j)

            if iou > 0.15 or containment > 0.40:
                _union(i, j)

    # ── Group by root and merge ─────────────────────────────────
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(_find(i), []).append(i)

    merged: list[tuple[np.ndarray, tuple[int, int, int, int], float]] = []
    for indices in groups.values():
        if len(indices) == 1:
            merged.append(person_contours[indices[0]])
        else:
            # Combine all contour points → compute concave-ish hull.
            all_pts = np.concatenate(
                [person_contours[i][0] for i in indices], axis=0,
            )
            hull = cv2.convexHull(all_pts)

            # Union bounding box
            ux1 = min(person_contours[i][1][0] for i in indices)
            uy1 = min(person_contours[i][1][1] for i in indices)
            ux2 = max(person_contours[i][1][2] for i in indices)
            uy2 = max(person_contours[i][1][3] for i in indices)

            best_conf = max(person_contours[i][2] for i in indices)
            merged.append((hull, (ux1, uy1, ux2, uy2), best_conf))

    return merged


# ---------------------------------------------------------------------------
# Overlap logic — polygon-aware
# ---------------------------------------------------------------------------
def _polygon_seat_overlap_ratio(
    contour: np.ndarray,
    sx1: int, sy1: int, sx2: int, sy2: int,
) -> float:
    """
    Compute the fraction of the *seat* area covered by the person's
    segmentation contour polygon.  Returns 0..1.

    Uses cv2.fillPoly to rasterise both shapes into a small ROI, then
    counts overlapping pixels — fast and accurate.
    """
    seat_area = max((sx2 - sx1) * (sy2 - sy1), 1)

    # Clip contour to the seat bounding region for speed.
    # Shift coordinates so the seat top-left is (0,0).
    shifted = contour.copy()
    shifted[:, :, 0] -= sx1
    shifted[:, :, 1] -= sy1
    roi_w = sx2 - sx1
    roi_h = sy2 - sy1

    if roi_w <= 0 or roi_h <= 0:
        return 0.0

    # Rasterise the person polygon inside the seat ROI.
    mask = np.zeros((roi_h, roi_w), dtype=np.uint8)
    cv2.fillPoly(mask, [shifted], 255)

    inter_pixels = int(cv2.countNonZero(mask))
    return inter_pixels / seat_area


def _contour_center_in_rect(
    contour: np.ndarray,
    sx1: int, sy1: int, sx2: int, sy2: int,
) -> bool:
    """Check if the centroid of the person contour falls inside the seat rect."""
    M = cv2.moments(contour)
    if M["m00"] == 0:
        return False
    cx = M["m10"] / M["m00"]
    cy = M["m01"] / M["m00"]
    return sx1 <= cx <= sx2 and sy1 <= cy <= sy2


# Fallback rect-based helpers (used when segmentation mask is unavailable).
def _overlap_ratio(
    px1: int, py1: int, px2: int, py2: int,
    sx1: int, sy1: int, sx2: int, sy2: int,
) -> float:
    """
    Compute the fraction of the *seat* area that is covered by the person bbox.
    Returns 0..1.
    """
    inter_x1 = max(px1, sx1)
    inter_y1 = max(py1, sy1)
    inter_x2 = min(px2, sx2)
    inter_y2 = min(py2, sy2)

    if inter_x1 >= inter_x2 or inter_y1 >= inter_y2:
        return 0.0

    inter_area = (inter_x2 - inter_x1) * (inter_y2 - inter_y1)
    seat_area = max((sx2 - sx1) * (sy2 - sy1), 1)
    return inter_area / seat_area


def _center_in_rect(
    px1: int, py1: int, px2: int, py2: int,
    sx1: int, sy1: int, sx2: int, sy2: int,
) -> bool:
    """Check if the center of the person bbox falls inside the seat rect."""
    cx = (px1 + px2) / 2
    cy = (py1 + py2) / 2
    return sx1 <= cx <= sx2 and sy1 <= cy <= sy2


# ---------------------------------------------------------------------------
# YOLO inference loop — segmentation-based contours
# ---------------------------------------------------------------------------
async def _inference_loop() -> None:
    global latest_occupancy, _latest_jpeg

    # ── Load BOTH models ─────────────────────────────────────────
    #  • seg_model  → body contour for VISUAL outline only
    #  • pose_model → head+shoulder keypoints for SEAT DETECTION
    seg_model  = YOLO("yolov8n-seg.pt")
    pose_model = YOLO("yolov8n-pose.pt")

    cap = cv2.VideoCapture(VIDEO_SOURCE)
    if not cap.isOpened():
        print(f"[ERROR] Cannot open video source: {VIDEO_SOURCE}")
        return

    print(f"[INFO] Inference loop started — source: {VIDEO_SOURCE}")

    # Person contour style
    CONTOUR_COLOR = (0, 220, 100)       # green silhouette
    CONTOUR_THICKNESS = 2
    CONTOUR_FILL_ALPHA = 0.15           # subtle green fill inside the body
    LABEL_FONT = cv2.FONT_HERSHEY_SIMPLEX
    LABEL_SCALE = 0.50
    LABEL_COLOR = (255, 255, 255)

    # Seat overlay colours (BGR)
    SEAT_VACANT_COLOR = (180, 200, 50)      # teal-ish green
    SEAT_OCCUPIED_COLOR = (60, 60, 230)     # red
    SEAT_ALPHA = 0.25                        # transparency for the fill

    # Temporal smoothing: track when each seat was last seen occupied.
    seat_last_occupied: dict[int, float] = {}

    # COCO keypoints used for torso bbox (head + shoulders only):
    #   0=nose, 1=left_eye, 2=right_eye, 3=left_ear, 4=right_ear,
    #   5=left_shoulder, 6=right_shoulder
    TORSO_KP_INDICES = [0, 1, 2, 3, 4, 5, 6]
    TORSO_KP_MIN_CONF = 0.3

    try:
        while True:
            ret, frame = await asyncio.to_thread(cap.read)
            if not ret:
                if isinstance(VIDEO_SOURCE, str):
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                await asyncio.sleep(0.5)
                continue

            h, w = frame.shape[:2]
            now = time.time()

            # ── Run both models in parallel ──────────────────────
            def _run_seg():
                return list(seg_model.predict(
                    frame, conf=SEG_CONFIDENCE_THRESHOLD,
                    iou=NMS_IOU_THRESHOLD, classes=[0],
                    verbose=False, stream=True,
                ))

            def _run_pose():
                return list(pose_model.predict(
                    frame, conf=CONFIDENCE_THRESHOLD,
                    iou=NMS_IOU_THRESHOLD,
                    verbose=False, stream=True,
                ))

            seg_results, pose_results = await asyncio.gather(
                asyncio.to_thread(_run_seg),
                asyncio.to_thread(_run_pose),
            )

            # ── Extract torso bboxes from POSE model ─────────────
            # These tight head+shoulder boxes are used for SEAT DETECTION.
            # They deliberately exclude hands, elbows, knees, and feet.
            torso_boxes: list[tuple[int, int, int, int]] = []
            person_full_boxes: list[tuple[int, int, int, int]] = []

            for result in pose_results:
                if result.boxes is None or result.keypoints is None:
                    continue
                for idx in range(len(result.boxes)):
                    kp_data = result.keypoints[idx].data[0]
                    head_visible = sum(
                        1 for i in HEAD_KP_INDICES
                        if float(kp_data[i][2]) > HEAD_KP_CONFIDENCE
                    )
                    if head_visible < MIN_HEAD_KPS:
                        continue

                    x1, y1, x2, y2 = map(int, result.boxes[idx].xyxy[0])
                    person_full_boxes.append((x1, y1, x2, y2))

                    # Build tight bbox from head + shoulder keypoints only.
                    kp_xs, kp_ys = [], []
                    for ki in TORSO_KP_INDICES:
                        kx = float(kp_data[ki][0])
                        ky = float(kp_data[ki][1])
                        kc = float(kp_data[ki][2])
                        if kc > TORSO_KP_MIN_CONF:
                            kp_xs.append(kx)
                            kp_ys.append(ky)

                    if len(kp_xs) >= 2:
                        tw = max(kp_xs) - min(kp_xs)
                        th = max(kp_ys) - min(kp_ys)
                        pad_x = tw * 0.15
                        pad_y = th * 0.15
                        tx1 = int(max(min(kp_xs) - pad_x, 0))
                        ty1 = int(max(min(kp_ys) - pad_y, 0))
                        tx2 = int(min(max(kp_xs) + pad_x, w))
                        ty2 = int(min(max(kp_ys) + pad_y, h))
                        torso_boxes.append((tx1, ty1, tx2, ty2))
                    else:
                        torso_boxes.append((x1, y1, x2, y2))

            # ── Extract seg contours for VISUAL drawing only ─────
            # Only keep contours that match a pose-validated person
            # (i.e. at least 2 head/upper-body keypoints were visible).
            person_contours: list[np.ndarray] = []
            for result in seg_results:
                if result.boxes is None or result.masks is None:
                    continue
                for idx in range(len(result.boxes)):
                    sbx1, sby1, sbx2, sby2 = map(int, result.boxes[idx].xyxy[0])
                    seg_cx = (sbx1 + sbx2) / 2
                    seg_cy = (sby1 + sby2) / 2

                    # Must match a pose-validated person to be drawn.
                    matched = False
                    for (px1, py1, px2, py2) in person_full_boxes:
                        pose_cx = (px1 + px2) / 2
                        pose_cy = (py1 + py2) / 2
                        if abs(seg_cx - pose_cx) < w * 0.10 and abs(seg_cy - pose_cy) < h * 0.10:
                            matched = True
                            break
                    if not matched:
                        continue

                    mask_xy = result.masks[idx].xy
                    if len(mask_xy) == 0:
                        continue
                    poly = max(mask_xy, key=lambda p: len(p))
                    if len(poly) < 3:
                        continue
                    contour = poly.reshape(-1, 1, 2).astype(np.int32)
                    person_contours.append(contour)

            # ── Match people to seats using TORSO BBOX ───────────
            # Each person occupies at most ONE seat (the best match).
            # This prevents one person sitting between two zones from
            # triggering both as occupied.
            annotated = frame.copy()
            overlay = annotated.copy()

            with _seat_lock:
                seats_snapshot = list(seat_zones)

            # Convert seat coords to pixels once.
            seat_pixel_rects: list[tuple[int, int, int, int]] = []
            for seat in seats_snapshot:
                seat_pixel_rects.append((
                    int(seat.x1 * w), int(seat.y1 * h),
                    int(seat.x2 * w), int(seat.y2 * h),
                ))

            # For each person, find the seat with highest overlap and
            # assign them exclusively to that one seat.
            occupied_seat_ids: set[int] = set()
            for (tx1, ty1, tx2, ty2) in torso_boxes:
                best_seat_idx = -1
                best_overlap = 0.0

                for si, (sx1, sy1, sx2, sy2) in enumerate(seat_pixel_rects):
                    # Check center-in-rect first (strong signal).
                    if _center_in_rect(tx1, ty1, tx2, ty2, sx1, sy1, sx2, sy2):
                        ov = 1.0  # center inside = strongest match
                    else:
                        ov = _overlap_ratio(tx1, ty1, tx2, ty2, sx1, sy1, sx2, sy2)
                    if ov > best_overlap:
                        best_overlap = ov
                        best_seat_idx = si

                if best_seat_idx >= 0 and best_overlap >= OVERLAP_THRESHOLD:
                    occupied_seat_ids.add(seats_snapshot[best_seat_idx].id)

            for si, seat in enumerate(seats_snapshot):
                sx1, sy1, sx2, sy2 = seat_pixel_rects[si]
                detected_now = seat.id in occupied_seat_ids

                # Temporal smoothing
                if detected_now:
                    seat_last_occupied[seat.id] = now

                last_seen = seat_last_occupied.get(seat.id, 0.0)
                occupied = (now - last_seen) < OCCUPANCY_HOLD_SECONDS

                seat.occupied = occupied
                color = SEAT_OCCUPIED_COLOR if occupied else SEAT_VACANT_COLOR

                cv2.rectangle(overlay, (sx1, sy1), (sx2, sy2), color, -1)
                cv2.rectangle(annotated, (sx1, sy1), (sx2, sy2), color, 2)

                status_text = f"{seat.label}: {'Occupied' if occupied else 'Vacant'}"
                (tw_text, th_text), _ = cv2.getTextSize(status_text, LABEL_FONT, LABEL_SCALE, 1)
                label_bg_y1 = max(sy1 - th_text - 10, 0)
                cv2.rectangle(annotated, (sx1, label_bg_y1), (sx1 + tw_text + 8, sy1), color, -1)
                cv2.putText(annotated, status_text, (sx1 + 4, sy1 - 6),
                            LABEL_FONT, LABEL_SCALE, LABEL_COLOR, 1, cv2.LINE_AA)

            cv2.addWeighted(overlay, SEAT_ALPHA, annotated, 1 - SEAT_ALPHA, 0, annotated)

            # ── Draw person body contours (silhouettes) ──────────
            # Visual only — these do NOT affect seat detection.
            contour_overlay = annotated.copy()
            for contour in person_contours:
                cv2.fillPoly(contour_overlay, [contour], CONTOUR_COLOR)
                cv2.drawContours(annotated, [contour], -1, CONTOUR_COLOR, CONTOUR_THICKNESS, cv2.LINE_AA)
            cv2.addWeighted(contour_overlay, CONTOUR_FILL_ALPHA, annotated, 1 - CONTOUR_FILL_ALPHA, 0, annotated)

            # Top-left HUD
            occupied_count = sum(1 for s in seats_snapshot if s.occupied)
            total_count = len(seats_snapshot)
            person_count = len(person_full_boxes)

            hud_lines = [
                f"Seats: {occupied_count}/{total_count} occupied",
                f"People: {person_count}",
            ]
            for i, line in enumerate(hud_lines):
                y_pos = 28 + i * 26
                cv2.putText(annotated, line, (12, y_pos), LABEL_FONT, 0.7, (0, 0, 0), 3, cv2.LINE_AA)
                cv2.putText(annotated, line, (12, y_pos), LABEL_FONT, 0.7, (255, 255, 255), 2, cv2.LINE_AA)

            # Encode JPEG
            _, jpeg = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 75])
            with _frame_lock:
                _latest_jpeg = jpeg.tobytes()

            # Update shared occupancy state
            latest_occupancy = {
                "zone": ZONE_NAME,
                "occupied_seats": occupied_count,
                "total_seats": total_count,
                "seats": [s.to_dict() for s in seats_snapshot],
                "person_count": person_count,
                "timestamp": time.time(),
            }

            await asyncio.sleep(0.05)
    finally:
        cap.release()
        print("[INFO] Inference loop stopped — video capture released.")


# ---------------------------------------------------------------------------
# Broadcast loop
# ---------------------------------------------------------------------------
async def _broadcast_loop() -> None:
    while True:
        await asyncio.sleep(BROADCAST_INTERVAL)
        if not connected_clients:
            continue
        payload = json.dumps(latest_occupancy)
        stale: list[WebSocket] = []
        for ws in connected_clients:
            try:
                await ws.send_text(payload)
            except Exception:
                stale.append(ws)
        for ws in stale:
            connected_clients.discard(ws)


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global inference_task
    inference_task = asyncio.create_task(_inference_loop())
    broadcast_task = asyncio.create_task(_broadcast_loop())
    print("[INFO] Background tasks started.")
    yield
    inference_task.cancel()
    broadcast_task.cancel()
    print("[INFO] Background tasks cancelled.")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Library Seat Occupancy Tracker",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "zone": ZONE_NAME}


# ---------------------------------------------------------------------------
# Seat management endpoints
# ---------------------------------------------------------------------------
class SeatZoneListIn(BaseModel):
    seats: List[SeatZoneIn]


@app.get("/seats")
async def get_seats():
    """Return all defined seat zones."""
    with _seat_lock:
        return {"seats": [s.to_defn() for s in seat_zones]}


@app.post("/seats")
async def save_seats(body: SeatZoneListIn):
    """Replace all seat zones with the provided list."""
    global seat_zones, latest_occupancy
    new_zones = [SeatZoneState(s) for s in body.seats]
    with _seat_lock:
        seat_zones = new_zones
        _save_seats(seat_zones)
    latest_occupancy["total_seats"] = len(new_zones)
    print(f"[INFO] Saved {len(new_zones)} seat zone(s).")
    return {"status": "ok", "count": len(new_zones)}


@app.delete("/seats/{seat_id}")
async def delete_seat(seat_id: int):
    """Remove a single seat zone by id."""
    global seat_zones
    with _seat_lock:
        seat_zones = [s for s in seat_zones if s.id != seat_id]
        _save_seats(seat_zones)
    latest_occupancy["total_seats"] = len(seat_zones)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# MJPEG video stream
# ---------------------------------------------------------------------------
def _mjpeg_generator():
    while True:
        with _frame_lock:
            frame = _latest_jpeg
        if frame is None:
            time.sleep(0.1)
            continue
        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
        )
        time.sleep(0.05)


@app.get("/video_feed")
async def video_feed():
    return StreamingResponse(
        _mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/occupancy")
async def get_occupancy():
    return latest_occupancy


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)
    print(f"[WS] Client connected. Total: {len(connected_clients)}")
    try:
        await ws.send_text(json.dumps(latest_occupancy))
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        connected_clients.discard(ws)
        print(f"[WS] Client disconnected. Total: {len(connected_clients)}")
