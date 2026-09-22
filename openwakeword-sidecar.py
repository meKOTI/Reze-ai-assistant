import sys, os, json, struct, traceback
from pathlib import Path

def emit(kind, **data):
    print(json.dumps({"type": kind, **data}, ensure_ascii=False), flush=True)

def fail(message):
    emit("error", message=message)

def resolve_model():
    base = Path(__file__).resolve().parent
    configured = os.environ.get("REZE_WAKE_MODEL", "").strip()
    if configured:
        p = Path(configured)
        if not p.is_absolute():
            p = base / p
        return p
    return base / "wake-models" / "reze.onnx"

try:
    import numpy as np
    import openwakeword
    from openwakeword.model import Model
except Exception as e:
    fail(
        "Brak openWakeWord. Uruchom SETUP-OPENWAKEWORD.ps1. "
        f"Szczegóły: {type(e).__name__}: {e}"
    )
    sys.exit(2)

model_path = resolve_model()
threshold = float(os.environ.get("REZE_WAKE_THRESHOLD", "0.50"))
vad_threshold = float(os.environ.get("REZE_WAKE_VAD_THRESHOLD", "0.35"))

if not model_path.exists():
    fail(
        f"Brak modelu wake word: {model_path}. "
        "Wgraj wytrenowany reze.onnx do wake-models/reze.onnx "
        "albo ustaw REZE_WAKE_MODEL."
    )
    sys.exit(3)

try:
    model = Model(
        wakeword_models=[str(model_path)],
        inference_framework="onnx",
        vad_threshold=vad_threshold,
    )
except Exception as e:
    fail(f"Nie udało się załadować modelu openWakeWord: {type(e).__name__}: {e}")
    sys.exit(4)

model_name = next(iter(model.models.keys()), model_path.stem)
emit(
    "ready",
    model=str(model_path),
    modelName=model_name,
    threshold=threshold,
    vadThreshold=vad_threshold,
)

# Electron sends a little-endian uint32 byte length followed by raw PCM16 mono 16 kHz.
buf = bytearray()
needed = None

while True:
    chunk = sys.stdin.buffer.read(4096)
    if not chunk:
        break
    buf.extend(chunk)

    while True:
        if needed is None:
            if len(buf) < 4:
                break
            needed = struct.unpack("<I", bytes(buf[:4]))[0]
            del buf[:4]
            if needed <= 0 or needed > 1024 * 1024:
                fail(f"Nieprawidłowy rozmiar ramki PCM: {needed}")
                needed = None
                continue

        if len(buf) < needed:
            break

        frame_bytes = bytes(buf[:needed])
        del buf[:needed]
        needed = None

        try:
            pcm = np.frombuffer(frame_bytes, dtype="<i2")
            if pcm.size == 0:
                continue

            # openWakeWord is optimized for multiples of 1280 samples (80 ms).
            predictions = model.predict(pcm)
            score = float(predictions.get(model_name, 0.0))
            emit("score", score=score)

            if score >= threshold:
                emit("detected", score=score, modelName=model_name)
                try:
                    model.reset()
                except Exception:
                    pass
        except Exception as e:
            fail(f"Błąd inferencji openWakeWord: {type(e).__name__}: {e}")

emit("closed")
