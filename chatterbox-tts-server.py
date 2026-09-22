import argparse
import base64
import io
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = None
DEVICE = None
LAST_REFERENCE = None


def load_model():
    global MODEL, DEVICE
    if MODEL is not None:
        return MODEL
    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    forced = os.environ.get('REZE_TTS_DEVICE', 'auto').lower().strip()
    if forced == 'cpu':
        DEVICE = 'cpu'
    elif forced == 'cuda':
        DEVICE = 'cuda'
    else:
        DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'

    print(f'Loading Chatterbox Multilingual V3 on {DEVICE}...', flush=True)
    MODEL = ChatterboxMultilingualTTS.from_pretrained(device=DEVICE, t3_model='v3')
    print('Chatterbox model ready.', flush=True)
    return MODEL


def synthesize(payload):
    global LAST_REFERENCE
    text = str(payload.get('text', '')).strip()
    reference = str(payload.get('reference_path', '')).strip()
    language_id = str(payload.get('language_id', 'pl')).strip().lower()
    exaggeration = float(payload.get('exaggeration', 0.45))
    cfg_weight = float(payload.get('cfg_weight', 0.0))

    if not text:
        raise ValueError('Brak tekstu.')
    if not reference or not os.path.isfile(reference):
        raise ValueError('Nie znaleziono próbki referencyjnej WAV.')

    model = load_model()
    if LAST_REFERENCE != reference:
        model.prepare_conditionals(reference, exaggeration=exaggeration)
        LAST_REFERENCE = reference

    started = time.perf_counter()
    wav = model.generate(
        text,
        language_id=language_id,
        exaggeration=exaggeration,
        cfg_weight=cfg_weight,
    )

    import torchaudio as ta
    buffer = io.BytesIO()
    ta.save(buffer, wav.cpu(), model.sr, format='wav')
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return {
        'audio_base64': base64.b64encode(buffer.getvalue()).decode('ascii'),
        'device': DEVICE,
        'generation_ms': elapsed_ms,
        'sample_rate': model.sr,
    }


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self._json(200, {'ok': True, 'loaded': MODEL is not None, 'device': DEVICE})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/synthesize':
            self._json(404, {'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            payload = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
            self._json(200, synthesize(payload))
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self._json(500, {'error': str(exc)})

    def log_message(self, fmt, *args):
        return


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'REZE Chatterbox server listening on {args.host}:{args.port}', flush=True)
    server.serve_forever()
