"""Build benchmark 'answers' from CMU ARCTIC sentences.

Usage: python3 -I bench/prepare-audio.py <arctic_dir> <out_dir>

Each answer = 5 consecutive sentences from one speaker, leading/trailing
silence trimmed (keeps 80 ms / 200 ms), joined. Writes for every answer:
  <name>.24k.pcm  int16 LE mono 24 kHz (what the voice model would stream)
  <name>.16k.pcm  int16 LE mono 16 kHz (original rate, for the reference)
and answers.json with names, durations and transcripts.
"""
import json, re, sys, wave, os
import numpy as np

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
texts = {}
for line in open(os.path.join(src, 'slt_txt.data')):
    m = re.match(r'\( (arctic_\w+) "(.*)" \)', line.strip())
    if m:
        texts[m.group(1)] = m.group(2)

def load(path):
    w = wave.open(path)
    assert w.getframerate() == 16000 and w.getnchannels() == 1
    return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64)

def trim(x, sr=16000):
    frame = sr // 100
    n = len(x) // frame
    e = np.sqrt((x[: n * frame].reshape(n, frame) ** 2).mean(axis=1))
    thr = max(e.max() * 0.03, 50)
    voiced = np.where(e > thr)[0]
    a = max(0, voiced[0] - 8) * frame
    b = min(len(x), (voiced[-1] + 20) * frame)
    return x[a:b]

def resample(x, up, down):
    # FFT resampling (band-limited), good enough to emulate a 24 kHz TTS stream
    n = len(x)
    m = n * up // down
    X = np.fft.rfft(x)
    Y = np.zeros(m // 2 + 1, dtype=complex)
    k = min(len(X), len(Y))
    Y[:k] = X[:k]
    return np.fft.irfft(Y, m) * (m / n)

answers = []
for spk in ['slt', 'bdl']:
    for g in range(4):
        ids = [f'arctic_a{(g * 5 + i + 1):04d}' for i in range(5)]
        parts = [trim(load(os.path.join(src, f'{spk}_{i.replace("arctic_", "")}.wav'))) for i in ids]
        x16 = np.concatenate(parts)
        x24 = resample(x16, 3, 2)
        name = f'{spk}{g + 1}'
        np.clip(x16, -32768, 32767).astype('<i2').tofile(os.path.join(out, name + '.16k.pcm'))
        np.clip(np.round(x24), -32768, 32767).astype('<i2').tofile(os.path.join(out, name + '.24k.pcm'))
        answers.append({'name': name, 'seconds': round(len(x16) / 16000, 3),
                        'text': ' '.join(texts[i] for i in ids)})
json.dump(answers, open(os.path.join(out, 'answers.json'), 'w'), indent=1)
print(len(answers), 'answers,', round(sum(a['seconds'] for a in answers), 1), 's total')
