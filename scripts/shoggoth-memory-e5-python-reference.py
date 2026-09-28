"""Offline synthetic tokenizer/vector reference. Not an App dependency."""
import json, os
from pathlib import Path
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

root = Path(__file__).resolve().parents[1]
assets = root / '.vendor/embedding/model'
tokenizer = Tokenizer.from_file(str(assets / 'tokenizer.json'))
options = ort.SessionOptions()
options.intra_op_num_threads = options.inter_op_num_threads = 1
session = ort.InferenceSession(str(assets / 'onnx/model_qint8_avx512_vnni.onnx'), options, providers=['CPUExecutionProvider'])
probes = ['我喜欢吃寿司。', '我希望每周末整理读过的诗歌。', 'Which language do I prefer?',
          '查询 cafe\u0301、café 与 🦑 相关的记录。', '代码变量 user_id 与文件 /tmp/test.md',
          'ＡＢＣ１２３ 与 ABC123', 'Line one\nLine two\tTabbed',
          '中文、English、Français、日本語、한국어 混合句子。']
rows = []
for text in probes:
    for kind in ['query', 'passage']:
        ids = tokenizer.encode(kind + ': ' + text).ids
        feeds = {name: np.array([ids if name == 'input_ids' else [1 if name == 'attention_mask' else 0]*len(ids)], dtype=np.int64)
                 for name in [i.name for i in session.get_inputs()]}
        hidden = session.run(['last_hidden_state'], feeds)[0][0]
        vector = hidden.mean(axis=0); vector /= np.linalg.norm(vector)
        rows.append(dict(text=text, kind=kind, ids=ids, vector=vector.tolist()))
target = root / '.artifacts/native-memory-e5-20260928/python-reference.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(dict(runtime=ort.__version__, rows=rows), ensure_ascii=False))
print(json.dumps(dict(runtime=ort.__version__, probes=len(rows), output=str(target))))
