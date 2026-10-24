import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Users,
  Wifi,
  WifiOff,
  Clock,
  MapPin,
  Activity,
  Video,
  VideoOff,
  Settings,
  Save,
  Trash2,
  X,
  Armchair,
} from 'lucide-react'
import { useOccupancySocket } from './useOccupancySocket'
import SeatCalibrator from './SeatCalibrator'

// ── WebSocket URL ────────────────────────────────────────────────
const WS_URL = `ws://${window.location.host}/ws`

// ── MJPEG stream URL (proxied through Vite in dev) ──────────────
const VIDEO_FEED_URL = '/video_feed'

// ── Helpers ──────────────────────────────────────────────────────
function getStatus(occupied, total) {
  if (total === 0) return { label: 'No Seats Defined', color: 'var(--color-text-tertiary)' }
  const ratio = occupied / total
  if (ratio >= 1) return { label: 'Full', color: 'var(--color-accent-red)' }
  if (ratio >= 0.8) return { label: 'Nearing Capacity', color: 'var(--color-accent-amber)' }
  return { label: 'Available', color: 'var(--color-accent-green)' }
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

// ── Ring Progress Component ──────────────────────────────────────
function RingProgress({ value, max, size = 180, strokeWidth = 10 }) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const ratio = max > 0 ? Math.min(value / max, 1) : 0
  const offset = circumference * (1 - ratio)
  const status = getStatus(value, max)

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Track */}
        <circle
          className="ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
        />
        {/* Fill */}
        <circle
          className="ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={status.color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>

      {/* Center label */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          key={value}
          className="animate-fade-up text-4xl font-black tracking-tight"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {value}
        </span>
        <span
          className="text-xs font-medium tracking-wide uppercase"
          style={{ color: 'var(--color-text-tertiary)' }}
        >
          of {max} seats
        </span>
      </div>
    </div>
  )
}

// ── Connection Badge ─────────────────────────────────────────────
function ConnectionBadge({ status }) {
  const isOnline = status === 'open'
  return (
    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest"
         style={{ color: isOnline ? 'var(--color-accent-green)' : 'var(--color-text-tertiary)' }}>
      {isOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
      {isOnline ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline'}
      {isOnline && (
        <span
          className="animate-pulse-dot inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: 'var(--color-accent-green)' }}
        />
      )}
    </div>
  )
}

// ── Seat Status Grid ─────────────────────────────────────────────
function SeatGrid({ seats }) {
  if (!seats || seats.length === 0) {
    return (
      <div className="seat-grid-empty">
        <Armchair size={24} style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }} />
        <span>No seats configured</span>
        <span className="text-[10px]">Click "Setup Seats" to define seat zones</span>
      </div>
    )
  }

  return (
    <div className="seat-grid">
      {seats.map((seat) => (
        <div
          key={seat.id}
          className={`seat-chip ${seat.occupied ? 'seat-chip-occupied' : 'seat-chip-vacant'}`}
          title={`${seat.label}: ${seat.occupied ? 'Occupied' : 'Vacant'}`}
        >
          <Armchair size={14} />
          <span className="seat-chip-label">{seat.label}</span>
          <span
            className="seat-chip-dot"
            style={{
              backgroundColor: seat.occupied
                ? 'var(--color-accent-red)'
                : 'var(--color-accent-green)',
            }}
          />
        </div>
      ))}
    </div>
  )
}

// ── Live Video Feed ──────────────────────────────────────────────
function LiveVideoFeed({ calibrating, onCalibrate, seats, onSeatsChange }) {
  const [hasError, setHasError] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  return (
    <div className="video-feed-container">
      {/* Header bar */}
      <div className="video-feed-header">
        <div className="flex items-center gap-2">
          {hasError ? <VideoOff size={14} /> : <Video size={14} />}
          <span>{calibrating ? 'Seat Calibration Mode' : 'Live Camera Feed'}</span>
        </div>
        <div className="flex items-center gap-3">
          {!calibrating && (
            <button className="setup-seats-btn" onClick={() => onCalibrate(true)}>
              <Settings size={12} />
              Setup Seats
            </button>
          )}
          {calibrating && (
            <button className="setup-seats-btn cancel" onClick={() => onCalibrate(false)}>
              <X size={12} />
              Exit Setup
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <span
              className="animate-pulse-dot inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: hasError ? 'var(--color-accent-red)' : 'var(--color-accent-green)' }}
            />
            <span>{hasError ? 'Offline' : 'Recording'}</span>
          </div>
        </div>
      </div>

      {/* Video frame */}
      <div className="video-feed-frame">
        {isLoading && !hasError && (
          <div className="video-feed-placeholder">
            <Video size={40} style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }} />
            <span>Connecting to camera…</span>
          </div>
        )}
        {hasError && (
          <div className="video-feed-placeholder">
            <VideoOff size={40} style={{ color: 'var(--color-accent-red)', opacity: 0.6 }} />
            <span>Camera feed unavailable</span>
            <button
              className="video-feed-retry"
              onClick={() => { setHasError(false); setIsLoading(true) }}
            >
              Retry
            </button>
          </div>
        )}

        {calibrating ? (
          <SeatCalibrator
            videoUrl={VIDEO_FEED_URL}
            seats={seats}
            onSeatsChange={onSeatsChange}
            onVideoError={() => { setHasError(true); setIsLoading(false) }}
            onVideoLoad={() => setIsLoading(false)}
          />
        ) : (
          <img
            src={VIDEO_FEED_URL}
            alt="Live camera feed with seat detection"
            className="video-feed-img"
            style={{ display: hasError ? 'none' : 'block' }}
            onLoad={() => setIsLoading(false)}
            onError={() => { setHasError(true); setIsLoading(false) }}
          />
        )}
      </div>
    </div>
  )
}

// ── Dashboard ────────────────────────────────────────────────────
export default function Dashboard() {
  const { data, status: wsStatus } = useOccupancySocket(WS_URL)
  const [now, setNow] = useState(new Date())
  const [calibrating, setCalibrating] = useState(false)
  const [localSeats, setLocalSeats] = useState([])

  // Tick the clock every second.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  // Load saved seats on mount.
  useEffect(() => {
    fetch('/seats')
      .then((r) => r.json())
      .then((d) => { if (d.seats) setLocalSeats(d.seats) })
      .catch(() => {})
  }, [])

  const handleSeatsChange = useCallback(async (newSeats) => {
    setLocalSeats(newSeats)
    try {
      await fetch('/seats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seats: newSeats }),
      })
    } catch (err) {
      console.error('[Seats] Failed to save:', err)
    }
  }, [])

  const occupiedSeats = data?.occupied_seats ?? 0
  const totalSeats = data?.total_seats ?? localSeats.length
  const zone = data?.zone ?? 'Main Lab'
  const personCount = data?.person_count ?? 0
  const seatStatuses = data?.seats ?? localSeats.map((s) => ({ ...s, occupied: false }))
  const occupancyStatus = getStatus(occupiedSeats, totalSeats)
  const percentage = totalSeats > 0 ? Math.round((occupiedSeats / totalSeats) * 100) : 0

  return (
    <div className="dashboard-root">

      {/* ── Top bar ──────────────────────────────────────────── */}
      <header className="dashboard-header">
        <div className="flex items-center gap-2">
          <Activity size={16} style={{ color: 'var(--color-accent-green)' }} />
          <h1 className="text-base font-bold tracking-tight"
              style={{ color: 'var(--color-text-primary)' }}>
            Library Seat Occupancy Tracker
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs"
               style={{ color: 'var(--color-text-tertiary)' }}>
            <Clock size={12} />
            <time>{formatTime(now)}</time>
          </div>
          <ConnectionBadge status={wsStatus} />
        </div>
      </header>

      {/* ── Main content — two-panel layout ───────────────────── */}
      <main className="dashboard-main">

        {/* Left: Live video feed */}
        <section className="dashboard-panel-video">
          <LiveVideoFeed
            calibrating={calibrating}
            onCalibrate={setCalibrating}
            seats={localSeats}
            onSeatsChange={handleSeatsChange}
          />
        </section>

        {/* Right: Occupancy stats */}
        <section className="dashboard-panel-stats">
          {/* Zone & date */}
          <div className="flex flex-col items-center gap-1">
            <div className="flex items-center gap-2">
              <MapPin size={16} style={{ color: 'var(--color-text-tertiary)' }} />
              <h2 className="text-lg font-semibold tracking-tight"
                  style={{ color: 'var(--color-text-primary)' }}>
                {zone}
              </h2>
            </div>
            <div className="flex items-center gap-1.5 text-xs"
                 style={{ color: 'var(--color-text-tertiary)' }}>
              <Users size={12} />
              <span>{formatDate(now)}</span>
            </div>
          </div>

          {/* Ring progress */}
          <RingProgress value={occupiedSeats} max={totalSeats} />

          {/* Fraction label */}
          <p className="text-center text-sm font-medium tracking-wide"
             style={{ color: 'var(--color-text-secondary)' }}>
            <span className="font-bold" style={{ color: 'var(--color-text-primary)' }}>
              {occupiedSeats}
            </span>
            {' / '}
            {totalSeats} Seats Occupied
          </p>

          {/* People detected (secondary info) */}
          <div className="flex items-center gap-1.5 text-xs"
               style={{ color: 'var(--color-text-tertiary)' }}>
            <Users size={12} />
            <span>{personCount} {personCount === 1 ? 'person' : 'people'} detected</span>
          </div>

          {/* Status pill */}
          <div
            className="rounded-full px-5 py-1.5 text-xs font-bold uppercase tracking-widest"
            style={{
              backgroundColor: occupancyStatus.color + '18',
              color: occupancyStatus.color,
              border: `1px solid ${occupancyStatus.color}30`,
            }}
          >
            {occupancyStatus.label}
          </div>

          {/* Capacity bar */}
          <div className="w-full max-w-xs">
            <div className="flex items-center justify-between text-xs font-medium mb-1.5"
                 style={{ color: 'var(--color-text-tertiary)' }}>
              <span>Capacity</span>
              <span>{percentage}%</span>
            </div>
            <div className="h-2 w-full rounded-full overflow-hidden"
                 style={{ backgroundColor: 'var(--color-border)' }}>
              <div
                className="h-full rounded-full transition-all duration-700 ease-out"
                style={{
                  width: `${Math.min(percentage, 100)}%`,
                  backgroundColor: occupancyStatus.color,
                }}
              />
            </div>
          </div>

          {/* Seat grid */}
          <SeatGrid seats={seatStatuses} />
        </section>
      </main>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer className="dashboard-footer">
        <p className="text-[10px] font-medium uppercase tracking-widest"
           style={{ color: 'var(--color-text-tertiary)' }}>
          Powered by YOLOv8 · Seat-Zone Occupancy Detection
        </p>
      </footer>
    </div>
  )
}
