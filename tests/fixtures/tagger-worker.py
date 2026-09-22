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
    if request["title"] == "slow":
        time.sleep(1)
    count += 1
    print(json.dumps([
        [
            {"text": request["title"], "type": "topic", "confidence": 0.9},
            {"text": claim, "type": "individual", "confidence": 0.8},
            {"text": str(os.getpid()), "type": "worker", "confidence": 0.7},
            {"text": str(count), "type": "count", "confidence": 0.6},
        ]
        for claim in request["claims"]
    ]), flush=True)
