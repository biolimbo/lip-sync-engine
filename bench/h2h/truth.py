"""Ground-truth phone timelines for the benchmark answers.

Usage: python3 -I bench/h2h/truth.py <arctic_wav_dir> <arctic_lab_dir> <out.json>

Applies exactly the trimming and joining of bench/prepare-audio.py to the
CMU ARCTIC phone labels (.lab: "end_time 125 phone" per line), so phone
times line up with the answer audio.
"""
import json, os, sys, wave
import numpy as np

wav_dir, lab_dir, out = sys.argv[1:4]

def load(path):
    w = wave.open(path)
    return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64)

def trim_bounds(x, sr=16000):  # same as prepare-audio.py trim()
    frame = sr // 100
    n = len(x) // frame
    e = np.sqrt((x[: n * frame].reshape(n, frame) ** 2).mean(axis=1))
    thr = max(e.max() * 0.03, 50)
    voiced = np.where(e > thr)[0]
    a = max(0, voiced[0] - 8) * frame
    b = min(len(x), (voiced[-1] + 20) * frame)
    return a, b

def labels(path):
    out, start = [], 0.0
    for line in open(path):
        parts = line.split()
        if len(parts) != 3 or line.startswith('#'):
            continue
        end = float(parts[0])
        out.append((start, end, parts[2]))
        start = end
    return out

result = {}
for spk in ['slt', 'bdl']:
    for g in range(4):
        offset = 0.0
        phones = []
        for i in range(5):
            idx = f'{(g * 5 + i + 1):04d}'
            x = load(os.path.join(wav_dir, f'{spk}_a{idx}.wav'))
            a, b = trim_bounds(x)
            a_s, b_s = a / 16000, b / 16000
            for s, e, p in labels(os.path.join(lab_dir, f'{spk}_a{idx}.lab')):
                s2, e2 = max(s, a_s), min(e, b_s)
                if e2 > s2:
                    phones.append({'start': round(s2 - a_s + offset, 4), 'end': round(e2 - a_s + offset, 4), 'phone': p})
            offset += (b - a) / 16000
        result[f'{spk}{g + 1}'] = phones
json.dump(result, open(out, 'w'))
print(len(result), 'answers;', sum(len(v) for v in result.values()), 'phones; phone set:', sorted({p['phone'] for v in result.values() for p in v}))
