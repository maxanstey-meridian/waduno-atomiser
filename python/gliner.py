import contextlib
import json
import sys
from pathlib import Path

MODEL = "fastino/gliner2.5-base-v1"
REVISION = "1a8bc24e00dc7300b9017c81d63e3dcdabb26596"
TAG_TYPES = {
    "individual": "A specifically named individual person or fictional character",
    "organization": "A specifically named organization, institution, school, company, government body, agency, band, media outlet, or organized group",
    "work": "A specifically named creative work, television series, film, book, play, programme, advertisement, game, or franchise",
    "installment": "A specifically named episode, chapter, issue, installment, or individual entry within a larger creative work",
    "place": "A specifically named real or fictional geographic place or location",
    "named_event_or_program": "A specifically named event, movement, test, programme, competition, campaign, initiative, rally, or organized activity",
    "named_object": "A specifically named individual physical or fictional object, artifact, vehicle, toy, weapon, or item",
    "topic": "A specific topic, cultural phenomenon, historical period, genre, theme, trend, or subject useful for identifying what the article or claim is about, such as 1990s nostalgia, Britpop, or 1990s music",
}


def setup(path):
    from huggingface_hub import snapshot_download

    snapshot_download(repo_id=MODEL, revision=REVISION, local_dir=str(path))


def serve(path):
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from gliner2 import AutoExtractor
        from gliner2.configuration import ExtractorConfig

        device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
        config = ExtractorConfig.from_pretrained(str(path.resolve() / "config.json"))
        config.attn_implementation = "eager"
        extractor = AutoExtractor.from_pretrained(str(path.resolve()), config=config, map_location=device)
        extractor.eval()

    for line in sys.stdin:
        request = json.loads(line)
        results = []
        with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
            for claim in request["claims"]:
                raw = extractor.extract_entities(
                    f"[Article: {request['title']}]\nClaim: {claim}",
                    TAG_TYPES,
                    threshold=0.5,
                    include_confidence=True,
                    include_spans=True,
                )
                tags = {}
                for values in raw["entities"].values():
                    for value in values:
                        text = value["text"] if isinstance(value, dict) else value
                        tag = " ".join(text.split()).casefold()
                        if tag:
                            tags[tag] = None
                results.append(list(tags))
        print(json.dumps(results, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--setup":
        setup(Path(sys.argv[2]))
    else:
        serve(Path(sys.argv[1]))
