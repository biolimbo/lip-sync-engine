"""Write the subset of the pronunciation dictionary whose words are in the
default language model's vocabulary.

Without dialog text the decoder can only output words the language model
knows (PocketSphinx skips other dictionary words when building its search
tree), so loading the other ~55k entries only costs start-up time and memory.
Decoders built for dialog text still use the full dictionary.

Usage: python3 scripts/filter-dict.py models/sphinx
"""
import os
import sys

d = sys.argv[1]
lm = open(os.path.join(d, 'en-us.lm.bin'), 'rb').read()
# The binary trie LM ends with its vocabulary as NUL-separated words.
i = lm.find(b'\x00</s>\x00')
j = i
while j > 0 and (32 <= lm[j - 1] < 127 or lm[j - 1] == 0):
    j -= 1
vocab = set(w.decode() for w in lm[j:].split(b'\x00') if w)
out = []
for line in open(os.path.join(d, 'cmudict-en-us.dict'), encoding='utf8'):
    w = line.split(' ', 1)[0]
    base = w[: w.index('(')] if '(' in w else w
    if base in vocab:
        out.append(line)
open(os.path.join(d, 'cmudict-en-us.lm-vocab.dict'), 'w', encoding='utf8').writelines(out)
print(f'{len(vocab)} LM words, {len(out)} dictionary entries kept')
