import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './contexts/AuthContext'
import './App.css'

const ENCODER_LEGEND = [
  { key: 'frontLeft', label: 'Front Left', color: '#111111' },
  { key: 'frontRight', label: 'Front Right', color: '#444444' },
  { key: 'rearLeft', label: 'Rear Left', color: '#777777' },
  { key: 'rearRight', label: 'Rear Right', color: '#aaaaaa' },
] as const

const GRAPH_W = 640
const GRAPH_H = 240
const PADDING_LEFT = 78
const PADDING_RIGHT = 14
const PADDING_TOP = 14
const PADDING_BOTTOM = 58

// --- CONFIGURATION ---
const DEFAULT_HOST = '10.104.2.157'
const DEFAULT_TELEMETRY_WS = `ws://${DEFAULT_HOST}:8000/ws/telemetry`

// Teleop command repeat interval (ms) - must be shorter than motor watchdog timeout
const TELEOP_REPEAT_INTERVAL = 100

type Telemetry = {
  timestamp: string
  encoders: { frontLeft: number; frontRight: number; rearLeft: number; rearRight: number }
  jetson: { cpuTemp: number; gpuTemp: number }
  power: { voltage: number; soc: number }
  motor?: {
    torqueOzIn: number
    speedRpm: number
    currentMa: number
    outputPowerW: number
    inputPowerW: number
    efficiency: number
  }
}

type ConnectionState = 'connecting' | 'open' | 'closed' | 'error'
type TeleopDirection = 'forward' | 'backward' | 'left' | 'right' | 'stop'

const DEFAULT_TELEMETRY: Telemetry = {
  timestamp: '',
  encoders: { frontLeft: 0, frontRight: 0, rearLeft: 0, rearRight: 0 },
  jetson: { cpuTemp: 0, gpuTemp: 0 },
  power: { voltage: 0, soc: 0 },
  motor: {
    torqueOzIn: 0,
    speedRpm: 0,
    currentMa: 0,
    outputPowerW: 0,
    inputPowerW: 0,
    efficiency: 0,
  },
}

const readStoredUrl = (key: string, fallback: string) => {
  if (typeof window === 'undefined') return fallback
  try {
    return window.localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

const writeStoredUrl = (key: string, value: string) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

function App() {
  const { logout, user, getAccessToken } = useAuth()

  const [telemetry, setTelemetry] = useState<Telemetry>(DEFAULT_TELEMETRY)
  const [connection, setConnection] = useState<ConnectionState>('connecting')

  // Controls the view source (RGB vs Depth)
  const [feedMode, setFeedMode] = useState<'rgb' | 'depth'>('rgb')

  const [telemetryWsUrl, setTelemetryWsUrl] = useState(() =>
    readStoredUrl('telemetryWsUrl', DEFAULT_TELEMETRY_WS),
  )

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'rover' | 'operations'>('rover')
  const [lastUpdate, setLastUpdate] = useState<string>('')
  const [startTime] = useState(() => Date.now())
  const [encoderHistory, setEncoderHistory] = useState<
    { t: number; frontLeft: number; frontRight: number; rearLeft: number; rearRight: number }[]
  >([])

  const [activeTeleop, setActiveTeleop] = useState<TeleopDirection | null>(null)
  const teleopIntervalRef = useRef<number | null>(null)

  // SLAM mini-map state (SLAM always active)
  const [mapImage, setMapImage] = useState<string | null>(null)
  const [mapStatus, setMapStatus] = useState<'idle' | 'waiting' | 'ready'>('idle')

  // --- DERIVED URLS ---
  const { apiBaseUrl, videoStreamUrl } = useMemo(() => {
    try {
      const urlObj = new URL(telemetryWsUrl)
      const host = urlObj.hostname

      const apiProtocol = urlObj.protocol === 'wss:' ? 'https:' : 'http:'
      const apiBase = `${apiProtocol}//${host}:8000`
      const videoBase = `http://${host}:8080`

      const topic = feedMode === 'rgb'
        ? '/helios/zed_node/rgb/color/rect/image'
        : '/helios/zed_node/depth/depth_registered'

      const streamUrl = `${videoBase}/stream?topic=${topic}&type=mjpeg&quality=100&width=1280&height=720`

      return { apiBaseUrl: apiBase, videoStreamUrl: streamUrl }
    } catch {
      return { apiBaseUrl: 'http://localhost:8000', videoStreamUrl: '' }
    }
  }, [telemetryWsUrl, feedMode])

  // --- TELEOP & SLAM HANDLERS ---
  const issueTeleopCommand = useCallback(
    async (direction: TeleopDirection) => {
      try {
        const token = await getAccessToken()
        await fetch(`${apiBaseUrl}/teleop`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ direction }),
        })
      } catch (err) {
        console.error('Failed to send teleop command', err)
      }
    },
    [apiBaseUrl, getAccessToken],
  )

  const handleTeleopStop = useCallback(() => {
    setActiveTeleop(null)
    // Clear the repeat interval
    if (teleopIntervalRef.current !== null) {
      clearInterval(teleopIntervalRef.current)
      teleopIntervalRef.current = null
    }
    issueTeleopCommand('stop')
  }, [issueTeleopCommand])

  const handleTeleopStart = useCallback(
    (direction: TeleopDirection) => {
      if (direction === 'stop') {
        handleTeleopStop()
        return
      }
      // Invert forward/backward to correct motor direction
      const commandDirection = direction === 'forward' ? 'backward'
        : direction === 'backward' ? 'forward'
        : direction
      setActiveTeleop(direction)
      issueTeleopCommand(commandDirection)

      // Clear any existing interval
      if (teleopIntervalRef.current !== null) {
        clearInterval(teleopIntervalRef.current)
      }
      // Send commands repeatedly while key is held (keeps motor watchdog happy)
      teleopIntervalRef.current = window.setInterval(() => {
        issueTeleopCommand(commandDirection)
      }, TELEOP_REPEAT_INTERVAL)
    },
    [issueTeleopCommand, handleTeleopStop],
  )

  // Poll SLAM map (SLAM always active now)
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const poll = async () => {
      try {
        const token = await getAccessToken()
        const res = await fetch(`${apiBaseUrl}/map_snapshot`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        })
        if (!res.ok) {
          if (!cancelled) setMapStatus('idle')
          return
        }
        const data = await res.json()
        if (cancelled) return

        if (data.status === 'ok' && data.image) {
          setMapImage(data.image)
          setMapStatus('ready')
        } else {
          setMapStatus('waiting')
        }
      } catch (err) {
        if (!cancelled) setMapStatus('idle')
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(poll, 1000)
        }
      }
    }

    setMapStatus('waiting')
    poll()

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [apiBaseUrl, getAccessToken])

  // --- KEYBOARD CONTROLS ---
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (event.repeat) return

      switch (key) {
        case 'w': case 'arrowup': handleTeleopStart('forward'); break
        case 's': case 'arrowdown': handleTeleopStart('backward'); break
        case 'a': case 'arrowleft': handleTeleopStart('left'); break
        case 'd': case 'arrowright': handleTeleopStart('right'); break
        case ' ':
          event.preventDefault()
          handleTeleopStop()
          break
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (['w','arrowup','s','arrowdown','a','arrowleft','d','arrowright'].includes(key)) {
        event.preventDefault()
        handleTeleopStop()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleTeleopStop)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleTeleopStop)
      // Clean up interval on unmount
      if (teleopIntervalRef.current !== null) {
        clearInterval(teleopIntervalRef.current)
      }
    }
  }, [handleTeleopStart, handleTeleopStop])

  // --- TELEMETRY WEBSOCKET ---
  useEffect(() => {
    writeStoredUrl('telemetryWsUrl', telemetryWsUrl)
    let shouldReconnect = true
    let reconnectTimer: number | undefined
    let ws: WebSocket | null = null

    const connect = async () => {
      setConnection('connecting')
      const token = await getAccessToken()
      const wsUrlWithToken = `${telemetryWsUrl}?token=${encodeURIComponent(token || '')}`
      ws = new WebSocket(wsUrlWithToken)

      ws.onopen = () => setConnection('open')
      ws.onerror = () => setConnection('error')
      ws.onclose = () => {
        setConnection('closed')
        if (shouldReconnect) {
          reconnectTimer = window.setTimeout(connect, 1500)
        }
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Partial<Telemetry>
          setTelemetry((prev) => ({
            ...prev,
            ...data,
            encoders: { ...prev.encoders, ...data.encoders },
            jetson: { ...prev.jetson, ...data.jetson },
            power: { ...prev.power, ...data.power },
            motor: data.motor ? { ...prev.motor, ...data.motor } : prev.motor,
          }))
          if (data.encoders) {
            setEncoderHistory((prev) => {
              const next = [
                ...prev,
                {
                  t: Date.now(),
                  frontLeft: data.encoders?.frontLeft ?? prev.at(-1)?.frontLeft ?? 0,
                  frontRight: data.encoders?.frontRight ?? prev.at(-1)?.frontRight ?? 0,
                  rearLeft: data.encoders?.rearLeft ?? prev.at(-1)?.rearLeft ?? 0,
                  rearRight: data.encoders?.rearRight ?? prev.at(-1)?.rearRight ?? 0,
                },
              ]
              return next.slice(-60)
            })
          }
          setLastUpdate(new Date().toLocaleTimeString())
        } catch (err) {
          console.error('Failed to parse telemetry', err)
        }
      }
    }

    connect()
    return () => {
      shouldReconnect = false
      window.clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [telemetryWsUrl, getAccessToken])

  // --- CHART HELPERS ---
  const encoderSeries = useMemo(() => {
    const keys = ENCODER_LEGEND.map((l) => l.key)
    const values = encoderHistory.length
      ? encoderHistory.flatMap((h) => keys.map((k) => h[k]))
      : keys.map((k) => telemetry.encoders[k])
    const min = Math.min(...values, telemetry.encoders.frontLeft)
    const max = Math.max(...values, min + 1)
    return { min, max }
  }, [encoderHistory, telemetry.encoders])

  const buildPath = (key: (typeof ENCODER_LEGEND)[number]['key']) => {
    const points = encoderHistory.length ? encoderHistory : [{ t: startTime, ...telemetry.encoders }]
    const w = GRAPH_W - PADDING_LEFT - PADDING_RIGHT
    const h = GRAPH_H - PADDING_TOP - PADDING_BOTTOM
    const min = encoderSeries.min
    const span = encoderSeries.max - encoderSeries.min || 1
    const step = points.length > 1 ? w / (points.length - 1) : w
    return points
      .map((p, i) => {
        const x = PADDING_LEFT + i * step
        const y = PADDING_TOP + h - ((p[key] - min) / span) * h
        return `${x},${y}`
      })
      .join(' ')
  }

  const yTicks = useMemo(() => {
    const steps = [0, 0.25, 0.5, 0.75, 1]
    const h = GRAPH_H - PADDING_TOP - PADDING_BOTTOM
    const span = encoderSeries.max - encoderSeries.min || 1
    return steps.map((s) => ({
      y: PADDING_TOP + h - s * h,
      label: (encoderSeries.min + s * span).toFixed(0),
    }))
  }, [encoderSeries])

  const xTicks = useMemo(() => {
    const points = encoderHistory.length ? encoderHistory : [{ t: startTime, ...telemetry.encoders }]
    const first = points[0]?.t ?? startTime
    const last = points[points.length - 1]?.t ?? first
    const span = Math.max(last - first, 1)
    const hW = GRAPH_W - PADDING_LEFT - PADDING_RIGHT
    const steps = [0, 0.25, 0.5, 0.75, 1]
    return steps.map((s, idx) => {
      const x = PADDING_LEFT + s * hW
      const dt = last - (first + s * span)
      const label = idx === steps.length - 1 ? 'now' : `-${(dt / 1000).toFixed(1)}s`
      return { x, label }
    })
  }, [encoderHistory, startTime])

  const connectionLabel = useMemo(() => {
    switch (connection) {
      case 'open': return 'Connected'
      case 'error': return 'Error'
      case 'closed': return 'Disconnected'
      default: return 'Connecting'
    }
  }, [connection])

  return (
    <div className="console-shell">
      <header className="console-header">
        <div className="header-left">
          <span className="console-heading">Helios Operations Console</span>
          <nav className="console-nav">
            <button className={activeTab === 'rover' ? 'active' : ''} onClick={() => setActiveTab('rover')}>
              Rover
            </button>
            <button
              className={activeTab === 'operations' ? 'active' : ''}
              onClick={() => setActiveTab('operations')}
            >
              Operations
            </button>
          </nav>
        </div>
        <div className="brand-lockup">
          <img src="/world.svg" alt="Narsil Systems logo" className="brand-logo" />
        </div>
        <div className="header-right">
          <span className="live-label">Last Update</span>
          <span className="live-value">{lastUpdate || '—'}</span>
        </div>
      </header>

      {settingsOpen && (
        <section className="settings-panel">
          <div>
            <label htmlFor="telemetry-ws">Telemetry WS URL</label>
            <input
              id="telemetry-ws"
              value={telemetryWsUrl}
              onChange={(e) => setTelemetryWsUrl(e.target.value)}
              placeholder="ws://10.104.x.x:8000/ws/telemetry"
            />
            <small style={{display:'block', marginTop: 4, opacity: 0.7}}>
              Camera stream will use port 8080 on the same IP.
            </small>
          </div>
        </section>
      )}

      <main className="console-frame">
        {activeTab === 'rover' && (
          <section className="rover-panel">
            <div className="rover-rect">
              <div className="tile-head">
                <p className="panel-label">Drive</p>
                <h3>Wheel Encoders</h3>
              </div>
              {telemetry.motor && (
                <div className="motor-stats">
                  <div className="stat"><p>Torque</p><strong>{telemetry.motor.torqueOzIn.toFixed(2)} oz-in</strong></div>
                  <div className="stat"><p>Speed</p><strong>{telemetry.motor.speedRpm.toFixed(1)} rpm</strong></div>
                  <div className="stat"><p>Current</p><strong>{telemetry.motor.currentMa.toFixed(1)} mA</strong></div>
                  <div className="stat"><p>Output Power</p><strong>{telemetry.motor.outputPowerW.toFixed(3)} W</strong></div>
                  <div className="stat"><p>Input Power</p><strong>{telemetry.motor.inputPowerW.toFixed(3)} W</strong></div>
                  <div className="stat"><p>Efficiency</p><strong>{telemetry.motor.efficiency.toFixed(1)}%</strong></div>
                </div>
              )}
              <div className="encoder-chart">
                <svg viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`} preserveAspectRatio="none">
                  <rect width={GRAPH_W} height={GRAPH_H} fill="#fff" />
                  {yTicks.map((tick) => (
                    <g key={`y-${tick.y}`}>
                      <line x1={PADDING_LEFT} x2={GRAPH_W - PADDING_RIGHT} y1={tick.y} y2={tick.y} stroke="#d9d9d9" strokeWidth="1" />
                      <text x={PADDING_LEFT - 8} y={tick.y + 4} fill="#444" fontSize="11" textAnchor="end">{tick.label}</text>
                    </g>
                  ))}
                  {xTicks.map((tick) => (
                    <g key={`x-${tick.x}`}>
                      <line x1={tick.x} x2={tick.x} y1={PADDING_TOP} y2={GRAPH_H - PADDING_BOTTOM} stroke="#f0f0f0" strokeWidth="1" />
                      <text x={tick.x} y={GRAPH_H - PADDING_BOTTOM + 18} fill="#555" fontSize="11" textAnchor="middle">{tick.label}</text>
                    </g>
                  ))}
                  <line x1={PADDING_LEFT} x2={GRAPH_W - PADDING_RIGHT} y1={GRAPH_H - PADDING_BOTTOM} y2={GRAPH_H - PADDING_BOTTOM} stroke="#444" strokeWidth="1.2" />
                  <line x1={PADDING_LEFT} x2={PADDING_LEFT} y1={PADDING_TOP} y2={GRAPH_H - PADDING_BOTTOM} stroke="#444" strokeWidth="1.2" />
                  <text x={GRAPH_W / 2} y={GRAPH_H - 8} fill="#222" fontSize="12" textAnchor="middle">Time (s)</text>
                  <text x={24} y={GRAPH_H / 2} fill="#222" fontSize="12" textAnchor="middle" transform={`rotate(-90 24 ${GRAPH_H / 2})`}>Encoder Ticks</text>
                  {ENCODER_LEGEND.map((item) => (
                    <polyline key={item.key} fill="none" stroke={item.color} strokeWidth="3" points={buildPath(item.key)} strokeLinejoin="round" strokeLinecap="round" />
                  ))}
                </svg>
              </div>
              <div className="encoder-legend">
                {ENCODER_LEGEND.map((item) => (
                  <div key={item.key} className="legend-item">
                    <span className="legend-dot" style={{ background: item.color }} />
                    <span>{item.label}</span>
                    <strong>{telemetry.encoders[item.key].toFixed(0)}</strong>
                  </div>
                ))}
              </div>
            </div>

            <div className="rover-rect">
              <div className="tile-head">
                <p className="panel-label">Compute</p>
                <h3>Jetson Thermals</h3>
              </div>
              <div className="thermals">
                <div className="thermal">
                  <p>CPU</p><strong>{telemetry.jetson.cpuTemp.toFixed(1)}°C</strong>
                  <div className="sparkline"><span style={{ width: `${Math.min((telemetry.jetson.cpuTemp / 90) * 100, 100)}%` }} /></div>
                </div>
                <div className="thermal">
                  <p>GPU</p><strong>{telemetry.jetson.gpuTemp.toFixed(1)}°C</strong>
                  <div className="sparkline"><span style={{ width: `${Math.min((telemetry.jetson.gpuTemp / 90) * 100, 100)}%` }} /></div>
                </div>
              </div>
            </div>

            <div className="rover-rect">
              <div className="tile-head">
                <p className="panel-label">Power</p>
                <h3>Battery</h3>
              </div>
              <div className="battery">
                <div><p>Voltage</p><strong>{telemetry.power.voltage.toFixed(2)} V</strong></div>
                <div>
                  <p>State of Charge</p>
                  <div className="soc">
                    <span>{telemetry.power.soc.toFixed(1)}%</span>
                    <div className="meter"><span style={{ width: `${Math.min(telemetry.power.soc, 100)}%` }} /></div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {activeTab === 'operations' && (
          <section className="video-panel">
            <div className="video-surface no-padding">
              {/* MJPEG STREAM IMG */}
              <img
                src={videoStreamUrl}
                alt="Live Stream"
                style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000' }}
              />

              {/* MODE TOGGLE */}
              <div style={{ position: 'absolute', top: 14, left: 14, display: 'flex', gap: 8 }}>
                <button
                  className={`link-btn ${feedMode === 'rgb' ? 'active' : ''}`}
                  style={{ background: feedMode==='rgb' ? '#333' : 'rgba(0,0,0,0.5)', padding: '4px 10px', color: '#fff', textDecoration: 'none', border: '2px solid #fff' }}
                  onClick={() => setFeedMode('rgb')}
                >
                  RGB
                </button>
              </div>

              {/* Live indicator */}
              <div className={`live-overlay ${connection === 'open' ? 'online' : 'offline'}`}>
                <span className="dot" />
                {connection === 'open' ? 'Live' : 'Offline'}
              </div>

              {/* SLAM Status - Always Active */}
              <div
                className="live-overlay slam-toggle online"
                style={{ position: 'absolute', top: 46, right: 14 }}
              >
                <span className="dot" />
                SLAM: Active
              </div>

              {/* MAP OVERLAY */}
              <div className="video-overlay map-overlay">
                <div className="mini-map">
                  {mapImage ? (
                    <img
                      src={mapImage}
                      alt="SLAM map"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        imageRendering: 'pixelated'
                      }}
                    />
                  ) : mapStatus === 'waiting' ? (
                    <span className="mini-map-placeholder">Building map…</span>
                  ) : (
                    <span className="mini-map-placeholder">No map yet</span>
                  )}
                </div>
              </div>

              {/* CONTROLS OVERLAY */}
              <div className="video-overlay controls-overlay">
                <div className="teleop-grid">
                  <span />
                  <button className={`teleop-btn ${activeTeleop === 'forward' ? 'active' : ''}`} onMouseDown={() => handleTeleopStart('forward')} onMouseUp={handleTeleopStop} onMouseLeave={handleTeleopStop}>⏶</button>
                  <span />
                  <button className={`teleop-btn ${activeTeleop === 'left' ? 'active' : ''}`} onMouseDown={() => handleTeleopStart('left')} onMouseUp={handleTeleopStop} onMouseLeave={handleTeleopStop}>⏴</button>
                  <span className="teleop-center" />
                  <button className={`teleop-btn ${activeTeleop === 'right' ? 'active' : ''}`} onMouseDown={() => handleTeleopStart('right')} onMouseUp={handleTeleopStop} onMouseLeave={handleTeleopStop}>⏵</button>
                  <span />
                  <button className={`teleop-btn ${activeTeleop === 'backward' ? 'active' : ''}`} onMouseDown={() => handleTeleopStart('backward')} onMouseUp={handleTeleopStop} onMouseLeave={handleTeleopStop}>⏷</button>
                  <span />
                </div>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="console-footer">
        <button className="status-chip" onClick={() => setSettingsOpen((v) => !v)} style={{ cursor: 'pointer', background: '#fff' }}>
          {settingsOpen ? 'Hide Connection Settings' : 'Connection Settings'}
        </button>
        <div className="status-chip" style={{ gap: '8px' }}>
          <span>{user}</span>
          <span>|</span>
          <button onClick={logout} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit' }}>
            Logout
          </button>
        </div>
        <div className="footer-status">
          <div className={`status-chip ${connection}`}>
            <span className="dot" />
            {connectionLabel}
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App
