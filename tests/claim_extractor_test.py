import io
import json
import os
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
        body, output = run_bridge(source, extraction, reasoning_effort="")
        system, user = body["messages"]
        self.assertIn("Do not extract additional claims from the context", system["content"])
        self.assertIn("not a reply from an assistant", system["content"])
        self.assertIn(json.dumps({"title": source["title"], "context": source["context"]}), user["content"])
        self.assertIn("LAST MESSAGE (ASSISTANT):\n" + source["text"], user["content"])
        self.assertNotIn("reasoning", body, "the local fine-tune is sent no reasoning field")
        self.assertEqual(json.loads(output), {"claims": [{"content": "Mary Shelley wrote Frankenstein."}]})

    def test_a_hosted_model_gets_the_same_request_plus_its_reasoning_effort(self):
        source = {"text": "She wrote the novel.", "title": "Mary Shelley", "context": {"sectionPath": [], "leadIn": None}}
        extraction = {"extractions": {"claims": [{"content": "Mary Shelley wrote a novel.", "subtype": "Factoid"}]}}
        local, _ = run_bridge(source, extraction, reasoning_effort="")
        hosted, _ = run_bridge(source, extraction, reasoning_effort="minimal")
        self.assertEqual(hosted.pop("reasoning"), {"effort": "minimal"})
        self.assertEqual(hosted, local)

    def test_the_request_carries_the_key_from_the_named_variable(self):
        source = {"text": "She wrote the novel.", "title": "Mary Shelley", "context": {"sectionPath": [], "leadIn": None}}
        extraction = {"extractions": {"claims": [{"content": "Mary Shelley wrote a novel.", "subtype": "Factoid"}]}}
        request, _ = run_bridge_request(source, completion(json.dumps(extraction)))
        self.assertEqual(request.get_header("Authorization"), "Bearer test-key")

    def test_a_reply_without_content_fails_with_a_clear_error(self):
        source = {"text": "She wrote the novel.", "title": "Mary Shelley", "context": {"sectionPath": [], "leadIn": None}}
        with self.assertRaisesRegex(ValueError, "ClaimExtractor returned no message content"):
            run_bridge_request(source, completion(None))


def completion(content):
    return {"choices": [{"message": {"content": content}}]}


def run_bridge(source, extraction, reasoning_effort):
    request, output = run_bridge_request(source, completion(json.dumps(extraction)), reasoning_effort)
    return json.loads(request.data), output


def run_bridge_request(source, response, reasoning_effort=""):
    argv = ["claim_extractor.py", "http://localhost/v1", "test", "CLAIM_EXTRACTOR_TEST_KEY", "5", reasoning_effort]
    with (
        patch("sys.argv", argv),
        patch.dict(os.environ, {"CLAIM_EXTRACTOR_TEST_KEY": "test-key"}),
        patch("sys.stdin", io.StringIO(json.dumps(source))),
        patch("sys.stdout", new_callable=io.StringIO) as output,
        patch("urllib.request.urlopen", return_value=io.BytesIO(json.dumps(response).encode())) as request,
    ):
        runpy.run_path(str(Path(__file__).parents[1] / "python/claim_extractor.py"), run_name="__main__")
    return request.call_args.args[0], output.getvalue()

if __name__ == "__main__":
    unittest.main()
