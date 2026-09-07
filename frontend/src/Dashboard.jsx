import { useState, useEffect } from 'react'
import {
  Users,
  Wifi,
  WifiOff,
  Clock,
  MapPin,
  Activity,
  Video,
  VideoOff,
} from 'lucide-react'
import { useOccupancySocket } from './useOccupancySocket'

// ── WebSocket URL ────────────────────────────────────────────────
// In dev, the Vite proxy forwards /ws → ws://localhost:8000/ws.
// In production, point this to your deployed backend.
const WS_URL = `ws://${window.location.host}/ws`

// ── MJPEG stream URL (proxied through Vite in dev) ──────────────
const VIDEO_FEED_URL = '/video_feed'

// ── Helpers ──────────────────────────────────────────────────────
function getStatus(occupancy, total) {
  const ratio = occupancy / total
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
  const ratio = Math.min(value / max, 1)
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
          of {max}
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

// ── Live Video Feed ──────────────────────────────────────────────
function LiveVideoFeed() {
  const [hasError, setHasError] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  return (
    <div className="video-feed-container">
      {/* Header bar */}
      <div className="video-feed-header">
        <div className="flex items-center gap-2">
          {hasError ? <VideoOff size={14} /> : <Video size={14} />}
          <span>Live Camera Feed</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="animate-pulse-dot inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: hasError ? 'var(--color-accent-red)' : 'var(--color-accent-green)' }}
          />
          <span>{hasError ? 'Offline' : 'Recording'}</span>
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
        <img
          src={VIDEO_FEED_URL}
          alt="Live camera feed with person detection"
          className="video-feed-img"
          style={{ display: hasError ? 'none' : 'block' }}
          onLoad={() => setIsLoading(false)}
          onError={() => { setHasError(true); setIsLoading(false) }}
        />
      </div>
    </div>
  )
}

// ── Dashboard ────────────────────────────────────────────────────
export default function Dashboard() {
  const { data, status: wsStatus } = useOccupancySocket(WS_URL)
  const [now, setNow] = useState(new Date())

  // Tick the clock every second.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const occupancy = data?.occupancy ?? 0
  const totalSeats = data?.total_seats ?? 50
  const zone = data?.zone ?? 'Main Lab'
  const occupancyStatus = getStatus(occupancy, totalSeats)
  const percentage = Math.round((occupancy / totalSeats) * 100)

  return (
    <div className="dashboard-root">

      {/* ── Top bar ──────────────────────────────────────────── */}
      <header className="dashboard-header">
        <div className="flex items-center gap-2">
          <Activity size={16} style={{ color: 'var(--color-accent-green)' }} />
          <h1 className="text-base font-bold tracking-tight"
              style={{ color: 'var(--color-text-primary)' }}>
            Library Occupancy Tracker
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
          <LiveVideoFeed />
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
          <RingProgress value={occupancy} max={totalSeats} />

          {/* Fraction label */}
          <p className="text-center text-sm font-medium tracking-wide"
             style={{ color: 'var(--color-text-secondary)' }}>
            <span className="font-bold" style={{ color: 'var(--color-text-primary)' }}>
              {occupancy}
            </span>
            {' / '}
            {totalSeats} Seats Occupied
          </p>

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
        </section>
      </main>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer className="dashboard-footer">
        <p className="text-[10px] font-medium uppercase tracking-widest"
           style={{ color: 'var(--color-text-tertiary)' }}>
          Powered by YOLOv8 · Real-time Computer Vision
        </p>
      </footer>
    </div>
  )
}
