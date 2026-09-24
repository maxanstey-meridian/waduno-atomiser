import io
import json
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch


class ClaimExtractorContextTest(unittest.TestCase):
    def test_context_resolves_references_without_replacing_selected_text(self):
        source = {
            "text": "  She wrote the novel.\n",
            "title": "Mary Shelley",
            "context": {
                "sectionPath": ["Frankenstein"],
                "leadIn": "Shelley began writing in 1816.",
            },
        }
        extraction = {"extractions": {"claims": [
            {"content": "Mary Shelley wrote Frankenstein.", "subtype": "Factoid"},
        ]}}
        response = io.BytesIO(json.dumps({"choices": [{
            "message": {"content": json.dumps(extraction)},
        }]}).encode())
        with (
            patch("sys.argv", ["claim_extractor.py", "http://localhost/v1", "test", "UNUSED_KEY", "5"]),
            patch("sys.stdin", io.StringIO(json.dumps(source))),
            patch("sys.stdout", new_callable=io.StringIO) as output,
            patch("urllib.request.urlopen", return_value=response) as request,
        ):
            runpy.run_path(str(Path(__file__).parents[1] / "python/claim_extractor.py"), run_name="__main__")
        body = json.loads(request.call_args.args[0].data)
        system, user = body["messages"]
        self.assertIn("Do not extract additional claims from the context", system["content"])
        self.assertIn(json.dumps({"title": source["title"], "context": source["context"]}), user["content"])
        self.assertIn("LAST MESSAGE (ASSISTANT):\n" + source["text"], user["content"])
        self.assertEqual(json.loads(output.getvalue()), {"claims": [{"content": "Mary Shelley wrote Frankenstein."}]})


if __name__ == "__main__":
    unittest.main()
