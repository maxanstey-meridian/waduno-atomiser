import json
import os
import sys
import time

count = 0
for line in sys.stdin:
    request = json.loads(line)
    if request["title"] == "crash":
        sys.exit(1)
    if request["title"] == "malformed":
        print("not json", flush=True)
        continue
    if request["title"] == "wrong count":
        print("[]", flush=True)
        continue
    if request["title"] == "bad entity":
        print(json.dumps([[{"text": "Bad", "type": "topic", "confidence": 2}]]), flush=True)
        continue
    if request["title"] == "duplicate":
        print(json.dumps([[
            {"text": "Same", "type": "topic", "confidence": 0.9},
            {"text": "Same", "type": "individual", "confidence": 0.8},
        ] for _ in request["claims"]]), flush=True)
        continue
    if request["title"] == "overlapping":
        print(json.dumps([[
            {"text": "Frankenstein", "type": "work", "confidence": 0.95},
            {"text": "Prometheus", "type": "work", "confidence": 0.91},
            {"text": "Frankenstein; or, The Modern Prometheus", "type": "work", "confidence": 0.86},
            {"text": "FRANKENSTEIN; OR, THE MODERN PROMETHEUS", "type": "topic", "confidence": 0.99},
            {"text": "Mary Shelley", "type": "individual", "confidence": 0.79},
            {"text": "Bath", "type": "place", "confidence": 0.8},
            {"text": "BATH", "type": "place", "confidence": 0.95},
            {"text": "Oman", "type": "place", "confidence": 0.99},
            {"text": "Romania", "type": "place", "confidence": 0.99},
        ] for _ in request["claims"]]), flush=True)
        continue
    if request["title"] == "slow":
        time.sleep(1)
    count += 1
    print(json.dumps([
        [
            {"text": request["title"], "type": "topic", "confidence": 0.9},
            {"text": claim, "type": "individual", "confidence": 0.8},
            {"text": str(os.getpid()), "type": "worker", "confidence": 0.85},
            {"text": f"request-{count}", "type": "count", "confidence": 0.82},
        ]
        for claim in request["claims"]
    ]), flush=True)
