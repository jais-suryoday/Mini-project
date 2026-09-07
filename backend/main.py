"""
AI Library Seat Occupancy Tracker — Backend
============================================
FastAPI server with YOLOv8 inference, WebSocket broadcasting,
and MJPEG video streaming with bounding-box overlays.

Run:  uvicorn main:app --reload --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from contextlib import asynccontextmanager
from typing import Set

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from ultralytics import YOLO

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ZONE_NAME = "Main Lab"
TOTAL_SEATS = 50

# Video source: use 0 for the default webcam.
# To use a video file instead, change to a path string, e.g.:
#   VIDEO_SOURCE = "test_video.mp4"
VIDEO_SOURCE = 0

# How often (in seconds) to broadcast occupancy updates.
BROADCAST_INTERVAL = 1.0

# YOLO confidence threshold for pose detection.
CONFIDENCE_THRESHOLD = 0.45

# NMS IoU threshold — lower = more aggressive overlap merging.
NMS_IOU_THRESHOLD = 0.4

# ── Head-keypoint verification ──────────────────────────────────
# COCO pose keypoints: 0=nose, 1=left_eye, 2=right_eye, 3=left_ear, 4=right_ear
# A detection only counts as a "person" if at least MIN_HEAD_KPS of these
# 5 head keypoints are visible. This completely ignores hands/feet/elbows.
HEAD_KP_INDICES = [0, 1, 2, 3, 4]
HEAD_KP_CONFIDENCE = 0.3   # min confidence for a keypoint to count as "visible"
MIN_HEAD_KPS = 2            # need at least 2 visible head keypoints

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
latest_occupancy: dict = {
    "zone": ZONE_NAME,
    "occupancy": 0,
    "total_seats": TOTAL_SEATS,
    "timestamp": 0.0,
}

connected_clients: Set[WebSocket] = set()
inference_task: asyncio.Task | None = None

# Latest annotated frame (JPEG bytes) for MJPEG streaming.
_frame_lock = threading.Lock()
_latest_jpeg: bytes | None = None


# ---------------------------------------------------------------------------
# YOLO inference loop (runs in a background thread via asyncio)
# ---------------------------------------------------------------------------
async def _inference_loop() -> None:
    """
    Continuously reads frames from the video source, runs YOLOv8 detection,
    counts the number of people, draws bounding boxes, and updates shared state.
    """
    global latest_occupancy, _latest_jpeg

    # Load pose model — detects full-body skeletons with keypoints.
    # This lets us verify head visibility and ignore limb-only detections.
    model = YOLO("yolov8n-pose.pt")

    cap = cv2.VideoCapture(VIDEO_SOURCE)
    if not cap.isOpened():
        print(f"[ERROR] Cannot open video source: {VIDEO_SOURCE}")
        return

    print(f"[INFO] Inference loop started — source: {VIDEO_SOURCE}")

    # Bounding-box style
    BOX_COLOR = (0, 220, 100)       # green (BGR)
    BOX_THICKNESS = 2
    LABEL_FONT = cv2.FONT_HERSHEY_SIMPLEX
    LABEL_SCALE = 0.55
    LABEL_COLOR = (255, 255, 255)   # white text
    LABEL_BG = (0, 180, 80)         # darker green bg

    try:
        while True:
            ret, frame = await asyncio.to_thread(cap.read)
            if not ret:
                # If reading from a file, loop back to the start.
                if isinstance(VIDEO_SOURCE, str):
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                # Webcam failure — wait briefly and retry.
                await asyncio.sleep(0.5)
                continue

            # Run detection (stream=True returns a generator — memory efficient).
            results = await asyncio.to_thread(
                lambda: list(
                    model.predict(
                        frame,
                        conf=CONFIDENCE_THRESHOLD,
                        iou=NMS_IOU_THRESHOLD,
                        verbose=False,
                        stream=True,
                    )
                )
            )

            person_count = 0
            annotated = frame.copy()

            for result in results:
                if result.boxes is None or result.keypoints is None:
                    continue

                for idx in range(len(result.boxes)):
                    box = result.boxes[idx]
                    x1, y1, x2, y2 = map(int, box.xyxy[0])

                    # ── Head-keypoint gate ─────────────────────────
                    # Only count this detection if we can see the head.
                    kp_data = result.keypoints[idx].data[0]  # (17, 3)
                    head_visible = sum(
                        1 for i in HEAD_KP_INDICES
                        if float(kp_data[i][2]) > HEAD_KP_CONFIDENCE
                    )
                    if head_visible < MIN_HEAD_KPS:
                        continue  # no head → hand / foot / limb → skip

                    person_count += 1
                    conf = float(box.conf[0])

                    # Draw bounding box
                    cv2.rectangle(annotated, (x1, y1), (x2, y2), BOX_COLOR, BOX_THICKNESS)

                    # Draw label background + text
                    label = f"Person {conf:.0%}"
                    (tw, th), _ = cv2.getTextSize(label, LABEL_FONT, LABEL_SCALE, 1)
                    cv2.rectangle(annotated, (x1, y1 - th - 10), (x1 + tw + 8, y1), LABEL_BG, -1)
                    cv2.putText(annotated, label, (x1 + 4, y1 - 6), LABEL_FONT, LABEL_SCALE, LABEL_COLOR, 1, cv2.LINE_AA)

            # Draw occupancy overlay in top-left corner
            overlay_text = f"People: {person_count}"
            cv2.putText(annotated, overlay_text, (12, 32), LABEL_FONT, 0.8, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(annotated, overlay_text, (12, 32), LABEL_FONT, 0.8, BOX_COLOR, 2, cv2.LINE_AA)

            # Encode the annotated frame as JPEG and store it
            _, jpeg = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 75])
            with _frame_lock:
                _latest_jpeg = jpeg.tobytes()

            latest_occupancy = {
                "zone": ZONE_NAME,
                "occupancy": person_count,
                "total_seats": TOTAL_SEATS,
                "timestamp": time.time(),
            }

            # Yield control so the broadcast loop and WebSocket handlers run.
            await asyncio.sleep(0.05)
    finally:
        cap.release()
        print("[INFO] Inference loop stopped — video capture released.")


# ---------------------------------------------------------------------------
# Broadcast loop — pushes updates to every connected WebSocket client.
# ---------------------------------------------------------------------------
async def _broadcast_loop() -> None:
    """Send the latest occupancy snapshot to all connected clients."""
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

        # Clean up dead connections.
        for ws in stale:
            connected_clients.discard(ws)


# ---------------------------------------------------------------------------
# Application lifespan — start / stop background tasks cleanly.
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
    version="1.0.0",
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
    """Simple health-check endpoint."""
    return {"status": "ok", "zone": ZONE_NAME}


# ---------------------------------------------------------------------------
# MJPEG video stream — serves annotated frames to the browser.
# ---------------------------------------------------------------------------
def _mjpeg_generator():
    """Yield JPEG frames as an MJPEG multipart stream."""
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
        time.sleep(0.05)  # ~20 fps cap for the stream


@app.get("/video_feed")
async def video_feed():
    """MJPEG stream of the live camera with bounding-box overlays."""
    return StreamingResponse(
        _mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/occupancy")
async def get_occupancy():
    """REST fallback — returns the latest occupancy snapshot."""
    return latest_occupancy


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """
    WebSocket endpoint.
    On connect, immediately sends the latest snapshot, then the broadcast
    loop keeps sending updates every BROADCAST_INTERVAL seconds.
    """
    await ws.accept()
    connected_clients.add(ws)
    print(f"[WS] Client connected. Total: {len(connected_clients)}")

    try:
        # Send the current state immediately on connect.
        await ws.send_text(json.dumps(latest_occupancy))

        # Keep the connection alive — listen for any incoming messages
        # (we don't expect any, but this keeps the socket open).
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        connected_clients.discard(ws)
        print(f"[WS] Client disconnected. Total: {len(connected_clients)}")
