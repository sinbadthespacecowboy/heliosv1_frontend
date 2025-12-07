import asyncio
import math
import random
from datetime import datetime

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn


app = FastAPI(title="Rover Ops Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def build_mock_payload(iteration: int) -> dict:
    """Create slightly changing mock telemetry so the UI looks alive."""
    # Smooth oscillation for encoder values (four wheels)
    front_left = 120 + int(5 * math.sin(iteration / 5))
    front_right = 118 + int(4 * math.cos(iteration / 4))
    rear_left = 115 + int(3 * math.sin(iteration / 6))
    rear_right = 117 + int(4 * math.cos(iteration / 7))

    # Add small jitter
    encoders = {
        "frontLeft": front_left + random.randint(-2, 2),
        "frontRight": front_right + random.randint(-2, 2),
        "rearLeft": rear_left + random.randint(-2, 2),
        "rearRight": rear_right + random.randint(-2, 2),
    }

    # Temps drift slowly
    cpu_temp = 60.0 + 3 * math.sin(iteration / 12)
    gpu_temp = 58.0 + 2.5 * math.cos(iteration / 10)

    # Voltage/SOC decay slowly with tiny noise
    voltage = 24.5 - 0.002 * iteration + random.uniform(-0.05, 0.05)
    soc = max(0, 85 - 0.02 * iteration + random.uniform(-0.2, 0.2))

    # Mock motor characteristics (single representative channel)
    torque_oz_in = 10 + 3 * math.sin(iteration / 9)
    speed_rpm = 260 + 20 * math.cos(iteration / 8)
    current_ma = 250 + 40 * math.sin(iteration / 6)
    output_power_w = 0.00074 * torque_oz_in * speed_rpm
    input_power_w = (current_ma / 1000) * 24
    efficiency = max(0.0, min(output_power_w / input_power_w if input_power_w else 0, 1.0))

    return {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "encoders": {
            "frontLeft": encoders["frontLeft"],
            "frontRight": encoders["frontRight"],
            "rearLeft": encoders["rearLeft"],
            "rearRight": encoders["rearRight"],
        },
        "jetson": {"cpuTemp": round(cpu_temp, 1), "gpuTemp": round(gpu_temp, 1)},
        "power": {"voltage": round(voltage, 2), "soc": round(soc, 1)},
        "motor": {
            "torqueOzIn": round(torque_oz_in, 2),
            "speedRpm": round(speed_rpm, 1),
            "currentMa": round(current_ma, 1),
            "outputPowerW": round(output_power_w, 3),
            "inputPowerW": round(input_power_w, 3),
            "efficiency": round(efficiency * 100, 2),
        },
    }


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.websocket("/ws/telemetry")
async def telemetry_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    iteration = 0
    try:
        while True:
            payload = build_mock_payload(iteration)
            await websocket.send_json(payload)
            iteration += 1
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        # Client disconnected; just exit the loop.
        return


if __name__ == "__main__":
    uvicorn.run("backend:app", host="0.0.0.0", port=8000, reload=True)
