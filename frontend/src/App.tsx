import { useEffect, useMemo, useState } from 'react'
import './App.css'

const ENCODER_LEGEND = [
  { key: 'frontLeft', label: 'Front Left', color: '#52ffd2' },
  { key: 'frontRight', label: 'Front Right', color: '#4aa8ff' },
  { key: 'rearLeft', label: 'Rear Left', color: '#ff8ac2' },
  { key: 'rearRight', label: 'Rear Right', color: '#ffb347' },
] as const

const GRAPH_W = 640
const GRAPH_H = 240
const PADDING_LEFT = 78
const PADDING_RIGHT = 14
const PADDING_TOP = 14
const PADDING_BOTTOM = 58

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

const WS_URL = import.meta.env.VITE_TELEMETRY_WS ?? 'ws://localhost:8000/ws/telemetry'

function App() {
  const [telemetry, setTelemetry] = useState<Telemetry>(DEFAULT_TELEMETRY)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [activeTab, setActiveTab] = useState<'rover' | 'operations'>('rover')
  const [lastUpdate, setLastUpdate] = useState<string>('')
  const [startTime] = useState(() => Date.now())
  const [encoderHistory, setEncoderHistory] = useState<
    { t: number; frontLeft: number; frontRight: number; rearLeft: number; rearRight: number }[]
  >([])

  useEffect(() => {
    let shouldReconnect = true
    let reconnectTimer: number | undefined
    const connect = () => {
      setConnection('connecting')
      const ws = new WebSocket(WS_URL)

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

      return ws
    }

    const socket = connect()
    return () => {
      shouldReconnect = false
      window.clearTimeout(reconnectTimer)
      socket.close()
    }
  }, [])

  const connectionLabel = useMemo(() => {
    switch (connection) {
      case 'open':
        return 'Connected'
      case 'error':
        return 'Error'
      case 'closed':
        return 'Disconnected'
      default:
        return 'Connecting'
    }
  }, [connection])

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
    const points = encoderHistory.length
      ? encoderHistory
      : [{ t: startTime, ...telemetry.encoders }]
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
    const points = encoderHistory.length
      ? encoderHistory
      : [{ t: startTime, ...telemetry.encoders }]
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
  }, [encoderHistory, telemetry.encoders, startTime])

  return (
    <div className="shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Narsil Systems</p>
          <h1>Helios Operations Console</h1>
        </div>
        <div className="status">
          <div className={`pill ${connection}`}>
            <span className="dot" />
            {connectionLabel}
          </div>
          <div className="meta">
            <span>WS: {WS_URL}</span>
            <span>Last update: {lastUpdate || '—'}</span>
          </div>
        </div>
      </header>

      <nav className="tabs">
        <button
          className={activeTab === 'rover' ? 'active' : ''}
          onClick={() => setActiveTab('rover')}
        >
          Rover
        </button>
        <button
          className={activeTab === 'operations' ? 'active' : ''}
          onClick={() => setActiveTab('operations')}
        >
          Operations
        </button>
      </nav>

      {activeTab === 'rover' ? (
        <section className="panel">
          <div className="grid">
            <div className="tile span-2">
              <div className="tile-head">
                <p className="eyebrow">Drive</p>
                <h3>Wheel Encoders</h3>
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
              {telemetry.motor && (
                <div className="motor-stats">
                  <div className="stat">
                    <p>Torque</p>
                    <strong>{telemetry.motor.torqueOzIn.toFixed(2)} oz-in</strong>
                  </div>
                  <div className="stat">
                    <p>Speed</p>
                    <strong>{telemetry.motor.speedRpm.toFixed(1)} rpm</strong>
                  </div>
                  <div className="stat">
                    <p>Current</p>
                    <strong>{telemetry.motor.currentMa.toFixed(1)} mA</strong>
                  </div>
                  <div className="stat">
                    <p>Output Power</p>
                    <strong>{telemetry.motor.outputPowerW.toFixed(3)} W</strong>
                  </div>
                  <div className="stat">
                    <p>Input Power</p>
                    <strong>{telemetry.motor.inputPowerW.toFixed(3)} W</strong>
                  </div>
                  <div className="stat">
                    <p>Efficiency</p>
                    <strong>{telemetry.motor.efficiency.toFixed(1)}%</strong>
                  </div>
                </div>
              )}
              <div className="encoder-chart">
                <svg viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`} preserveAspectRatio="none">
                  <rect width={GRAPH_W} height={GRAPH_H} fill="rgba(255,255,255,0.02)" />
                  {yTicks.map((tick) => (
                    <g key={`y-${tick.y}`}>
                      <line
                        x1={PADDING_LEFT}
                        x2={GRAPH_W - PADDING_RIGHT}
                        y1={tick.y}
                        y2={tick.y}
                        stroke="rgba(255,255,255,0.06)"
                        strokeWidth="1"
                      />
                      <text x={PADDING_LEFT - 8} y={tick.y + 4} fill="#9fb3d9" fontSize="11" textAnchor="end">
                        {tick.label}
                      </text>
                    </g>
                  ))}
                  {xTicks.map((tick) => (
                    <g key={`x-${tick.x}`}>
                      <line
                        x1={tick.x}
                        x2={tick.x}
                        y1={PADDING_TOP}
                        y2={GRAPH_H - PADDING_BOTTOM}
                        stroke="rgba(255,255,255,0.04)"
                        strokeWidth="1"
                      />
                      <text
                        x={tick.x}
                        y={GRAPH_H - PADDING_BOTTOM + 18}
                        fill="#9fb3d9"
                        fontSize="11"
                        textAnchor="middle"
                      >
                        {tick.label}
                      </text>
                    </g>
                  ))}
                  <line
                    x1={PADDING_LEFT}
                    x2={GRAPH_W - PADDING_RIGHT}
                    y1={GRAPH_H - PADDING_BOTTOM}
                    y2={GRAPH_H - PADDING_BOTTOM}
                    stroke="rgba(255,255,255,0.35)"
                    strokeWidth="1.2"
                  />
                  <line
                    x1={PADDING_LEFT}
                    x2={PADDING_LEFT}
                    y1={PADDING_TOP}
                    y2={GRAPH_H - PADDING_BOTTOM}
                    stroke="rgba(255,255,255,0.35)"
                    strokeWidth="1.2"
                  />
                  <text
                    x={GRAPH_W / 2}
                    y={GRAPH_H - 8}
                    fill="#cfe8ff"
                    fontSize="12"
                    textAnchor="middle"
                  >
                    Time (seconds ago)
                  </text>
                  <text
                    x={24}
                    y={GRAPH_H / 2}
                    fill="#cfe8ff"
                    fontSize="12"
                    textAnchor="middle"
                    transform={`rotate(-90 24 ${GRAPH_H / 2})`}
                  >
                    Wheel encoder counts (ticks)
                  </text>
                  {ENCODER_LEGEND.map((item) => (
                    <polyline
                      key={item.key}
                      fill="none"
                      stroke={item.color}
                      strokeWidth="3"
                      points={buildPath(item.key)}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  ))}
                </svg>
              </div>
            </div>

            <div className="tile">
              <div className="tile-head">
                <p className="eyebrow">Compute</p>
                <h3>Jetson Thermals</h3>
              </div>
              <div className="thermals">
                <div className="thermal">
                  <p>CPU</p>
                  <strong>{telemetry.jetson.cpuTemp.toFixed(1)}°C</strong>
                  <div className="sparkline">
                    <span style={{ width: `${Math.min((telemetry.jetson.cpuTemp / 90) * 100, 100)}%` }} />
                  </div>
                </div>
                <div className="thermal">
                  <p>GPU</p>
                  <strong>{telemetry.jetson.gpuTemp.toFixed(1)}°C</strong>
                  <div className="sparkline">
                    <span style={{ width: `${Math.min((telemetry.jetson.gpuTemp / 90) * 100, 100)}%` }} />
                  </div>
                </div>
              </div>
            </div>

            <div className="tile">
              <div className="tile-head">
                <p className="eyebrow">Power</p>
                <h3>Battery</h3>
              </div>
              <div className="battery">
                <div>
                  <p>Voltage</p>
                  <strong>{telemetry.power.voltage.toFixed(2)} V</strong>
                </div>
                <div>
                  <p>State of Charge</p>
                  <div className="soc">
                    <span>{telemetry.power.soc.toFixed(1)}%</span>
                    <div className="meter">
                      <span style={{ width: `${Math.min(telemetry.power.soc, 100)}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="ops-grid">
            <div className="feed rgb">
              <div className="feed-header">
                <span className="live">LIVE</span>
                <div>
                  <p className="eyebrow">Perception</p>
                  <h3>RGB Video</h3>
                </div>
              </div>
              <div className="scanlines" />
            </div>

            <div className="feed depth">
              <div className="feed-header">
                <span className="live">DEPTH</span>
                <div>
                  <p className="eyebrow">Perception</p>
                  <h3>Depth View</h3>
                </div>
              </div>
              <div className="scanlines" />
            </div>

            <div className="map-card">
              <div className="map">
                <div className="heatmap" />
                <div className="map-grid" />
              </div>
              <div className="map-meta">
                <p className="eyebrow">Navigation</p>
                <h3>Satellite Map</h3>
                <p>Placeholder imagery with heatmap overlay.</p>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

export default App
