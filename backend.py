import asyncio
import base64
import io
import math
import os
import random
import signal
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from pydantic import BaseModel

# Optional imports so the backend can still run without hardware/ROS
try:  # ZED SDK
    import pyzed.sl as sl  # type: ignore
except ImportError:  # pragma: no cover - hardware dependent
    sl = None

try:  # ROS 2
    import rclpy
    from geometry_msgs.msg import Twist
except ImportError:  # pragma: no cover - ROS dependent
    rclpy = None
    Twist = None


app = FastAPI(title="Rover Ops Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

THERMAL_ZONE_ROOT = Path("/sys/devices/virtual/thermal")

# Target ~24 FPS for smoother motion but less jitter on the Jetson
FRAME_INTERVAL_SEC = 1.0 / 80.0

# Stream resolution and quality
# 960-wide is a good compromise: lower bandwidth & CPU than 1280, but still sharp
MAX_STREAM_WIDTH = 960
RGB_JPEG_QUALITY = 82  # slightly reduced for more stable latency

# Keep these for compatibility (mock mode)
MOCK_FRAME_HEIGHT = max(1, int(round(MAX_STREAM_WIDTH * 9 / 16)))
RESAMPLE_LANCZOS = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)

# ROS 2 / cmd_vel bridge globals
ROS_NODE = None
CMD_VEL_PUB = None

# Tune these to taste
LINEAR_SPEED = 0.3   # m/s forward/backward
ANGULAR_SPEED = 0.8  # rad/s for spin / skid-steer turns

# SLAM process management
SLAM_PROC: Optional[subprocess.Popen] = None
SLAM_LOCK = threading.Lock()
SLAM_CMD = (
    "source /opt/ros/humble/setup.bash && "
    "source /home/robotsailor/helios_ws/install/setup.bash && "
    "ros2 launch helios_bringup helios_slam.launch.py use_rviz:=false"
)


def encode_frame(
    array: np.ndarray,
    *,
    mode: str = "RGB",
    fmt: str = "JPEG",
    quality: int = 90,
    max_width: Optional[int] = None,
) -> str:
    """Encode a numpy frame into a base64 data URL with high fidelity."""
    img = Image.fromarray(np.ascontiguousarray(array), mode=mode)
    fmt = fmt.upper()
    mime = f"image/{fmt.lower()}"

    if max_width and img.width > max_width:
        ratio = max_width / float(img.width)
        new_size = (max_width, max(1, int(img.height * ratio)))
        img = img.resize(new_size, RESAMPLE_LANCZOS)

    save_kwargs = {"quality": quality}
    if fmt == "JPEG":
        # Force 4:4:4 subsampling to avoid chroma loss on UI overlays.
        save_kwargs.update({"subsampling": 0, "progressive": True})
    elif fmt == "WEBP":
        save_kwargs.update({"method": 6})

    with io.BytesIO() as buffer:
        try:
            img.save(buffer, format=fmt, **save_kwargs)
        except (KeyError, OSError):
            # Pillow might be built without WebP; gracefully fall back to JPEG.
            mime = "image/jpeg"
            img.save(
                buffer,
                format="JPEG",
                quality=min(quality + 5, 100),
                subsampling=0,
                progressive=True,
            )
        payload = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:{mime};base64,{payload}"


class ZedStreamer:
    """Capture RGB frames from the ZED camera or fall back to mock data."""

    def __init__(self) -> None:
        self._cam: Optional["sl.Camera"] = None
        self._image: Optional["sl.Mat"] = None
        self._depth: Optional["sl.Mat"] = None  # kept for future use, but unused now
        self._runtime_params: Optional["sl.RuntimeParameters"] = None
        self._start = time.time()
        self.last_error: Optional[str] = None
        self._latest_frame: Optional[dict] = None
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._worker: Optional[threading.Thread] = None
        self._profile: Optional[str] = None

    def ensure_camera(self) -> bool:
        if sl is None:
            self.last_error = "pyzed SDK not available; using mock feed"
            return False
        if self._cam is not None:
            return True

        # We still ask the SDK for a depth mode, but we won't retrieve depth
        depth_mode = (
            getattr(sl.DEPTH_MODE, "NEURAL", None)
            or getattr(sl.DEPTH_MODE, "DEPTH_MODE_NEURAL", None)
            or getattr(sl.DEPTH_MODE, "PERFORMANCE", None)
            or getattr(sl.DEPTH_MODE, "DEPTH_MODE_PERFORMANCE")
        )

        def resolve_resolution(name: str):
            return getattr(
                sl.RESOLUTION,
                f"RESOLUTION_{name}",
                getattr(sl.RESOLUTION, name, getattr(sl.RESOLUTION, "RESOLUTION_HD720", sl.RESOLUTION.HD720)),
            )

        # Prefer high FPS; resolution will be scaled to MAX_STREAM_WIDTH anyway
        preferred_profiles = [
            ("HD720", 60),
            ("HD1080", 60),
            ("HD720", 30),
            ("HD1080", 30),
        ]
        last_status = None
        for res_name, fps in preferred_profiles:
            camera = sl.Camera()
            init_params = sl.InitParameters(
                camera_resolution=resolve_resolution(res_name),
                camera_fps=fps,
                depth_mode=depth_mode,
            )
            status = camera.open(init_params)
            if status == sl.ERROR_CODE.SUCCESS:
                self._cam = camera
                self._image = sl.Mat()
                # We are not retrieving depth in this UI pipeline
                self._depth = sl.Mat()
                # Disable depth in runtime to reduce processing
                self._runtime_params = sl.RuntimeParameters(enable_depth=False)
                self._profile = f"{res_name}@{fps}fps"
                self.last_error = None
                return True
            last_status = status

        self.last_error = f"Failed to open ZED camera: {last_status}"
        return False

    def close(self) -> None:
        if self._cam is not None:
            self._cam.close()
        self._cam = None
        self._image = None
        self._depth = None
        self._runtime_params = None
        self._profile = None
        self.stop()

    def _capture_from_camera(self) -> Optional[dict]:
        """RGB-only capture from the ZED (no depth encoding)."""
        if self._cam is None or self._runtime_params is None or self._image is None:
            return None

        if self._cam.grab(self._runtime_params) != sl.ERROR_CODE.SUCCESS:
            self.last_error = "Failed to grab frame from ZED"
            return None

        # Only retrieve the left RGB image
        self._cam.retrieve_image(self._image, getattr(sl.VIEW, "VIEW_LEFT", sl.VIEW.LEFT))
        rgb_np = self._image.get_data()[:, :, :3][:, :, ::-1].copy()  # BGRA -> RGB

        return {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "rgb": encode_frame(
                rgb_np,
                mode="RGB",
                fmt="JPEG",
                quality=RGB_JPEG_QUALITY,
                max_width=MAX_STREAM_WIDTH,
            ),
            # Depth disabled in this build – keep key for compatibility
            "depth": "",
            "source": "zed",
            "status": "live",
            "profile": self._profile,
        }

    def _mock_frame(self) -> dict:
        """RGB-only mock frame to keep UI alive when camera is unavailable."""
        width, height = MAX_STREAM_WIDTH, MOCK_FRAME_HEIGHT
        t = time.time() - self._start
        x = np.linspace(0, 1, width)
        y = np.linspace(0, 1, height)
        xv, yv = np.meshgrid(x, y)

        rgb = np.stack(
            [
                (0.6 + 0.4 * np.sin(2 * math.pi * (xv + t * 0.1))),
                (0.5 + 0.5 * np.sin(2 * math.pi * (yv + t * 0.17))),
                (0.45 + 0.5 * np.sin(2 * math.pi * (xv + yv + t * 0.07))),
            ],
            axis=-1,
        )
        rgb = np.clip(rgb, 0, 1)
        rgb_frame = (rgb * 255).astype(np.uint8)

        return {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "rgb": encode_frame(
                rgb_frame,
                fmt="JPEG",
                quality=RGB_JPEG_QUALITY,
                max_width=MAX_STREAM_WIDTH,
            ),
            "depth": "",  # depth disabled
            "source": "mock",
            "status": self.last_error or "mock-feed",
            "profile": f"mock {width}x{height}@24fps",
        }

    def _generate_frame(self) -> dict:
        if self.ensure_camera():
            payload = self._capture_from_camera()
            if payload:
                return payload
        # Camera unavailable; fall back to mock visuals.
        return self._mock_frame()

    def start(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        self._stop_event.clear()
        self._worker = threading.Thread(target=self._capture_loop, daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._worker:
            self._worker.join(timeout=1.0)
        self._worker = None

    def _capture_loop(self) -> None:
        # Use monotonic clock for stable intervals
        next_tick = time.monotonic()
        while not self._stop_event.is_set():
            frame = self._generate_frame()
            with self._lock:
                self._latest_frame = frame

            next_tick += FRAME_INTERVAL_SEC
            delay = next_tick - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            else:
                # If we are lagging behind, realign to now
                next_tick = time.monotonic()

    def latest(self) -> dict:
        with self._lock:
            if self._latest_frame:
                return dict(self._latest_frame)
        # If the worker has not produced anything yet, return an immediate frame.
        frame = self._generate_frame()
        with self._lock:
            self._latest_frame = frame
        return frame


zed_streamer = ZedStreamer()


def init_ros_bridge() -> None:
    """Initialize ROS 2 node and /cmd_vel publisher if ROS is available."""
    global ROS_NODE, CMD_VEL_PUB

    if rclpy is None or Twist is None:
        # ROS not available / environment not sourced – run backend anyway
        return

    if ROS_NODE is not None:
        return  # already initialized

    rclpy.init(args=None)
    ROS_NODE = rclpy.create_node("helios_teleop_bridge")
    CMD_VEL_PUB = ROS_NODE.create_publisher(Twist, "/cmd_vel", 10)


def publish_teleop(direction: str) -> bool:
    """
    Map a simple direction string into a geometry_msgs/Twist and publish.

    Returns True if published, False if invalid direction or ROS unavailable.
    """
    if CMD_VEL_PUB is None or Twist is None:
        return False

    msg = Twist()

    if direction == "forward":
        msg.linear.x = LINEAR_SPEED
    elif direction == "backward":
        msg.linear.x = -LINEAR_SPEED
    elif direction == "left":
        msg.angular.z = ANGULAR_SPEED
    elif direction == "right":
        msg.angular.z = -ANGULAR_SPEED
    elif direction == "stop":
        # all zeros → stop
        pass
    else:
        # unknown direction
        return False

    CMD_VEL_PUB.publish(msg)
    return True


def read_thermal_zone(zone_type: str) -> Optional[float]:
    for zone in THERMAL_ZONE_ROOT.glob("thermal_zone*"):
        try:
            if zone.joinpath("type").read_text().strip() == zone_type:
                raw = zone.joinpath("temp").read_text().strip()
                return float(raw) / 1000.0
        except OSError:
            continue
    return None


def resolve_jetson_temps(iteration: int) -> dict:
    cpu_temp = read_thermal_zone("cpu-thermal")
    gpu_temp = read_thermal_zone("gpu-thermal")
    if cpu_temp is None:
        cpu_temp = 60.0 + 3 * math.sin(iteration / 12)
    if gpu_temp is None:
        gpu_temp = 58.0 + 2.5 * math.cos(iteration / 10)
    return {"cpuTemp": round(cpu_temp, 1), "gpuTemp": round(gpu_temp, 1)}


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
        "jetson": resolve_jetson_temps(iteration),
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


class TeleopCommand(BaseModel):
    direction: str  # "forward" | "backward" | "left" | "right" | "stop"


class SlamCommand(BaseModel):
    action: str  # "start" | "stop" | "status"


def slam_status() -> str:
    with SLAM_LOCK:
        if SLAM_PROC is not None and SLAM_PROC.poll() is None:
            return "running"
        return "stopped"


def start_slam() -> str:
    global SLAM_PROC
    with SLAM_LOCK:
        # Already running
        if SLAM_PROC is not None and SLAM_PROC.poll() is None:
            return "running"

        # Spawn SLAM in its own process group so we can kill the whole tree
        proc = subprocess.Popen(
            ["bash", "-lc", SLAM_CMD],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            preexec_fn=os.setsid,
        )
        SLAM_PROC = proc
        return "running"


def stop_slam() -> str:
    global SLAM_PROC
    with SLAM_LOCK:
        if SLAM_PROC is None:
            return "stopped"

        if SLAM_PROC.poll() is not None:
            SLAM_PROC = None
            return "stopped"

        try:
            pgid = os.getpgid(SLAM_PROC.pid)
            os.killpg(pgid, signal.SIGTERM)
            try:
                SLAM_PROC.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(pgid, signal.SIGKILL)
        except Exception:
            # As a fallback, try to terminate just the process
            try:
                SLAM_PROC.terminate()
            except Exception:
                pass

        SLAM_PROC = None
        return "stopped"


@app.post("/teleop")
async def teleop(cmd: TeleopCommand) -> dict:
    """
    Receive tele-op commands from the UI and publish /cmd_vel.

    The frontend sends: { "direction": "forward" | "backward" | "left" | "right" | "stop" }.
    """
    ok = publish_teleop(cmd.direction)

    if not ok:
        return {
            "status": "error",
            "detail": "Invalid direction or ROS bridge not available",
        }

    return {"status": "ok"}


@app.post("/slam")
async def slam(cmd: SlamCommand) -> dict:
    """
    Control SLAM process from the UI.

    Body: { "action": "start" | "stop" | "status" }
    """
    action = cmd.action.lower()

    if action == "start":
        state = await asyncio.to_thread(start_slam)
    elif action == "stop":
        state = await asyncio.to_thread(stop_slam)
    elif action == "status":
        state = await asyncio.to_thread(slam_status)
    else:
        return {"status": "error", "detail": "Invalid action"}

    return {"status": "ok", "state": state}


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


@app.websocket("/ws/zed")
async def zed_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            payload = zed_streamer.latest()
            await websocket.send_json(payload)
            # Send at a fixed cadence; the capture thread handles timing
            await asyncio.sleep(FRAME_INTERVAL_SEC)
    except WebSocketDisconnect:
        return


@app.on_event("startup")
async def startup_event() -> None:
    # Initialize ROS 2 bridge (if ROS is installed and sourced)
    await asyncio.to_thread(init_ros_bridge)
    # Start ZED capture worker
    zed_streamer.start()


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await asyncio.to_thread(zed_streamer.close)
    await asyncio.to_thread(stop_slam)

    global ROS_NODE
    if ROS_NODE is not None and rclpy is not None:
        ROS_NODE.destroy_node()
        ROS_NODE = None
        rclpy.shutdown()


if __name__ == "__main__":
    # In production on the Jetson, disable reload to avoid extra overhead/jitter
    uvicorn.run("backend:app", host="0.0.0.0", port=8000, reload=False)