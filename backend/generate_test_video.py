"""
Generate a synthetic test video with colored rectangles simulating people.
YOLOv8 won't detect these as real people, but this verifies the pipeline.

For a real demo, replace test_video.mp4 with actual footage of people.
You can record a short clip with your phone and transfer it.
"""

import cv2
import numpy as np
import random

WIDTH, HEIGHT = 640, 480
FPS = 15
DURATION = 30  # seconds
OUTPUT = "test_video.mp4"

fourcc = cv2.VideoWriter_fourcc(*"mp4v")
out = cv2.VideoWriter(OUTPUT, fourcc, FPS, (WIDTH, HEIGHT))

# Simulate 3-7 "people" as moving colored blobs per frame.
for frame_idx in range(FPS * DURATION):
    img = np.full((HEIGHT, WIDTH, 3), 240, dtype=np.uint8)  # light gray bg

    # Draw a "library" background — table, chairs
    cv2.rectangle(img, (50, 300), (590, 320), (180, 180, 180), -1)  # table
    
    num_people = 3 + (frame_idx // (FPS * 5)) % 5  # slowly changes 3→7
    
    for i in range(num_people):
        seed = frame_idx * 100 + i
        rng = random.Random(seed)
        cx = 80 + i * 90 + rng.randint(-10, 10)
        cy = 220 + rng.randint(-15, 15)
        
        # Body (torso rectangle)
        color = (rng.randint(40, 120), rng.randint(40, 120), rng.randint(80, 180))
        cv2.rectangle(img, (cx - 15, cy), (cx + 15, cy + 80), color, -1)
        
        # Head (circle)
        skin = (180, 200, 220)
        cv2.circle(img, (cx, cy - 15), 18, skin, -1)

    # Add frame counter text
    cv2.putText(
        img, f"Frame {frame_idx}/{FPS * DURATION}",
        (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (100, 100, 100), 1
    )

    out.write(img)

out.release()
print(f"[OK] Generated {OUTPUT} — {DURATION}s @ {FPS}fps, {FPS * DURATION} frames")
