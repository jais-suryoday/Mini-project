"""
AI Library Seat Occupancy Tracker — Backend
============================================
FastAPI server with YOLOv8 inference and WebSocket broadcasting.

Run:  uvicorn main:app --reload --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from typing import Set

import cv2
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
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

# YOLO confidence threshold — keeps detections tight.
CONFIDENCE_THRESHOLD = 0.40

# COCO class ID for "person" is 0.
PERSON_CLASS_ID = 0

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


# ---------------------------------------------------------------------------
# YOLO inference loop (runs in a background thread via asyncio)
# ---------------------------------------------------------------------------
async def _inference_loop() -> None:
    """
    Continuously reads frames from the video source, runs YOLOv8 detection,
    counts the number of people, and updates `latest_occupancy`.
    """
    global latest_occupancy

    # Load model — yolov8n is the nano variant, ideal for CPU / Apple Silicon.
    model = YOLO("yolov8n.pt")

    cap = cv2.VideoCapture(VIDEO_SOURCE)
    if not cap.isOpened():
        print(f"[ERROR] Cannot open video source: {VIDEO_SOURCE}")
        return

    print(f"[INFO] Inference loop started — source: {VIDEO_SOURCE}")

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
                        verbose=False,
                        stream=True,
                    )
                )
            )

            person_count = 0
            for result in results:
                for box in result.boxes:
                    if int(box.cls[0]) == PERSON_CLASS_ID:
                        person_count += 1

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
