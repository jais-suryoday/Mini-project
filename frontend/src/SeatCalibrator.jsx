import { useState, useRef, useEffect, useCallback } from 'react'
import { Save, Trash2, Undo2 } from 'lucide-react'

/**
 * SeatCalibrator — draw seat-zone rectangles on top of the live MJPEG feed.
 *
 * Props:
 *   videoUrl      — MJPEG stream URL
 *   seats         — current seat definitions [{ id, label, x1, y1, x2, y2 }]
 *   onSeatsChange — callback(newSeats) to persist changes
 *   onVideoError  — called if the video stream fails
 *   onVideoLoad   — called when the first video frame loads
 */
export default function SeatCalibrator({ videoUrl, seats, onSeatsChange, onVideoError, onVideoLoad }) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const imgRef = useRef(null)

  const [drawing, setDrawing] = useState(false)
  const [startPt, setStartPt] = useState(null)
  const [currentPt, setCurrentPt] = useState(null)
  const [localSeats, setLocalSeats] = useState(seats || [])
  const [imgLoaded, setImgLoaded] = useState(false)

  // Sync from parent when seats prop changes (e.g. initial load).
  useEffect(() => {
    setLocalSeats(seats || [])
  }, [seats])

  // ── Coordinate helpers ──────────────────────────────────────
  const getRelativePos = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    }
  }, [])

  // ── Redraw canvas ───────────────────────────────────────────
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width
    const h = canvas.height

    ctx.clearRect(0, 0, w, h)

    // Draw existing seats
    localSeats.forEach((seat) => {
      const sx = seat.x1 * w
      const sy = seat.y1 * h
      const sw = (seat.x2 - seat.x1) * w
      const sh = (seat.y2 - seat.y1) * h

      // Filled with alpha
      ctx.fillStyle = 'rgba(34, 197, 94, 0.18)'
      ctx.fillRect(sx, sy, sw, sh)

      // Border
      ctx.strokeStyle = '#22c55e'
      ctx.lineWidth = 2
      ctx.strokeRect(sx, sy, sw, sh)

      // Label
      ctx.font = 'bold 13px Inter, system-ui, sans-serif'
      ctx.fillStyle = '#22c55e'
      const label = seat.label
      const tm = ctx.measureText(label)
      const lh = 18

      // Label background
      ctx.fillStyle = 'rgba(0,0,0,0.65)'
      ctx.fillRect(sx, sy - lh - 2, tm.width + 8, lh + 2)

      ctx.fillStyle = '#fff'
      ctx.fillText(label, sx + 4, sy - 5)

      // Delete button circle (top-right corner)
      const delR = 8
      const delCx = sx + sw - delR - 4
      const delCy = sy + delR + 4
      ctx.beginPath()
      ctx.arc(delCx, delCy, delR, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(220, 38, 38, 0.85)'
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 11px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('×', delCx, delCy)
      ctx.textAlign = 'start'
      ctx.textBaseline = 'alphabetic'
    })

    // Draw current drag rectangle
    if (drawing && startPt && currentPt) {
      const sx = startPt.x * w
      const sy = startPt.y * h
      const sw = (currentPt.x - startPt.x) * w
      const sh = (currentPt.y - startPt.y) * h

      ctx.fillStyle = 'rgba(59, 130, 246, 0.2)'
      ctx.fillRect(sx, sy, sw, sh)

      ctx.strokeStyle = '#3b82f6'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.strokeRect(sx, sy, sw, sh)
      ctx.setLineDash([])
    }
  }, [localSeats, drawing, startPt, currentPt])

  // Redraw whenever state changes.
  useEffect(() => {
    redraw()
  }, [redraw])

  // Resize canvas to match the container.
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current
      const container = containerRef.current
      if (!canvas || !container) return
      canvas.width = container.offsetWidth
      canvas.height = container.offsetHeight
      redraw()
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [redraw, imgLoaded])

  // ── Mouse handlers ──────────────────────────────────────────
  const handleMouseDown = (e) => {
    // Check if clicking a delete button
    const pos = getRelativePos(e)
    if (!pos) return

    const canvas = canvasRef.current
    const w = canvas.width
    const h = canvas.height

    for (const seat of localSeats) {
      const sx = seat.x1 * w
      const sy = seat.y1 * h
      const sw = (seat.x2 - seat.x1) * w

      const delR = 8
      const delCx = sx + sw - delR - 4
      const delCy = sy + delR + 4

      const dx = pos.x * w - delCx
      const dy = pos.y * h - delCy
      if (dx * dx + dy * dy <= delR * delR) {
        // Delete this seat
        const updated = localSeats.filter((s) => s.id !== seat.id)
        setLocalSeats(updated)
        onSeatsChange(updated)
        return
      }
    }

    setDrawing(true)
    setStartPt(pos)
    setCurrentPt(pos)
  }

  const handleMouseMove = (e) => {
    if (!drawing) return
    const pos = getRelativePos(e)
    if (pos) setCurrentPt(pos)
  }

  const handleMouseUp = () => {
    if (!drawing || !startPt || !currentPt) {
      setDrawing(false)
      return
    }

    // Require minimum size (at least 2% of frame in each dimension)
    const dw = Math.abs(currentPt.x - startPt.x)
    const dh = Math.abs(currentPt.y - startPt.y)
    if (dw < 0.02 || dh < 0.02) {
      setDrawing(false)
      setStartPt(null)
      setCurrentPt(null)
      return
    }

    const nextId = localSeats.length > 0
      ? Math.max(...localSeats.map((s) => s.id)) + 1
      : 1

    const newSeat = {
      id: nextId,
      label: `Seat ${nextId}`,
      x1: Math.min(startPt.x, currentPt.x),
      y1: Math.min(startPt.y, currentPt.y),
      x2: Math.max(startPt.x, currentPt.x),
      y2: Math.max(startPt.y, currentPt.y),
    }

    const updated = [...localSeats, newSeat]
    setLocalSeats(updated)
    onSeatsChange(updated)

    setDrawing(false)
    setStartPt(null)
    setCurrentPt(null)
  }

  const handleClearAll = () => {
    setLocalSeats([])
    onSeatsChange([])
  }

  const handleUndo = () => {
    if (localSeats.length === 0) return
    const updated = localSeats.slice(0, -1)
    setLocalSeats(updated)
    onSeatsChange(updated)
  }

  return (
    <div className="calibrator-root">
      <div className="calibrator-frame" ref={containerRef}>
        <img
          ref={imgRef}
          src={videoUrl}
          alt="Camera feed for seat calibration"
          className="calibrator-video"
          onLoad={() => { setImgLoaded(true); onVideoLoad?.() }}
          onError={() => onVideoError?.()}
        />
        <canvas
          ref={canvasRef}
          className="calibrator-canvas"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />
      </div>

      {/* Toolbar */}
      <div className="calibrator-toolbar">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
            {localSeats.length} seat{localSeats.length !== 1 ? 's' : ''} defined
          </span>
          <span className="text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>
            — Click & drag to draw seats
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="calibrator-btn"
            onClick={handleUndo}
            disabled={localSeats.length === 0}
            title="Undo last seat"
          >
            <Undo2 size={13} />
            Undo
          </button>
          <button
            className="calibrator-btn danger"
            onClick={handleClearAll}
            disabled={localSeats.length === 0}
            title="Clear all seats"
          >
            <Trash2 size={13} />
            Clear All
          </button>
        </div>
      </div>
    </div>
  )
}
