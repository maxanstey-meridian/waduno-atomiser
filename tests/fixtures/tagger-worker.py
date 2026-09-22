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
    if request["title"] == "slow":
        time.sleep(1)
    count += 1
    print(json.dumps([
        [request["title"], claim, str(os.getpid()), str(count)]
        for claim in request["claims"]
    ]), flush=True)
